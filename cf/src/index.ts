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
 *                                  presence + decision + register-tunnel).
 *                                  The worker also pushes
 *                                  {"type":"tunnel-spec","tunnels":[{slug,target}]}
 *                                  here whenever the user creates/edits/deletes
 *                                  a tunnel, so a CLI in host mode
 *                                  (`kstunnel --host ID`) auto-opens/closes
 *                                  per-tunnel data sockets — no per-tunnel CLI
 *                                  command needed. Current spec is re-sent to
 *                                  every new agent and served at
 *                                  GET /api/hosts/:id/tunnels/spec...
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
 *   GET /!tunnel=<slug>[/*]    -> FULLSCREEN tunnel proxy (canonical): returns the
 *                                  local http://<target>/<rest> bytes verbatim
 *                                  (status+headers+body, no KS wrapper) via the
 *                                  per-tunnel wss. e.g. /!tunnel=hello shows
 *                                  127.0.0.1:4757.
 *   GET /<slug> , /<slug>/*     -> same proxy (legacy form, kept working).
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

import {
  RATE_IP_LIMIT,
  RATE_IP_WINDOW_MS,
  RATE_MISS_LIMIT,
  RATE_MISS_WINDOW_MS,
  TOKEN_RE,
  checkLimit,
  clientIp,
  rateLimited,
  validToken as validTokenQ,
} from "./limit.js";

export interface Env {
  ASSETS: Fetcher;
  HOST_PRESENCE: DurableObjectNamespace;
  TUNNEL_REGISTRY: DurableObjectNamespace;
}

// Per-isolate fixed windows like ks-ssh-v2 (IP-wide + per-IP token-miss).
const ipHits: Map<string, { n: number; reset: number }> = new Map();
const tokenMiss: Map<string, { n: number; reset: number }> = new Map();

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

/** Canonical host key for DO idFromName — case-insensitive (lower) so
 *  tunnel's lower "abcde" and ssh's upper "ABCDE" pair in the same room,
 *  mirroring ks-ssh-v2's upper-casing. Display keeps original casing. */
function canonicalHost(host: string): string {
  return host.trim().toLowerCase();
}

function stubFor(env: Env, host: string): DurableObjectStub {
  const id = env.HOST_PRESENCE.idFromName(`host:${canonicalHost(host)}`);
  return env.HOST_PRESENCE.get(id);
}

function registryStub(env: Env): DurableObjectStub {
  const id = env.TUNNEL_REGISTRY.idFromName("tunnels:registry");
  return env.TUNNEL_REGISTRY.get(id);
}

function validToken(url: URL): string | null {
  // ks-ssh-v2 compat: ?token= is alias for ?host=, checked in that order.
  const raw = url.searchParams.get("token") ?? url.searchParams.get("host");
  const t = validTokenQ(raw);
  if (t) return t;
  // Fallback to raw host validation (lowercase 5-char ids).
  const host = raw?.trim() ?? "";
  return isValidHost(host) ? host : null;
}

function requireHost(url: URL): string | null {
  // Accept both ?host= (tunnel) and ?token= (ks-ssh-v2) for interop.
  const raw = url.searchParams.get("host") ?? url.searchParams.get("token");
  if (!raw) return null;
  const tok = validTokenQ(raw);
  if (tok) return raw.trim(); // preserve original casing for logging, DO uses canonical
  return isValidHost(raw) ? raw.trim() : null;
}

function pathToken(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).split("/")[0] ?? "";
  const t = rest.trim().toUpperCase();
  return TOKEN_RE.test(t) ? t : null;
}

/**
 * Push the desired-tunnel list for one host into its HostPresence DO, which
 * persists it and broadcasts {"type":"tunnel-spec",...} to agent sockets.
 * Called (best-effort) after every registry mutation so a CLI in host mode
 * (`kstunnel --host <id>`) opens/closes tunnel sockets as users
 * create/edit/delete tunnels in the web UI.
 */
async function pushTunnelSpec(env: Env, host: string): Promise<void> {
  const canon = canonicalHost(host);
  if (!isValidHost(canon) && !validTokenQ(canon)) return;
  try {
    const reg = registryStub(env);
    const r = await reg.fetch("https://registry/list");
    if (!r.ok) return;
    const data = (await r.json()) as { tunnels?: TunnelEntry[] };
    // Host compare is case-insensitive (tunnel uses lower, ssh uses upper).
    const want = canon.toLowerCase();
    const tunnels = (Array.isArray(data.tunnels) ? data.tunnels : [])
      .filter((e) => e && e.host && e.host.trim().toLowerCase() === want && isValidSlug(normalizeSlug(e.slug)))
      .map((e) => ({ slug: normalizeSlug(e.slug), target: (e.target ?? "").trim() }))
      .filter((e) => !!e.target);
    const stub = stubFor(env, host);
    await stub.fetch("https://presence/tunnels/spec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tunnels }),
    });
  } catch {
    // best-effort: the CLI also polls the registry every 30s as fallback
  }
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

/** Extract `/api/hosts/<id>/...` host segment — accepts both host and token forms. */
function hostFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/hosts\/([^/]+)\/(status|ws|decision|allow|deny|decline|cancel|tunnels)\/?$/);
  if (!m) return null;
  const raw = m[1];
  if (isValidHost(raw)) return raw;
  if (validTokenQ(raw)) return raw;
  return null;
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

/** One desired tunnel: the CLI must serve local target at public /slug. */
export type TunnelSpecEntry = {
  slug: string;
  target: string;
};

/** Worker -> CLI over the MAIN agent wss: "serve exactly these tunnels". */
type SpecMessage = {
  type: "tunnel-spec";
  host: string;
  tunnels: TunnelSpecEntry[];
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
  // Desired tunnels for host mode: what the CLI should serve right now.
  // Set by the worker entrypoint after every registry mutation (users
  // create/edit/delete in the web UI) and pushed to agent sockets.
  private desired: TunnelSpecEntry[] = [];
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
        const spec = await ctx.storage.get<TunnelSpecEntry[]>("desiredTunnels");
        if (Array.isArray(spec)) {
          const clean: TunnelSpecEntry[] = [];
          for (const e of spec.slice(0, 100)) {
            const slug = normalizeSlug(typeof e?.slug === "string" ? e.slug : "");
            const target = typeof e?.target === "string" ? e.target.trim() : "";
            if (isValidSlug(slug) && target) clean.push({ slug, target });
          }
          this.desired = clean;
        }
      } catch {
        // ignore
      }
    });
  }

  private hostFromRequest(request: Request): string {
    try {
      const url = new URL(request.url);
      // Accept both ?host= (tunnel) and ?token= (ssh compat)
      const q = url.searchParams.get("host") ?? url.searchParams.get("token");
      if (q && isValidHost(q)) return q;
      // Token form is also valid (5 or 9 upper)
      if (q && /^[A-Za-z0-9]{5}$|^[A-Za-z0-9]{9}$/.test(q.trim())) return q.trim();
      const m = url.pathname.match(/\/api\/hosts\/([^/]+)\//);
      if (m && (isValidHost(m[1]) || /^[A-Za-z0-9]{5}$|^[A-Za-z0-9]{9}$/.test(m[1]))) return m[1];
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

  private specMessage(host: string): SpecMessage {
    return {
      type: "tunnel-spec",
      host,
      tunnels: this.desired,
      timestamp: new Date().toISOString(),
    };
  }

  private broadcastSpec(host: string): void {
    const msg = JSON.stringify(this.specMessage(host));
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // dead socket — runtime will clean it up via close/error events
      }
    }
  }

  /** Store the desired tunnel list (from the registry) and push it to agents. */
  private async setDesired(host: string, tunnels: TunnelSpecEntry[]): Promise<void> {
    const clean: TunnelSpecEntry[] = [];
    const seen = new Set<string>();
    for (const t of tunnels.slice(0, 100)) {
      const slug = normalizeSlug(t.slug);
      const target = (t.target ?? "").trim();
      if (!isValidSlug(slug) || !target || seen.has(slug)) continue;
      seen.add(slug);
      clean.push({ slug, target });
    }
    this.desired = clean;
    try {
      await this.ctx.storage.put("desiredTunnels", clean);
    } catch {
      // ignore
    }
    this.broadcastSpec(host);
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

      // GET /tunnels/spec -> desired tunnels for host mode { host, tunnels }
      // POST /tunnels/spec {tunnels:[{slug,target}]} -> store + push to agents.
      // Called by the worker entrypoint after every registry mutation so a
      // CLI in host mode (`kstunnel --host <id>`) opens/closes tunnel sockets
      // as users create/edit/delete tunnels — no per-tunnel CLI needed.
      if (path === "/tunnels/spec" || path.endsWith("/tunnels/spec")) {
        if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
          let list: TunnelSpecEntry[];
          try {
            const body = (await request.json()) as { tunnels?: unknown };
            if (!Array.isArray(body?.tunnels)) return json({ error: "invalid tunnels (want [{slug,target}])" }, 400);
            list = (body.tunnels as Record<string, unknown>[]).map((e) => ({
              slug: typeof e?.["slug"] === "string" ? (e["slug"] as string) : "",
              target: typeof e?.["target"] === "string" ? (e["target"] as string) : "",
            }));
          } catch {
            return json({ error: "invalid json" }, 400);
          }
          await this.setDesired(host, list);
          return json({ ok: true, host, tunnels: this.desired });
        }
        return json({ host, tunnels: this.desired, timestamp: new Date().toISOString() });
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
      // Host-mode CLIs need the desired tunnels immediately: a CLI that
      // connects after the user already created tunnels still learns them.
      try {
        server.send(JSON.stringify(this.specMessage(wsHost)));
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
      // Host-mode CLI asks for the desired tunnels (pull, e.g. right after
      // connecting): answer it directly without broadcasting.
      if (obj && (obj["type"] === "get-tunnels" || obj["type"] === "sync-tunnels")) {
        try {
          ws.send(JSON.stringify(this.specMessage(this.host)));
        } catch {
          // ignore
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
        return json({ error: "invalid slug (want 2-32 chars: a-z, 0-9, hyphen, like hello)" }, 400);
      }
      // "assets" would shadow the frontend's /assets/* files on the legacy
      // /<slug> route — refuse it at publish time with a clear error.
      if (slug === "assets") {
        return json({ error: 'slug "assets" is reserved (it would shadow the web UI files)' }, 400);
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
// Tunnel status pages: when /<slug> can't be proxied, browsers get a
// self-refreshing loading page (facts + live log + auto-reload once the
// tunnel is up) instead of a bare error string. Non-HTML clients keep the
// plain-text errors. Every error response is no-store so it never goes
// stale in a cache and masks the real page later.
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wantsHtmlPage(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

async function presenceSnapshot(
  env: Env,
  host: string,
): Promise<{ online: boolean; agents: number; tunnels: string[] } | null> {
  try {
    const stub = stubFor(env, host);
    const r = await stub.fetch(`https://presence/status?host=${encodeURIComponent(host)}`);
    if (!r.ok) return null;
    const d = (await r.json()) as { online?: unknown; agents?: unknown; tunnels?: unknown };
    return {
      online: d.online === true,
      agents: typeof d.agents === "number" ? d.agents : 0,
      tunnels: Array.isArray(d.tunnels)
        ? (d.tunnels as unknown[]).filter((t): t is string => typeof t === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function tunnelStatusPage(opts: {
  status: number;
  heading: string;
  slug: string;
  /** Public path as visited, e.g. /!tunnel=ks (shown in title/kicker). */
  pathShown: string;
  intro: string;
  facts: string[];
  cliCmd: string;
  /** Host to poll for liveness; null polls the registry until the slug is published. */
  pollHost: string | null;
}): Response {
  const { status, heading, slug, pathShown, intro, facts, cliCmd, pollHost } = opts;
  const factsHtml = facts.map((f) => `<li>${escHtml(f)}</li>`).join("");
  const seedLog = facts.map((f) => `• ${f}`).join("\n");
  const pollJs = pollHost
    ? 'var url = "/api/hosts/" + encodeURIComponent(HOST) + "/status";\n' +
      "var check = async function () {\n" +
      "  n++;\n" +
      "  try {\n" +
      '    var r = await fetch(url, { cache: "no-store" });\n' +
      "    var d = await r.json();\n" +
      "    var live = Array.isArray(d.tunnels) ? d.tunnels : [];\n" +
      '    log("check #" + n + ": host online=" + d.online + " agents=" + d.agents + " live=[" + live.join(", ") + "]");\n' +
      "    if (live.indexOf(SLUG) !== -1) { log(\"tunnel is live — reloading…\"); setTimeout(function () { location.reload(); }, 800); return true; }\n" +
      "  } catch (e) { log(\"check #\" + n + \": status unreachable\"); }\n" +
      "  return false;\n" +
      "};"
    : 'var url = "/api/tunnels/" + encodeURIComponent(SLUG);\n' +
      "var check = async function () {\n" +
      "  n++;\n" +
      "  try {\n" +
      '    var r = await fetch(url, { cache: "no-store" });\n' +
      '    if (r.ok) { var d = await r.json(); log("check #" + n + ": /" + SLUG + " is published (host " + d.host + ") — reloading…"); setTimeout(function () { location.reload(); }, 800); return true; }\n' +
      '    log("check #" + n + ": still not published (HTTP " + r.status + ")");\n' +
      "  } catch (e) { log(\"check #\" + n + \": registry unreachable\"); }\n" +
      "  return false;\n" +
      "};";
  const html =
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escHtml(pathShown)} — ${escHtml(heading)} · KS Tunnel</title>\n` +
    "<style>\n" +
    ":root{--text:#0f1e2e;--muted:#64748b;--primary:#0ea45e;--primary-soft:rgba(16,185,129,0.10)}\n" +
    "body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:radial-gradient(900px 600px at 12% -10%, rgba(16,185,129,0.14), transparent 60%),radial-gradient(800px 500px at 88% 0%, rgba(52,211,153,0.12), transparent 58%),radial-gradient(700px 500px at 50% 110%, rgba(167,243,208,0.18), transparent 60%),linear-gradient(180deg,#ffffff 0%,#f7fdf9 45%,#eefcf3 100%);background-attachment:fixed;color:var(--text);margin:0;padding:32px 16px;min-height:100vh;-webkit-font-smoothing:antialiased}\n" +
    "main{max-width:680px;margin:0 auto;animation:enter .35s cubic-bezier(0.16,1,0.3,1)}\n" +
    "@keyframes enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}\n" +
    ".kicker{color:var(--muted);font-size:13px;font-weight:600;letter-spacing:0.01em}\n" +
    "code,.cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}\n" +
    ".cmd{background:rgba(255,255,255,0.84);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.82);box-shadow:0 1px 2px rgba(15,23,42,0.04),0 1px 0 rgba(255,255,255,0.7) inset;border-radius:10px;padding:12px;white-space:pre-wrap;font-size:13px;line-height:1.5;word-break:break-all}\n" +
    "ul{background:rgba(255,255,255,0.72);backdrop-filter:blur(14px) saturate(1.12);border:1px solid rgba(255,255,255,0.72);box-shadow:0 8px 32px rgba(15,23,42,0.06);border-radius:10px;padding:14px 14px 14px 32px}\n" +
    "#log{background:rgba(255,255,255,0.84);border:1px solid rgba(226,232,240,0.95);box-shadow:0 1px 2px rgba(15,23,42,0.03);border-radius:10px;padding:12px;height:220px;overflow-y:auto;white-space:pre-wrap;font-size:12px;line-height:1.6;color:var(--muted)}\n" +
    ".spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(16,185,129,0.18);border-top-color:var(--primary);border-radius:50%;animation:sp 1s linear infinite;vertical-align:-2px;margin-right:8px}\n" +
    "@keyframes sp{to{transform:rotate(360deg)}}\n" +
    ".muted{color:var(--muted)}\n" +
    "h1{font-size:21px;font-weight:800;letter-spacing:-0.03em;margin:8px 0 6px}\n" +
    "a{color:var(--primary);text-decoration:none}\n" +
    "a:hover{text-decoration:underline}\n" +
    "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    "<main>\n" +
    `<p class="kicker"><span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0f9d58;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.14);padding:3px 8px;border-radius:999px;margin-right:8px">KS Warrior</span>KS Tunnel · <code>${escHtml(pathShown)}</code></p>\n` +
    `<h1><span class="spin"></span>${escHtml(heading)}</h1>\n` +
    '<p class="muted">Waiting for the tunnel — this page reloads itself when it is live. Live log:</p>\n' +
    '<pre id="log"></pre>\n' +
    `<p>${escHtml(intro)}</p>\n` +
    `<ul>${factsHtml}</ul>\n` +
    "<p>Run on the host machine and keep it running:</p>\n" +
    `<pre class="cmd">${escHtml(cliCmd)}</pre>\n` +
    "</main>\n" +
    "<script>\n" +
    `var SLUG = ${JSON.stringify(slug)};\n` +
    `var HOST = ${JSON.stringify(pollHost ?? "")};\n` +
    "var n = 0;\n" +
    'var el = document.getElementById("log");\n' +
    `el.textContent = ${JSON.stringify(seedLog)} + "\\n";\n` +
    "function log(s) { var t = new Date().toLocaleTimeString(); el.textContent += \"[\" + t + \"] \" + s + \"\\n\"; el.scrollTop = el.scrollHeight; }\n" +
    `${pollJs}\n` +
    "(async function () {\n" +
    '  log("waiting for tunnel…");\n' +
    "  for (var i = 0; i < 240; i++) { if (await check()) return; await new Promise(function (r) { setTimeout(r, 2500); }); }\n" +
    '  log("stopped auto-checks — press Ctrl+Shift+R to retry manually.");\n' +
    "})();\n" +
    "</script>\n" +
    "</body>\n" +
    "</html>\n";
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 404 when /<slug> has nothing published: text for machines, log page for browsers. */
function tunnelNotPublishedResponse(request: Request, slug: string, pathShown?: string): Response {
  const shown = pathShown ?? `/${slug}`;
  const text =
    `No tunnel published at ${shown}.\n` +
    `The Host "Connected" dot and the tunnel "Enabled" toggle alone do not expose a port.\n` +
    `1) Tunnels card must show Live + registry: published (not just Enabled).\n` +
    `2) Publish: re-save the tunnel in the UI, or POST /api/tunnels {"slug":"${slug}","host":"<id-from-Hosts>","target":"127.0.0.1:PORT"}.\n` +
    `3) Serve: kstunnel --host <id-from-Hosts> (host mode, auto-serves) or kstunnel --host <id> --tunnel ${slug} --target 127.0.0.1:PORT (keep running).\n` +
    `Then reload ${shown} — it proxies that host's local port fullscreen via wss (cli -> workers -> you).`;
  if (!wantsHtmlPage(request)) {
    return new Response(text, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return tunnelStatusPage({
    status: 404,
    heading: "No tunnel published here yet",
    slug,
    pathShown: shown,
    intro: "Nothing is published at this path, so there is nothing to show yet. This page keeps checking and reloads itself once the tunnel is published and live.",
    facts: [
      `slug /${slug} is not in the worker registry`,
      "the Host Connected dot and the tunnel Enabled toggle alone do not expose a port",
      "publish: re-save the tunnel in the web UI (Tunnels must show registry: published)",
    ],
    cliCmd: `kstunnel --host <id-from-Hosts>   # host mode: auto-serves every published tunnel\n# or one tunnel: kstunnel --host <id> --tunnel ${slug} --target 127.0.0.1:PORT`,
    pollHost: null,
  });
}

/** 502/504 when /<slug> is published but no tunnel socket serves it. */async function tunnelOfflineResponse(
  request: Request,
  env: Env,
  entry: TunnelEntry,
  errText: string,
  code: number,
  pathShown?: string,
): Promise<Response> {
  const shown = pathShown ?? `/${entry.slug}`;
  const presence = await presenceSnapshot(env, entry.host);
  const live = presence?.tunnels ?? [];
  const cliCmd = `kstunnel --host ${entry.host} --tunnel ${entry.slug} --target ${entry.target}`;
  const facts = [
    `slug /${entry.slug} → target ${entry.target} (host ${entry.host})`,
    presence
      ? `host ${entry.host}: online=${presence.online} agents=${presence.agents} live tunnels=[${live.join(", ") || "none"}]`
      : `host ${entry.host}: presence unreachable`,
    `last error: ${errText}`,
  ];
  const text =
    `${errText} (slug /${entry.slug})\n` +
    `host ${entry.host}: ${presence ? `online=${presence.online} agents=${presence.agents} live=[${live.join(", ") || "none"}]` : "presence unreachable"}\n` +
    `Is the CLI running? run: ${cliCmd}\n` +
    `or host mode (auto-serves all tunnels): kstunnel --host ${entry.host}`;
  if (!wantsHtmlPage(request)) {
    return new Response(text, {
      status: code,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return tunnelStatusPage({
    status: code,
    heading: "Tunnel offline — waiting…",
    slug: entry.slug,
    pathShown: shown,
    intro: "The tunnel is published, but no live tunnel socket is serving it right now. This page keeps checking the host and reloads itself once the tunnel is live.",
    facts,
    cliCmd: `${cliCmd}\n# or host mode (auto-serves all tunnels):\nkstunnel --host ${entry.host}`,
    pollHost: entry.host,
  });
}

/** Loading wrapper for /!tunnel=<slug> — checks agent + port before showing port view. */
async function tunnelLoadingWrapperResponse(
  request: Request,
  env: Env,
  entry: TunnelEntry,
  pathShown?: string,
): Promise<Response> {
  const shown = pathShown ?? `/${entry.slug}`;
  const presence = await presenceSnapshot(env, entry.host);
  const live = presence?.tunnels ?? [];
  const facts = [
    `slug /${entry.slug} → target ${entry.target} (host ${entry.host})`,
    presence
      ? `host ${entry.host}: online=${presence.online} agents=${presence.agents} live tunnels=[${live.join(", ") || "none"}]`
      : `host ${entry.host}: checking…`,
    `checking agent and port before showing port view…`,
  ];
  const text = `Loading tunnel ${shown} — checking agent ${entry.host} and target ${entry.target}…`;
  if (!wantsHtmlPage(request)) {
    // Non-HTML clients (curl, fetch) get direct proxy — don't wrap.
    // Return null signal is not useful; caller should bypass wrapper.
    // We return a simple 200 text to indicate loading, but the caller
    // will handle direct proxy instead. This function is only called for HTML.
    return new Response(text, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const cliCmd = `kstunnel --host ${entry.host} --tunnel ${entry.slug} --target ${entry.target}`;
  const htmlFacts = facts.map((f) => `<li>${escHtml(f)}</li>`).join("");
  const seedLog = facts.map((f) => `• ${f}`).join("\n");
  // Build raw URL for the actual port view (bypass wrapper). Preserve
  // existing query + hash, append raw=1 so worker directly proxies.
  const html =
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escHtml(shown)} — Loading tunnel · KS Tunnel</title>\n` +
    "<style>\n" +
    ":root{--text:#0f1e2e;--muted:#64748b;--primary:#0ea45e;--primary-soft:rgba(16,185,129,0.10)}\n" +
    "body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:radial-gradient(900px 600px at 12% -10%, rgba(16,185,129,0.14), transparent 60%),radial-gradient(800px 500px at 88% 0%, rgba(52,211,153,0.12), transparent 58%),radial-gradient(700px 500px at 50% 110%, rgba(167,243,208,0.18), transparent 60%),linear-gradient(180deg,#ffffff 0%,#f7fdf9 45%,#eefcf3 100%);background-attachment:fixed;color:var(--text);margin:0;padding:32px 16px;min-height:100vh;-webkit-font-smoothing:antialiased}\n" +
    "main{max-width:680px;margin:0 auto;animation:enter .35s cubic-bezier(0.16,1,0.3,1)}\n" +
    "@keyframes enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}\n" +
    ".kicker{color:var(--muted);font-size:13px;font-weight:600;letter-spacing:0.01em}\n" +
    "code,.cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}\n" +
    ".cmd{background:rgba(255,255,255,0.84);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.82);box-shadow:0 1px 2px rgba(15,23,42,0.04),0 1px 0 rgba(255,255,255,0.7) inset;border-radius:10px;padding:12px;white-space:pre-wrap;font-size:13px;line-height:1.5;word-break:break-all}\n" +
    "ul{background:rgba(255,255,255,0.72);backdrop-filter:blur(14px) saturate(1.12);border:1px solid rgba(255,255,255,0.72);box-shadow:0 8px 32px rgba(15,23,42,0.06);border-radius:10px;padding:14px 14px 14px 32px}\n" +
    "#log{background:rgba(255,255,255,0.84);border:1px solid rgba(226,232,240,0.95);box-shadow:0 1px 2px rgba(15,23,42,0.03);border-radius:10px;padding:12px;height:220px;overflow-y:auto;white-space:pre-wrap;font-size:12px;line-height:1.6;color:var(--muted)}\n" +
    ".spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(16,185,129,0.18);border-top-color:var(--primary);border-radius:50%;animation:sp 1s linear infinite;vertical-align:-2px;margin-right:8px}\n" +
    "@keyframes sp{to{transform:rotate(360deg)}}\n" +
    ".muted{color:var(--muted)}\n" +
    "h1{font-size:21px;font-weight:800;letter-spacing:-0.03em;margin:8px 0 6px}\n" +
    "a{color:var(--primary);text-decoration:none}\n" +
    "a:hover{text-decoration:underline}\n" +
    "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    "<main>\n" +
    `<p class="kicker"><span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0f9d58;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.14);padding:3px 8px;border-radius:999px;margin-right:8px">KS Warrior</span>KS Tunnel · <code>${escHtml(shown)}</code> → <code>${escHtml(entry.target)}</code></p>\n` +
    `<h1><span class="spin"></span>Loading tunnel — checking agent and port…</h1>\n` +
    '<p class="muted">Live log (auto-checks every 2.5s, redirects to port view when ready):</p>\n' +
    '<pre id="log"></pre>\n' +
    `<p>Checking if host <code>${escHtml(entry.host)}</code> is online and tunnel <code>${escHtml(entry.slug)}</code> is live. This page verifies the agent and port, then shows the port view.</p>\n` +
    `<ul>${htmlFacts}</ul>\n` +
    `<p>CLI must be running:</p>\n` +
    `<pre class="cmd">${escHtml(cliCmd)}\n# or host mode: kstunnel --host ${escHtml(entry.host)}</pre>\n` +
    `<p class="muted">If this stays here, the tunnel is offline or not published. <a href="${escHtml(shown)}?raw=1">Skip check and show port directly (raw)</a> · <a href="javascript:location.reload()">Retry</a></p>\n` +
    "</main>\n" +
    "<script>\n" +
    `var SLUG = ${JSON.stringify(entry.slug)};\n` +
    `var HOST = ${JSON.stringify(entry.host)};\n` +
    `var TARGET = ${JSON.stringify(entry.target)};\n` +
    `var SHOWN = ${JSON.stringify(shown)};\n` +
    "var n = 0;\n" +
    'var el = document.getElementById("log");\n' +
    `el.textContent = ${JSON.stringify(seedLog)} + "\\n";\n` +
    "function log(s){ var t=new Date().toLocaleTimeString(); el.textContent += \"[\"+t+\"] \"+s+\"\\n\"; el.scrollTop=el.scrollHeight; }\n" +
    "function rawUrl(){ var u = new URL(window.location.href); if(u.searchParams.has('raw')) return u.toString(); u.searchParams.set('raw','1'); return u.toString(); }\n" +
    "var check = async function(){\n" +
    "  n++;\n" +
    "  try {\n" +
    '    var reg = await fetch("/api/tunnels/" + encodeURIComponent(SLUG), {cache:"no-store"}).then(function(r){ return r.json().catch(function(){ return null; }); });\n' +
    "    var published = !!(reg && reg.host);\n" +
    '    log("check #"+n+": registry "+(published ? "published host="+reg.host+" target="+reg.target : "not published")); \n' +
    "    if(!published){ log(\"waiting for publish — re-save tunnel in UI\"); return false; }\n" +
    '    var st = await fetch("/api/hosts/" + encodeURIComponent(HOST) + "/status", {cache:"no-store"}).then(function(r){ return r.json().catch(function(){ return null; }); });\n' +
    "    var online = !!(st && st.online);\n" +
    "    var live = st && Array.isArray(st.tunnels) ? st.tunnels : [];\n" +
    '    log("host "+HOST+" online="+online+" agents="+(st?st.agents:"?")+" live=["+live.join(", ")+"]");\n' +
    "    if(online && live.indexOf(SLUG) !== -1){ log(\"tunnel live — loading port view \"+TARGET+\"…\"); setTimeout(function(){ window.location.replace(rawUrl()); }, 800); return true; }\n" +
    '    log("tunnel not live yet — keep CLI running: kstunnel --host "+HOST+" --tunnel "+SLUG+" --target "+TARGET);\n' +
    "  } catch(e){ log(\"check #\"+n+\": error \"+(e&&e.message?e.message:e)); }\n" +
    "  return false;\n" +
    "};\n" +
    "(async function(){\n" +
    '  log("checking agent and port…");\n' +
    "  // First quick check, then poll\n" +
    "  if(await check()) return;\n" +
    "  for(var i=0;i<240;i++){ await new Promise(function(r){ setTimeout(r,2500); }); if(await check()) return; }\n" +
    '  log("stopped auto-checks — tunnel still offline. Keep CLI running and press Retry.");\n' +
    "})();\n" +
    "</script>\n" +
    "</body>\n" +
    "</html>\n";
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// Fallback Allow page: served for /!config?host=ID when the frontend assets
// binding is unavailable. Same job as the React ConfigHost page (show agent
// status, Allow/Cancel the host) in one self-contained file using only the
// JSON API, so onboarding never depends on the asset deployment.
// ---------------------------------------------------------------------------

function configFallbackPage(hostRaw: string): Response {
  const host = (hostRaw ?? "").trim();
  const valid = isValidHost(host);
  const html =
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>Allow this host? · KS Tunnel</title>\n" +
    "<style>\n" +
    ":root{--text:#0f1e2e;--muted:#64748b;--primary:#0ea45e;--danger:#dc2626}\n" +
    "body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:radial-gradient(900px 600px at 12% -10%, rgba(16,185,129,0.14), transparent 60%),radial-gradient(800px 500px at 88% 0%, rgba(52,211,153,0.12), transparent 58%),radial-gradient(700px 500px at 50% 110%, rgba(167,243,208,0.18), transparent 60%),linear-gradient(180deg,#ffffff 0%,#f7fdf9 45%,#eefcf3 100%);background-attachment:fixed;color:var(--text);margin:0;padding:32px 16px;min-height:100vh;-webkit-font-smoothing:antialiased}\n" +
    "main{max-width:560px;margin:0 auto}\n" +
    "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}\n" +
    ".card{background:rgba(255,255,255,0.72);backdrop-filter:blur(14px) saturate(1.12);border:1px solid rgba(255,255,255,0.72);box-shadow:0 8px 32px rgba(15,23,42,0.06);border-radius:14px;padding:20px;position:relative;overflow:hidden}\n" +
    ".card::before{content:\"\";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0.68) 0%,rgba(255,255,255,0.22) 100%);pointer-events:none}\n" +
    ".card>*{position:relative;z-index:1}\n" +
    ".row{display:flex;gap:10px;margin-top:14px}\n" +
    "button{flex:1;padding:10px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.82);background:rgba(255,255,255,0.84);backdrop-filter:blur(8px);box-shadow:0 1px 2px rgba(15,23,42,0.04);color:var(--text);cursor:pointer;font-size:15px;font-weight:650}\n" +
    "button.primary{background:linear-gradient(135deg, #0f9d58 0%, #10b981 55%, #34d399 100%);border-color:rgba(255,255,255,0.30);color:#fff;box-shadow:0 6px 18px rgba(16,185,129,0.28)}\n" +
    "button:disabled{opacity:.5;cursor:default}\n" +
    ".ok{color:#0ea45e}.err{color:var(--danger)}.muted{color:var(--muted)}\n" +
    "h1{font-size:21px;font-weight:800;letter-spacing:-0.03em}\n" +
    "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    "<main>\n" +
    "<h1>Allow this host?</h1>\n" +
    '<div class="card">\n' +
    `<p>Host <code>${escHtml(host || "(missing)")}</code> — <span id="st">checking…</span></p>\n` +
    '<p id="msg" class="muted">Your CLI asked to register a new host. Allow keeps the CLI alive — Cancel stops it.</p>\n' +
    '<div class="row"><button id="deny">Cancel</button><button id="allow" class="primary">Allow</button></div>\n' +
    "</div>\n" +
    "</main>\n" +
    "<script>\n" +
    `var HOST = ${JSON.stringify(host)};\n` +
    `var VALID = ${valid ? "true" : "false"};\n` +
    'var st = document.getElementById("st");\n' +
    'var msg = document.getElementById("msg");\n' +
    'var allowB = document.getElementById("allow");\n' +
    'var denyB = document.getElementById("deny");\n' +
    "function say(t, cls) { st.textContent = t; st.className = cls || \"\"; }\n" +
    "async function poll() {\n" +
    "  if (!VALID) { say(\"missing or invalid ?host=\", \"err\"); allowB.disabled = denyB.disabled = true; return; }\n" +
    "  try {\n" +
    '    var r = await fetch("/api/hosts/" + encodeURIComponent(HOST) + "/status", { cache: "no-store" });\n' +
    "    var d = await r.json();\n" +
    '    say((d.online ? "Agent online" : "Agent offline") + " · decision: " + d.decision, d.online ? "ok" : "err");\n' +
    "    if (d.decision === \"allowed\") { msg.textContent = \"Allowed — this host is saved. The CLI stays connected.\"; msg.className = \"ok\"; }\n" +
    "    else if (d.decision === \"denied\") { msg.textContent = \"Canceled — the CLI was told to stop.\"; msg.className = \"err\"; }\n" +
    "  } catch (e) { say(\"worker unreachable\", \"err\"); }\n" +
    "}\n" +
    "async function send(kind) {\n" +
    "  allowB.disabled = denyB.disabled = true;\n" +
    "  try {\n" +
    '    await fetch("/api/hosts/" + encodeURIComponent(HOST) + "/" + kind, { method: "POST" });\n' +
    "    await poll();\n" +
    "  } catch (e) { say(\"worker unreachable — retry\", \"err\"); }\n" +
    "  allowB.disabled = denyB.disabled = false;\n" +
    "}\n" +
    'allowB.onclick = function () { send("allow"); };\n' +
    'denyB.onclick = function () { send("deny"); };\n' +
    "poll(); setInterval(poll, 5000);\n" +
    "</script>\n" +
    "</body>\n" +
    "</html>\n";
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();

    // Canonicalize percent-encoded tunnel paths so the address bar stays clean:
    // /!tunnel=ks should stay /!tunnel=ks, not /!tunnel%3Dks or /%21tunnel%3Dks.
    // Some browsers/CDNs percent-encode "!" -> %21 and "=" -> %3D in the pathname.
    // The worker already accepts both via decodeURIComponent, but we redirect the
    // encoded form to the canonical decoded form (302) for GET navigations.
    // Skip websockets (Upgrade: websocket) and non-GET.
    if (request.method === "GET" && !(request.headers.get("Upgrade") || request.headers.get("upgrade"))) {
      const rawPath = url.pathname;
      if (rawPath.includes("%")) {
        try {
          const decoded = decodeURIComponent(rawPath);
          // After decoding, "/%21tunnel%3Dks" -> "/!tunnel=ks" which starts with "/!tunnel".
          if (decoded !== rawPath && decoded.toLowerCase().startsWith("/!tunnel")) {
            const target = decoded + url.search;
            return Response.redirect(url.origin + target, 302);
          }
        } catch {
          // ignore malformed percent sequences
        }
      }
    }

    // --- Global guard like ks-ssh-v2: per-IP budget + E2E fragment guard ----
    const ip = clientIp(request);
    const ipCheck = checkLimit(ipHits, ip, now, RATE_IP_LIMIT, RATE_IP_WINDOW_MS);
    if (!ipCheck.allowed) return rateLimited(ipCheck.retryAfter);

    // `k` must never be in query string — it lives only in fragment #k=...
    // Reject loudly like ks-ssh-v2 so a pasted full share link is not leaked.
    if (url.searchParams.has("k")) {
      return json(
        { ok: false, error: "E2E secret must stay in the URL fragment (#k=), never in query" },
        400,
      );
    }

    // --- ks-ssh-v2 compat aliases: WSS relay via /v1/agent and /v1/client ----
    // CLI: wss://<worker>/v1/agent?token=ABCDE   (ssh style)
    // Browser: wss://<worker>/v1/client?token=ABCDE
    // Both map to the same HostPresence DO (host == token) so a single
    // CLI<->CF<->user bridge works with either naming.
    if (url.pathname === "/v1/agent" || url.pathname === "/v1/client") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ ok: false, error: "expected websocket" }, 426);
      }
      const host = requireHost(url);
      if (!host) {
        const miss = checkLimit(tokenMiss, `miss:${ip}`, now, RATE_MISS_LIMIT, RATE_MISS_WINDOW_MS);
        if (!miss.allowed) return rateLimited(miss.retryAfter);
        return json({ ok: false, error: "bad token (want 5-9 letters/numbers, or 5-64 host id)" }, 400);
      }
      const role = url.pathname === "/v1/client" ? "watch" : "agent";
      const stub = stubFor(env, host);
      const relayUrl = new URL(request.url);
      relayUrl.searchParams.set("role", role);
      // Normalize to internal path the DO understands.
      const fwd = new Request(
        `https://presence/api/agent/ws?host=${encodeURIComponent(host)}&role=${role}`,
        request,
      );
      return stub.fetch(fwd);
    }

    // Fullscreen UI alias like ssh's /v/<TOKEN> -> same DO cache check.
    // In tunnel the React assets already serve /!config etc; this alias
    // just makes ssh-style share links (/v/ABCDE) return a helpful redirect.
    if (url.pathname === "/v" || url.pathname.startsWith("/v/")) {
      const token = pathToken(url.pathname + "/", "/v/");
      // Token-guess budgets apply like ssh.
      if (url.pathname !== "/v" && !token) {
        const miss = checkLimit(tokenMiss, `miss:${ip}`, now, RATE_MISS_LIMIT, RATE_MISS_WINDOW_MS);
        if (!miss.allowed) return rateLimited(miss.retryAfter);
        return json({ ok: false, error: "bad token (want /v/ABCDE; 5 or 9 letters/numbers)" }, 400);
      }
      // Known token -> redirect to canonical tunnel home with host param,
      // unknown token falls through to SPA (or 404 below) after budget.
      if (token) {
        return Response.redirect(`${url.origin}/!config?host=${encodeURIComponent(token)}`, 302);
      }
    }

    // Relay status compat: ssh clients poll /api/relay/<TOKEN>/status or
    // /api/ssh/status?token=ABCDE. Map them to /api/hosts/:id/status.
    if (url.pathname === "/api/ssh/status" || url.pathname === "/api/relay/status") {
      const host = requireHost(url);
      if (!host) {
        const miss = checkLimit(tokenMiss, `miss:${ip}`, now, RATE_MISS_LIMIT, RATE_MISS_WINDOW_MS);
        if (!miss.allowed) return rateLimited(miss.retryAfter);
        return json({ ok: false, error: "bad token (want 5-9 letters/numbers)" }, 400);
      }
      const stub = stubFor(env, host);
      const r = await stub.fetch(`https://presence/status?host=${encodeURIComponent(host)}`);
      const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return json({
        ok: true,
        agentOnline: (data["online"] as boolean) ?? false,
        hasUi: false,
        online: (data["online"] as boolean) ?? false,
        agents: (data["agents"] as number) ?? 0,
        host,
        tunnels: (data["tunnels"] as string[]) ?? [],
        decision: (data["decision"] as string) ?? "pending",
      });
    }
    if (url.pathname.startsWith("/api/relay/")) {
      const token = pathToken(url.pathname + "/", "/api/relay/");
      const tail = url.pathname.slice(("/api/relay/" + (token ?? "")).length);
      if (token && (tail === "/status" || tail === "" || tail === "/")) {
        const stub = stubFor(env, token);
        const r = await stub.fetch(`https://presence/status?host=${encodeURIComponent(token)}`);
        const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        return json({
          ok: true,
          agentOnline: (data["online"] as boolean) ?? false,
          hasUi: false,
          online: (data["online"] as boolean) ?? false,
          agents: (data["agents"] as number) ?? 0,
          host: token,
          tunnels: (data["tunnels"] as string[]) ?? [],
          decision: (data["decision"] as string) ?? "pending",
        });
      }
    }

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
    // WS wss://<worker>/api/agent/ws?host=<random>  (also ?token= compat)
    if (url.pathname === "/api/agent/ws") {
      const host = requireHost(url);
      if (!host) {
        const miss = checkLimit(tokenMiss, `miss:${ip}`, now, RATE_MISS_LIMIT, RATE_MISS_WINDOW_MS);
        if (!miss.allowed) return rateLimited(miss.retryAfter);
        return json({ error: "missing or invalid ?host= (or ?token=)" }, 400);
      }
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
    // GET  https://<worker>/api/hosts/<id>/tunnels/spec -> desired tunnels
    //        {host, tunnels:[{slug,target}]} (what a host-mode CLI should serve)
    {
      const specMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/tunnels\/spec\/?$/);
      if (specMatch && isValidHost(specMatch[1])) {
        if (!env.HOST_PRESENCE) return json({ error: "presence not configured" }, 500);
        const stub = stubFor(env, specMatch[1]);
        return stub.fetch(`https://presence/tunnels/spec?host=${encodeURIComponent(specMatch[1])}`);
      }
    }
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
      if (!isValidSlug(slug)) return json({ error: "missing or invalid ?slug= (want slug like hello)" }, 400);
      if (!env.HOST_PRESENCE) return json({ error: "presence not configured" }, 500);
      const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return json({ error: "expected websocket upgrade" }, 426);
      }
      // Make sure visitors can resolve /<slug> even if the browser form
      // never POSTed: upsert the mapping from the CLI's own query params.
      // Only touch the registry when the CLI sent a target — storing a bogus
      // "127.0.0.1:0" placeholder would make /<slug> hints lie about the port.
      if (env.TUNNEL_REGISTRY) {
        try {
          const target = (url.searchParams.get("target") || "").trim();
          if (target) {
            const reg = registryStub(env);
            await reg.fetch(
              new Request("https://registry/register", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  slug,
                  host,
                  target,
                  name: slug,
                  tunnelType: "HTTP",
                }),
              }),
            );
            // Refresh the host's desired spec so host-mode CLIs converge.
            await pushTunnelSpec(env, host);
          }
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
        const out = await reg.fetch(
          new Request("https://registry/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        );
        // A tunnel was created/edited: tell the host's CLI to open/update it.
        if (out.ok) {
          try {
            const parsed = JSON.parse(body) as { host?: unknown };
            if (typeof parsed?.host === "string") await pushTunnelSpec(env, parsed.host.trim());
          } catch {
            // ignore — CLI registry poll heals it within ~30s
          }
        }
        return out;
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
          // Learn the owning host first so its CLI can be told to close the socket.
          let host = "";
          try {
            const res = await reg.fetch(`https://registry/resolve?slug=${encodeURIComponent(slug)}`);
            if (res.ok) host = ((await res.json()) as TunnelEntry).host ?? "";
          } catch {
            host = "";
          }
          const out = await reg.fetch(`https://registry/unregister?slug=${encodeURIComponent(slug)}`, {
            method: "DELETE",
          });
          if (out.ok && host) await pushTunnelSpec(env, host);
          return out;
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

    // --- Public tunnel proxy: /!tunnel=<slug> shows the host's local port --
    // FULLSCREEN: returns the upstream bytes verbatim (status+headers+body),
    // no KS Tunnel chrome — only the wss of that port (cli -> workers -> you).
    // e.g. tunnel { slug:"hello", target:"127.0.0.1:4757" } => GET /!tunnel=hello
    // proxies http://127.0.0.1:4757/ through the per-tunnel wss.
    // Legacy /<slug> form proxies the same way (old links keep working).
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
        // Canonical public form: /!tunnel=<slug>[/...] — unambiguous, never
        // collides with the app or its assets, and never falls back to the
        // SPA. Legacy form /<slug>[/...] is still proxied (old links work).
        let maybeSlug = "";
        let rest = "/";
        let isNewForm = false;
        // Some clients/proxies percent-encode the `=` (legal): accept both
        // /!tunnel=ks and /!tunnel%3Dks by matching the decoded segment.
        // Slice the DECODED string — slicing the raw one would keep `%3D`.
        let firstDecoded = segs[0];
        try {
          firstDecoded = decodeURIComponent(segs[0]);
        } catch {
          // keep raw on malformed sequences
        }
        const firstLower = firstDecoded.toLowerCase();
        if (firstLower === "!tunnel" || firstLower.startsWith("!tunnel=")) {
          isNewForm = true;
          maybeSlug = normalizeSlug(firstLower.startsWith("!tunnel=") ? firstDecoded.slice(8) : "");
          rest = segs.length > 1 ? "/" + segs.slice(1).join("/") : "/";
          if (!isValidSlug(maybeSlug)) {
            const text =
              `invalid tunnel path ${JSON.stringify(url.pathname)} ` +
              `(want /!tunnel=<slug>[/...], slug 2-32 chars: a-z, 0-9, hyphen, like /!tunnel=hello)`;
            return new Response(text + "\n", {
              status: 404,
              headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
            });
          }
        } else {
          const cand = normalizeSlug(segs[0]);
          // Skip vite/dev + well-known + file-like paths unless registered.
          if (isValidSlug(cand)) {
            maybeSlug = cand;
            rest = segs.length > 1 ? "/" + segs.slice(1).join("/") : "/";
          }
        }
        // Public path shown on status pages (canonical form when used).
        const pathShown = isNewForm ? `/!tunnel=${maybeSlug}` : `/${maybeSlug}`;
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
            // Browser HTML gets a loading wrapper that verifies agent + port
            // before showing the port view (helps debug "home page not port").
            // The wrapper polls /api/tunnels/:slug and /api/hosts/:id/status
            // then redirects to ?raw=1 for the actual bytes. Non-HTML/curl
            // and ?raw=1 bypass the wrapper and proxy directly.
            if (isNewForm && wantsHtmlPage(request) && !url.searchParams.has("raw") && request.method === "GET") {
              return await tunnelLoadingWrapperResponse(request, env, entry, pathShown);
            }
            // Strip wrapper's ?raw=1 so upstream sees the real path.
            const rawSearch = new URLSearchParams(url.search);
            rawSearch.delete("raw");
            const cleanSearch = rawSearch.toString() ? "?" + rawSearch.toString() : "";
            const targetPath = rest + cleanSearch;
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
              return tunnelOfflineResponse(
                request,
                env,
                entry,
                `Tunnel error — could not reach host ${entry.host}. Is the CLI running?`,
                502,
                pathShown,
              );
            }
            if (!bridge.ok) {
              const errData = (await bridge.json().catch(() => null)) as Record<string, unknown> | null;
              const msg =
                typeof errData?.["hint"] === "string"
                  ? (errData["hint"] as string)
                  : typeof errData?.["error"] === "string"
                    ? (errData["error"] as string)
                    : "Tunnel unavailable";
              const code = bridge.status === 504 ? 504 : 502;
              return tunnelOfflineResponse(request, env, entry, msg, code, pathShown);
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
              // Strip CSP that would block our injected fetch interceptor (inline <script>)
              if (lk === "content-security-policy" || lk === "content-security-policy-report-only" || lk === "x-content-security-policy" || lk === "x-webkit-csp") continue;
              if (lk === "x-frame-options") continue;
              // Rewrite redirects so absolute Location like "/" or "http://127.0.0.1:7070/..." becomes "/!tunnel=slug/..."
              if (lk === "location" || lk === "content-location" || lk === "link") {
                let loc = String(v);
                const prefix = `/!tunnel=${entry.slug}`;
                try {
                  if (loc.startsWith("/")) {
                    if (!loc.startsWith(prefix) && !loc.startsWith("/!tunnel=") && !loc.startsWith("/!config") && !loc.startsWith("//")) {
                      loc = prefix + loc;
                    }
                  } else if (/^https?:\/\//i.test(loc)) {
                    try {
                      const u = new URL(loc);
                      // If Location points back to the local target (e.g. http://127.0.0.1:7070/foo) rewrite to tunnel path
                      const targetHost = entry.target.split("/")[0];
                      if (u.host === targetHost || loc.includes(targetHost)) {
                        loc = prefix + u.pathname + u.search + u.hash;
                      }
                    } catch {}
                  }
                } catch {}
                try { outHeaders.set(k, loc); } catch {}
                continue;
              }
              if (lk === "set-cookie") {
                // Scope cookie to tunnel path: Path=/ -> Path=/!tunnel=slug/
                let cookie = String(v);
                const prefix = `/!tunnel=${entry.slug}`;
                cookie = cookie.replace(/;\s*Path=\//gi, `; Path=${prefix}/`);
                // Multiple cookies may be comma-joined into one string — try to split and append separately
                try {
                  // Use append so multiple Set-Cookie headers survive (Headers.set would dedup)
                  outHeaders.append(k, cookie);
                } catch {
                  try { outHeaders.set(k, cookie); } catch {}
                }
                continue;
              }
              try {
                outHeaders.set(k, String(v));
              } catch {
                // skip bad header
              }
            }
            // No KS wrapper headers — fullscreen upstream bytes only.
            outHeaders.delete("x-powered-by");
            let bodyBytes = payload.bodyBase64 ? base64ToUint8(payload.bodyBase64) : new Uint8Array(0);
            const status = typeof payload.status === "number" ? payload.status : 200;
            if (request.method === "HEAD" || status === 204 || status === 304) {
              return new Response(null, { status, headers: outHeaders });
            }
            // HTML rewrites for tunnel: opencode (and many apps) serve index.html
            // with absolute URLs like <script src="/assets/index.js"> or fetch("/api/...").
            // Those would otherwise hit the Worker's /assets/* or /api/* instead of the
            // tunnel target. Inject a <base>-like fetch interceptor and rewrite attributes
            // so the proxied app loads through /!tunnel=<slug>/*.
            const ct = (payload.headers?.["content-type"] ?? payload.headers?.["Content-Type"] ?? "") as string;
            const isHtml = typeof ct === "string" && ct.toLowerCase().includes("text/html");
            const isCss = typeof ct === "string" && ct.toLowerCase().includes("text/css");
            const isJs = typeof ct === "string" && (ct.toLowerCase().includes("application/javascript") || ct.toLowerCase().includes("text/javascript") || ct.toLowerCase().includes("application/x-javascript"));
            const shouldRewriteHtml = isHtml && bodyBytes.length > 0 && status === 200 && request.method === "GET";
            const shouldRewriteCss = isCss && bodyBytes.length > 0 && status === 200 && request.method === "GET";
            // Rewrite CSS url() and @import references for tunnel (preserves quotes, supports all websites)
            if (shouldRewriteCss) {
              try {
                let css = new TextDecoder().decode(bodyBytes);
                const prefix = `/!tunnel=${entry.slug}`;
                if (!css.includes(prefix + "/")) {
                  // url("/assets/..." ) -> url("/!tunnel=slug/assets/..." ) preserving quote
                  css = css.replace(/url\(\s*(["']?)(\/(?!\/|!tunnel=|!config)[^"')]*)\1\s*\)/gi, (m, q, path) => `url(${q}${prefix}${path}${q})`);
                  // @import "/assets/..." and @import url(...)
                  css = css.replace(/@import\s+(["'])(\/(?!\/|!tunnel=|!config)[^"']+)\1/gi, (m, q, path) => `@import ${q}${prefix}${path}${q}`);
                  css = css.replace(/@import\s+url\(\s*(["']?)(\/(?!\/|!tunnel=|!config)[^"')]+)\1\s*\)/gi, (m, q, path) => `@import url(${q}${prefix}${path}${q})`);
                  bodyBytes = new TextEncoder().encode(css);
                  outHeaders.set("content-length", String(bodyBytes.length));
                }
              } catch {
                // ignore
              }
            }
            // JS rewriting is intentionally minimal for generic sites: the injected fetch/XHR/WS interceptor
            // handles dynamic absolute URLs at runtime (fetch("/api") -> /!tunnel=slug/api).
            // Static rewriting of JS files is fragile (breaks "/" , regex, JSON) and caused blank page for opencode
            // ("/" -> "/!tunnel=code/" broke routing). Only rewrite obvious asset imports for CSS injection, not generic.
            // Disabled for now — rely on interceptor + HTML/CSS rewriting for all websites.
            void isJs;
            if (shouldRewriteHtml) {
              try {
                let html = new TextDecoder().decode(bodyBytes);
                const prefix = `/!tunnel=${entry.slug}`;
                // Only rewrite if not already rewritten (avoid double prefix).
                if (!html.includes(prefix + "/")) {
                                                      const interceptor = String.raw`<script>(function(){const p="${prefix}";function _rw(u){if(typeof u!=="string")return u;if(u.startsWith(p)||u.startsWith("/!tunnel=")||u.startsWith("/!config")||u.startsWith("//")||u.startsWith("http://")||u.startsWith("https://")||u.startsWith("data:")||u.startsWith("blob:"))return u;if(u.startsWith("/"))return p+u;return u}function _rwAbs(u){if(typeof u!=="string")return u;try{const parsed=new URL(u,location.origin);if(parsed.origin!==location.origin)return u;if(parsed.pathname.startsWith(p)||parsed.pathname.startsWith("/!tunnel=")||parsed.pathname.startsWith("/!config"))return u;if(parsed.pathname.startsWith("/")){parsed.pathname=p+(parsed.pathname==="/"?"/":parsed.pathname);return parsed.toString()}}catch{if(u.startsWith("/")&&!u.startsWith(p))return p+u;}return u}const _fetch=window.fetch;window.fetch=function(i,init){if(typeof i==="string"){i=_rw(i)}else if(i instanceof Request){const url=i.url;try{const u=new URL(url,location.origin);if(u.origin===location.origin&&u.pathname.startsWith("/")&&!u.pathname.startsWith(p)){u.pathname=p+u.pathname;i=new Request(u.toString(),i)}}catch{}}return _fetch.call(this,i,init)};const _open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,url){if(typeof url==="string")url=_rw(url);return _open.apply(this,[m,url,...Array.prototype.slice.call(arguments,2)])};const _WS=window.WebSocket;window.WebSocket=function(url,protocols){if(typeof url==="string"){if(url.startsWith("/"))url=_rw(url);else{try{const u=new URL(url,location.href);if(u.pathname.startsWith("/")&&!u.pathname.startsWith(p))u.pathname=p+u.pathname,url=u.toString()}catch{}}}return protocols?new _WS(url,protocols):new _WS(url)};const _ES=new EventSource;window.EventSource=function(url,opts){if(typeof url==="string")url=_rw(url);return new _ES(url,opts)};try{const _ps=history.pushState;history.pushState=function(s,t,u){if(typeof u==="string")u=_rwAbs(u);return _ps.call(this,s,t,u)};const _rs=history.replaceState;history.replaceState=function(s,t,u){if(typeof u==="string")u=_rwAbs(u);return _rs.call(this,s,t,u)};}catch{};try{const _assign=Location.prototype.assign;Location.prototype.assign=function(u){return _assign.call(this,_rwAbs(u))};const _replace=Location.prototype.replace;Location.prototype.replace=function(u){return _replace.call(this,_rwAbs(u))};const d=Object.getOwnPropertyDescriptor(Location.prototype,"href");if(d&&d.set){Object.defineProperty(Location.prototype,"href",{get:function(){const v=d.get.call(this);try{const u=new URL(v);if(u.pathname===p||u.pathname===p+"/")return u.origin+"/";if(u.pathname.startsWith(p+"/")){u.pathname=u.pathname.slice(p.length)||"/";return u.toString()}}catch{}return v;},set:function(v){return d.set.call(this,_rwAbs(v))},configurable:true});}const d2=Object.getOwnPropertyDescriptor(Location.prototype,"pathname");if(d2&&d2.set){Object.defineProperty(Location.prototype,"pathname",{get:function(){const v=d2.get.call(this);if(v===p||v===p+"/")return "/";if(v.startsWith(p+"/"))return v.slice(p.length)||"/";return v;},set:function(v){if(typeof v==="string"&&v.startsWith("/")&&!v.startsWith(p))v=p+v;return d2.set.call(this,v)},configurable:true});}const d3=Object.getOwnPropertyDescriptor(Location.prototype,"search");if(d3&&d3.get){Object.defineProperty(Location.prototype,"search",{get:function(){const v=d3.get.call(this);try{const u=new URL(location.href);if((u.pathname===p||u.pathname===p+"/"||u.pathname.startsWith(p+"/"))&&u.searchParams.get("raw")==="1"){const ps=new URLSearchParams(u.search);ps.delete("raw");const s=ps.toString();return s?"?"+s:"";}}catch{}return v;},set:function(v){return d3.set.call(this,v)},configurable:true});}const _openWin=window.open;if(_openWin){window.open=function(u,n,f){if(typeof u==="string")u=_rwAbs(u);return _openWin.call(this,u,n,f)};}}catch{};try{if(location.pathname===p)history.replaceState(history.state,"",p+"/");}catch{};try{
  const _setAttr=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(n,v){
    if(typeof v==="string"&&(n==="href"||n==="src"||n==="action"||n==="cite"||n==="data"||n==="poster"||n==="background"||n==="formaction"||n==="srcset"||n==="imagesrcset"||n==="icon"||n==="manifest")){
      if(n==="srcset"||n==="imagesrcset"){
        v=v.split(",").map(function(s){s=s.trim();var sp=s.split(/\s+/);if(sp[0].startsWith("/")&&!sp[0].startsWith(p)&&!sp[0].startsWith("/!tunnel=")&&!sp[0].startsWith("/!config")&&!sp[0].startsWith("//"))sp[0]=p+sp[0];return sp.join(" ")}).join(", ");
      } else if(v.startsWith("/")&&!v.startsWith(p)&&!v.startsWith("/!tunnel=")&&!v.startsWith("/!config")&&!v.startsWith("//"))v=p+v;
    }
    return _setAttr.call(this,n,v);
  };
  new MutationObserver(function(muts){
    muts.forEach(function(m){
      m.addedNodes.forEach(function(n){
        if(n.nodeType!==1)return;
        function fix(el){
          var attrs=["href","src","action","cite","data","poster","background","formaction","icon","manifest"];
          attrs.forEach(function(a){
            if(el.hasAttribute&&el.hasAttribute(a)){
              var v=el.getAttribute(a);
              if(v&&v.startsWith("/")&&!v.startsWith(p)&&!v.startsWith("/!tunnel=")&&!v.startsWith("/!config")&&!v.startsWith("//"))el.setAttribute(a,p+v);
            }
          });
          if(el.hasAttribute&&el.hasAttribute("srcset")){
            var v=el.getAttribute("srcset");
            if(v){
              var nv=v.split(",").map(function(s){s=s.trim();var sp=s.split(/\s+/);if(sp[0].startsWith("/")&&!sp[0].startsWith(p))sp[0]=p+sp[0];return sp.join(" ")}).join(", ");
              el.setAttribute("srcset",nv);
            }
          }
          var st=el.getAttribute&&el.getAttribute("style");
          if(st&&st.includes("url(/")){
            el.setAttribute("style",st.replace(/url\(\s*(["']?)(\/(?!\/|!tunnel=|!config)[^"')]*)\1\s*\)/g,function(mm,q,path){return "url("+q+p+path+q+")"}));
          }
        }
        fix(n);
        if(n.querySelectorAll){
          try{
            n.querySelectorAll("[href^='/'],[src^='/'],[action^='/'],[cite^='/'],[data^='/']").forEach(fix);
          }catch(e){}
        }
      });
    });
  }).observe(document.documentElement,{childList:true,subtree:true});
}catch(e){}})();</script>`;
                  // Rewrite all URL attributes for generic website support: href, src, action, cite, data, poster, background, formaction, etc.
                  // Preserves original quote style and handles both quoted and unquoted absolute paths
                  html = html.replace(/\b(href|src|action|srcset|imagesrcset|cite|data|poster|background|formaction|icon|manifest|archive|codebase|classid|usemap|profile)\s*=\s*(["'])\/(?!\/|!tunnel=|!config)/gi, (m, attr, q) => `${attr}=${q}${prefix}/`);
                  html = html.replace(/\b(href|src|action|cite|data|poster|background|formaction)\s*=\s*\/(?!\/|!tunnel=|!config)([a-zA-Z0-9])/gi, (m, attr, first) => `${attr}="${prefix}/${first}`);
                  // srcset="/foo.png 1x, /bar.png 2x" -> srcset="/!tunnel=ks/foo.png ..."
                  html = html.replace(/srcset=(["'])([^"']+)\1/gi, (m: string, q: string, content: string) => {
                    let out2 = content;
                    out2 = out2.replace(/,\s*\//g, `, ${prefix}/`);
                    out2 = out2.replace(/(^|\s)\//g, (mm: string, p1: string) => `${p1}${prefix}/`);
                    // Remove double rewrite if already prefixed
                    out2 = out2.replace(new RegExp(prefix + "/" + prefix + "/", "g"), prefix + "/");
                    return `srcset=${q}${out2}${q}`;
                  });
                  // Rewrite url() in inline styles and <style> tags, preserving quotes
                  html = html.replace(/url\(\s*(["']?)(\/(?!\/|!tunnel=|!config)[^"')]*)\1\s*\)/gi, (m, q, path) => `url(${q}${prefix}${path}${q})`);
                  // Also handle @import in <style> blocks
                  html = html.replace(/@import\s+(["'])(\/(?!\/|!tunnel=|!config)[^"']+)\1/gi, (m, q, path) => `@import ${q}${prefix}${path}${q}`);
                  html = html.replace(/@import\s+url\(\s*(["']?)(\/(?!\/|!tunnel=|!config)[^"')]+)\1\s*\)/gi, (m, q, path) => `@import url(${q}${prefix}${path}${q})`);
                  if (html.includes("<head>")) {
                    html = html.replace("<head>", `<head>${interceptor}`);
                  } else if (/<head[^>]*>/i.test(html)) {
                    html = html.replace(/<head[^>]*>/i, (mm) => mm + interceptor);
                  } else {
                    html = interceptor + html;
                  }
                  bodyBytes = new TextEncoder().encode(html);
                  outHeaders.set("content-length", String(bodyBytes.length));
                  // Ensure correct content-type charset
                  if (!outHeaders.has("content-type")) outHeaders.set("content-type", "text/html; charset=utf-8");
                }
              } catch {
                // ignore rewrite errors — serve original
              }
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
          // Canonical /!tunnel= form never falls back to the SPA: nothing
          // under it is a real asset, so an unregistered slug 404s here.
          if (isNewForm) {
            return tunnelNotPublishedResponse(request, maybeSlug, pathShown);
          }
          const lastSeg = segs[segs.length - 1] ?? "";
          const assetLike = segs[0] === "assets" || lastSeg.includes(".");
          if (!assetLike) {
            return tunnelNotPublishedResponse(request, maybeSlug, pathShown);
          }
        }
      }
    }

    // Serve frontend static assets built by Vite into ./dist.
    // Works with wrangler.toml `[assets] directory = "./dist"`.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // No assets binding (partial deploy, or `vite dev` without assets).
    // The Allow flow must survive that: serve a self-contained Allow page
    // for /!config instead of a dead 404 — otherwise hosts can never be
    // approved and decisions stay "pending" forever.
    if (url.pathname === "/!config" || url.pathname.startsWith("/!config/")) {
      return configFallbackPage(url.searchParams.get("host") ?? "");
    }

    // Local fallback when assets binding is unavailable (e.g. `vite dev`).
    return new Response("Frontend assets not found. Run `npm run build` first.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
