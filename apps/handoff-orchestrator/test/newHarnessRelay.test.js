"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { relayAction, availability } = require("../src/functions/newHarnessRelay");

const HOST = "https://nh-host.test/api";
const ENV = {
  NH_REQUEST_HOST_URL: HOST,
  NH_DISPATCH_ENTITYSET: "crcce_nhclaimrequests",
  NH_WORKFLOW_READY: "1"
};
const REQ = "REQ-2026-100300000001";
const BEARER = "Bearer user-token";
const handoff = {
  request_id: REQ,
  caller_phone: "(555) 123-4567",
  policy_number: "POL-2024-008341",
  intent: "auto_collision",
  summary: "Rear-ended at 5th and Main.",
  requested_by: { agent_id: "entra-1", display_name: "Test CSR" },
  timestamp: "2026-10-03T01:00:00Z",
  target_backend: "mcs-new-harness"
};

function gateHeaders(gateway, registration, stage = "nh-request-v1") {
  return { "x-zava-gateway": gateway, "x-zava-request-registration": registration, "x-zava-stage": stage };
}

/** Fake host: metadata probe carries the host's own gate headers; /requests is the RequestRegistry. */
function fakeHost({ gateway = "enabled", registration = "enabled", register = [201, { request_id: "opaque-1", expires_at: 1 }], report = [200, {}], close = [200, {}] } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ url: u, method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    if (u.endsWith("/.well-known/oauth-protected-resource")) return reply(200, { resource: `${HOST}/mcp` }, gateHeaders(gateway, registration));
    if (u === `${HOST}/requests` && method === "POST") return reply(...register);
    if (method === "DELETE") return reply(...close);
    return reply(...report);
  };
  return { calls, impl };
}

function fakeDataverse({ fail = false, row = null } = {}) {
  const created = [];
  return {
    created,
    create: async (set, r) => {
      if (fail) throw new Error("Dataverse POST failed");
      created.push({ set, row: r });
      return { crcce_nhclaimrequestid: "row-1" };
    },
    get: async () => row
  };
}

test("availability is truthful: the auth-only host keeps the third path disabled", async () => {
  assert.equal((await availability({})).configured, false);
  const authOnly = fakeHost({ gateway: "disabled", registration: "disabled" });
  const a = await availability(ENV, authOnly.impl);
  assert.equal(a.configured, true);
  assert.equal(a.ready, false);
  assert.equal(a.desktop, false);
  assert.equal(a.registration, false);
  assert.match(a.message, /desktop control is not enabled/i);
  const noWorkflow = await availability({ ...ENV, NH_WORKFLOW_READY: "" }, fakeHost().impl);
  assert.equal(noWorkflow.ready, false);
  assert.match(noWorkflow.message, /workflow/i);
  assert.equal((await availability(ENV, fakeHost().impl)).ready, true);
});

test("availability refuses a dispatch table that would fire the standard MCS trigger", async () => {
  for (const set of ["crcce_claimrequests", "CRCCE_CLAIMREQUESTS"]) {
    const a = await availability({ ...ENV, NH_DISPATCH_ENTITYSET: set }, fakeHost().impl);
    assert.equal(a.ready, false);
    assert.match(a.message, /standard MCS/i);
  }
  const custom = await availability({ ...ENV, CUA_TRIGGER_ENTITYSET: "x_req", NH_DISPATCH_ENTITYSET: "x_req" }, fakeHost().impl);
  assert.equal(custom.ready, false);
});

test("start registers the interaction with the caller's own bearer, then writes one isolated dispatch row", async () => {
  const host = fakeHost();
  const dv = fakeDataverse();
  const r = await relayAction("start", { request_id: REQ, operation: "claims", handoff }, { env: ENV, fetchImpl: host.impl, dataverse: dv, authorization: BEARER });
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { request_id: REQ, nh_request_id: "opaque-1", dispatch_id: "row-1", state: "dispatched" });
  const reg = host.calls.find((c) => c.method === "POST");
  assert.deepEqual(reg.body, { interaction_id: REQ });
  assert.equal(reg.headers.Authorization, BEARER);
  assert.equal(reg.headers["X-Zava-Authorization"], BEARER);
  assert.equal(dv.created.length, 1);
  assert.equal(dv.created[0].set, "crcce_nhclaimrequests");
  assert.equal(dv.created[0].row.crcce_correlationid, REQ);
  assert.equal(dv.created[0].row.crcce_nhrequestid, "opaque-1");
  assert.equal(JSON.parse(dv.created[0].row.crcce_nhhandoff).target_backend, "mcs-new-harness");
  assert.equal(JSON.stringify(dv.created).includes("user-token"), false);
});

test("start is refused before any host or Dataverse call when not ready, unauthenticated or misaddressed", async () => {
  const dv = fakeDataverse();
  const authOnly = fakeHost({ gateway: "disabled", registration: "disabled" });
  const gated = await relayAction("start", { request_id: REQ, operation: "claims", handoff }, { env: ENV, fetchImpl: authOnly.impl, dataverse: dv, authorization: BEARER });
  assert.equal(gated.status, 503);
  assert.equal(authOnly.calls.filter((c) => c.method !== "GET").length, 0);

  const host = fakeHost();
  const opts = { env: ENV, fetchImpl: host.impl, dataverse: dv };
  assert.equal((await relayAction("start", { request_id: REQ, operation: "claims", handoff }, opts)).status, 401);
  for (const bad of [
    { request_id: REQ, operation: "claims", handoff: { ...handoff, target_backend: "mcs" } },
    { request_id: REQ, operation: "claims", handoff: { ...handoff, target_backend: "foundry" } },
    { request_id: REQ, operation: "claims", handoff: { ...handoff, request_id: "REQ-2026-100300000002" } },
    { request_id: "REQ-bad", operation: "claims", handoff: { ...handoff, request_id: "REQ-bad" } }
  ]) {
    assert.equal((await relayAction("start", bad, { ...opts, authorization: BEARER })).status, 400, JSON.stringify(bad));
  }
  assert.equal(host.calls.filter((c) => c.method !== "GET").length, 0);
  assert.equal(dv.created.length, 0);
});

test("a host registration refusal stops the run with no dispatch", async () => {
  const host = fakeHost({ register: [403, { error: "unauthorized_interaction" }] });
  const dv = fakeDataverse();
  const r = await relayAction("start", { request_id: REQ, operation: "claims", handoff }, { env: ENV, fetchImpl: host.impl, dataverse: dv, authorization: BEARER });
  assert.equal(r.status, 403);
  assert.equal(dv.created.length, 0);
});

test("a failed or uncertain dispatch closes the registered request once and is not retried", async () => {
  const host = fakeHost();
  const r = await relayAction("start", { request_id: REQ, operation: "claims", handoff }, { env: ENV, fetchImpl: host.impl, dataverse: fakeDataverse({ fail: true }), authorization: BEARER });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /closed/i);
  const deletes = host.calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].url, `${HOST}/requests/opaque-1`);
  assert.equal(host.calls.filter((c) => c.method === "POST").length, 1);
});

test("status reports a claim only from the host's verified UI evidence, never from the agent's words", async () => {
  const agentSaysDone = { crcce_correlationid: REQ, crcce_nhrequestid: "opaque-1", crcce_status: "agent_completed", crcce_agentresponse: "Claim CLM-2026-000999 filed." };
  const ids = { request_id: REQ, nh_request_id: "opaque-1", dispatch_id: "row-1" };

  const words = await relayAction("status", ids, { env: ENV, authorization: BEARER, dataverse: fakeDataverse({ row: agentSaysDone }),
    fetchImpl: fakeHost({ report: [200, { request_id: "opaque-1", state: "release_accepted", cleanup_completed: true, requires_reconciliation: false }] }).impl });
  assert.equal(words.status, 200);
  assert.equal(words.body.outcome.status, "error");
  assert.equal(words.body.outcome.claim_id, undefined);
  assert.match(words.body.outcome.message, /no verified claim/i);

  const verified = await relayAction("status", ids, { env: ENV, authorization: BEARER, dataverse: fakeDataverse({ row: agentSaysDone }),
    fetchImpl: fakeHost({ report: [200, { request_id: "opaque-1", state: "release_accepted", cleanup_completed: true, requires_reconciliation: false,
      events: [{ sequence: 1, type: "tool", tool: "computer_click", message: "Clicked Submit Claim." }],
      claim: { status: "submitted", claim_id: "CLM-2026-000321", evidence: "observed_ui" } }] }).impl });
  assert.deepEqual(verified.body.outcome, { status: "submitted", claim_id: "CLM-2026-000321" });
  assert.deepEqual(verified.body.release, { state: "released" });
  assert.equal(verified.body.events.length, 1);

  const running = await relayAction("status", ids, { env: ENV, authorization: BEARER, dataverse: fakeDataverse({ row: { ...agentSaysDone, crcce_status: "dispatched" } }),
    fetchImpl: fakeHost({ report: [200, { request_id: "opaque-1", state: "observable", cleanup_completed: false, requires_reconciliation: false }] }).impl });
  assert.equal(running.body.outcome, null);
  assert.equal(running.body.running, true);
});

test("status rejects a dispatch row that belongs to another request", async () => {
  const other = { crcce_correlationid: "REQ-2026-100300000009", crcce_nhrequestid: "opaque-9", crcce_status: "agent_completed" };
  const r = await relayAction("status", { request_id: REQ, nh_request_id: "opaque-1", dispatch_id: "row-1" },
    { env: ENV, authorization: BEARER, dataverse: fakeDataverse({ row: other }), fetchImpl: fakeHost().impl });
  assert.equal(r.status, 409);
});

test("cancel closes the owned host request with the caller's bearer; unknown actions are refused", async () => {
  const host = fakeHost({ close: [200, { state: "release_accepted" }] });
  const r = await relayAction("cancel", { request_id: REQ, nh_request_id: "opaque-1" }, { env: ENV, fetchImpl: host.impl, authorization: BEARER });
  assert.equal(r.status, 200);
  const del = host.calls.find((c) => c.method === "DELETE");
  assert.equal(del.url, `${HOST}/requests/opaque-1`);
  assert.equal(del.headers["X-Zava-Authorization"], BEARER);
  assert.equal((await relayAction("recover", { request_id: REQ }, { env: ENV, fetchImpl: host.impl, authorization: BEARER })).status, 404);
  assert.equal((await relayAction("cancel", { request_id: REQ, nh_request_id: "../x" }, { env: ENV, fetchImpl: host.impl, authorization: BEARER })).status, 400);
});
