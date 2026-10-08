/*
 * foundryHostedClient.ts — browser side of the separate Foundry hosted Claims
 * transfer. All calls go through this app's own service relay
 * (/api/foundry-claims/*), which holds the Foundry credential; the browser
 * never does. Contract: the Foundry session's ccaas-integration-contract.md.
 *
 * One run per transfer. No automatic retry of start. If the run is interrupted
 * (no outcome and no longer running) the client asks once for a release-only
 * recovery. If the person resets the interaction mid-run, the run is cancelled
 * (the agent still releases the Cloud PC).
 */

export interface FoundryEvent {
  type: string;
  sequence?: number;
  timestamp?: string;
  source?: string;
  message?: string;
  explanation_type?: "assistant_text" | "model_summary" | string;
  status?: string;
  session_id?: string;
  tool?: string;
  release_status?: string;
  result?: {
    request_id?: string;
    status?: string;
    claim_id?: string;
    agent_id?: string;
    error_code?: string;
    message?: string;
    timestamp?: string;
  };
}

export interface FoundrySnapshot {
  events: FoundryEvent[];
  computer: FoundryEvent | null;
  outcome: FoundryEvent | null;
  release: FoundryEvent | null;
  running?: boolean;
  interrupted?: boolean;
}

export interface FoundryViewDetails {
  request_id: string;
  session_id: string;
  computer_url: string;
  viewer_url: string;
  sdk_url: string;
  token: string;
  mode: string;
}

export interface FoundryAvailability {
  configured: boolean;
  ready: boolean;
  message: string;
  /** The relay refuses new starts without a free Cloud PC; the directory must check capacity. */
  capacityGate: boolean;
}

/** The relay's capacity reading for the Foundry pool; gate=false means it does not gate starts. */
export type FoundryCapacity =
  | { gate: false }
  | { gate: true; state: "available" | "none" | "unknown"; reason?: string };

/** Whether a failed relay action may have reached the relay: "no" means it was never sent. */
export type FoundrySent = "no" | "maybe" | "yes";

export class FoundryRelayError extends Error {
  constructor(
    message: string,
    public status: number,
    public sent: FoundrySent = "yes",
    /** True when the user's sign-in token could not be obtained without interaction. */
    public interactionRequired = false,
    /** MSAL error code for a token failure. */
    public code = "",
    /** The relay refused a new start for capacity before claiming its request ID. */
    public capacity: "none" | "unknown" | null = null
  ) {
    super(message);
    this.name = "FoundryRelayError";
  }
}

export type TokenProvider = () => Promise<string>;

/** The signed-in user's existing Handoff.Access token; the relay requires it on every action. */
const defaultToken: TokenProvider = async () => (await import("@/lib/msalLogin")).acquireHandoffAccessToken();

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/foundry-claims/${path}`;
}

export async function getFoundryAvailability(baseUrl: string, signal?: AbortSignal): Promise<FoundryAvailability> {
  const res = await fetch(endpoint(baseUrl, "availability"), { signal });
  if (!res.ok) throw new FoundryRelayError(`Could not check Foundry availability (HTTP ${res.status}).`, res.status);
  const body = (await res.json()) as Partial<FoundryAvailability> & { capacity_gate?: unknown };
  return {
    configured: body.configured === true,
    ready: body.ready === true,
    message: String(body.message ?? ""),
    capacityGate: body.capacity_gate === true
  };
}

/**
 * Ask the relay (signed in) whether the Foundry pool has a free Cloud PC for a new start.
 * Any failure or unexpected answer throws: it must never read as "available" or "none".
 */
export async function getFoundryCapacity(
  baseUrl: string,
  signal?: AbortSignal,
  getToken: TokenProvider = defaultToken
): Promise<FoundryCapacity> {
  const token = await getToken();
  const res = await fetch(endpoint(baseUrl, "capacity"), { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!res.ok) throw new FoundryRelayError(`Could not check Cloud PC availability (HTTP ${res.status}).`, res.status);
  const body = (await res.json().catch(() => ({}))) as { gate?: unknown; state?: unknown; reason?: unknown };
  if (body.gate === false) return { gate: false };
  if (body.gate === true && (body.state === "available" || body.state === "none" || body.state === "unknown")) {
    return { gate: true, state: body.state, ...(typeof body.reason === "string" ? { reason: body.reason } : {}) };
  }
  throw new FoundryRelayError("The relay's Cloud PC availability answer was not understood.", res.status);
}

export async function foundryAction<T>(
  baseUrl: string,
  action: "prepare" | "start" | "status" | "view" | "view_ready" | "cancel" | "recover",
  body: Record<string, unknown>,
  signal?: AbortSignal,
  getToken: TokenProvider = defaultToken
): Promise<T> {
  let token: string;
  try {
    token = await getToken();
  } catch (err) {
    // Nothing is sent without the user's sign-in token.
    const reason = err instanceof Error ? err.message : "Sign in again before using the Foundry agent.";
    const e = (err ?? {}) as { code?: unknown; interactionRequired?: unknown };
    throw new FoundryRelayError(`Foundry ${action} was not sent: ${reason}`, 401, "no",
      e.interactionRequired === true, typeof e.code === "string" ? e.code : "");
  }
  let res: Response;
  try {
    res = await fetch(endpoint(baseUrl, action), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new FoundryRelayError(`Could not reach the Foundry relay (Foundry ${action}).`, 0, "maybe");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: unknown; capacity?: unknown };
  if (!res.ok) {
    const detail = typeof data.error === "string" && data.error
      ? data.error
      : data.error ? JSON.stringify(data.error).slice(0, 500) : `Foundry ${action} failed`;
    const capacity = action === "start" && res.status === 503 && (data.capacity === "none" || data.capacity === "unknown")
      ? data.capacity : null;
    throw new FoundryRelayError(`${detail} (Foundry ${action}, HTTP ${res.status})`, res.status, "yes", false, "", capacity);
  }
  return data;
}

/**
 * Optional: while the confirmation is open, ask Foundry to start this request's sandbox and
 * sign in early. It never starts a run or takes a Cloud PC; any failure is ignored because
 * start does the same work itself. Returns whether the relay accepted it.
 */
export async function prepareFoundryHosted(
  baseUrl: string,
  requestId: string,
  getToken: TokenProvider = defaultToken
): Promise<boolean> {
  try {
    await foundryAction(baseUrl, "prepare", { request_id: requestId }, undefined, getToken);
    return true;
  } catch {
    return false;
  }
}

/**
 * How a failed Foundry transfer stands:
 * - not_sent: the start was never sent (no request left the browser), or the relay refused it
 *   for Cloud PC capacity before claiming its request ID (nothing reached Foundry);
 * - unknown: the run may have started and its outcome is not known (this includes the
 *   relay declining to confirm ownership: that never proves the start did not happen);
 * - stopped: the relay says the run is no longer running, but no outcome was reported
 *   (a claim may or may not have been filed; a person must check before a new transfer);
 * - rejected: the relay or Foundry refused the start.
 */
export type FoundryOutcome = "not_sent" | "unknown" | "stopped" | "rejected";

export interface FoundryFailure {
  outcome: FoundryOutcome;
  stage: "start" | "status";
  /** The user's sign-in token could not be obtained (nothing was sent for this action). */
  auth: boolean;
  /** Microsoft requires the person to sign in or confirm before a token is issued. */
  interactionRequired: boolean;
  code: string;
}

export type FoundryUpdate =
  | { type: "event"; event: FoundryEvent }
  | { type: "outcome"; outcome: FoundryEvent }
  | { type: "error"; message: string; failure: FoundryFailure }
  | { type: "done" };

export interface RunFoundryHostedOptions {
  baseUrl: string;
  requestId: string;
  handoff: unknown;
  onUpdate: (u: FoundryUpdate) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxDurationMs?: number;
  /** Watch an already started request through status only; never sends start. */
  resume?: boolean;
}

// The relay's refusal when its owner record for the request is not this user's
// (foundryRelay.js). It is sent for another owner and for no owner record yet, so it
// never proves the start did not happen: a lost start may still be recording its owner.
const OWNERSHIP_REFUSAL_TEXT = "This Foundry run is not one you started.";

function isOwnershipRefusal(err: unknown): boolean {
  return err instanceof FoundryRelayError && err.status === 403 && err.message.startsWith(OWNERSHIP_REFUSAL_TEXT);
}

function classify(err: unknown, stage: FoundryFailure["stage"]): FoundryFailure {
  if (!(err instanceof FoundryRelayError)) {
    return { outcome: "unknown", stage, auth: false, interactionRequired: false, code: "" };
  }
  const base = { stage, auth: err.sent === "no", interactionRequired: err.interactionRequired, code: err.code };
  if (err.sent === "no") return { ...base, outcome: stage === "start" ? "not_sent" : "unknown" };
  if (err.sent === "maybe") return { ...base, outcome: "unknown" };
  // The relay refused for capacity before claiming the request ID: nothing reached Foundry.
  if (stage === "start" && err.capacity) return { ...base, outcome: "not_sent" };
  // A 4xx answer to start is a refusal; 408/409 and 5xx may hide a start that happened.
  if (stage === "start" && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 409) {
    return { ...base, outcome: "rejected" };
  }
  return { ...base, outcome: "unknown" };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

const MAX_CONSECUTIVE_READ_FAILURES = 5;

export async function runFoundryHosted(opts: RunFoundryHostedOptions): Promise<void> {
  const { baseUrl, requestId, onUpdate, signal } = opts;
  // Each status read through the relay takes about a second, so a 1 s pause gives a ~2 s
  // cadence (Run J: 2 s pause, ~3.1 s cadence before readiness and the result were seen).
  const pollMs = opts.pollIntervalMs ?? 1000;
  const maxMs = opts.maxDurationMs ?? 20 * 60 * 1000;
  let seen = 0;
  let finished = false;

  const take = (snap: FoundrySnapshot) => {
    const events = (Array.isArray(snap.events) ? snap.events : [])
      .map((e, i) => ({ e, n: typeof e.sequence === "number" ? e.sequence : i + 1 }))
      .sort((a, b) => a.n - b.n);
    for (const { e, n } of events) {
      if (n <= seen) continue;
      seen = n;
      if (e.type !== "outcome") onUpdate({ type: "event", event: e });
    }
    if (snap.outcome && !finished) {
      finished = true;
      onUpdate({ type: "outcome", outcome: snap.outcome });
    }
  };

  let stage: FoundryFailure["stage"] = "start";
  const fail = (outcome: FoundryOutcome, message: string) =>
    onUpdate({ type: "error", message, failure: { outcome, stage: "status", auth: false, interactionRequired: false, code: "" } });

  try {
    if (!opts.resume) {
      take(await foundryAction<FoundrySnapshot>(baseUrl, "start",
        { request_id: requestId, operation: "claims", handoff: opts.handoff }, signal));
    }
    stage = "status";

    const startedAt = Date.now();
    let failures = 0;
    let first = opts.resume === true;
    while (!finished && !signal?.aborted && Date.now() - startedAt < maxMs) {
      if (!first) await delay(pollMs, signal);
      first = false;
      if (signal?.aborted) break;
      let snap: FoundrySnapshot;
      try {
        // Only events after the last one already shown come back (older relays/agents send all).
        snap = await foundryAction<FoundrySnapshot>(baseUrl, "status", { request_id: requestId, after_sequence: seen }, signal);
        failures = 0;
      } catch (err) {
        if (signal?.aborted) break;
        // A sign-in that needs the person, or a definite refusal, ends watching at once.
        const transient = err instanceof FoundryRelayError && !err.interactionRequired &&
          (err.status === 0 || err.status >= 500 || err.sent === "no");
        failures += 1;
        if (transient && failures < MAX_CONSECUTIVE_READ_FAILURES) continue;
        throw err;
      }
      take(snap);
      if (!finished && snap.running === false) {
        take(await foundryAction<FoundrySnapshot>(baseUrl, "recover", { request_id: requestId }, signal));
        if (!finished) {
          finished = true;
          fail("stopped", "The Foundry run is no longer running and reported no outcome; a claim may or may not have been filed. Release of the Cloud PC was requested. Check the claims system before transferring again.");
        }
      }
    }
    if (!finished && !signal?.aborted) {
      finished = true;
      await foundryAction(baseUrl, "cancel", { request_id: requestId }).catch(() => undefined);
      fail("unknown", "The Foundry run did not finish before the time limit. Cancellation and Cloud PC release were requested; its outcome is not known.");
    }
  } catch (err) {
    if (!signal?.aborted) {
      const failure = classify(err, stage);
      const message = isOwnershipRefusal(err)
        ? `The relay did not confirm that ${requestId} belongs to this account, so its outcome is not available. ` +
          "This does not mean it never started: it may still be starting or running. Zava keeps this request ID " +
          "and will not start it again under a new one. Check its status again, or check the claims system."
        : err instanceof Error ? err.message : String(err);
      onUpdate({ type: "error", message, failure });
      finished = true;
    }
  } finally {
    if (signal?.aborted && !finished) {
      void foundryAction(baseUrl, "cancel", { request_id: requestId }).catch(() => undefined);
    }
    onUpdate({ type: "done" });
  }
}
