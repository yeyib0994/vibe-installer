import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// vitest 2.x ships its own vite 5 types; the cast bridges @vitejs/plugin-react's
// vite 6 Plugin type to vitest's bundled vite 5 PluginOption. Runtime is unaffected.
export default defineConfig({
  plugins: [react() as never],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
