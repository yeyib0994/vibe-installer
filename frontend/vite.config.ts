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
  // 生产构建不投 sourcemap：容器只送 nginx 静态目录，带 .map 等于把源码原样公开。
  build: { outDir: "dist" },
});
