import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111827",
        mist: "#f7f7f8",
        line: "#e5e7eb",
        accent: "#0a84ff",
        success: "#16a34a",
        warning: "#d97706",
        danger: "#dc2626"
      },
      boxShadow: {
        panel: "0 18px 50px rgba(15, 23, 42, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;

