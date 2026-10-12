import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server on Vite's default port: the backend's CORS allow-list expects http://localhost:5173.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // Node cannot load the Vite entry's `.wasm?url` import, so tests use the package's Node entry instead.
  test: { environment: "node", include: ["src/**/*.test.js"], alias: { "@wasm-fmt/clang-format/vite": "@wasm-fmt/clang-format/node" } },
});
