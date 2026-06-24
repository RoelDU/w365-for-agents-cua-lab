import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@schemas": path.resolve(__dirname, "../../schemas")
    }
  },
  // Explicit cache dir inside node_modules avoids OneDrive sync contention on Windows.
  cacheDir: "node_modules/.vite",
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      // Limit parallel file reads to prevent hangs on Windows/OneDrive/Node 24
      // where concurrent fs operations can stall indefinitely (#123, #127).
      maxParallelFileOps: 4,
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          radix: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-tooltip",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-tabs",
            "@radix-ui/react-separator",
            "@radix-ui/react-toast",
            "@radix-ui/react-slot"
          ],
          msal: ["@azure/msal-browser", "@azure/msal-react"]
        }
      }
    }
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    css: false,
    // Use forks pool (child processes) instead of threads (worker_threads) to avoid
    // Node 24 fs.readFileSync UNKNOWN error in worker_threads (node:fs:737).
    pool: "forks",
    // The SWA managed API (api/) has its own node:test suite; keep it out of vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "api/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"]
    }
  }
});
