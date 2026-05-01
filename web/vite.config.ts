import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The web UI builds into ../dist-web at the repo root, which is then
 * shipped inside the npm package and served by `recallr serve`.
 *
 * `base` is "" so all asset urls in the built index.html are relative
 * — important because we serve the same file at any port the user picks.
 */
export default defineConfig({
  root: resolve(__dirname),
  base: "",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "..", "dist-web"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7474",
    },
  },
});
