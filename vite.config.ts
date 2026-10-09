import { defineConfig } from "vite";
export default defineConfig({
  server: { port: 18297, proxy: { "/api": "http://127.0.0.1:18296" } },
  build: { outDir: "dist", emptyOutDir: true },
});
