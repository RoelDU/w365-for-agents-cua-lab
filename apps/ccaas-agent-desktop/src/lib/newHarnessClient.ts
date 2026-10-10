/*
 * newHarnessClient.ts — browser side of the separate "MCS - new harness
 * (experimental)" Claims transfer. All calls go to the isolated relay
 * (/api/nh-claims/*) in this app's service; it never reaches the standard MCS
 * trigger or the Foundry relay. The signed-in user's handoff API token is sent
 * on every call so the new-harness host can bind the request to that person.
 *
 * One start per transfer, never retried. A claim is shown only when the relay
 * reports host-verified evidence; the agent's own words are passed on, labelled
 * as not verification. If the person resets the interaction mid-run, the owned
 * request is cancelled once (the host then releases the Cloud PC).
 */

export interface NewHarnessAvailability {
  configured: boolean;
  ready: boolean;
  stage?: string | null;
  desktop?: boolean;
  registration?: boolean;
  invocation?: boolean;
  message: string;
}

export interface NewHarnessEvent {
  sequence?: number;
  type?: string;
  tool?: string;
  message?: string;
  timestamp?: string;
}

export type NewHarnessRelease = { state: "released" | "pending" | "uncertain" };

export type NewHarnessOutcome =
  | { status: "submitted"; claim_id: string }
  | { status: "error"; error_code?: string; message?: string };

export interface NewHarnessStatus {
  host_state: string | null;
  workflow_status: string | null;
  agent_response?: string | null;
  events?: NewHarnessEvent[];
  release: NewHarnessRelease | null;
  outcome: NewHarnessOutcome | null;
  running: boolean;
}

export class NewHarnessRelayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "NewHarnessRelayError";
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = await res.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function getNewHarnessAvailability(baseUrl: string, signal?: AbortSignal): Promise<NewHarnessAvailability> {
  const res = await fetch(joinUrl(baseUrl, "nh-claims/availability"), { method: "GET", signal });
  const body = await readJson(res);
  if (!res.ok) throw new NewHarnessRelayError(String(body.error ?? `HTTP ${res.status}`), res.status);
  return {
    configured: body.configured === true,
    ready: body.ready === true,
    stage: typeof body.stage === "string" ? body.stage : null,
    desktop: body.desktop === true,
    registration: body.registration === true,
    invocation: body.invocation === true,
    message: typeof body.message === "string" ? body.message : "The new-harness service gave no availability message."
  };
}

export async function newHarnessAction(
  baseUrl: string,
  action: "start" | "status" | "cancel",
  body: Record<string, unknown>,
  token: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const res = await fetch(joinUrl(baseUrl, `nh-claims/${action}`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal
  });
  const parsed = await readJson(res);
  if (!res.ok) {
    throw new NewHarnessRelayError(String(parsed.error ?? `The new-harness service returned HTTP ${res.status}.`), res.status);
  }
  return parsed;
}

export type NewHarnessUpdate =
  | { type: "accepted"; nhRequestId: string }
  | { type: "host_state"; state: string }
  | { type: "event"; event: NewHarnessEvent }
  | { type: "agent_response"; text: string }
  | { type: "release"; release: NewHarnessRelease }
  | { type: "outcome"; outcome: NewHarnessOutcome }
  | { type: "cancelled"; detail: string }
  | { type: "error"; message: string };

export interface RunNewHarnessOptions {
  baseUrl: string;
  requestId: string;
  handoff: unknown;
  getToken: () => Promise<string>;
  signal: AbortSignal;
  onUpdate: (u: NewHarnessUpdate) => void;
  pollMs?: number;
  maxMs?: number;
  maxReadFailures?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const id = setTimeout(done, ms);
    function done() {
      clearTimeout(id);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runNewHarness(opts: RunNewHarnessOptions): Promise<void> {
  const { baseUrl, requestId, signal, onUpdate } = opts;
  const pollMs = opts.pollMs ?? 2_000;
  const maxMs = opts.maxMs ?? 20 * 60_000;
  const maxReadFailures = opts.maxReadFailures ?? 5;

  let token: string;
  try {
    token = await opts.getToken();
  } catch (err) {
    onUpdate({ type: "error", message: messageOf(err) });
    return;
  }
  if (signal.aborted) return;

  // The start is deliberately not tied to the abort signal: once sent, its
  // answer is needed so an owned request can be cancelled rather than orphaned.
  let started: Record<string, unknown>;
  try {
    started = await newHarnessAction(baseUrl, "start", { request_id: requestId, operation: "claims", handoff: opts.handoff }, token);
  } catch (err) {
    onUpdate({
      type: "error",
      message: err instanceof NewHarnessRelayError
        ? err.message
        : `The new-harness start could not be confirmed (${messageOf(err)}). It was not retried.`
    });
    return;
  }
  const nhRequestId = typeof started.nh_request_id === "string" ? started.nh_request_id : "";
  const dispatchId = typeof started.dispatch_id === "string" ? started.dispatch_id : "";
  if (started.request_id !== requestId || !nhRequestId || !dispatchId) {
    onUpdate({ type: "error", message: "The new-harness service answered for a different or incomplete request. Nothing was retried." });
    return;
  }
  onUpdate({ type: "accepted", nhRequestId });

  let finished = false;
  let cancelled = false;
  const cancelOnce = async (reason: string) => {
    if (cancelled) return;
    cancelled = true;
    try {
      const fresh = await opts.getToken();
      const r = await newHarnessAction(baseUrl, "cancel", { request_id: requestId, nh_request_id: nhRequestId }, fresh);
      onUpdate({ type: "cancelled", detail: `${reason} Host state: ${String(r.state ?? "unknown")}.` });
    } catch (err) {
      onUpdate({ type: "cancelled", detail: `${reason} The cancel was not confirmed (${messageOf(err)}); the host's own lifecycle still owns release.` });
    }
  };

  const seen = new Set<string>();
  let hostState: string | null = null;
  let releaseState: string | null = null;
  let agentResponseShown = false;
  let readFailures = 0;
  const startedAt = Date.now();

  try {
    while (!signal.aborted) {
      if (Date.now() - startedAt > maxMs) {
        await cancelOnce("The new-harness run exceeded its time limit and was cancelled.");
        onUpdate({ type: "error", message: "The new-harness run did not finish within its time limit. It was cancelled and not retried." });
        finished = true;
        return;
      }
      let status: NewHarnessStatus;
      try {
        const fresh = await opts.getToken();
        status = await newHarnessAction(
          baseUrl, "status", { request_id: requestId, nh_request_id: nhRequestId, dispatch_id: dispatchId }, fresh, signal
        ) as unknown as NewHarnessStatus;
        readFailures = 0;
      } catch (err) {
        if (signal.aborted) break;
        readFailures += 1;
        if (readFailures >= maxReadFailures || (err instanceof NewHarnessRelayError && err.status === 409)) {
          onUpdate({
            type: "error",
            message: `Lost track of new-harness request ${nhRequestId} (${messageOf(err)}). The claim outcome is unknown and was not retried; the host's own lifecycle owns release.`
          });
          finished = true;
          return;
        }
        await sleep(pollMs, signal);
        continue;
      }

      if (status.host_state && status.host_state !== hostState) {
        hostState = status.host_state;
        onUpdate({ type: "host_state", state: hostState });
      }
      for (const [i, e] of (status.events ?? []).entries()) {
        const key = typeof e.sequence === "number" ? `s${e.sequence}` : `i${i}:${e.type ?? ""}:${e.message ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        onUpdate({ type: "event", event: e });
      }
      if (!agentResponseShown && typeof status.agent_response === "string" && status.agent_response.trim()) {
        agentResponseShown = true;
        onUpdate({ type: "agent_response", text: status.agent_response.trim() });
      }
      if (status.release && status.release.state !== releaseState) {
        releaseState = status.release.state;
        onUpdate({ type: "release", release: status.release });
      }
      if (status.outcome) {
        onUpdate({ type: "outcome", outcome: status.outcome });
        finished = true;
        return;
      }
      await sleep(pollMs, signal);
    }
  } finally {
    if (signal.aborted && !finished) {
      await cancelOnce("The interaction was reset, so the new-harness request was cancelled.");
    }
  }
}
