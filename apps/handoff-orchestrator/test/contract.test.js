/*
 * contract.test.js - unit tests for the pure handoff contract logic.
 * Run: npm test  (node --test)
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateCallContext,
  buildContextEnvelope,
  idempotencyKey,
  instanceIdFor,
  normalizeResult,
  parseActivities,
  mapJobToStatus
} = require("../src/contract");

const validCtx = {
  request_id: "REQ-2024-0042",
  caller_phone: "(555) 123-4567",
  policy_number: "POL-2024-008341",
  intent: "auto_collision",
  summary: "Rear-ended at 5th and Main, no injuries.",
  requested_by: { agent_id: "csr-acarter", display_name: "A. Carter", email: "a@x.demo" },
  timestamp: "2024-04-15T18:32:11Z"
};

test("validateCallContext accepts a valid envelope", () => {
  const { valid, errors } = validateCallContext(validCtx);
  assert.equal(valid, true, errors.join("; "));
});

test("validateCallContext accepts null policy_number", () => {
  assert.equal(validateCallContext({ ...validCtx, policy_number: null }).valid, true);
});

test("validateCallContext rejects a bad intent / missing requested_by / non-object", () => {
  assert.equal(validateCallContext({ ...validCtx, intent: "nope" }).valid, false);
  const c = { ...validCtx };
  delete c.requested_by;
  assert.equal(validateCallContext(c).valid, false);
  assert.equal(validateCallContext(null).valid, false);
  assert.equal(validateCallContext([]).valid, false);
});

test("buildContextEnvelope produces neutral flat string fields incl. agent identity", () => {
  const env = buildContextEnvelope(validCtx);
  assert.equal(env.correlation_id, "REQ-2024-0042");
  assert.equal(env.caller_phone, "(555) 123-4567");
  assert.equal(env.policy_number, "POL-2024-008341");
  assert.equal(env.agent_user_id, "csr-acarter");
  assert.equal(env.agent_display_name, "A. Carter");
  assert.equal(env.source_system, "Zava");
  // handoff_id defaults empty here; the orchestrator stamps the real instance id.
  assert.equal(env.handoff_id, "");
  assert.equal(buildContextEnvelope({ ...validCtx, handoff_id: "handoff-abc" }).handoff_id, "handoff-abc");
  // null policy collapses to empty string (flat strings only).
  assert.equal(buildContextEnvelope({ ...validCtx, policy_number: null }).policy_number, "");
});

test("idempotencyKey is stable for the same logical handoff and instanceId is deterministic", () => {
  assert.equal(idempotencyKey(validCtx), idempotencyKey({ ...validCtx }));
  assert.equal(instanceIdFor(validCtx), instanceIdFor({ ...validCtx }));
  assert.ok(instanceIdFor(validCtx).startsWith("handoff-"));
  assert.notEqual(instanceIdFor(validCtx), instanceIdFor({ ...validCtx, request_id: "REQ-2024-0099" }));
});

test("normalizeResult trusts explicit success with a claim id", () => {
  const r = normalizeResult({ status: "succeeded", claim_id: "CLM-2024-000123", reserve_amount: 4200 });
  assert.equal(r.status, "succeeded");
  assert.equal(r.claim_id, "CLM-2024-000123");
  assert.equal(r.reserve_amount, 4200);
});

test("normalizeResult treats success-without-claim-id as error", () => {
  assert.equal(normalizeResult({ status: "succeeded" }).status, "error");
});

test("normalizeResult maps explicit error code", () => {
  const r = normalizeResult({ status: "error", error_code: "POLICY_NOT_FOUND", message: "no match" });
  assert.equal(r.status, "error");
  assert.equal(r.error_code, "POLICY_NOT_FOUND");
});

test("normalizeResult coerces unknown error_code to UNKNOWN", () => {
  assert.equal(normalizeResult({ status: "error", error_code: "WAT" }).error_code, "UNKNOWN");
});

test("parseActivities: structured outbound event wins", () => {
  const acts = [
    { type: "message", from: { id: "bot", role: "bot" }, text: "working..." },
    {
      type: "event",
      name: "handoffResult",
      from: { id: "bot", role: "bot" },
      value: { correlation_id: "REQ-2024-0042", status: "succeeded", claim_id: "CLM-2024-000777" }
    }
  ];
  const r = parseActivities(acts, "REQ-2024-0042");
  assert.equal(r.status, "succeeded");
  assert.equal(r.claim_id, "CLM-2024-000777");
});

test("parseActivities: sentinel JSON block is parsed", () => {
  const acts = [
    {
      type: "message",
      from: { id: "bot", role: "bot" },
      text: "Done. HANDOFF_RESULT_JSON:{\"correlation_id\":\"REQ-2024-0042\",\"status\":\"succeeded\",\"claim_id\":\"CLM-2024-000888\"}END_HANDOFF_RESULT_JSON"
    }
  ];
  const r = parseActivities(acts, "REQ-2024-0042");
  assert.equal(r.claim_id, "CLM-2024-000888");
});

test("parseActivities: bare claim id in bot message", () => {
  const acts = [{ type: "message", from: { id: "bot", role: "bot" }, text: "Filed CLM-2024-000999." }];
  assert.equal(parseActivities(acts, "REQ-2024-0042").claim_id, "CLM-2024-000999");
});

test("parseActivities: ignores user echoes and returns null when not done", () => {
  const acts = [
    { type: "message", from: { id: "dl_x", role: "user" }, text: "start handoff CLM-2024-000111" },
    { type: "message", from: { id: "bot", role: "bot" }, text: "Looking up the policy now..." }
  ];
  assert.equal(parseActivities(acts, "REQ-2024-0042"), null);
});

test("parseActivities: rejects a mismatched correlation id on structured event", () => {
  const acts = [
    {
      type: "event",
      name: "handoffResult",
      from: { id: "bot", role: "bot" },
      value: { correlation_id: "OTHER", status: "succeeded", claim_id: "CLM-2024-000777" }
    }
  ];
  assert.equal(parseActivities(acts, "REQ-2024-0042"), null);
});

test("parseActivities: structured event wins over an EARLIER bare claim id in the same batch", () => {
  const acts = [
    { type: "message", from: { id: "bot", role: "bot" }, text: "Draft saved as CLM-2024-000111." },
    {
      type: "event",
      name: "handoffResult",
      from: { id: "bot", role: "bot" },
      value: { correlation_id: "REQ-2024-0042", status: "succeeded", claim_id: "CLM-2024-000777" }
    }
  ];
  const r = parseActivities(acts, "REQ-2024-0042");
  assert.equal(r.claim_id, "CLM-2024-000777");
});

test("mapJobToStatus: custom status is authoritative over runtime status", () => {
  // Completed runtime but succeeded custom status -> submitted.
  const ok = mapJobToStatus("REQ", "Completed", {
    state: "succeeded",
    result: { status: "succeeded", claim_id: "CLM-2024-000123", reserve_amount: 4200 }
  });
  assert.equal(ok.status, "submitted");
  assert.equal(ok.claim_id, "CLM-2024-000123");

  // Completed runtime but timed_out custom status -> error (NOT submitted).
  const to = mapJobToStatus("REQ", "Completed", { state: "timed_out", result: { status: "error" } });
  assert.equal(to.status, "error");

  assert.equal(mapJobToStatus("REQ", "Running", { state: "working" }).status, "ready");
  assert.equal(mapJobToStatus("REQ", "Pending", { state: "queued" }).status, "queued");
});

test("mapJobToStatus: failed runtime with no custom status -> error", () => {
  assert.equal(mapJobToStatus("REQ", "Failed", null).status, "error");
  assert.equal(mapJobToStatus("REQ", "Running", null).status, "queued");
});
