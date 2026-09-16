import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Frontend (React + TS) builds into ./dist, served by the Worker via [assets].
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: true,
    cssMinify: "esbuild",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
        },
      },
    },
  },
  esbuild: {
    drop: ["console", "debugger"],
    legalComments: "none",
  },
  optimizeDeps: {
    include: ["react", "react-dom"],
  },
  server: {
    port: 8080,
    proxy: {
      // Lets `npm run dev` talk to `wrangler dev` backend on :8787.
      "/api": "http://127.0.0.1:8787",
    },
  },
  preview: {
    port: 8080,
    strictPort: true,
  },
});
