"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { relayAction, availability } = require("../src/functions/foundryRelay");

const URL_BASE = "https://foundry.test/api/projects/p/agents/claims-w365/endpoint/protocols/invocations?api-version=v1";
const AUTH_ENV = { FOUNDRY_RELAY_TENANT_ID: "tenant-test", FOUNDRY_RELAY_CLIENT_ID: "client-test" };
const ENV = { FOUNDRY_INVOCATIONS_URL: URL_BASE, FOUNDRY_CLAIMS_READY: "1", ...AUTH_ENV };
// Caller sign-in and ownership are covered in foundryRelayAuth.test.js; here one signed-in owner.
const auth = {
  authorization: "Bearer test",
  authenticate: async () => "tenant-test:csr",
  owners: { claim: async () => true, owner: async () => "tenant-test:csr" }
};
const REQ = "REQ-2026-10020001";
const handoff = {
  request_id: REQ,
  caller_phone: "(555) 123-4567",
  policy_number: "POL-2024-008341",
  intent: "auto_collision",
  summary: "Rear-ended at 5th and Main.",
  requested_by: { agent_id: "csr-test", display_name: "Test CSR" },
  timestamp: "2026-10-02T01:00:00Z",
  target_backend: "foundry"
};

function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, impl };
}
const token = async () => "tok";

test("start forwards one claims run with agent_session_id equal to the request id", async () => {
  const f = fakeFetch(202, { request_id: REQ, events: [] });
  const r = await relayAction("start", { request_id: REQ, operation: "claims", handoff }, { env: ENV, fetchImpl: f.impl, getToken: token, ...auth });
  assert.equal(r.status, 202);
  assert.equal(f.calls.length, 1);
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get("agent_session_id"), REQ);
  assert.equal(u.searchParams.get("api-version"), "v1");
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer tok");
  assert.deepEqual(f.calls[0].body, { action: "start", request_id: REQ, operation: "claims", handoff });
});

test("start is refused before any Foundry call when Claims is not enabled for CCaaS", async () => {
  const f = fakeFetch(202, {});
  const r = await relayAction("start", { request_id: REQ, operation: "claims", handoff }, { env: { FOUNDRY_INVOCATIONS_URL: URL_BASE, ...AUTH_ENV }, fetchImpl: f.impl, getToken: token, ...auth });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /not enabled/i);
  assert.equal(f.calls.length, 0);
});

test("start rejects a handoff addressed to another backend or another request", async () => {
  const f = fakeFetch(202, {});
  const opts = { env: ENV, fetchImpl: f.impl, getToken: token, ...auth };
  for (const bad of [
    { request_id: REQ, operation: "claims", handoff: { ...handoff, target_backend: "mcs" } },
    { request_id: REQ, operation: "claims", handoff: { ...handoff, request_id: "REQ-2026-10020002" } },
    { request_id: REQ, operation: "smoke", handoff },
    { request_id: "REQ-bad", operation: "claims", handoff: { ...handoff, request_id: "REQ-bad" } }
  ]) {
    const r = await relayAction("start", bad, opts);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(f.calls.length, 0);
});

test("only the contract's actions are relayed, with only their own fields", async () => {
  const f = fakeFetch(200, { ok: true });
  const opts = { env: ENV, fetchImpl: f.impl, getToken: token, ...auth };
  assert.equal((await relayAction("delete", { request_id: REQ }, opts)).status, 404);
  await relayAction("status", { request_id: REQ, extra: "x" }, opts);
  await relayAction("view_ready", { request_id: REQ, session_id: "s-1" }, opts);
  assert.equal((await relayAction("view_ready", { request_id: REQ }, opts)).status, 400);
  assert.deepEqual(f.calls.map((c) => c.body), [
    { action: "status", request_id: REQ },
    { action: "view_ready", request_id: REQ, session_id: "s-1" }
  ]);
});

test("status passes on only a whole, non-negative after_sequence", async () => {
  const f = fakeFetch(200, { events: [] });
  const opts = { env: ENV, fetchImpl: f.impl, getToken: token, ...auth };
  for (const after of [0, 41, -1, 1.5, "41", null, true]) {
    await relayAction("status", { request_id: REQ, after_sequence: after }, opts);
  }
  await relayAction("cancel", { request_id: REQ, after_sequence: 41 }, opts);
  assert.deepEqual(f.calls.map((c) => c.body), [
    { action: "status", request_id: REQ, after_sequence: 0 },
    { action: "status", request_id: REQ, after_sequence: 41 },
    ...Array(5).fill({ action: "status", request_id: REQ }),
    { action: "cancel", request_id: REQ }
  ]);
});

test("Foundry errors pass through unchanged, and view responses are never cached", async () => {
  const gate = fakeFetch(403, { error: "Claims execution is not enabled." });
  const r = await relayAction("status", { request_id: REQ }, { env: ENV, fetchImpl: gate.impl, getToken: token, ...auth });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "Claims execution is not enabled.");
  const view = fakeFetch(200, { request_id: REQ, session_id: "s-1", token: "secret", mode: "viewOnly" });
  const v = await relayAction("view", { request_id: REQ }, { env: ENV, fetchImpl: view.impl, getToken: token, ...auth });
  assert.equal(v.noStore, true);
  assert.equal(v.body.token, "secret");
});

test("a failed token or network call is reported, not retried", async () => {
  let n = 0;
  const r = await relayAction("status", { request_id: REQ }, {
    env: ENV, getToken: async () => { throw new Error("no role"); }, fetchImpl: async () => { n += 1; }, ...auth
  });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /identity/i);
  assert.equal(n, 0);
});

test("availability reports configuration and the explicit CCaaS enablement honestly", () => {
  assert.deepEqual(availability({}), { configured: false, ready: false, message: "Foundry hosted agent is not configured for this service." });
  assert.equal(availability({ FOUNDRY_INVOCATIONS_URL: URL_BASE, ...AUTH_ENV }).ready, false);
  assert.equal(availability(ENV).ready, true);
});
