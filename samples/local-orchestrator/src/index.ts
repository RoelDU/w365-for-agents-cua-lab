import { loadConfig } from "./config";
import { HandoffStore } from "./store";
import { ensureDirs, reconcile, startWatcher } from "./handoff";
import { createApp } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new HandoffStore();

  await ensureDirs(config);
  // Recover any out\ files left behind by a previous run before we start.
  await reconcile(config, store);
  const watcher = await startWatcher(config, store);

  const app = createApp({ config, store, listeningSince: new Date().toISOString() });

  const server = app.listen(config.port, () => {
    console.log(`Orchestrator listening on http://localhost:${config.port}`);
    console.log(`[orchestrator] handoff dir: ${config.handoffDir}`);
    console.log(
      `[orchestrator] CORS: ${
        config.allowedOrigins === "*" ? "any origin" : config.allowedOrigins.join(", ")
      }`
    );
  });

  const shutdown = () => {
    console.log("\n[orchestrator] shutting down...");
    void watcher.close();
    server.close(() => process.exit(0));
    // Force-exit if connections (e.g. open SSE streams) keep the server alive.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[orchestrator] fatal:", err);
  process.exit(1);
});
