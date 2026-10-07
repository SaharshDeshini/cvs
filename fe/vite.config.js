import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server on Vite's default port: the backend's CORS allow-list expects http://localhost:5173.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  test: { environment: "node", include: ["src/**/*.test.js"] },
});
