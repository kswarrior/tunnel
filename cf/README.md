# CF Hello World (Backend TS + Frontend TS + React)

Cloudflare Worker + Vite React frontend, deployable with Wrangler.

## Layout

- `src/index.ts` — backend Worker (`GET /api/hello`, `GET /api/health`, serves frontend assets)
- `client/` — frontend React + TS (`App.tsx`, `main.tsx`)
- `index.html` + `vite.config.ts` — Vite builds frontend into `./dist`
- `wrangler.toml` — `main = src/index.ts`, `[assets] directory = "./dist"`

## Your dashboard settings

- Root directory: `/cf/` (this folder)
- Build command: `None` (Cloudflare already runs `npm clean-install`, and
  `wrangler.toml` `[build] command = "npm run build"` makes
  `npx wrangler deploy` build `./dist` automatically).
  Alternatively, set Build command to `npm run build` explicitly.
- Deploy command: `npx wrangler deploy`
- Build token: own-auth-app build token

`npx wrangler deploy` now builds `./dist` via the `[build]` step, so the
`assets.directory does not exist: .../cf/dist` error is gone.

## Local dev

```bash
cd cf
npm install
npm run dev          # frontend only (http://localhost:5173, /api proxied to :8787)
npm run dev:worker   # full worker + assets (run `npm run build` first)
```

## Build + deploy

```bash
cd cf
npm install
npm run build
npx wrangler deploy
```
