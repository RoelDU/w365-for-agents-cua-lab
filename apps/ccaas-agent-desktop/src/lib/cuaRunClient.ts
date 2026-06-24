/*
 * cuaRunClient.ts — near-live progress client for the "autonomous trigger +
 * Dataverse poll" architecture (Option A).
 *
 * Why this exists: when the Copilot Studio agent is set to "Authenticate with
 * Microsoft" (required for the Activity/Session-replay audit trail), the
 * browser-direct Direct Line stream no longer works — an unauthenticated Direct
 * Line conversation returns zero activities. The supported way to keep an in-app
 * view of the Computer Use run AND preserve the audit trail is:
 *
 *   1. The app asks the orchestrator to START a run. The orchestrator writes a
 *      row to a Dataverse table whose "row created" event is an AUTONOMOUS
 *      TRIGGER on the agent. Autonomous-trigger runs DO appear in Activity, so
 *      the audit trail (screenshots + reasoning Session replay) is preserved.
 *   2. The orchestrator polls the Computer Use Dataverse logs
 *      (flowsession / flowsessionbinary / flowlog) and exposes them as a simple
 *      progress feed. The app POLLS that feed (~every 2.5s) and renders the
 *      screenshots + reasoning as each action completes — a NEAR-LIVE view
 *      (a few seconds behind real time), not a real-time socket stream.
 *
 * This client emits the SAME update contract as directLineClient.ts
 * (DirectLineUpdate) so the AI Agent Status panel rendering is reused unchanged.
 */

import type { DirectLineUpdate } from "./directLineClient";
import { DirectLineError } from "./directLineClient";

/** A single completed Computer Use action as returned by the progress endpoint. */
interface CuaProgressStep {
  /** Monotonic index of the action within the run (0-based). */
  index: number;
  /** The agent's reasoning/narration for this action. */
  reasoning?: string;
  /** Screenshot the agent captured for this action (data URI or https URL). */
  screenshotUrl?: string;
  /** Claim id if this step surfaced one (format CLM-YYYY-NNNNNN). */
  claimId?: string;
}

/** Shape returned by GET /api/cua-run/{id}/progress. */
interface CuaProgressResponse {
  /** "queued" | "running" | "succeeded" | "failed". */
  status: "queued" | "running" | "succeeded" | "failed";
  /** All steps known so far, in order. The client renders only NEW ones. */
  steps: CuaProgressStep[];
  /** Claim id once the run has filed one. */
  claimId?: string;
  /** Human-readable failure reason when status === "failed". */
  errorMessage?: string;
}

const CLAIM_ID_RE = /CLM-\d{4}-\d{6}/;

/** True for the DOMException thrown when a fetch/delay is aborted. */
function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/**
 * Resolve a screenshot URL against the orchestrator. The progress feed returns the
 * screenshot proxy as a root-relative path ("/api/cua-run/.../shot/..."); a relative
 * path would otherwise resolve against the APP's origin (the SWA), not the
 * orchestrator, so the image fails to load. Absolute URLs (https, data:) pass through.
 */
function resolveScreenshotUrl(baseUrl: string, url: string): string {
  if (/^(https?:|data:)/i.test(url)) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

export interface RunCuaViaTriggerOptions {
  /** Orchestrator base URL ending in /api (no trailing slash needed). */
  baseUrl: string;
  /** The CallContext envelope the run is for (policy, summary, request id, …). */
  callContext: unknown;
  /** Narration language so the agent narrates in the UI language. */
  lang: "en" | "ja";
  onUpdate: (update: DirectLineUpdate) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxDurationMs?: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

async function startRun(baseUrl: string, callContext: unknown, lang: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/cua-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callContext, lang }),
      signal
    });
  } catch (err) {
    throw new DirectLineError(
      `Could not reach the run endpoint (${err instanceof Error ? err.message : "network error"}).`
    );
  }
  if (!res.ok) {
    throw new DirectLineError(`Could not start the AI run (HTTP ${res.status}).`);
  }
  const body = (await res.json().catch(() => ({}))) as { runId?: string };
  if (!body.runId) throw new DirectLineError("Run endpoint returned no run id.");
  return body.runId;
}

async function getProgress(baseUrl: string, runId: string, signal?: AbortSignal): Promise<CuaProgressResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/cua-run/${encodeURIComponent(runId)}/progress`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new DirectLineError(`Could not read run progress (HTTP ${res.status}).`);
  }
  const body = (await res.json().catch(() => ({}))) as Partial<CuaProgressResponse>;
  return {
    status: body.status ?? "running",
    steps: Array.isArray(body.steps) ? body.steps : [],
    claimId: body.claimId,
    errorMessage: body.errorMessage
  };
}

/**
 * Start a CUA run via the autonomous-trigger path and stream near-live progress
 * via polling, emitting narration/screenshot/claim/error/done updates until the
 * run reaches a terminal state, the deadline passes, or the signal aborts.
 *
 * Resolves when the run reaches a terminal state; never rejects — failures are
 * delivered as an "error" update so the caller has a single code path (mirrors
 * runDirectLineHandoff).
 */
export async function runCuaViaTrigger(opts: RunCuaViaTriggerOptions): Promise<void> {
  const pollMs = opts.pollIntervalMs ?? 2500;
  const maxMs = opts.maxDurationMs ?? 16 * 60 * 1000;
  const { onUpdate, signal } = opts;
  let claimed = false;
  let renderedThrough = -1; // highest step index already pushed to the UI

  try {
    const runId = await startRun(opts.baseUrl, opts.callContext, opts.lang, signal);
    if (signal?.aborted) return;
    onUpdate({ type: "queued" });

    const start = Date.now();
    let done = false;

    while (!done && Date.now() - start < maxMs) {
      await delay(pollMs, signal);
      if (signal?.aborted) return;

      let prog: CuaProgressResponse;
      try {
        prog = await getProgress(opts.baseUrl, runId, signal);
      } catch (err) {
        // A cancel (Reset demo / unmount) aborts the in-flight fetch — exit quietly.
        if (signal?.aborted || isAbortError(err)) return;
        // Transient read error: keep polling rather than failing the whole run.
        if (err instanceof DirectLineError) continue;
        throw err;
      }

      // Render only steps we haven't shown yet, in order.
      for (const step of prog.steps.filter((s) => s.index > renderedThrough).sort((a, b) => a.index - b.index)) {
        if (step.reasoning) onUpdate({ type: "narration", text: step.reasoning });
        if (step.screenshotUrl) {
          onUpdate({ type: "screenshot", imageUrl: resolveScreenshotUrl(opts.baseUrl, step.screenshotUrl) });
        }
        const claim = step.claimId || (step.reasoning ? step.reasoning.match(CLAIM_ID_RE)?.[0] : undefined);
        if (claim && !claimed) {
          claimed = true;
          onUpdate({ type: "claim", claimId: claim });
        }
        renderedThrough = step.index;
      }

      if (prog.claimId && !claimed) {
        claimed = true;
        onUpdate({ type: "claim", claimId: prog.claimId });
      }

      if (prog.status === "succeeded") {
        done = true;
      } else if (prog.status === "failed") {
        onUpdate({
          type: "error",
          errorMessage: prog.errorMessage || "The AI run did not complete successfully."
        });
        done = true;
      }
    }

    if (!done) {
      onUpdate({ type: "error", errorMessage: "The agent did not finish before the time limit." });
    }
  } catch (err) {
    // A cancel (Reset demo / unmount aborts the signal) is not an error — exit
    // quietly so the UI doesn't flip to an error state.
    if (signal?.aborted || isAbortError(err)) return;
    onUpdate({
      type: "error",
      errorMessage:
        err instanceof DirectLineError
          ? err.message
          : `Unexpected error talking to the AI agent (${err instanceof Error ? err.message : String(err)}).`
    });
  } finally {
    onUpdate({ type: "done" });
  }
}
