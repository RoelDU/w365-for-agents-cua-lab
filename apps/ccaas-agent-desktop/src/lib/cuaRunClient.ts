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
 *   2. The orchestrator reads the Computer Use logs (flowsession / flowlog /
 *      flowsessionbinary) and exposes each logged action as a progress step: the
 *      agent's own explanation (or null when none was logged), the action, the
 *      application and the exact screenshot. The app POLLS that feed (~every
 *      2.5s) — a NEAR-LIVE view (a few seconds behind), not a socket stream.
 *
 * The feed also says whether the activity is proven to belong to this handoff
 * (attribution) and whether the Cloud PC was released. Both are passed through
 * unchanged; the claim id comes only from the run result, never from step text.
 */

import type { DirectLineUpdate, LiveActivity, LiveRelease } from "./directLineClient";
import { DirectLineError } from "./directLineClient";

/** A single logged Computer Use action as returned by the progress endpoint. */
interface CuaProgressStep {
  /** Monotonic index of the action within the run (0-based). */
  index: number;
  /** The agent's own explanation for this action; null when none was logged. */
  explanation?: string | null;
  /** Simulation-only note, present only when the feed is simulated. */
  note?: string | null;
  action?: string | null;
  application?: string | null;
  at?: string | null;
  /** The screenshot logged with this action (root-relative, https or data URI). */
  screenshotUrl?: string | null;
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
  /** "uncertain" when a failed run may or may not have filed a claim. */
  outcome?: "uncertain";
  /** Whether the shown activity is proven to belong to this handoff. */
  activity?: LiveActivity;
  /** Cloud PC release, separate from the claim. */
  release?: LiveRelease;
  /** True when the feed is a labelled simulation, not a real agent run. */
  simulated?: boolean;
}

/** After the claim, keep reading only to learn whether the Cloud PC was released. */
const RELEASE_FOLLOW_UP_MS = 10 * 60 * 1000;

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
  /** Region displayed by the app, checked by region-bound services before starting. */
  regionId?: string;
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

async function startRun(baseUrl: string, callContext: unknown, lang: string, regionId?: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/cua-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callContext, lang, regionId }),
      signal
    });
  } catch (err) {
    throw new DirectLineError(
      `Could not reach the run endpoint (${err instanceof Error ? err.message : "network error"}).`
    );
  }
  if (!res.ok) {
    if (res.status === 409) {
      const error: unknown = await res.json().catch(() => null);
      if (error && typeof error === "object" && "code" in error && error.code === "REGION_MISMATCH") {
        throw new DirectLineError(
          "The selected region does not match this service. Refresh the app and select its available region before transferring."
        );
      }
    }
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
    errorMessage: body.errorMessage,
    ...(body.outcome === "uncertain" ? { outcome: "uncertain" as const } : {}),
    activity: body.activity,
    release: body.release,
    simulated: body.simulated === true
  };
}

/**
 * Start a CUA run via the autonomous-trigger path and stream near-live progress
 * via polling, emitting step/activity/release/claim/error/done updates until the
 * run reaches a terminal state, the deadline passes, or the signal aborts. After a
 * claim, polling continues only while the Cloud PC release is still pending.
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
  let lastActivity = "";
  let lastRelease = "";

  try {
    const runId = await startRun(opts.baseUrl, opts.callContext, opts.lang, opts.regionId, signal);
    if (signal?.aborted) return;
    onUpdate({ type: "queued" });

    const start = Date.now();
    let done = false;
    let succeededAt: number | null = null;

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

      const activity: LiveActivity | undefined = prog.simulated
        ? { state: "simulated", simulated: true }
        : prog.activity;
      const activityKey = activity ? JSON.stringify(activity) : "";
      if (activity && activityKey !== lastActivity) {
        lastActivity = activityKey;
        onUpdate({ type: "activity", activity });
      }

      // Render only steps we haven't shown yet, in order.
      for (const step of prog.steps.filter((s) => s.index > renderedThrough).sort((a, b) => a.index - b.index)) {
        onUpdate({
          type: "step",
          step: {
            explanation: prog.simulated ? null : (step.explanation ?? null),
            note: prog.simulated ? (step.note ?? null) : null,
            action: step.action ?? null,
            application: step.application ?? null,
            at: step.at ?? null,
            imageUrl: step.screenshotUrl ? resolveScreenshotUrl(opts.baseUrl, step.screenshotUrl) : null
          }
        });
        renderedThrough = step.index;
      }

      if (prog.claimId && !claimed) {
        claimed = true;
        onUpdate({ type: "claim", claimId: prog.claimId });
      }

      const releaseKey = prog.release ? JSON.stringify(prog.release) : "";
      if (prog.release && releaseKey !== lastRelease) {
        lastRelease = releaseKey;
        onUpdate({ type: "release", release: prog.release });
      }

      if (prog.status === "succeeded") {
        succeededAt = succeededAt ?? Date.now();
        const releasePending = prog.release?.state === "pending";
        done = !releasePending || Date.now() - succeededAt >= RELEASE_FOLLOW_UP_MS;
      } else if (prog.status === "failed") {
        onUpdate({
          type: "error",
          errorMessage: prog.errorMessage || "The AI run did not complete successfully.",
          ...(prog.outcome === "uncertain" ? { uncertain: true } : {})
        });
        done = true;
      }
    }

    if (!done && succeededAt === null) {
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
