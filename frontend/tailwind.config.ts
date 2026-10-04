import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#f5f6f8",
        panel: "#ffffff",
        line: "#e3e6ea",
        ink: { DEFAULT: "#1a1d21", soft: "#5a6470", mute: "#8b95a1" },
        brand: { DEFAULT: "#2563eb", dark: "#1d4ed8", soft: "#eff4ff" },
        ok: "#0f9d58",
        warn: "#b7791f",
        danger: "#d93025",
        purple: "#7c3aed",
      },
      borderRadius: { card: "10px", btn: "7px" },
      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.04)",
        pop: "0 16px 40px rgba(16,24,40,.16)",
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "Segoe UI", "PingFang SC", "Microsoft YaHei", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
