/**
 * Backend (Cloudflare Worker) — Hello World
 *
 * Routes:
 *   GET /api/hello  -> { message: "Hello World from backend", ... }
 *   GET /api/health -> { ok: true }
 *   *               -> serves static frontend assets (dist/) with SPA fallback
 */

export interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/hello") {
      return Response.json({
        message: "Hello World from backend",
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
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
