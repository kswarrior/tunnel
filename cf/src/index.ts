/**
 * Backend (Cloudflare Worker) — KS Tunnel
 *
 * Routes:
 *   GET /api/hello              -> { message: "KS Tunnel online", ... }
 *   GET /api/health             -> { ok: true }
 *   GET /api/hosts/:id/status   -> { host, online, agents, timestamp }
 *   WS  /api/agent/ws?host=ID   -> CLI agent socket (role=agent)
 *   WS  /api/hosts/:id/ws       -> browser watcher socket (role=watch)
 *   WS  /api/ws?host=ID&role=.. -> generic alias for the two above
 *   *                           -> serves static frontend assets (dist/) with SPA fallback
 *
 * Presence is tracked by the HostPresence Durable Object (one instance per
 * host id, via idFromName("host:"+id)). Agents = CLI connections, watchers =
 * browser tabs. Online = at least one agent socket is open.
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
  const m = pathname.match(/^\/api\/hosts\/([^/]+)\/(status|ws)\/?$/);
  if (!m) return null;
  return isValidHost(m[1]) ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Durable Object: presence registry for a single host id.
// ---------------------------------------------------------------------------

type PresenceMessage = {
  type: "presence";
  host: string;
  online: boolean;
  agents: number;
  timestamp: string;
};

export class HostPresence implements DurableObject {
  private ctx: DurableObjectState;
  private host: string = "unknown";

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
    // Restore host label after hibernation-eviction wakeups (best effort).
    ctx.blockConcurrencyWhile(async () => {
      try {
        const stored = await ctx.storage.get<string>("host");
        if (typeof stored === "string" && stored) this.host = stored;
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

      const host = this.hostFromRequest(request);
      // Immediately tell the newcomer (and everyone else) the current state.
      try {
        server.send(JSON.stringify(this.snapshot(host)));
      } catch {
        // ignore send race
      }
      if (tag === "agent") this.broadcast(host);

      return new Response(null, { status: 101, webSocket: client });
    }

    // --- HTTP status -------------------------------------------------------
    const host = this.hostFromRequest(request);
    return json(this.snapshot(host === "unknown" ? (url.searchParams.get("host") ?? "unknown") : host));
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

    // --- Browser watcher socket / HTTP status -------------------------------
    // WS  wss://<worker>/api/hosts/<id>/ws
    // GET https://<worker>/api/hosts/<id>/status
    if (url.pathname.startsWith("/api/hosts/")) {
      const host = hostFromPath(url.pathname);
      if (!host) return json({ error: "invalid host id" }, 400);
      if (!env.HOST_PRESENCE) return json({ error: "presence not configured" }, 500);
      const stub = stubFor(env, host);
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
      if (url.pathname.endsWith("/status")) {
        const res = await stub.fetch(
          `https://presence/status?host=${encodeURIComponent(host)}`,
        );
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        return json({
          host,
          online: (data?.["online"] as boolean) ?? false,
          agents: (data?.["agents"] as number) ?? 0,
          timestamp: (data?.["timestamp"] as string) ?? new Date().toISOString(),
        });
      }
      return json({ error: "not found" }, 404);
    }

    // --- Generic alias -------------------------------------------------------
    // WS /api/ws?host=ID&role=agent|watch | GET /api/ws?host=ID (status)
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
      const res = await stub.fetch(`https://presence/status?host=${encodeURIComponent(host)}`);
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return json({
        host,
        online: (data?.["online"] as boolean) ?? false,
        agents: (data?.["agents"] as number) ?? 0,
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
