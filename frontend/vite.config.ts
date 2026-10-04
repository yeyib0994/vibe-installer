import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.SHIPDESK_API ?? "http://127.0.0.1:8848";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: { "/api": { target: API_TARGET, changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});
