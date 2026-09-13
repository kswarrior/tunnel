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
 *   WS  /api/agent/ws?host=ID   -> MAIN wss: CLI control socket (cf <-> cli talk,
 *                                  presence + decision + register-tunnel)
 *   WS  /api/hosts/:id/ws       -> browser watcher socket (role=watch, sends decision)
 *   WS  /api/ws?host=ID&role=.. -> generic alias for the two above
 *   GET /api/config?host=ID     -> { host, online, agents, decision, ... }
 *   POST /api/config?host=ID {decision} -> set decision
 *   WS  /api/tunnels/ws?host=ID&slug=hello[&target=127.0.0.1:4757]
 *                             -> PER-TUNNEL wss: one socket per tunnel (data plane).
 *                                CLI opens one per tunnel it serves; visitors'
 *                                HTTP is bridged over it (cli -> workers -> you).
 *   GET /api/tunnels            -> list registered tunnels [{slug,host,target,...}]
 *   POST /api/tunnels {slug,host,target,...} -> register/upsert a tunnel
 *   GET /api/tunnels/:slug      -> resolve one tunnel
 *   DELETE /api/tunnels/:slug   -> unregister
 *   GET /api/hosts/:id/tunnels  -> { host, tunnels:[slug...] } online data sockets
 *   GET /<slug> , /<slug>/*     -> FULLSCREEN tunnel proxy: returns the local
 *                                  http://<target>/<rest> bytes verbatim
 *                                  (status+headers+body, no KS wrapper) via the
 *                                  per-tunnel wss. e.g. /hello shows 127.0.0.1:4757.
 *   *                           -> serves static frontend assets (dist/) with SPA fallback
 *                                 (`/!config?host=ID` serves index.html; the React app
 *                                 shows the Allow/Cancel page.)
 *
 * Presence is tracked by the HostPresence Durable Object (one instance per
 * host id, via idFromName("host:"+id)). Agents = CLI main-wss connections,
 * watchers = browser tabs. Online = at least one agent socket is open.
 * Tunnel data sockets live in the same DO with tag `tunnel:<slug>`.
 * Slug -> host/target mapping lives in the TunnelRegistry DO singleton
 * (idFromName("tunnels:registry")) so visitor requests (no localStorage)
 * can resolve /<slug> to the owning host.
 *
 * Traffic shape: cli --wss--> workers --https--> users.
 *   main wss  (/api/agent/ws)   : control — presence, allow/deny, pings.
 *   tunnel wss (/api/tunnels/ws): data — one per tunnel, multiplexed by id:
 *     workers -> cli : {"type":"tunnel-request","id","method","path","headers","bodyBase64"}
 *     cli -> workers : {"type":"tunnel-response","id","status","headers","bodyBase64"}
 */

export interface Env {
  ASSETS: Fetcher;
  HOST_PRESENCE: DurableObjectNamespace;
  TUNNEL_REGISTRY: DurableObjectNamespace;
}

const HOST_RE = /^[A-Za-z0-9_-]{5,64}$/;
const SLUG_RE = /^[a-z0-9-]{2,32}$/;

function normalizeSlug(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^\/+/, "").toLowerCase();
}

function isValidSlug(value: string | null | undefined): value is string {
  return !!value && SLUG_RE.test(value);
}

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

function registryStub(env: Env): DurableObjectStub {
  const id = env.TUNNEL_REGISTRY.idFromName("tunnels:registry");
  return env.TUNNEL_REGISTRY.get(id);
}

export type TunnelEntry = {
  slug: string;
  host: string;
  target: string;
  name: string;
  tunnelType: string;
  updatedAt: string;
};

function uint8ToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function base64ToUint8(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function requireHost(url: URL): string | null {
  const host = url.searchParams.get("host");
  return isValidHost(host) ? host : null;
}

/** Extract `/api/hosts/<id>/...` host segment. */
function hostFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/hosts\/([^/]+)\/(status|ws|decision|allow|deny|decline|cancel|tunnels)\/?$/);
  if (!m) return null;
  return isValidHost(m[1]) ? m[1] : null;
}

/** Action suffix of `/api/hosts/<id>/<action>`. */
function actionFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/hosts\/[^/]+\/(status|ws|decision|allow|deny|decline|cancel|tunnels)\/?$/);
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
  /** Slugs with a live per-tunnel wss right now. */
  tunnels: string[];
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
  // Pending visitor -> CLI tunnel requests, keyed by request id.
  // In-memory only: eviction drops them and visitors get a 504.
  private pending = new Map<string, { resolve: (data: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

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

  /** Slugs with at least one live per-tunnel wss right now. */
  private tunnelSlugs(): string[] {
    const out = new Set<string>();
    try {
      for (const ws of this.ctx.getWebSockets()) {
        let tags: string[] = [];
        try {
          tags = this.ctx.getTags(ws);
        } catch {
          continue;
        }
        for (const t of tags) {
          if (t.startsWith("tunnel:")) out.add(t.slice("tunnel:".length));
        }
      }
    } catch {
      // ignore
    }
    return [...out].sort();
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
      tunnels: this.tunnelSlugs(),
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

      // --- Tunnel data-plane (internal, called by the Worker entrypoint) ----
      // POST /tunnel/request?slug=hello {id,method,path,headers,bodyBase64}
      // Forwards one visitor HTTP request over the per-tunnel wss to the CLI
      // and waits (max 30s) for {"type":"tunnel-response",...}.
      if (path === "/tunnel/request" || path.endsWith("/tunnel/request")) {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        const slug = normalizeSlug(url.searchParams.get("slug"));
        if (!isValidSlug(slug)) return json({ error: "invalid slug" }, 400);
        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ error: "invalid json" }, 400);
        }
        const id = typeof payload["id"] === "string" ? (payload["id"] as string) : "";
        if (!id) return json({ error: "missing id" }, 400);
        let sockets: WebSocket[] = [];
        try {
          sockets = this.ctx.getWebSockets(`tunnel:${slug}`);
        } catch {
          sockets = [];
        }
        if (sockets.length === 0) {
          return json(
            {
              error: "tunnel offline",
              slug,
              host,
              hint: `run: kstunnel --host ${host} --tunnel ${slug} --target 127.0.0.1:PORT`,
            },
            502,
          );
        }
        const ws = sockets[0];
        const msg = JSON.stringify({
          type: "tunnel-request",
          id,
          method: typeof payload["method"] === "string" ? payload["method"] : "GET",
          path: typeof payload["path"] === "string" ? payload["path"] : "/",
          headers: (payload["headers"] as Record<string, string>) ?? {},
          bodyBase64: typeof payload["bodyBase64"] === "string" ? payload["bodyBase64"] : "",
          slug,
        });
        const data = await new Promise<unknown>((resolve) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            resolve({ error: "tunnel timeout", slug });
          }, 30000);
          this.pending.set(id, {
            resolve: (d) => {
              clearTimeout(timer);
              resolve(d);
            },
            timer,
          });
          try {
            ws.send(msg);
          } catch {
            clearTimeout(timer);
            this.pending.delete(id);
            resolve({ error: "tunnel send failed", slug });
          }
        });
        const err = (data as Record<string, unknown>)?.["error"];
        if (typeof err === "string" && (data as Record<string, unknown>)?.["status"] === undefined) {
          const code = err === "tunnel timeout" ? 504 : 502;
          return json(data, code);
        }
        return json(data);
      }

      // GET /tunnels -> { host, tunnels:[slug...], online, agents, ... }
      if (path === "/tunnels" || path.endsWith("/tunnels")) {
        return json(this.snapshot(host));
      }
    }

    // --- WebSocket attach -------------------------------------------------
    if (upgrade && upgrade.toLowerCase() === "websocket") {
      // Per-tunnel data socket: /tunnel/ws?host=ID&slug=hello
      // One wss per tunnel (data plane). Main wss (/api/agent/ws) stays control.
      if (url.pathname === "/tunnel/ws" || url.pathname.endsWith("/tunnel/ws")) {
        const slug = normalizeSlug(url.searchParams.get("slug"));
        if (host === "unknown") return json({ error: "missing or invalid ?host=" }, 400);
        if (!isValidSlug(slug)) return json({ error: "missing or invalid ?slug= (want 2-32 a-z0-9-)" }, 400);
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
        this.ctx.acceptWebSocket(server, [`tunnel:${slug}`]);
        try {
          server.send(JSON.stringify({ type: "tunnel-ready", slug, host, timestamp: new Date().toISOString() }));
        } catch {
          // ignore send race
        }
        this.broadcast(host);
        return new Response(null, { status: 101, webSocket: client });
      }

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
    // Tunnel data-plane: CLI answers visitor requests here.
    // {"type":"tunnel-response","id":"...","status":200,"headers":{},"bodyBase64":"..."}
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj && obj["type"] === "tunnel-response" && typeof obj["id"] === "string") {
        const waiter = this.pending.get(obj["id"] as string);
        if (waiter) {
          this.pending.delete(obj["id"] as string);
          clearTimeout(waiter.timer);
          waiter.resolve({
            status: typeof obj["status"] === "number" ? obj["status"] : 200,
            headers: (obj["headers"] as Record<string, string>) ?? {},
            bodyBase64: typeof obj["bodyBase64"] === "string" ? obj["bodyBase64"] : "",
          });
        }
        return;
      }
      // CLI may also (re)register its tunnel over the main wss; ack it.
      if (obj && obj["type"] === "register-tunnel") {
        try {
          ws.send(JSON.stringify({ type: "registered", timestamp: new Date().toISOString() }));
        } catch {
          // ignore
        }
        return;
      }
    } catch {
      // not JSON — fall through to decision parsing
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
    // An agent or tunnel socket may have gone away — recount and notify watchers.
    this.broadcast(this.host);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    void ws;
    this.broadcast(this.host);
  }
}

// ---------------------------------------------------------------------------
// Durable Object: global tunnel registry (slug -> host/target).
// Singleton via idFromName("tunnels:registry") so visitor requests
// (which have no localStorage) can resolve /<slug> to the owning host.
// ---------------------------------------------------------------------------

export class TunnelRegistry implements DurableObject {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // GET /list -> { tunnels: TunnelEntry[] }
    if ((path === "/list" || path.endsWith("/list")) && request.method === "GET") {
      try {
        const map = await this.ctx.storage.list<TunnelEntry>({ prefix: "tunnel:" });
        return json({ tunnels: [...map.values()].sort((a, b) => a.slug.localeCompare(b.slug)) });
      } catch {
        return json({ tunnels: [] });
      }
    }

    // GET /resolve?slug=hello -> TunnelEntry | 404
    if (path === "/resolve" || path.endsWith("/resolve")) {
      const slug = normalizeSlug(url.searchParams.get("slug"));
      if (!isValidSlug(slug)) return json({ error: "invalid slug" }, 400);
      try {
        const entry = await this.ctx.storage.get<TunnelEntry>(`tunnel:${slug}`);
        if (!entry) return json({ error: "not found", slug }, 404);
        return json(entry);
      } catch {
        return json({ error: "storage error" }, 500);
      }
    }

    // POST /register {slug,host,target,name,tunnelType} -> upsert
    if (path === "/register" || path.endsWith("/register") || (path === "/" && request.method === "POST")) {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const slug = normalizeSlug(typeof body["slug"] === "string" ? (body["slug"] as string) : "");
      if (!isValidSlug(slug)) {
        return json({ error: "invalid slug (want 2-32 chars: a-z, 0-9, hyphen, like /hello)" }, 400);
      }
      const host = typeof body["host"] === "string" ? (body["host"] as string).trim() : "";
      // Require a real host id: an entry with host="" can never proxy
      // (visitor flow needs entry.host for the DO lookup) and falls through
      // to the SPA fallback, so /<slug> confusingly shows the web UI itself
      // instead of the port. Fail fast so the UI can surface "pick a host".
      if (!isValidHost(host)) return json({ error: "invalid host (pick the CLI host id from Hosts)" }, 400);
      const target = typeof body["target"] === "string" ? (body["target"] as string).trim() : "";
      if (!target) return json({ error: "missing target (want like 127.0.0.1:4757)" }, 400);
      const entry: TunnelEntry = {
        slug,
        host,
        target,
        name: typeof body["name"] === "string" && (body["name"] as string).trim()
          ? (body["name"] as string).trim()
          : slug,
        tunnelType: typeof body["tunnelType"] === "string" && (body["tunnelType"] as string).trim()
          ? (body["tunnelType"] as string).trim()
          : "HTTP",
        updatedAt: new Date().toISOString(),
      };
      try {
        await this.ctx.storage.put(`tunnel:${slug}`, entry);
      } catch {
        return json({ error: "storage error" }, 500);
      }
      return json(entry);
    }

    // POST /unregister {slug} | DELETE /unregister?slug=.. | DELETE /?slug=..
    if (path === "/unregister" || path.endsWith("/unregister")) {
      let slug = normalizeSlug(url.searchParams.get("slug"));
      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          if (typeof body["slug"] === "string") slug = normalizeSlug(body["slug"] as string);
        } catch {
          // keep query slug
        }
      }
      if (!isValidSlug(slug)) return json({ error: "invalid slug" }, 400);
      try {
        await this.ctx.storage.delete(`tunnel:${slug}`);
      } catch {
        // ignore
      }
      return json({ ok: true, slug });
    }

    return json({ error: "not found" }, 404);
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
          tunnels: (data?.["tunnels"] as string[]) ?? [],
        });
      }
      if (action === "tunnels") {
        // GET /api/hosts/:id/tunnels -> live per-tunnel wss slugs for this host
        const res = await stub.fetch(`https://presence/tunnels?host=${encodeURIComponent(host)}`);
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        return json({
          host,
          tunnels: (data?.["tunnels"] as string[]) ?? [],
          online: (data?.["online"] as boolean) ?? false,
          agents: (data?.["agents"] as number) ?? 0,
          timestamp: (data?.["timestamp"] as string) ?? new Date().toISOString(),
        });
      }
      return json({ error: "not found" }, 404);
    }

    // --- Per-tunnel wss (data plane): one socket per tunnel ------------------
    // WS wss://<worker>/api/tunnels/ws?host=ID&slug=hello[&target=127.0.0.1:4757]
    // CLI opens one per tunnel it serves. Main wss (/api/agent/ws) stays
    // control (cf <-> cli talk: presence/decisions/pings).
    if (url.pathname === "/api/tunnels/ws") {
      const host = requireHost(url);
      const slug = normalizeSlug(url.searchParams.get("slug"));
      if (!host) return json({ error: "missing or invalid ?host=" }, 400);
      if (!isValidSlug(slug)) return json({ error: "missing or invalid ?slug= (want like /hello)" }, 400);
      if (!env.HOST_PRESENCE) return json({ error: "presence not configured" }, 500);
      const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return json({ error: "expected websocket upgrade" }, 426);
      }
      // Make sure visitors can resolve /<slug> even if the browser form
      // never POSTed: upsert the mapping from the CLI's own query params.
      if (env.TUNNEL_REGISTRY) {
        try {
          const target = (url.searchParams.get("target") || "").trim();
          const reg = registryStub(env);
          await reg.fetch(
            new Request("https://registry/register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                slug,
                host,
                target: target || "127.0.0.1:0",
                name: slug,
                tunnelType: "HTTP",
              }),
            }),
          );
        } catch {
          // registry touch is best-effort; the socket itself still works
        }
      }
      const stub = stubFor(env, host);
      const fwd = new Request(
        `https://presence/tunnel/ws?host=${encodeURIComponent(host)}&slug=${encodeURIComponent(slug)}`,
        request,
      );
      return stub.fetch(fwd);
    }

    // --- Tunnel registry (so visitors without localStorage can resolve /slug)
    // GET /api/tunnels -> { tunnels:[...] }
    // POST /api/tunnels {slug,host,target,name,tunnelType} -> upsert
    if (url.pathname === "/api/tunnels") {
      if (!env.TUNNEL_REGISTRY) return json({ error: "registry not configured" }, 500);
      const reg = registryStub(env);
      if (request.method === "GET") {
        return reg.fetch(new Request("https://registry/list", request));
      }
      if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
        let body = "";
        try {
          body = await request.text();
        } catch {
          body = "";
        }
        return reg.fetch(
          new Request("https://registry/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        );
      }
      return json({ error: "method not allowed" }, 405);
    }

    // GET /api/tunnels/:slug -> resolve | DELETE /api/tunnels/:slug -> remove
    {
      const m = url.pathname.match(/^\/api\/tunnels\/([A-Za-z0-9-]+)\/?$/);
      if (m) {
        if (!env.TUNNEL_REGISTRY) return json({ error: "registry not configured" }, 500);
        const reg = registryStub(env);
        const slug = normalizeSlug(m[1]);
        if (!isValidSlug(slug)) return json({ error: "invalid slug" }, 400);
        if (request.method === "GET") {
          return reg.fetch(`https://registry/resolve?slug=${encodeURIComponent(slug)}`);
        }
        if (request.method === "DELETE") {
          return reg.fetch(`https://registry/unregister?slug=${encodeURIComponent(slug)}`, {
            method: "DELETE",
          });
        }
        return json({ error: "method not allowed" }, 405);
      }
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

    // --- Public tunnel proxy: /<slug> shows the host's local port --------
    // FULLSCREEN: returns the upstream bytes verbatim (status+headers+body),
    // no KS Tunnel chrome — only the wss of that port (cli -> workers -> you).
    // e.g. tunnel { slug:"hello", target:"127.0.0.1:4757" } => GET /hello
    // proxies http://127.0.0.1:4757/ through the per-tunnel wss.
    if (
      env.TUNNEL_REGISTRY &&
      env.HOST_PRESENCE &&
      !url.pathname.startsWith("/api/") &&
      url.pathname !== "/!config" &&
      !url.pathname.startsWith("/!config/") &&
      url.pathname !== "/"
    ) {
      const segs = url.pathname.split("/").filter(Boolean);
      if (segs.length >= 1) {
        const maybeSlug = normalizeSlug(segs[0]);
        // Skip vite/dev + well-known + file-like paths unless registered.
        if (isValidSlug(maybeSlug)) {
          let entry: TunnelEntry | null = null;
          try {
            const reg = registryStub(env);
            const r = await reg.fetch(`https://registry/resolve?slug=${encodeURIComponent(maybeSlug)}`);
            if (r.ok) entry = (await r.json()) as TunnelEntry;
          } catch {
            entry = null;
          }
          if (entry && entry.host) {
            const rest = segs.length > 1 ? "/" + segs.slice(1).join("/") : "/";
            const targetPath = rest + url.search;
            // Read visitor body (if any) for POST/PUT/etc.
            let bodyBase64 = "";
            if (request.method !== "GET" && request.method !== "HEAD") {
              try {
                const buf = await request.arrayBuffer();
                if (buf.byteLength > 0) {
                  if (buf.byteLength > 10 * 1024 * 1024) {
                    return new Response("Request body too large (max 10MB).", { status: 413 });
                  }
                  bodyBase64 = uint8ToBase64(new Uint8Array(buf));
                }
              } catch {
                bodyBase64 = "";
              }
            }
            const fwdHeaders: Record<string, string> = {};
            try {
              request.headers.forEach((v, k) => {
                const lk = k.toLowerCase();
                if (lk === "host" || lk === "content-length" || lk === "connection" || lk === "transfer-encoding") return;
                if (lk.startsWith("cf-")) return;
                if (lk === "x-forwarded-for" || lk === "x-forwarded-proto" || lk === "x-real-ip") return;
                fwdHeaders[k] = v;
              });
            } catch {
              // ignore header copy errors
            }
            const reqId = crypto.randomUUID();
            let bridge: Response;
            try {
              const stub = stubFor(env, entry.host);
              bridge = await stub.fetch(
                `https://presence/tunnel/request?slug=${encodeURIComponent(entry.slug)}`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    id: reqId,
                    method: request.method,
                    path: targetPath,
                    headers: fwdHeaders,
                    bodyBase64,
                  }),
                },
              );
            } catch {
              return new Response(
                `Tunnel error — could not reach host ${entry.host}. Is the CLI running?\nrun: kstunnel --host ${entry.host} --tunnel ${entry.slug} --target ${entry.target}`,
                { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } },
              );
            }
            if (!bridge.ok) {
              const errData = (await bridge.json().catch(() => null)) as Record<string, unknown> | null;
              const msg =
                typeof errData?.["hint"] === "string"
                  ? (errData["hint"] as string)
                  : typeof errData?.["error"] === "string"
                    ? `${errData["error"]} (slug /${entry.slug})`
                    : `Tunnel unavailable (slug /${entry.slug}).`;
              const code = bridge.status === 504 ? 504 : 502;
              return new Response(
                `${msg}\nIs the CLI running? run: kstunnel --host ${entry.host} --tunnel ${entry.slug} --target ${entry.target}`,
                { status: code, headers: { "content-type": "text/plain; charset=utf-8" } },
              );
            }
            const payload = (await bridge.json().catch(() => null)) as {
              status?: number;
              headers?: Record<string, string>;
              bodyBase64?: string;
            } | null;
            if (!payload) return new Response("Tunnel error — bad gateway.", { status: 502 });
            const outHeaders = new Headers();
            for (const [k, v] of Object.entries(payload.headers ?? {})) {
              const lk = k.toLowerCase();
              if (lk === "content-length" || lk === "transfer-encoding" || lk === "connection") continue;
              try {
                outHeaders.set(k, String(v));
              } catch {
                // skip bad header
              }
            }
            // No KS wrapper headers — fullscreen upstream bytes only.
            outHeaders.delete("x-powered-by");
            const bodyBytes = payload.bodyBase64 ? base64ToUint8(payload.bodyBase64) : new Uint8Array(0);
            const status = typeof payload.status === "number" ? payload.status : 200;
            if (request.method === "HEAD" || status === 204 || status === 304) {
              return new Response(null, { status, headers: outHeaders });
            }
            return new Response(bodyBytes as unknown as BodyInit, { status, headers: outHeaders });
          }
          // Registered-slug miss: /<slug> exists as a name but nothing is
          // published for it. Without this explicit 404 the request falls
          // through to the SPA fallback (not_found_handling =
          // "single-page-application") and /<slug> confusingly renders the KS
          // web UI itself instead of the tunneled port. Only intercept
          // extensionless tunnel-like paths so real assets (/assets/*.js,
          // files with extensions) still serve normally.
          const lastSeg = segs[segs.length - 1] ?? "";
          const assetLike = segs[0] === "assets" || lastSeg.includes(".");
          if (!assetLike) {
            return new Response(
              `No tunnel published at /${maybeSlug}.\n` +
                `The Host "Connected" dot and the tunnel "Enabled" toggle alone do not expose a port.\n` +
                `1) Tunnels card must show Live + registry: published (not just Enabled).\n` +
                `2) Publish: re-save the tunnel in the UI, or POST /api/tunnels {"slug":"${maybeSlug}","host":"<id-from-Hosts>","target":"127.0.0.1:PORT"}.\n` +
                `3) Serve (keep running, one process per tunnel): kstunnel --host <id-from-Hosts> --tunnel ${maybeSlug} --target 127.0.0.1:PORT\n` +
                `Then reload /${maybeSlug} — it proxies that host's local port fullscreen via wss (cli -> workers -> you).`,
              { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } },
            );
          }
        }
      }
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
