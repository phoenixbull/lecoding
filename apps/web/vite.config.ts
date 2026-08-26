import { defineConfig } from "vite";

/** Development uses the same relative API URLs as the production same-origin build. */
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
