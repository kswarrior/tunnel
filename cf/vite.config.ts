import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Frontend (React + TS) builds into ./dist, served by the Worker via [assets].
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Lets `npm run dev` talk to `wrangler dev` backend on :8787.
      "/api": "http://127.0.0.1:8787",
    },
  },
});
