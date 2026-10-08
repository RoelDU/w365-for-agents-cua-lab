"use strict";

/*
 * Cloud PC capacity gate for NEW Foundry starts (8 Oct 2026). Mock HTTP only, not live proof.
 * Covers: pool read outcomes, gate off = previous behaviour, start refused before the request
 * ID is claimed, duplicate-start answer kept, and a started run's status/view/cancel/recover
 * never gated by its own Cloud PC making the free count zero.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { relayAction, availability, capacityStatus } = require("../src/functions/foundryRelay");
const { readPoolCapacity, sharedCapacityReader } = require("../src/cloudPcCapacity");

const POOL = "00000000-0000-4000-8000-00000000c0de";
const URL_BASE = "https://foundry.test/api/projects/p/agents/claims-w365/endpoint/protocols/invocations?api-version=v1";
const ENV = {
  FOUNDRY_INVOCATIONS_URL: URL_BASE, FOUNDRY_CLAIMS_READY: "1",
  FOUNDRY_RELAY_TENANT_ID: "tenant-test", FOUNDRY_RELAY_CLIENT_ID: "client-test",
  FOUNDRY_CAPACITY_GATE: "1", FOUNDRY_CLOUDPC_POOL_ID: POOL
};
const REQ = "REQ-2026-10080001";
const handoff = {
  request_id: REQ, caller_phone: "(555) 123-4567", policy_number: "POL-2024-008341", intent: "auto_collision",
  summary: "Synthetic.", requested_by: { agent_id: "csr-test", display_name: "Test CSR" },
  timestamp: "2026-10-08T01:00:00Z", target_backend: "foundry"
};
const START = { request_id: REQ, operation: "claims", handoff };

function memoryOwners() {
  const rows = new Map();
  return {
    rows,
    async claim(id, p) { if (rows.has(id)) return false; rows.set(id, p); return true; },
    async owner(id) { return rows.get(id) ?? null; }
  };
}
function foundryFetch() {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
  };
}
function capacity(...states) {
  const seq = [...states];
  const fn = async () => {
    fn.reads += 1;
    const s = seq.length > 1 ? seq.shift() : seq[0];
    return s === "unknown" ? { state: "unknown", reason: "graph_permission_denied" } : { state: s };
  };
  fn.reads = 0;
  return fn;
}
const opts = (f, owners, readCapacity, env = ENV) => ({
  env, fetchImpl: f.impl, getToken: async () => "mi", authorization: "Bearer alice",
  authenticate: async () => "tenant-test:alice", owners, readCapacity
});

// --- pool read ---------------------------------------------------------------------------
function graph(status, body) {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url: String(url), auth: init.headers.Authorization });
      return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
  };
}
const read = (g, env = ENV) => readPoolCapacity({ env, fetchImpl: g.impl, getToken: async () => "graph-mi" });

test("reads only the configured pool's own GET with the managed identity token", async () => {
  const g = graph(200, { id: POOL, sessionUsage: { activeSessionsCount: 0, availableSessionsCount: 1 } });
  const r = await read(g);
  assert.equal(r.state, "available");
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].url, `https://graph.microsoft.com/beta/deviceManagement/virtualEndpoint/cloudPcPools/${POOL}`);
  assert.equal(g.calls[0].auth, "Bearer graph-mi");
  assert.equal(r.count, undefined, "no count is exposed");
});

test("zero available is 'none'; a missing or malformed count is unknown, never zero", async () => {
  assert.equal((await read(graph(200, { sessionUsage: { activeSessionsCount: 1, availableSessionsCount: 0 } }))).state, "none");
  for (const body of [{}, { sessionUsage: null }, { sessionUsage: {} }, { sessionUsage: { availableSessionsCount: "1" } },
    { sessionUsage: { availableSessionsCount: -1 } }, { sessionUsage: { availableSessionsCount: 0.5 } }]) {
    const r = await read(graph(200, body));
    assert.deepEqual([r.state, r.reason], ["unknown", "usage_missing"], JSON.stringify(body));
  }
});

test("permission, not-found, throttling, network and token failures are unknown with a reason", async () => {
  assert.equal((await read(graph(403, { error: { code: "Forbidden" } }))).reason, "graph_permission_denied");
  assert.equal((await read(graph(401, {}))).reason, "graph_permission_denied");
  assert.equal((await read(graph(404, {}))).reason, "pool_not_found");
  assert.equal((await read(graph(429, {}))).reason, "graph_throttled");
  assert.equal((await read(graph(500, {}))).reason, "graph_http_500");
  const offline = await readPoolCapacity({ env: ENV, fetchImpl: async () => { throw new Error("ECONNRESET"); }, getToken: async () => "t" });
  assert.equal(offline.reason, "graph_unreachable");
  const g = graph(200, {});
  const noToken = await readPoolCapacity({ env: ENV, fetchImpl: g.impl, getToken: async () => { throw new Error("no MI"); } });
  assert.equal(noToken.reason, "identity_token_failed");
  assert.equal(g.calls.length, 0);
  for (const r of [offline, noToken]) assert.equal(r.state, "unknown");
});

test("without a valid pool ID nothing is read and the state is unknown", async () => {
  for (const id of [undefined, "", "pool-1", `${POOL}/../x`]) {
    const g = graph(200, { sessionUsage: { availableSessionsCount: 1 } });
    const r = await read(g, { ...ENV, FOUNDRY_CLOUDPC_POOL_ID: id });
    assert.deepEqual([r.state, r.reason], ["unknown", "pool_not_configured"]);
    assert.equal(g.calls.length, 0);
  }
});

test("the directory's shared read joins one in-flight read, reuses it briefly and never reuses a failure", async () => {
  let t = 0;
  const results = [{ state: "available" }, { state: "unknown", reason: "graph_throttled" }, { state: "none" }];
  let reads = 0;
  const shared = sharedCapacityReader(async () => { reads += 1; await new Promise((r) => setTimeout(r, 5)); return results.shift(); }, () => t);
  const [a, b] = await Promise.all([shared(), shared()]);
  assert.equal(reads, 1);
  assert.deepEqual([a.state, b.state], ["available", "available"]);
  t = 4000;
  assert.equal((await shared()).state, "available");
  assert.equal(reads, 1);
  t = 6000;
  assert.equal((await shared()).state, "unknown");
  assert.equal((await shared()).state, "none");
  assert.equal(reads, 3);
});

// --- availability and the capacity route --------------------------------------------------
test("gate off: availability and start behave exactly as before and the pool is never read", async () => {
  const off = { ...ENV, FOUNDRY_CAPACITY_GATE: "" };
  assert.deepEqual(availability(off), { configured: true, ready: true, message: "Foundry hosted agent is available." });
  const cap = capacity("none");
  const f = foundryFetch();
  const r = await relayAction("start", START, opts(f, memoryOwners(), cap, off));
  assert.equal(r.status, 200);
  assert.equal(cap.reads, 0);
  assert.deepEqual(await capacityStatus({ env: off, authorization: "x", authenticate: async () => "p", readCapacity: cap }),
    { status: 200, body: { gate: false } });
});

test("gate on: availability says only that capacity must be checked", () => {
  assert.equal(availability(ENV).capacity_gate, true);
  assert.equal(availability({ ...ENV, FOUNDRY_CLAIMS_READY: "" }).capacity_gate, undefined);
});

test("the capacity reading needs the caller's sign-in and exposes no count", async () => {
  const cap = capacity("available");
  const denied = await capacityStatus({ env: ENV, authorization: undefined, authenticate: async () => { throw new Error("no"); }, readCapacity: cap });
  assert.equal(denied.status, 401);
  assert.equal(cap.reads, 0);
  const ok = await capacityStatus({ env: ENV, authorization: "Bearer a", authenticate: async () => "p", readCapacity: cap });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ["checked_at", "gate", "state"]);
  assert.equal(ok.body.state, "available");
  const failed = await capacityStatus({ env: ENV, authorization: "a", authenticate: async () => "p", readCapacity: capacity("unknown") });
  assert.deepEqual([failed.body.state, failed.body.reason], ["unknown", "graph_permission_denied"]);
  const threw = await capacityStatus({ env: ENV, authorization: "a", authenticate: async () => "p", readCapacity: async () => { throw new Error("x"); } });
  assert.equal(threw.body.state, "unknown");
});

// --- admission ------------------------------------------------------------------------------
test("start with no free Cloud PC is refused before the request ID is claimed or Foundry is called", async () => {
  for (const state of ["none", "unknown"]) {
    const f = foundryFetch();
    const owners = memoryOwners();
    const r = await relayAction("start", START, opts(f, owners, capacity(state)));
    assert.equal(r.status, 503, state);
    assert.equal(r.body.capacity, state);
    assert.match(r.body.error, /nothing was started and this request ID was not used/i);
    assert.equal(owners.rows.size, 0, "request ID not consumed");
    assert.equal(f.calls.length, 0);
  }
});

test("the same request starts once capacity is reported again (re-enabled), and reads fresh each time", async () => {
  const f = foundryFetch();
  const owners = memoryOwners();
  const cap = capacity("none", "available");
  assert.equal((await relayAction("start", START, opts(f, owners, cap))).status, 503);
  const r = await relayAction("start", START, opts(f, owners, cap));
  assert.equal(r.status, 200);
  assert.equal(cap.reads, 2);
  assert.equal(owners.rows.get(REQ), "tenant-test:alice");
  assert.deepEqual(f.calls.map((c) => c.action), ["start"]);
});

test("a duplicate start still gets 'already started', not a capacity refusal from its own Cloud PC", async () => {
  const f = foundryFetch();
  const owners = memoryOwners();
  const cap = capacity("available", "none");
  assert.equal((await relayAction("start", START, opts(f, owners, cap))).status, 200);
  const again = await relayAction("start", START, opts(f, owners, cap));
  assert.equal(again.status, 409);
  assert.equal(cap.reads, 1);
  assert.equal(f.calls.length, 1);
});

test("a raced allocation after a positive check is Foundry's answer, passed through and not retried", async () => {
  const owners = memoryOwners();
  let n = 0;
  const fetchImpl = async () => { n += 1; return new Response(JSON.stringify({ error: "No Cloud PC could be allocated." }), { status: 503 }); };
  const r = await relayAction("start", START, { ...opts({ impl: fetchImpl }, owners, capacity("available")), fetchImpl });
  assert.equal(r.status, 503);
  assert.equal(r.body.capacity, undefined);
  assert.equal(n, 1);
});

test("a started run's status, view, view_ready, cancel and recover are never gated, even with zero free", async () => {
  const f = foundryFetch();
  const owners = memoryOwners();
  const cap = capacity("available", "none");
  await relayAction("start", START, opts(f, owners, cap));
  for (const action of ["status", "view", "view_ready", "cancel", "recover"]) {
    const r = await relayAction(action, { request_id: REQ, session_id: "s-1" }, opts(f, owners, cap));
    assert.equal(r.status, 200, action);
  }
  assert.equal(cap.reads, 1);
  assert.deepEqual(f.calls.map((c) => c.action), ["start", "status", "view", "view_ready", "cancel", "recover"]);
});

test("prepare is not gated: it takes no Cloud PC", async () => {
  const cap = capacity("none");
  const r = await relayAction("prepare", { request_id: REQ }, opts(foundryFetch(), memoryOwners(), cap));
  assert.equal(r.status, 200);
  assert.equal(cap.reads, 0);
});

test("an unsigned start is refused before any capacity read", async () => {
  const cap = capacity("available");
  const r = await relayAction("start", START, { ...opts(foundryFetch(), memoryOwners(), cap), authenticate: async () => { throw new Error("no"); } });
  assert.equal(r.status, 401);
  assert.equal(cap.reads, 0);
});
