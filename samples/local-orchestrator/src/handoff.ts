import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import type { OrchestratorConfig } from "./config";
import { HandoffStore } from "./store";
import {
  validateReady,
  validateResult,
  validateError,
  formatErrors
} from "./schemas";
import type {
  CallContext,
  Prefill,
  ReadyMessage,
  ResultMessage,
  ErrorMessage,
  HandoffStatusPayload
} from "./types";

/** Project a CallContext into the Prefill the legacy app reads. */
export function derivePrefill(ctx: CallContext): Prefill {
  return {
    request_id: ctx.request_id,
    caller_phone: ctx.caller_phone,
    policy_number: ctx.policy_number ?? null,
    intent: ctx.intent,
    summary: ctx.summary,
    requested_by: `ccaas-desktop:${ctx.requested_by.agent_id}`,
    // Carry the presenter's backend selection through to the file-drop so the runner
    // only acts on handoffs addressed to it (prevents two agents driving the Cloud PC).
    ...(ctx.target_backend ? { target_backend: ctx.target_backend } : {})
  };
}

export async function ensureDirs(config: OrchestratorConfig): Promise<void> {
  await fs.mkdir(config.inDir, { recursive: true });
  await fs.mkdir(config.outDir, { recursive: true });
}

/** Atomically write JSON: write a unique .tmp then rename into place. */
export async function writeJsonAtomic(targetPath: string, data: unknown): Promise<void> {
  const tmp = `${targetPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, targetPath);
}

/** Write prefill.json (fixed name) plus a per-request archival copy. */
export async function writePrefill(config: OrchestratorConfig, prefill: Prefill): Promise<void> {
  await ensureDirs(config);
  await writeJsonAtomic(config.prefillPath, prefill);
  const archive = path.join(config.inDir, `prefill-${prefill.request_id}.json`);
  await writeJsonAtomic(archive, prefill).catch(() => {
    /* archival copy is best-effort */
  });
}

/** Best-effort removal of a previous cycle's out files when a new handoff starts. */
export async function clearOutFiles(config: OrchestratorConfig): Promise<void> {
  await Promise.all(
    [config.readyPath, config.resultPath, config.errorPath].map((p) =>
      fs.rm(p, { force: true }).catch(() => undefined)
    )
  );
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

type OutKind = "ready" | "result" | "error";

function kindForPath(config: OrchestratorConfig, filePath: string): OutKind | undefined {
  const resolved = path.resolve(filePath);
  if (resolved === path.resolve(config.readyPath)) return "ready";
  if (resolved === path.resolve(config.resultPath)) return "result";
  if (resolved === path.resolve(config.errorPath)) return "error";
  return undefined;
}

function toPayload(kind: OutKind, doc: unknown): HandoffStatusPayload | undefined {
  if (kind === "ready" && validateReady(doc)) {
    const m = doc as ReadyMessage;
    return {
      request_id: m.request_id,
      status: "ready",
      window_title: m.window_title,
      matched_policy_number: m.matched_policy_number ?? null,
      matched_customer_name: m.matched_customer_name ?? null,
      timestamp: m.timestamp
    };
  }
  if (kind === "result" && validateResult(doc)) {
    const m = doc as ResultMessage;
    return {
      request_id: m.request_id,
      status: "submitted",
      claim_id: m.claim_id,
      policy_number: m.policy_number,
      agent_id: m.agent_id,
      reserve_amount: m.reserve_amount ?? null,
      timestamp: m.timestamp
    };
  }
  if (kind === "error" && validateError(doc)) {
    const m = doc as ErrorMessage;
    return {
      request_id: m.request_id,
      status: "error",
      error_code: m.error_code,
      message: m.message,
      timestamp: m.timestamp
    };
  }
  return undefined;
}

function validatorFor(kind: OutKind) {
  return kind === "ready" ? validateReady : kind === "result" ? validateResult : validateError;
}

/**
 * Read, validate and apply one out\ file to the store. Logs and, where a
 * request_id can be recovered from invalid output, records an UNKNOWN error so
 * the desktop is not left waiting forever.
 */
async function processOutFile(
  config: OrchestratorConfig,
  store: HandoffStore,
  filePath: string
): Promise<void> {
  const kind = kindForPath(config, filePath);
  if (!kind) return;

  let doc: unknown;
  try {
    doc = await readJsonWithRetry(filePath);
  } catch (err) {
    console.error(`[orchestrator] could not read ${path.basename(filePath)}:`, err);
    return;
  }

  const payload = toPayload(kind, doc);
  if (payload) {
    const applied = store.apply(payload);
    if (applied) {
      console.log(
        `[orchestrator] ${payload.request_id} -> ${applied.status}` +
          (applied.claim_id ? ` (${applied.claim_id})` : "")
      );
    }
    return;
  }

  // Valid JSON but does not match the expected schema for this file.
  console.error(
    `[orchestrator] ${path.basename(filePath)} failed ${kind} schema: ${formatErrors(
      validatorFor(kind)
    )}`
  );
  const maybeId = (doc as { request_id?: unknown })?.request_id;
  if (typeof maybeId === "string" && store.has(maybeId)) {
    store.apply({
      request_id: maybeId,
      status: "error",
      error_code: "UNKNOWN",
      message: `Legacy app wrote an invalid ${kind}.json that failed schema validation.`,
      timestamp: new Date().toISOString()
    });
  }
}

/** Scan any out files that already exist and apply them (boot/restart recovery). */
export async function reconcile(config: OrchestratorConfig, store: HandoffStore): Promise<void> {
  for (const p of [config.readyPath, config.resultPath, config.errorPath]) {
    try {
      await fs.access(p);
    } catch {
      continue;
    }
    await processOutFile(config, store, p);
  }
}

/** Start watching the out\ folder. Resolves once the watcher is ready. */
export async function startWatcher(
  config: OrchestratorConfig,
  store: HandoffStore
): Promise<FSWatcher> {
  // Watch the directory (not individual not-yet-existing files, which chokidar
  // handles unreliably) and filter events down to the three known out files.
  const watcher = chokidar.watch(config.outDir, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  });

  const onChange = (filePath: string) => {
    if (!kindForPath(config, filePath)) return;
    void processOutFile(config, store, filePath);
  };
  watcher.on("add", onChange);
  watcher.on("change", onChange);
  watcher.on("error", (err) => console.error("[orchestrator] watcher error:", err));

  await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  return watcher;
}
