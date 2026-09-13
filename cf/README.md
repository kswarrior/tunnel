# CF Hello World (Backend TS + Frontend TS + React)

Cloudflare Worker + Vite React frontend, deployable with Wrangler.

## Layout

- `src/index.ts` — backend Worker (`GET /api/hello`, `GET /api/health`, serves frontend assets)
- `client/` — frontend React + TS (`App.tsx`, `main.tsx`)
- `index.html` + `vite.config.ts` — Vite builds frontend into `./dist`
- `wrangler.toml` — `main = src/index.ts`, `[assets] directory = "./dist"`

## Your dashboard settings

- Root directory: `/cf/` (this folder)
- Build command: `None` — change to `npm install && npm run build` so Cloudflare builds the React app, or run `npm run build` locally before deploy
- Deploy command: `npx wrangler deploy`
- Build token: own-auth-app build token

If Build stays `None`, `npx wrangler deploy` deploys whatever is in `./dist`. Commit a fresh build or set a Build command.

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
