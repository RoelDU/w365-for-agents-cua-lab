import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finishReconnect,
  installTransferRecorder,
  isCheckable,
  isUnresolved,
  recordAuthDiagnostic,
  redactSecrets,
  resetTransferRecorderForTests,
  saveCallForReconnect,
  useRecoveryStore,
  type TransferRecord
} from "@/lib/handoffRecovery";
import { useCallStore } from "@/stores/useCallStore";
import { useHandoffStore } from "@/stores/useHandoffStore";
import type { CallContext } from "@/types/contracts";

// Unit tests (no MSAL, relay or Foundry): the reconnect checks run as on the page load after Microsoft's redirect.
const ME = { homeAccountId: "oid-1.tid-1", tenantId: "tid-1", username: "tu1@contoso.example" };
const OTHER = { homeAccountId: "oid-2.tid-1", tenantId: "tid-1", username: "other@contoso.example" };
const CALL_KEY = "ccaas:reconnect-call";

function liveCall() {
  const call = useCallStore.getState();
  call.startRinging();
  call.answerCall(1_790_000_000_000);
  useCallStore.getState().appendTranscriptLine();
  useCallStore.getState().appendTranscriptLine();
  useCallStore.getState().setNotes("Caller is shaken but unhurt.");
  useCallStore.getState().setDisposition("callback");
  return useCallStore.getState();
}

function seedRecord(record: Partial<TransferRecord>) {
  sessionStorage.setItem("ccaas:last-transfer", JSON.stringify({
    request_id: "REQ-2026-111122223333", backend: "foundry", state: "unknown",
    started_at: "2026-10-06T07:00:00.000Z", updated_at: "2026-10-06T07:00:05.000Z", ...record
  }));
  resetTransferRecorderForTests();
}

function pageLoad() {
  useCallStore.getState().reset(); // a full page load starts with no call
  resetTransferRecorderForTests(); // and re-reads this tab's storage
}

describe("handoff recovery across a sign-in redirect (unit, not live proof)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useCallStore.getState().reset();
    resetTransferRecorderForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it("R3: restores the same call once, for the same account, only after the relay pass is confirmed", async () => {
    const before = liveCall();
    expect(saveCallForReconnect({ account: ME, stage: "precheck" })).toEqual({ ok: true });
    pageLoad();
    const checkToken = vi.fn(async () => "token");
    await expect(finishReconnect({ account: ME, redirect: { account: ME }, checkToken })).resolves.toBe("recovered");
    const after = useCallStore.getState();
    expect(after.phase).toBe("talking");
    expect(after.startedAtMs).toBe(1_790_000_000_000);
    expect(after.transcript.map(({ id: _id, ...l }) => l)).toEqual(before.transcript.map(({ id: _id, ...l }) => l));
    expect(after.nextLineIdx).toBe(before.nextLineIdx);
    expect(after.notes).toBe("Caller is shaken but unhurt.");
    expect(after.disposition).toBe("callback");
    expect(checkToken).toHaveBeenCalledTimes(1);
    expect(useRecoveryStore.getState().notice).toMatch(/reconnected/i);
    expect(sessionStorage.getItem(CALL_KEY)).toBeNull();
    pageLoad();
    await expect(finishReconnect({ account: ME, redirect: null, checkToken })).resolves.toBe("none");
  });

  it("R3: keeps the saved call, restores nothing and says why when a different account comes back", async () => {
    liveCall();
    saveCallForReconnect({ account: ME, stage: "start", request_id: "REQ-2026-111122223333" });
    pageLoad();
    const checkToken = vi.fn(async () => "token");
    await expect(finishReconnect({ account: OTHER, redirect: { account: OTHER }, checkToken })).resolves.toBe("account_mismatch");
    expect(useCallStore.getState().phase).toBe("idle");
    expect(sessionStorage.getItem(CALL_KEY)).not.toBeNull();
    expect(checkToken).not.toHaveBeenCalled();
    expect(useRecoveryStore.getState().authDiag).toMatchObject({
      stage: "reconnect", code: "account_mismatch", request_id: "REQ-2026-111122223333"
    });
    expect(useRecoveryStore.getState().authDiag?.detail).toContain("tu1@contoso.example");
    // Still recoverable by the right account.
    await expect(finishReconnect({ account: ME, redirect: { account: ME }, checkToken })).resolves.toBe("recovered");
    expect(useCallStore.getState().phase).toBe("talking");
  });

  it("R3: reports a failed or cancelled redirect, keeps the transfer record, and does not resume anything", async () => {
    seedRecord({ state: "unknown" });
    liveCall();
    saveCallForReconnect({ account: ME, stage: "status", request_id: "REQ-2026-111122223333" });
    pageLoad();
    const checkToken = vi.fn(async () => "token");
    const result = await finishReconnect({
      account: ME,
      redirect: { error: { code: "user_cancelled", message: "User cancelled the flow." } },
      checkToken
    });
    expect(result).toBe("redirect_failed");
    expect(useCallStore.getState().phase).toBe("talking");
    expect(checkToken).not.toHaveBeenCalled();
    const s = useRecoveryStore.getState();
    expect(s.authDiag).toMatchObject({ stage: "reconnect", code: "user_cancelled" });
    expect(s.authDiag?.detail).toContain("User cancelled the flow.");
    expect(s.record).toMatchObject({ request_id: "REQ-2026-111122223333", state: "unknown" });
    expect(s.resume).toBeNull();
    expect(s.notice).toBeNull();
  });

  it("R3: does not report recovery while the relay pass is still unavailable", async () => {
    liveCall();
    saveCallForReconnect({ account: ME, stage: "precheck" });
    pageLoad();
    const checkToken = vi.fn(async () => {
      throw Object.assign(new Error("Microsoft needs you to confirm your sign-in (login_required). AADSTS50058: no session."), { code: "login_required" });
    });
    await expect(finishReconnect({ account: ME, redirect: { account: ME }, checkToken })).resolves.toBe("token_failed");
    expect(useRecoveryStore.getState().notice).toBeNull();
    expect(useRecoveryStore.getState().authDiag).toMatchObject({ stage: "reconnect", code: "login_required" });
    expect(useRecoveryStore.getState().authDiag?.detail).toContain("AADSTS50058");
  });

  it("R1/R2: after reconnecting while a run was watched, resumes that request's status, never a start", async () => {
    seedRecord({ state: "unknown" });
    liveCall();
    saveCallForReconnect({ account: ME, stage: "status", request_id: "REQ-2026-111122223333" });
    pageLoad();
    await expect(finishReconnect({ account: ME, redirect: { account: ME }, checkToken: async () => "t" })).resolves.toBe("recovered");
    expect(useRecoveryStore.getState().resume).toEqual({ request_id: "REQ-2026-111122223333" });
  });

  it("R4: refuses to let the page leave unless the call is saved and read back intact", () => {
    liveCall();
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    const blocked = saveCallForReconnect({ account: ME, stage: "precheck" });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.error).toMatch(/quota/i);
    write.mockRestore();

    vi.spyOn(Storage.prototype, "getItem").mockReturnValue("{\"truncated\":");
    const unreadable = saveCallForReconnect({ account: ME, stage: "precheck" });
    expect(unreadable.ok).toBe(false);
    vi.restoreAllMocks();
    expect(sessionStorage.getItem(CALL_KEY)).toBeNull();
  });

  it("R5: keeps the last sign-in problem across a reload, redacted, without any transfer", () => {
    recordAuthDiagnostic({
      stage: "precheck",
      code: "monitor_window_timeout",
      detail: "Could not get a sign-in token (monitor_window_timeout). Trace ID: 7f1c Bearer abc.def.ghi"
    });
    expect(sessionStorage.getItem("ccaas:auth-diagnostic")).not.toContain("abc.def");
    pageLoad();
    const diag = useRecoveryStore.getState().authDiag;
    expect(diag).toMatchObject({ stage: "precheck", code: "monitor_window_timeout" });
    expect(diag?.detail).toContain("Trace ID: 7f1c");
    expect(diag?.detail).not.toContain("abc.def");
    expect(useRecoveryStore.getState().record).toBeNull();
  });

  it("gives restored lines their own IDs, so lines added after a fresh page load never clash", async () => {
    liveCall();
    saveCallForReconnect({ account: ME, stage: "precheck" });
    vi.resetModules(); // a page load: the call store's line counter starts again
    const { useCallStore: freshCall } = await import("@/stores/useCallStore");
    const fresh = await import("@/lib/handoffRecovery");
    await fresh.finishReconnect({ account: ME, redirect: { account: ME }, checkToken: async () => "t" });
    freshCall.getState().appendTranscriptLine();
    const ids = freshCall.getState().transcript.map((l) => l.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("R2: a transfer to another destination never replaces an unresolved Foundry request's record", () => {
    installTransferRecorder();
    seedRecord({ state: "unknown" });
    const mcs = { request_id: "REQ-2026-999988887777", target_backend: "mcs" } as unknown as CallContext;
    useHandoffStore.getState().beginHandoff(mcs, { handoffId: "h-1" });
    useHandoffStore.getState().setError("UNKNOWN", "MCS failed.");
    expect(useRecoveryStore.getState().record).toMatchObject({ request_id: "REQ-2026-111122223333", backend: "foundry", state: "unknown" });
    expect(JSON.parse(sessionStorage.getItem("ccaas:last-transfer") ?? "null").request_id).toBe("REQ-2026-111122223333");
    useHandoffStore.getState().reset();
  });

  it("E2: with no MSAL account, saves the call for the signed-in agent and restores it only to that agent", async () => {
    const OWNER = { agent_id: "entra-oid-1", username: "tu1@contoso.example" };
    liveCall();
    expect(saveCallForReconnect({ account: null, owner: OWNER, stage: "status", request_id: "REQ-2026-111122223333" })).toEqual({ ok: true });
    expect(JSON.parse(sessionStorage.getItem(CALL_KEY) ?? "null")).toMatchObject({ owner: OWNER, stage: "status" });
    pageLoad();
    const checkToken = vi.fn(async () => "token");
    const other = { ...OTHER, agentId: "entra-oid-2" };
    await expect(finishReconnect({ account: other, redirect: { account: other }, checkToken })).resolves.toBe("account_mismatch");
    expect(useCallStore.getState().phase).toBe("idle");
    expect(sessionStorage.getItem(CALL_KEY)).not.toBeNull();
    expect(checkToken).not.toHaveBeenCalled();
    const mine = { ...ME, agentId: "entra-oid-1" };
    await expect(finishReconnect({ account: mine, redirect: { account: mine }, checkToken })).resolves.toBe("recovered");
    expect(useCallStore.getState().phase).toBe("talking");
    expect(checkToken).toHaveBeenCalledTimes(1);
  });

  it("E2: refuses to save a call that has no owner to return to", () => {
    liveCall();
    const result = saveCallForReconnect({ account: null, owner: null, stage: "precheck" });
    expect(result.ok).toBe(false);
    expect(sessionStorage.getItem(CALL_KEY)).toBeNull();
  });

  it("E2: a failed redirect that returns no account is reported and the call is kept for its owner", async () => {
    seedRecord({ state: "unknown" });
    liveCall();
    saveCallForReconnect({ account: null, owner: { agent_id: "entra-oid-1", username: "tu1@contoso.example" }, stage: "status", request_id: "REQ-2026-111122223333" });
    pageLoad();
    const checkToken = vi.fn(async () => "token");
    const result = await finishReconnect({
      account: null,
      redirect: { error: { code: "access_denied", message: "AADSTS65004: User declined to consent." } },
      checkToken
    });
    expect(result).toBe("redirect_failed");
    expect(useCallStore.getState().phase).toBe("idle");
    expect(sessionStorage.getItem(CALL_KEY)).not.toBeNull();
    expect(checkToken).not.toHaveBeenCalled();
    const s = useRecoveryStore.getState();
    expect(s.authDiag).toMatchObject({ stage: "reconnect", code: "access_denied", request_id: "REQ-2026-111122223333" });
    expect(s.authDiag?.detail).toContain("AADSTS65004");
    expect(s.authDiag?.detail).toContain("tu1@contoso.example");
    expect(s.record).toMatchObject({ request_id: "REQ-2026-111122223333", state: "unknown" });
    expect(s.resume).toBeNull();
  });

  it("E2: says the call is waiting when the page loads with no account and no redirect", async () => {
    liveCall();
    saveCallForReconnect({ account: ME, stage: "precheck" });
    pageLoad();
    await expect(finishReconnect({ account: null, redirect: null, checkToken: async () => "t" })).resolves.toBe("no_account");
    expect(useRecoveryStore.getState().authDiag).toMatchObject({ stage: "reconnect", code: "no_account" });
    expect(useRecoveryStore.getState().authDiag?.detail).toContain("Sign in as tu1@contoso.example");
    expect(sessionStorage.getItem(CALL_KEY)).not.toBeNull();
  });

  it("E2: reports a failed sign-in redirect even when no call was saved and no account returned", async () => {
    await expect(finishReconnect({
      account: null,
      redirect: { error: { code: "user_cancelled", message: "User cancelled the flow." } },
      checkToken: async () => "t"
    })).resolves.toBe("redirect_failed");
    expect(useRecoveryStore.getState().authDiag).toMatchObject({ stage: "signin", code: "user_cancelled" });
    expect(useRecoveryStore.getState().authDiag?.detail).toContain("User cancelled the flow.");
    // A later successful sign-in clears that sign-in problem.
    await expect(finishReconnect({ account: ME, redirect: { account: ME }, checkToken: async () => "t" })).resolves.toBe("none");
    expect(useRecoveryStore.getState().authDiag).toBeNull();
  });

  it("E1: a record an earlier build saved as never started stays unresolved and checkable on its own ID", () => {
    seedRecord({ state: "not_started" as TransferRecord["state"] });
    const record = useRecoveryStore.getState().record;
    expect(record).toMatchObject({ request_id: "REQ-2026-111122223333", state: "unknown" });
    expect(isUnresolved(record)).toBe(true);
    expect(isCheckable(record)).toBe(true);
  });

  it("never keeps tokens in saved error details", () => {
    const text = redactSecrets(
      "relay said Authorization: Bearer abc.def.ghi and token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl end"
    );
    expect(text).not.toMatch(/abc\.def|eyJ/);
    expect(text).toContain("relay said");
    expect(text).toContain("end");
  });
});
