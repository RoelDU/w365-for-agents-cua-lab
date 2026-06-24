import type { FSWatcher } from "chokidar";
import { loadConfig, validateForLive } from "./config";
import { ensureDirs, readPrefill, startPrefillWatcher } from "./handoff";
import { createDriver } from "./runner";
import { HandoffProcessor } from "./processor";

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const config = loadConfig();

  if (config.mode === "live") {
    const problems = validateForLive(config);
    if (problems.length > 0) {
      console.error("[runner] live mode is missing configuration:");
      for (const p of problems) console.error(`  - ${p}`);
      console.error("[runner] set the variables (see .env.example) or run in simulation mode (RUNNER_MODE=simulation).");
      process.exit(1);
    }
  }

  await ensureDirs(config);
  const driver = createDriver(config);
  const processor = new HandoffProcessor(config, driver);

  console.log(`[runner] mode: ${config.mode}`);
  console.log(`[runner] backend id: ${config.backendId} (ignores handoffs addressed to another backend)`);
  console.log(`[runner] watching: ${config.prefillPath}`);
  if (config.mode === "live") {
    console.log(`[runner] foundry: ${config.foundry.endpoint} (model ${config.foundry.model})`);
    console.log(`[runner] w365a  : ${config.w365a.baseUrl} (pool ${config.w365a.poolId})`);
  }

  // Process any handoff already waiting (boot/restart recovery, and --once).
  const existing = await readPrefill(config);
  if (existing) await processor.process(existing);

  if (once) {
    return;
  }

  const watcher: FSWatcher = await startPrefillWatcher(config, (prefill) => void processor.process(prefill));
  console.log("[runner] ready. Waiting for handoffs. Press Ctrl+C to stop.");

  const shutdown = async () => {
    console.log("\n[runner] shutting down...");
    await watcher.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exit(1);
});
