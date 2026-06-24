/*
 * contract.test.js - unit tests for the pure request/response mapping.
 * Run with: npm test   (node --test)
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateCallContext,
  buildHandoffMessage,
  extractClaimId,
  extractErrorCode,
  mapRunToStatus
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
  const { valid } = validateCallContext({ ...validCtx, policy_number: null });
  assert.equal(valid, true);
});

test("validateCallContext rejects a bad intent", () => {
  const { valid, errors } = validateCallContext({ ...validCtx, intent: "nope" });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("intent")));
});

test("validateCallContext rejects a missing requested_by", () => {
  const c = { ...validCtx };
  delete c.requested_by;
  assert.equal(validateCallContext(c).valid, false);
});

test("validateCallContext rejects non-object body", () => {
  assert.equal(validateCallContext(null).valid, false);
  assert.equal(validateCallContext("x").valid, false);
  assert.equal(validateCallContext([]).valid, false);
});

test("buildHandoffMessage embeds the key fields", () => {
  const msg = buildHandoffMessage(validCtx);
  assert.ok(msg.includes("(555) 123-4567"));
  assert.ok(msg.includes("auto_collision"));
  assert.ok(msg.includes("POL-2024-008341"));
});

test("extractClaimId finds a claim id", () => {
  assert.equal(extractClaimId("Claim CLM-2024-008123 has been filed."), "CLM-2024-008123");
  assert.equal(extractClaimId("no id here"), undefined);
});

test("extractErrorCode finds a known code", () => {
  assert.equal(extractErrorCode("Filing failed: POLICY_NOT_FOUND - no match."), "POLICY_NOT_FOUND");
  assert.equal(extractErrorCode("all good"), undefined);
});

test("mapRunToStatus: queued", () => {
  assert.equal(mapRunToStatus("R", { status: "queued" }, "").status, "queued");
});

test("mapRunToStatus: in_progress -> ready", () => {
  assert.equal(mapRunToStatus("R", { status: "in_progress" }, "").status, "ready");
});

test("mapRunToStatus: completed with claim id -> submitted", () => {
  const p = mapRunToStatus("R", { status: "completed" }, "Claim CLM-2024-000999 has been filed.");
  assert.equal(p.status, "submitted");
  assert.equal(p.claim_id, "CLM-2024-000999");
});

test("mapRunToStatus: completed without claim id -> error", () => {
  const p = mapRunToStatus("R", { status: "completed" }, "Filing failed: POLICY_NOT_FOUND - no match.");
  assert.equal(p.status, "error");
  assert.equal(p.error_code, "POLICY_NOT_FOUND");
});

test("mapRunToStatus: failed -> error with last_error", () => {
  const p = mapRunToStatus("R", { status: "failed", last_error: { message: "boom" } }, "");
  assert.equal(p.status, "error");
  assert.equal(p.message, "boom");
});

test("mapRunToStatus: unknown status defaults to queued", () => {
  assert.equal(mapRunToStatus("R", { status: "weird" }, "").status, "queued");
});
