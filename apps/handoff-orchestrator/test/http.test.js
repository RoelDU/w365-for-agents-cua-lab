"use strict";

/*
 * Regression tests for the HTTP idempotency/404 helpers. The full HTTP handlers
 * self-register with the Functions runtime and are covered by the live smoke
 * test; here we lock in the two pure helpers that decide idempotency and how an
 * unknown durable instance is surfaced.
 *
 * safeGetStatus exists because the REAL durable-functions runtime THROWS an
 * error containing "HTTP 404 response" for an unknown instance id (the unit-test
 * mocks used to return null, which hid this). A 404 must become a normal null so
 * idempotency probing and status reads treat "unknown" as "no such handoff",
 * never a 502.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { isReusable, safeGetStatus } = require("../src/functions/http");

test("safeGetStatus: a thrown HTTP 404 becomes null (unknown instance)", async () => {
  const client = {
    getStatus: async () => {
      throw new Error("Webhook returned HTTP 404 response: No instance found.");
    }
  };
  const result = await safeGetStatus(client, "handoff-unknown");
  assert.equal(result, null);
});

test("safeGetStatus: passes through extra args and returns the status", async () => {
  let seenArgs;
  const client = {
    getStatus: async (id, ...args) => {
      seenArgs = [id, ...args];
      return { instanceId: id, runtimeStatus: "Running" };
    }
  };
  const result = await safeGetStatus(client, "handoff-x", false, false, true);
  assert.deepEqual(seenArgs, ["handoff-x", false, false, true]);
  assert.equal(result.runtimeStatus, "Running");
});

test("safeGetStatus: a non-404 error is re-thrown (don't mask real failures)", async () => {
  const client = {
    getStatus: async () => {
      throw new Error("HTTP 500 response: storage unavailable");
    }
  };
  await assert.rejects(() => safeGetStatus(client, "handoff-x"), /500/);
});

test("isReusable: in-flight instances are reusable", () => {
  for (const runtimeStatus of ["Running", "Pending", "ContinuedAsNew"]) {
    assert.equal(isReusable({ runtimeStatus }), true, runtimeStatus);
  }
});

test("isReusable: a Completed-but-SUCCEEDED instance is reusable", () => {
  assert.equal(
    isReusable({ runtimeStatus: "Completed", customStatus: { state: "succeeded" } }),
    true
  );
  assert.equal(
    isReusable({ runtimeStatus: "Completed", customStatus: { result: { status: "succeeded" } } }),
    true
  );
});

test("isReusable: a Completed-but-FAILED/timed_out instance is NOT reusable (retry gets a fresh attempt)", () => {
  assert.equal(
    isReusable({ runtimeStatus: "Completed", customStatus: { state: "failed" } }),
    false
  );
  assert.equal(
    isReusable({ runtimeStatus: "Completed", customStatus: { state: "timed_out" } }),
    false
  );
  // Completed with no custom status at all is also not reusable.
  assert.equal(isReusable({ runtimeStatus: "Completed" }), false);
});

test("isReusable: terminal failure/termination and unknown are not reusable", () => {
  assert.equal(isReusable({ runtimeStatus: "Failed" }), false);
  assert.equal(isReusable({ runtimeStatus: "Terminated" }), false);
  assert.equal(isReusable(null), false);
  assert.equal(isReusable({}), false);
});
