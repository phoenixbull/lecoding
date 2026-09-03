import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Renderer bundle for the packaged Electron app.
 *
 * `base: "./"` is mandatory: the main process loads the Renderer through
 * `file://`, where absolute `/assets/...` URLs cannot resolve. Output lands in
 * `apps/desktop/dist/renderer` because `forge.config.ts` points the packaged
 * entry at `dist/renderer/index.html`.
 *
 * Vite 7 is used deliberately — `apps/web` already pins it, and a second major
 * version in a hoisted pnpm workspace would collide at the root.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, "src", "renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist", "renderer"),
    emptyOutDir: true,
    // Source maps would ship readable Renderer internals inside the asar.
    sourcemap: false
  }
});
