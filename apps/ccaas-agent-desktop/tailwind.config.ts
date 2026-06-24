import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Genesys-inspired dark palette
        bg: {
          900: "#0b1220",
          800: "#0f172a",
          700: "#152033",
          600: "#1e293b",
          500: "#27334a"
        },
        accent: {
          50: "#ccfbf1",
          400: "#2dd4bf",
          500: "#14b8a6",
          600: "#0d9488",
          700: "#0f766e"
        },
        warn: {
          400: "#fb923c",
          500: "#f97316",
          600: "#ea580c"
        },
        ok: {
          500: "#22c55e"
        },
        danger: {
          500: "#ef4444"
        },
        muted: {
          400: "#94a3b8",
          500: "#64748b"
        },
        border: "rgba(255,255,255,0.06)"
      },
      fontFamily: {
        sans: [
          "Inter",
          "Segoe UI",
          "-apple-system",
          "BlinkMacSystemFont",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif"
        ],
        mono: [
          "JetBrains Mono",
          "Cascadia Code",
          "Consolas",
          "Menlo",
          "monospace"
        ]
      },
      fontSize: {
        xxs: ["10px", "14px"]
      },
      boxShadow: {
        panel: "0 1px 0 rgba(255,255,255,0.04), 0 8px 24px rgba(0,0,0,0.35)"
      },
      keyframes: {
        pulseDot: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" }
        },
        slideIn: {
          from: { transform: "translateY(-8px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" }
        }
      },
      animation: {
        "pulse-dot": "pulseDot 1.6s ease-in-out infinite",
        "slide-in": "slideIn 180ms ease-out"
      }
    }
  },
  plugins: []
};

export default config;
