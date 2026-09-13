/**
 * Backend (Cloudflare Worker) — KS Tunnel
 *
 * Routes:
 *   GET /api/hello              -> { message: "KS Tunnel online", ... }
 *   GET /api/health             -> { ok: true }
 *   GET /api/hosts/:id/status   -> { host, online, agents, decision, timestamp }
 *   GET /api/hosts/:id/decision -> { host, decision, timestamp }
 *   POST /api/hosts/:id/allow   -> { host, decision: "allowed", ... } (browser Allow)
 *   POST /api/hosts/:id/deny    -> { host, decision: "denied", ... } (also /decline, /cancel)
 *   POST /api/hosts/:id/decision {decision} -> set pending/allowed/denied
 *   WS  /api/agent/ws?host=ID   -> CLI agent socket (role=agent, waits for decision)
 *   WS  /api/hosts/:id/ws       -> browser watcher socket (role=watch, sends decision)
 *   WS  /api/ws?host=ID&role=.. -> generic alias for the two above
 *   GET /api/config?host=ID     -> { host, online, agents, decision, ... }
 *   POST /api/config?host=ID {decision} -> set decision
 *   *                           -> serves static frontend assets (dist/) with SPA fallback
 *                                 (`/!config?host=ID` serves index.html; the React app
 *                                 shows the Allow/Cancel page.)
 *
 * Presence is tracked by the HostPresence Durable Object (one instance per
 * host id, via idFromName("host:"+id)). Agents = CLI connections, watchers =
 * browser tabs. Online = at least one agent socket is open.
 *
 * Config handshake (CLI <-> browser via the DO):
 *   1. CLI generates a 5-letter token, prints /!config?host=<token>,
 *      then holds `WS /api/agent/ws?host=<token>` open. While no browser
 *      has decided, the decision is "pending" (missing/404 counts as
 *      pending = OK, keep waiting — not an error).
 *   2. User opens the /!config link: the React app shows Allow / Cancel
 *      and opens `WS /api/hosts/<token>/ws` (role=watch).
 *   3. Cancel/Decline -> browser sends {"type":"decision","decision":"denied"}
 *      (HTTP POST /api/hosts/<token>/deny as fallback). The DO broadcasts
 *      {"type":"decision","decision":"denied"} to every socket; the CLI
 *      sees it and stops (exits).
 *   4. Allow -> browser sends {"type":"decision","decision":"allowed"}
 *      (HTTP POST /api/hosts/<token>/allow as fallback). The DO broadcasts
 *      "allowed"; the CLI stays connected (alive) and the browser saves
 *      the host into the Hosts page (localStorage).
 */

export interface Env {
  ASSETS: Fetcher;
  HOST_PRESENCE: DurableObjectNamespace;
}

const HOST_RE = /^[A-Za-z0-9_-]{5,64}$/;

function isValidHost(value: string | null): value is string {
  return !!value && HOST_RE.test(value);
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      // Same-origin by default, but allow explicit cross-origin polling too.
      "access-control-allow-origin": "*",
    },
  });
}

function stubFor(env: Env, host: string): DurableObjectStub {
  const id = env.HOST_PRESENCE.idFromName(`host:${host}`);
  return env.HOST_PRESENCE.get(id);
}

function requireHost(url: URL): string | null {
  const host = url.searchParams.get("host");
  return isValidHost(host) ? host : null;
}

/** Extract `/api/hosts/<id>/...` host segment. */
function hostFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/hosts\/([^/]+)\/(status|ws|decision|allow|deny|decline|cancel)\/?$/);
  if (!m) return null;
  return isValidHost(m[1]) ? m[1] : null;
}

/** Action suffix of `/api/hosts/<id>/<action>`. */
function actionFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/hosts\/[^/]+\/(status|ws|decision|allow|deny|decline|cancel)\/?$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Durable Object: presence registry + config-decision relay for one host id.
// ---------------------------------------------------------------------------

export type ConfigDecision = "pending" | "allowed" | "denied";

type PresenceMessage = {
  type: "presence";
  host: string;
  online: boolean;
  agents: number;
  decision: ConfigDecision;
  timestamp: string;
};

type DecisionMessage = {
  type: "decision";
  host: string;
  decision: ConfigDecision;
  timestamp: string;
};

function normalizeDecision(value: unknown): ConfigDecision | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "allowed" || v === "allow" || v === "approve" || v === "approved" || v === "accept") {
    return "allowed";
  }
  if (
    v === "denied" ||
    v === "deny" ||
    v === "decline" ||
    v === "declined" ||
    v === "cancel" ||
    v === "canceled" ||
    v === "cancelled" ||
    v === "reject" ||
    v === "rejected"
  ) {
    return "denied";
  }
  if (v === "pending" || v === "reset" || v === "wait" || v === "waiting") return "pending";
  return null;
}

/** Parse an inbound WS/HTTP JSON body into a decision, if it carries one. */
function decisionFromPayload(text: string): ConfigDecision | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const direct = normalizeDecision(text);
    return direct;
  }
  if (typeof data === "string") return normalizeDecision(data);
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // {"type":"allow"} / {"type":"deny"} / {"type":"cancel"} / ...
    if (typeof obj["type"] === "string") {
      const byType = normalizeDecision(obj["type"]);
      // "decision" type needs the nested field; other types map directly.
      if (obj["type"] !== "decision" && byType && byType !== "pending") return byType;
      if (obj["type"] === "reset") return "pending";
    }
    for (const key of ["decision", "action", "allow", "approved"]) {
      const d = normalizeDecision(obj[key]);
      if (d) return d;
    }
    // {"allow": true} / {"deny": true} / {"cancel": true}
    if (obj["allow"] === true || obj["approved"] === true) return "allowed";
    if (obj["deny"] === true || obj["decline"] === true || obj["cancel"] === true) return "denied";
  }
  return null;
}

export class HostPresence implements DurableObject {
  private ctx: DurableObjectState;
  private host: string = "unknown";
  private decision: ConfigDecision = "pending";

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
    // Restore host label + last decision after hibernation-eviction wakeups.
    ctx.blockConcurrencyWhile(async () => {
      try {
        const stored = await ctx.storage.get<string>("host");
        if (typeof stored === "string" && stored) this.host = stored;
        const dec = await ctx.storage.get<string>("decision");
        if (dec === "allowed" || dec === "denied" || dec === "pending") this.decision = dec;
      } catch {
        // ignore
      }
    });
  }

  private hostFromRequest(request: Request): string {
    try {
      const url = new URL(request.url);
      const q = url.searchParams.get("host");
      if (isValidHost(q)) return q;
      const m = url.pathname.match(/\/api\/hosts\/([^/]+)\//);
      if (m && isValidHost(m[1])) return m[1];
    } catch {
      // fall through
    }
    return "unknown";
  }

  private snapshot(host: string): PresenceMessage {
    let agents = 0;
    try {
      agents = this.ctx.getWebSockets("agent").length;
    } catch {
      agents = 0;
    }
    return {
      type: "presence",
      host,
      online: agents > 0,
      agents,
      decision: this.decision,
      timestamp: new Date().toISOString(),
    };
  }

  private decisionMessage(host: string): DecisionMessage {
    return {
      type: "decision",
      host,
      decision: this.decision,
      timestamp: new Date().toISOString(),
    };
  }

  private broadcast(host: string): void {
    const msg = JSON.stringify(this.snapshot(host));
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // dead socket — runtime will clean it up via close/error events
      }
    }
  }

  private broadcastDecision(host: string): void {
    const msg = JSON.stringify(this.decisionMessage(host));
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // ignore dead sockets
      }
    }
  }

  private async setDecision(host: string, decision: ConfigDecision): Promise<DecisionMessage> {
    this.decision = decision;
    try {
      await this.ctx.storage.put("decision", decision);
      await this.ctx.storage.put("decisionAt", new Date().toISOString());
    } catch {
      // ignore
    }
    this.broadcastDecision(host);
    // Presence pollers also read decision from the snapshot.
    this.broadcast(host);
    return this.decisionMessage(host);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");

    // Remember host label for close/error broadcasts (hibernation-safe).
    const seen = this.hostFromRequest(request);
    if (seen !== "unknown") {
      this.host = seen;
      try {
        await this.ctx.storage.put("host", seen);
      } catch {
        // ignore
      }
    }
    const host = seen !== "unknown" ? seen : this.host;

    // --- HTTP decision controls (forwarded by the Worker entrypoint) --------
    // Internal paths: /decision/allow, /decision/deny, /decision, /status.
    // POST wins; GET on /decision/allow|deny also applies (link fallback).
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      const path = url.pathname;
      if (path === "/decision/allow" || path.endsWith("/decision/allow")) {
        const msg = await this.setDecision(host, "allowed");
        return json(msg);
      }
      if (
        path === "/decision/deny" ||
        path.endsWith("/decision/deny") ||
        path === "/decision/cancel" ||
        path.endsWith("/decision/cancel")
      ) {
        const msg = await this.setDecision(host, "denied");
        return json(msg);
      }
      if (path === "/decision" || path.endsWith("/decision")) {
        if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
          let body = "";
          try {
            body = await request.text();
          } catch {
            body = "";
          }
          const qsDecision = normalizeDecision(url.searchParams.get("decision"));
          const next = decisionFromPayload(body) ?? qsDecision;
          if (!next) return json({ error: "invalid decision (want allowed|denied|pending)" }, 400);
          const msg = await this.setDecision(host, next);
          return json(msg);
        }
        return json(this.decisionMessage(host));
      }
    }

    // --- WebSocket attach -------------------------------------------------
    if (upgrade && upgrade.toLowerCase() === "websocket") {
      const roleParam = url.searchParams.get("role");
      const pathIsAgent = url.pathname === "/api/agent/ws" || url.pathname === "/api/ws";
      const role = roleParam === "agent" || roleParam === "watch"
        ? roleParam
        : pathIsAgent && !url.pathname.startsWith("/api/hosts/")
          ? "agent"
          : "watch";
      // Default role inference: /api/agent/ws => agent unless ?role=watch given.
      const tag = role === "agent" ? "agent" : "watch";

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server, [tag]);

      const wsHost = this.hostFromRequest(request);
      // Immediately tell the newcomer (and everyone else) the current state.
      // New sockets always get presence + the current decision, so a CLI that
      // connects after the browser already clicked still learns allowed/denied,
      // and a browser that opens late learns pending vs decided.
      try {
        server.send(JSON.stringify(this.snapshot(wsHost)));
      } catch {
        // ignore send race
      }
      try {
        server.send(JSON.stringify(this.decisionMessage(wsHost)));
      } catch {
        // ignore send race
      }
      if (tag === "agent") this.broadcast(wsHost);

      return new Response(null, { status: 101, webSocket: client });
    }

    // --- HTTP status -------------------------------------------------------
    // Pending counts as OK: a missing/unknown decision is "not decided yet",
    // so CLI waiting on it must keep waiting instead of treating 404 as fatal.
    const httpHost = this.hostFromRequest(request);
    return json(this.snapshot(httpHost === "unknown" ? (url.searchParams.get("host") ?? "unknown") : httpHost));
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // Respond to heartbeats so agents/browsers can keep NATs alive.
    let text = "";
    if (typeof message === "string") text = message;
    else {
      try {
        text = new TextDecoder().decode(message);
      } catch {
        return;
      }
    }
    const trimmed = text.trim();
    if (trimmed === '{"type":"ping"}' || trimmed === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
      } catch {
        // ignore
      }
      return;
    }
    // Browser Allow/Cancel arrives here as a watcher WS message, e.g.
    // {"type":"decision","decision":"allowed"} or {"type":"deny"}.
    // Persist it and relay to every socket (CLI agent + other watchers).
    const next = decisionFromPayload(trimmed);
    if (next) {
      let target = this.host;
      if (target === "unknown") {
        try {
          const stored = await this.ctx.storage.get<string>("host");
          if (typeof stored === "string" && stored) target = stored;
        } catch {
          // ignore
        }
      }
      const msg = await this.setDecision(target, next);
      // Ack the sender directly too (broadcast already covered it).
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // ignore
      }
      return;
    }
    void ws;
    // Unknown messages are ignored (presence is connection-based, not message-based).
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    void ws;
    // An agent may have gone away — recount and notify remaining watchers.
    this.broadcast(this.host);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    void ws;
    this.broadcast(this.host);
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/hello") {
      return json({
        message: "KS Tunnel online",
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true });
    }

    // --- Agent socket: CLI connects here -----------------------------------
    // WS wss://<worker>/api/agent/ws?host=<random>
    if (url.pathname === "/api/agent/ws") {
      const host = requireHost(url);
      if (!host) return json({ error: "missing or invalid ?host=" }, 400);
      if (!env.HOST_PRESENCE) return json({ error: "presence not configured" }, 500);
      const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return json({ error: "expected websocket upgrade" }, 426);
      }
      const stub = stubFor(env, host);
      // Forward the real socket to the DO.
      const fwd = new Request(`https://presence/api/agent/ws?host=${encodeURIComponent(host)}&role=agent`, request);
      return stub.fetch(fwd);
    }

    // --- Browser watcher socket / HTTP status + decision -----------------------
    // WS   wss://<worker>/api/hosts/<id>/ws
    // GET  https://<worker>/api/hosts/<id>/status   -> {host,online,agents,decision,...}
    // GET  https://<worker>/api/hosts/<id>/decision -> {host,decision,...}
    // POST https://<worker>/api/hosts/<id>/allow    -> allow (browser Allow button)
    // POST https://<worker>/api/hosts/<id>/deny     -> deny (also /decline, /cancel)
    // POST https://<worker>/api/hosts/<id>/decision {decision} -> set
    if (url.pathname.startsWith("/api/hosts/")) {
      const host = hostFromPath(url.pathname);
      if (!host) return json({ error: "invalid host id" }, 400);
      if (!env.HOST_PRESENCE) return json({ error: "presence not configured" }, 500);
      const stub = stubFor(env, host);
      const action = actionFromPath(url.pathname);
      if (url.pathname.endsWith("/ws")) {
        const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");
        if (!upgrade || upgrade.toLowerCase() !== "websocket") {
          return json({ error: "expected websocket upgrade" }, 426);
        }
        const fwd = new Request(
          `https://presence/api/hosts/${encodeURIComponent(host)}/ws?host=${encodeURIComponent(host)}&role=watch`,
          request,
        );
        return stub.fetch(fwd);
      }
      if (action === "allow") {
        const fwd = new Request(
          `https://presence/decision/allow?host=${encodeURIComponent(host)}`,
          request,
        );
        return stub.fetch(fwd);
      }
      if (action === "deny" || action === "decline" || action === "cancel") {
        const fwd = new Request(
          `https://presence/decision/deny?host=${encodeURIComponent(host)}`,
          request,
        );
        return stub.fetch(fwd);
      }
      if (action === "decision") {
        // GET returns current decision; POST/PUT/PATCH sets it.
        const fwd = new Request(
          `https://presence/decision?host=${encodeURIComponent(host)}`,
          request,
        );
        return stub.fetch(fwd);
      }
      if (url.pathname.endsWith("/status")) {
        const res = await stub.fetch(
          `https://presence/status?host=${encodeURIComponent(host)}`,
        );
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        return json({
          host,
          online: (data?.["online"] as boolean) ?? false,
          agents: (data?.["agents"] as number) ?? 0,
          decision: (data?.["decision"] as string) ?? "pending",
          timestamp: (data?.["timestamp"] as string) ?? new Date().toISOString(),
        });
      }
      return json({ error: "not found" }, 404);
    }

    // --- Generic alias -------------------------------------------------------
    // WS /api/ws?host=ID&role=agent|watch | GET /api/ws?host=ID (status+decision)
    // GET /api/config?host=ID (status+decision) | POST /api/config?host=ID {decision}
    if (url.pathname === "/api/ws" || url.pathname === "/api/config") {
      const host = requireHost(url);
      if (!host) return json({ error: "missing or invalid ?host=" }, 400);
      if (!env.HOST_PRESENCE) return json({ error: "presence not configured" }, 500);
      const stub = stubFor(env, host);
      const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        const role = url.searchParams.get("role") === "agent" ? "agent" : "watch";
        const fwd = new Request(
          `https://presence/api/ws?host=${encodeURIComponent(host)}&role=${role}`,
          request,
        );
        return stub.fetch(fwd);
      }
      if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
        const fwd = new Request(
          `https://presence/decision?host=${encodeURIComponent(host)}`,
          request,
        );
        return stub.fetch(fwd);
      }
      const res = await stub.fetch(`https://presence/status?host=${encodeURIComponent(host)}`);
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return json({
        host,
        online: (data?.["online"] as boolean) ?? false,
        agents: (data?.["agents"] as number) ?? 0,
        decision: (data?.["decision"] as string) ?? "pending",
        timestamp: (data?.["timestamp"] as string) ?? new Date().toISOString(),
      });
    }

    // Serve frontend static assets built by Vite into ./dist.
    // Works with wrangler.toml `[assets] directory = "./dist"`.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Local fallback when assets binding is unavailable (e.g. `vite dev`).
    return new Response("Frontend assets not found. Run `npm run build` first.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
