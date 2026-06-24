import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import type { RunnerConfig } from "./config";
import { validatePrefill, validateReady, validateResult, validateError, formatErrors } from "./schemas";
import type { Prefill, ReadyMessage, ResultMessage, ErrorMessage, ReadySignal, DriveOutcome } from "./types";

export async function ensureDirs(config: RunnerConfig): Promise<void> {
  await fs.mkdir(config.inDir, { recursive: true });
  await fs.mkdir(config.outDir, { recursive: true });
}

/** Atomically write JSON: write a unique .tmp then rename into place. */
export async function writeJsonAtomic(targetPath: string, data: unknown): Promise<void> {
  const tmp = `${targetPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, targetPath);
}

async function readJsonWithRetry(filePath: string, attempts = 5): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      if (raw.trim().length === 0) throw new Error("empty file");
      return JSON.parse(raw);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  throw lastErr;
}

/** Read and validate the captured CCaaS outcome (in\prefill.json). */
export async function readPrefill(config: RunnerConfig): Promise<Prefill | null> {
  let doc: unknown;
  try {
    doc = await readJsonWithRetry(config.prefillPath);
  } catch {
    return null;
  }
  if (!validatePrefill(doc)) {
    console.error(`[runner] in\\prefill.json failed schema: ${formatErrors(validatePrefill)}`);
    return null;
  }
  return doc as Prefill;
}

/** Remove a previous cycle's out files so a fresh handoff starts clean. */
export async function clearOutFiles(config: RunnerConfig): Promise<void> {
  await Promise.all(
    [config.readyPath, config.resultPath, config.errorPath].map((p) =>
      fs.rm(p, { force: true }).catch(() => undefined)
    )
  );
}

export async function writeReady(config: RunnerConfig, requestId: string, ready: ReadySignal): Promise<void> {
  const msg: ReadyMessage = {
    request_id: requestId,
    status: "ready",
    window_title: ready.window_title,
    matched_policy_number: ready.matched_policy_number ?? null,
    matched_customer_name: ready.matched_customer_name ?? null,
    timestamp: new Date().toISOString()
  };
  if (!validateReady(msg)) throw new Error(`ready.json invalid: ${formatErrors(validateReady)}`);
  await writeJsonAtomic(config.readyPath, msg);
}

export async function writeOutcome(config: RunnerConfig, requestId: string, outcome: DriveOutcome): Promise<void> {
  if (outcome.kind === "result") {
    const msg: ResultMessage = {
      request_id: requestId,
      status: "submitted",
      claim_id: outcome.claim_id,
      ...(outcome.policy_number ? { policy_number: outcome.policy_number } : {}),
      agent_id: outcome.agent_id,
      reserve_amount: outcome.reserve_amount ?? null,
      timestamp: new Date().toISOString()
    };
    if (!validateResult(msg)) throw new Error(`result.json invalid: ${formatErrors(validateResult)}`);
    await writeJsonAtomic(config.resultPath, msg);
    return;
  }
  const msg: ErrorMessage = {
    request_id: requestId,
    status: "error",
    error_code: outcome.error_code,
    message: outcome.message,
    timestamp: new Date().toISOString()
  };
  if (!validateError(msg)) throw new Error(`error.json invalid: ${formatErrors(validateError)}`);
  await writeJsonAtomic(config.errorPath, msg);
}

/**
 * Watch in\ for prefill.json (the captured CCaaS outcome). Calls onPrefill once
 * per new/changed prefill. Resolves once the watcher is ready.
 */
export async function startPrefillWatcher(
  config: RunnerConfig,
  onPrefill: (prefill: Prefill) => void
): Promise<FSWatcher> {
  const watcher = chokidar.watch(config.inDir, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 }
  });

  const onChange = async (filePath: string) => {
    if (path.resolve(filePath) !== path.resolve(config.prefillPath)) return;
    const prefill = await readPrefill(config);
    if (prefill) onPrefill(prefill);
  };
  watcher.on("add", (p) => void onChange(p));
  watcher.on("change", (p) => void onChange(p));
  watcher.on("error", (err) => console.error("[runner] watcher error:", err));

  await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  return watcher;
}
