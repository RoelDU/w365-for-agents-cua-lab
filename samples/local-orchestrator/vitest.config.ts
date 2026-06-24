import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use forks pool (child processes) instead of threads (worker_threads) to avoid
    // Node 24 fs.readFileSync UNKNOWN error in worker_threads (#133, same as #120).
    pool: "forks"
  }
});
