/*
 * handoffRecovery.ts - keeps an interaction and its Foundry transfer recoverable
 * across a full page load (a sign-in reconnect or a reload).
 *
 * 1. Reconnect: before the one sign-in redirect that renews the relay token, the
 *    call is saved in this tab's sessionStorage, bound to the signed-in account (or,
 *    when MSAL has lost it, to the signed-in Zava agent). The redirect only starts
 *    when that save is read back intact. On return the saved call is restored only
 *    for its owner; a failed or cancelled redirect (also one that returns no
 *    account) and a token that still cannot be obtained are reported, not hidden.
 * 2. Transfer record: the last transfer's request ID, exact handoff, state and
 *    redacted error are kept so they survive a reload. A Foundry transfer whose
 *    outcome is unknown keeps its request ID and is reconciled through status;
 *    it is never started again under a new ID while unresolved.
 * 3. Sign-in diagnostics: the last sign-in problem (stage, code, detail) is kept,
 *    redacted, even when no transfer was started.
 *
 * Tokens are never stored: only the fields below, with token-like text redacted.
 */

import { create } from "zustand";
import { HERO_SCENARIOS, getScenarioByKey } from "@/mocks/heroScenarios";
import type { HeroScenario } from "@/types/domain";
import type { CallContext } from "@/types/contracts";
import { useCallStore } from "@/stores/useCallStore";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { useLangStore } from "@/stores/useLangStore";
import { translate } from "@/i18n";
import { redactSecrets } from "@/lib/redact";

export { redactSecrets };

const CALL_KEY = "ccaas:reconnect-call";
const TRANSFER_KEY = "ccaas:last-transfer";
const DIAG_KEY = "ccaas:auth-diagnostic";

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function text(key: string, vars?: Record<string, string | number>): string {
  return translate(useLangStore.getState().lang, key, vars);
}

/** The signed-in Microsoft account a saved call belongs to (identifiers only, no tokens). */
export interface AccountRef {
  homeAccountId: string;
  tenantId: string;
  username: string;
  /** The Zava agent ID the account signs in as. */
  agentId?: string;
}

/** The Zava agent a saved call belongs to, kept when MSAL had no account to bind it to. */
export interface ExpectedOwner {
  agent_id: string;
  username: string;
}

export function sameAccount(a: AccountRef | null | undefined, b: AccountRef | null | undefined): boolean {
  return !!a && !!b && !!a.homeAccountId && a.homeAccountId === b.homeAccountId && a.tenantId === b.tenantId;
}

/** Where the reconnect was started: the transfer list, a start, or watching a started run. */
export type ReconnectStage = "precheck" | "start" | "status";

// ---------------------------------------------------------------- diagnostics

export interface AuthDiagnostic {
  stage: ReconnectStage | "reconnect" | "signin";
  code: string;
  detail: string;
  request_id?: string;
  at: string;
}

function readDiag(): AuthDiagnostic | null {
  try {
    const raw = storage()?.getItem(DIAG_KEY);
    const d = raw ? (JSON.parse(raw) as AuthDiagnostic) : null;
    return d && typeof d.detail === "string" ? d : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- transfer record

export type TransferState = "started" | "not_sent" | "unknown" | "stopped" | "error" | "submitted";

export interface TransferRecord {
  request_id: string;
  backend: string;
  state: TransferState;
  started_at: string;
  updated_at: string;
  error_code?: string;
  message?: string;
  claim_id?: string;
  /** The exact handoff sent (or to be sent) for a Foundry transfer, including the edited summary. */
  handoff?: CallContext;
}

/**
 * A Foundry transfer that may have started and has no known outcome. While one
 * exists, no new Foundry start is offered for this tab, and no other transfer
 * replaces its record.
 */
export function isUnresolved(record: TransferRecord | null | undefined): boolean {
  return !!record && record.backend === "foundry" &&
    (record.state === "started" || record.state === "unknown" || record.state === "stopped");
}

/** Unresolved and still checkable through status (a stopped run has nothing more to report). */
export function isCheckable(record: TransferRecord | null | undefined): boolean {
  return isUnresolved(record) && record?.state !== "stopped";
}

function readTransfer(): TransferRecord | null {
  try {
    const raw = storage()?.getItem(TRANSFER_KEY);
    const record = raw ? (JSON.parse(raw) as TransferRecord) : null;
    if (!record || typeof record.request_id !== "string") return null;
    // An earlier build saved a relay ownership refusal as "never started". That was not
    // proof, so such a Foundry request stays unresolved and checkable on its own ID.
    if ((record.state as string) === "not_started" && record.backend === "foundry") return { ...record, state: "unknown" };
    return record;
  } catch {
    return null;
  }
}

interface RecoveryState {
  /** The last transfer, live as the handoff changes and as found when the page loaded. */
  record: TransferRecord | null;
  /** Request ID of the record that was present when this page loaded. */
  loadedId: string | null;
  dismissedId: string | null;
  authDiag: AuthDiagnostic | null;
  /** A successful reconnect's confirmation, shown once. */
  notice: string | null;
  /** After a reconnect while watching a run: resume status for this request (never start). */
  resume: { request_id: string } | null;
}

function initialRecovery(): RecoveryState {
  const record = readTransfer();
  return { record, loadedId: record?.request_id ?? null, dismissedId: null, authDiag: readDiag(), notice: null, resume: null };
}

export const useRecoveryStore = create<RecoveryState>(() => initialRecovery());

export function recordAuthDiagnostic(d: Omit<AuthDiagnostic, "at" | "detail"> & { detail: string }): void {
  const diag: AuthDiagnostic = {
    stage: d.stage,
    code: redactSecrets(d.code || "").slice(0, 80),
    detail: redactSecrets(d.detail).slice(0, 600),
    ...(d.request_id ? { request_id: d.request_id } : {}),
    at: new Date().toISOString()
  };
  try {
    storage()?.setItem(DIAG_KEY, JSON.stringify(diag));
  } catch {
    /* still shown on this page */
  }
  useRecoveryStore.setState({ authDiag: diag });
}

export function clearAuthDiagnostic(): void {
  storage()?.removeItem(DIAG_KEY);
  useRecoveryStore.setState({ authDiag: null });
}

function writeTransfer(record: TransferRecord): void {
  try {
    storage()?.setItem(TRANSFER_KEY, JSON.stringify(record));
  } catch {
    /* best effort; the live state still holds it */
  }
  useRecoveryStore.setState({ record });
}

let installed = false;

/** Record each transfer's correlation details as the handoff store changes. Idempotent. */
export function installTransferRecorder(): void {
  if (installed) return;
  installed = true;
  useHandoffStore.subscribe((s) => {
    const ctx = s.callContext;
    if (!ctx || s.status === "idle") return;
    const state: TransferState = s.status === "submitted"
      ? "submitted"
      : s.status === "error"
        ? s.failure?.outcome === "not_sent" ? "not_sent"
          : s.failure?.outcome === "unknown" ? "unknown"
            : s.failure?.outcome === "stopped" ? "stopped" : "error"
        : "started";
    const backend = ctx.target_backend ?? "mcs";
    const previous = useRecoveryStore.getState().record;
    const same = previous?.request_id === ctx.request_id;
    // An unresolved Foundry request keeps its record until it is reconciled; a
    // transfer to another destination meanwhile does not replace it.
    if (!same && isUnresolved(previous)) return;
    const next = {
      request_id: ctx.request_id,
      backend,
      state,
      ...(state !== "started" && state !== "submitted" ? {
        error_code: s.errorCode ?? "UNKNOWN",
        message: redactSecrets(s.errorMessage ?? "").slice(0, 1000)
      } : {}),
      ...(state === "submitted" && s.claimId ? { claim_id: s.claimId } : {}),
      ...(backend === "foundry" ? { handoff: ctx } : {})
    };
    if (same && previous) {
      const { started_at: _s, updated_at: _u, ...kept } = previous;
      if (JSON.stringify(kept) === JSON.stringify(next)) return;
    }
    const now = new Date().toISOString();
    writeTransfer({ ...next, started_at: same && previous ? previous.started_at : now, updated_at: now });
  });
}

/** Hide a resolved record. An unresolved Foundry transfer cannot be dismissed; check its status. */
export function dismissTransfer(): boolean {
  const { record } = useRecoveryStore.getState();
  if (!record || isUnresolved(record)) return false;
  storage()?.removeItem(TRANSFER_KEY);
  useRecoveryStore.setState({ dismissedId: record.request_id });
  return true;
}

/**
 * The person's explicit reconciliation of a request Zava cannot settle itself: a run
 * that stopped without an outcome, or one started under another account. Only this
 * releases the block on a new Foundry transfer for such a request.
 */
export function acknowledgeTransfer(): boolean {
  const { record } = useRecoveryStore.getState();
  if (!record || !isUnresolved(record)) return false;
  storage()?.removeItem(TRANSFER_KEY);
  useRecoveryStore.setState({ record: null, dismissedId: record.request_id });
  return true;
}

/** Tests only: re-read storage as if the page had just loaded. */
export function resetTransferRecorderForTests(): void {
  useRecoveryStore.setState(initialRecovery());
}

// ------------------------------------------------------------- saved call

const CALL_FIELDS = [
  "phase", "scenarioKey", "startedAtMs", "durationSec", "isOnHold", "isMuted",
  "notes", "disposition", "transcript", "nextLineIdx"
] as const;

interface SavedCall {
  version: 2;
  saved_at: string;
  /** The MSAL account at save time; when present, only that account may restore the call. */
  account?: AccountRef;
  /** The Zava agent at save time; decides ownership when MSAL had no account. */
  owner?: ExpectedOwner;
  stage: ReconnectStage;
  request_id?: string;
  call: Record<string, unknown>;
}

export type SaveResult = { ok: true } | { ok: false; error: string };

/**
 * Save the current call before the reconnect redirect. The caller must not leave
 * the page unless this returns ok: the save is read back to prove it is intact.
 * It needs an owner to restore to: the MSAL account, or else the signed-in Zava agent.
 */
export function saveCallForReconnect(input: {
  account: AccountRef | null;
  owner?: ExpectedOwner | null;
  stage: ReconnectStage;
  request_id?: string;
}): SaveResult {
  const store = storage();
  if (!store) return { ok: false, error: "this browser tab has no session storage" };
  if (!input.account && !input.owner?.agent_id) return { ok: false, error: "there is no signed-in account to return the call to" };
  const call = useCallStore.getState();
  const snapshot: SavedCall = {
    version: 2,
    saved_at: new Date().toISOString(),
    ...(input.account ? { account: input.account } : {}),
    ...(input.owner?.agent_id ? { owner: input.owner } : {}),
    stage: input.stage,
    ...(input.request_id ? { request_id: input.request_id } : {}),
    call: Object.fromEntries(CALL_FIELDS.map((f) => [f, call[f]]))
  };
  const json = JSON.stringify(snapshot);
  try {
    store.setItem(CALL_KEY, json);
    if (store.getItem(CALL_KEY) !== json) throw new Error("the saved copy could not be read back");
    return { ok: true };
  } catch (err) {
    try {
      store.removeItem(CALL_KEY);
    } catch {
      /* nothing more to do */
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function discardSavedCall(): void {
  storage()?.removeItem(CALL_KEY);
}

function readSavedCall(): SavedCall | null {
  try {
    const raw = storage()?.getItem(CALL_KEY);
    const saved = raw ? (JSON.parse(raw) as SavedCall) : null;
    return saved && saved.version === 2 && (saved.account || saved.owner?.agent_id) && saved.call ? saved : null;
  } catch {
    return null;
  }
}

function restoreCall(saved: Record<string, unknown>): boolean {
  if (useCallStore.getState().phase !== "idle") return false;
  if (saved.phase === "idle" || !HERO_SCENARIOS.some((s) => s.key === saved.scenarioKey)) return false;
  const scenario = getScenarioByKey(saved.scenarioKey as HeroScenario["key"], useLangStore.getState().lang);
  const patch: Record<string, unknown> = {};
  for (const field of CALL_FIELDS) if (field in saved) patch[field] = saved[field];
  // New lines after a page load are numbered from line-1 again; keep restored keys distinct.
  if (Array.isArray(patch.transcript)) {
    patch.transcript = (patch.transcript as Record<string, unknown>[])
      .map((line, i) => ({ ...line, id: `restored-${i + 1}` }));
  }
  useCallStore.setState({ ...patch, scenario, isPlaying: false });
  return true;
}

export interface RedirectOutcome {
  /** Microsoft's redirect response could not be processed (cancelled, failed, ...). */
  error?: { code: string; message: string };
  /** The account the redirect signed in. */
  account?: AccountRef;
}

export type FinishResult = "none" | "account_mismatch" | "no_account" | "redirect_failed" | "token_failed" | "recovered";

function ownsSavedCall(saved: SavedCall, returned: AccountRef | null | undefined): boolean {
  if (saved.account) return sameAccount(saved.account, returned);
  return !!returned?.agentId && returned.agentId === saved.owner?.agent_id;
}

/**
 * Complete a reconnect after the page comes back, also when no account came back.
 * Runs its checks and restores the call synchronously (before the first await),
 * then confirms the relay token.
 * - Redirect failed/cancelled: always reported, even with no saved call or no account.
 *   The call is restored only for its owner; otherwise it is kept for that owner.
 * - No account returned, or a different one: nothing is restored; the saved call stays
 *   for the expected owner, who can sign in to recover it.
 * - Token still unavailable: call restored, Microsoft's reason shown.
 * - Recovered: a start that was never sent waits for the person to send it; a run
 *   that was being watched is resumed through status (never a new start).
 */
export async function finishReconnect(deps: {
  account: AccountRef | null;
  redirect: RedirectOutcome | null;
  checkToken: () => Promise<unknown>;
}): Promise<FinishResult> {
  const saved = readSavedCall();
  const returned = deps.redirect?.account ?? deps.account;
  const redirectError = deps.redirect?.error;
  const redirectDetail = redirectError ? redirectError.message || redirectError.code : "";
  if (!saved) {
    // An unreadable leftover is never acted on.
    if (storage()?.getItem(CALL_KEY)) discardSavedCall();
    if (redirectError) {
      recordAuthDiagnostic({
        stage: "signin",
        code: redirectError.code || "redirect_failed",
        detail: text("recovery.signInFailed", { detail: redirectDetail })
      });
      return "redirect_failed";
    }
    if (returned && useRecoveryStore.getState().authDiag?.stage === "signin") clearAuthDiagnostic();
    return "none";
  }
  const expected = saved.account?.username || saved.owner?.username || "-";
  if (!ownsSavedCall(saved, returned)) {
    if (redirectError) {
      recordAuthDiagnostic({
        stage: "reconnect",
        code: redirectError.code || "redirect_failed",
        detail: text("recovery.redirectFailedKept", { detail: redirectDetail, expected }),
        request_id: saved.request_id
      });
      return "redirect_failed";
    }
    if (!returned) {
      recordAuthDiagnostic({
        stage: "reconnect",
        code: "no_account",
        detail: text(deps.redirect ? "recovery.noAccountReturned" : "recovery.signInToRecover", { expected }),
        request_id: saved.request_id
      });
      return "no_account";
    }
    recordAuthDiagnostic({
      stage: "reconnect",
      code: "account_mismatch",
      detail: text("recovery.accountMismatch", { expected, actual: returned.username || "-" }),
      request_id: saved.request_id
    });
    return "account_mismatch";
  }
  discardSavedCall();
  restoreCall(saved.call);

  if (redirectError) {
    recordAuthDiagnostic({
      stage: "reconnect",
      code: redirectError.code || "redirect_failed",
      detail: text("recovery.redirectFailed", { detail: redirectDetail }),
      request_id: saved.request_id
    });
    return "redirect_failed";
  }
  try {
    await deps.checkToken();
  } catch (err) {
    const e = (err ?? {}) as { code?: unknown; message?: unknown };
    recordAuthDiagnostic({
      stage: "reconnect",
      code: typeof e.code === "string" && e.code ? e.code : "token_unavailable",
      detail: text("recovery.tokenFailed", { detail: typeof e.message === "string" ? e.message : String(err) }),
      request_id: saved.request_id
    });
    return "token_failed";
  }

  clearAuthDiagnostic();
  const record = useRecoveryStore.getState().record;
  if (saved.stage === "status" && saved.request_id && record?.request_id === saved.request_id && isCheckable(record)) {
    useRecoveryStore.setState({ notice: text("recovery.done.status", { id: saved.request_id }), resume: { request_id: saved.request_id } });
  } else if (saved.stage === "start" && saved.request_id) {
    useRecoveryStore.setState({ notice: text("recovery.done.start", { id: saved.request_id }) });
  } else {
    useRecoveryStore.setState({ notice: text("recovery.done.precheck") });
  }
  return "recovered";
}
