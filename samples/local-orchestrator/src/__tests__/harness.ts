import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FSWatcher } from "chokidar";
import { loadConfig, type OrchestratorConfig } from "../config";
import { HandoffStore } from "../store";
import { ensureDirs, startWatcher, writeJsonAtomic } from "../handoff";
import { createApp } from "../server";
import type { Express } from "express";

export interface Harness {
  config: OrchestratorConfig;
  store: HandoffStore;
  app: Express;
  watcher: FSWatcher;
  cleanup: () => Promise<void>;
}

export async function makeHarness(env: Partial<NodeJS.ProcessEnv> = {}): Promise<Harness> {
  const handoffDir = path.join(os.tmpdir(), `orc-test-${randomUUID()}`);
  const config = loadConfig({ HANDOFF_DIR: handoffDir, PORT: "0", ...env } as NodeJS.ProcessEnv);
  const store = new HandoffStore();
  await ensureDirs(config);
  const watcher = await startWatcher(config, store);
  const app = createApp({ config, store, listeningSince: new Date().toISOString() });
  return {
    config,
    store,
    app,
    watcher,
    cleanup: async () => {
      await watcher.close();
      await fs.rm(handoffDir, { recursive: true, force: true });
    }
  };
}

/** Atomically write one of the legacy app's out\ files, like claims.exe does. */
export async function writeOut(
  config: OrchestratorConfig,
  kind: "ready" | "result" | "error",
  doc: unknown
): Promise<void> {
  const target =
    kind === "ready" ? config.readyPath : kind === "result" ? config.resultPath : config.errorPath;
  await writeJsonAtomic(target, doc);
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4000,
  intervalMs = 25
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

export const sampleCallContext = {
  request_id: "REQ-2024-0042",
  caller_phone: "(555) 123-4567",
  policy_number: "POL-2024-008341",
  intent: "auto_collision",
  summary: "Rear-ended at intersection of 5th and Main, no injuries reported.",
  transcript_excerpt: "Caller: ...a Honda Civic rear-ended me. No one was hurt.",
  requested_by: {
    agent_id: "csr-acarter",
    display_name: "A. Carter",
    email: "acarter@zavamutual.demo"
  },
  timestamp: "2024-04-15T18:32:11Z"
} as const;
