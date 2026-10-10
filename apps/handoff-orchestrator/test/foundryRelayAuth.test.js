"use strict";

/*
 * Caller authentication and request ownership for the Foundry relay (Scout QA, 4 Oct 2026):
 * every action must carry the CCaaS user's existing Handoff.Access token, and only the
 * user who started a request may read, view, cancel or recover it. NOT live proof.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { relayAction, availability } = require("../src/functions/foundryRelay");
const { verifyHandoffAccessToken } = require("../src/handoffAccessToken");

const TENANT = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";
const URL_BASE = "https://foundry.test/api/projects/p/agents/claims-w365/endpoint/protocols/invocations?api-version=v1";
const ENV = {
  FOUNDRY_INVOCATIONS_URL: URL_BASE,
  FOUNDRY_CLAIMS_READY: "1",
  FOUNDRY_RELAY_TENANT_ID: TENANT,
  FOUNDRY_RELAY_CLIENT_ID: CLIENT
};
const REQ = "REQ-2026-10030001";
const handoff = {
  request_id: REQ,
  caller_phone: "(555) 123-4567",
  policy_number: "POL-2024-008341",
  intent: "auto_collision",
  summary: "Synthetic.",
  requested_by: { agent_id: "csr-test", display_name: "Test CSR" },
  timestamp: "2026-10-03T01:00:00Z",
  target_backend: "foundry"
};

function memoryOwners() {
  const rows = new Map();
  return {
    rows,
    async claim(requestId, principal) {
      if (rows.has(requestId)) return false;
      rows.set(requestId, principal);
      return true;
    },
    async owner(requestId) {
      return rows.get(requestId) ?? null;
    }
  };
}

function fakeFetch() {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
  };
}

const users = { "Bearer alice": `${TENANT}:alice`, "Bearer bob": `${TENANT}:bob` };
const authenticate = async (header) => {
  if (!users[header]) throw new Error("invalid_token");
  return users[header];
};
const opts = (f, owners, authorization) => ({
  env: ENV, fetchImpl: f.impl, getToken: async () => "mi", authorization, authenticate, owners
});

test("every action without a valid caller token is refused before any Foundry call", async () => {
  const f = fakeFetch();
  const owners = memoryOwners();
  for (const action of ["start", "status", "view", "view_ready", "cancel", "recover"]) {
    const body = action === "start" ? { request_id: REQ, operation: "claims", handoff } : { request_id: REQ, session_id: "s" };
    for (const authorization of [undefined, "Bearer forged"]) {
      const r = await relayAction(action, body, opts(f, owners, authorization));
      assert.equal(r.status, 401, `${action} ${authorization}`);
    }
  }
  assert.equal(f.calls.length, 0);
  assert.equal(owners.rows.size, 0);
});

test("the starter owns the request; another signed-in user cannot read, view, cancel or recover it", async () => {
  const f = fakeFetch();
  const owners = memoryOwners();
  const start = await relayAction("start", { request_id: REQ, operation: "claims", handoff }, opts(f, owners, "Bearer alice"));
  assert.equal(start.status, 200);
  assert.equal(owners.rows.get(REQ), `${TENANT}:alice`);
  for (const action of ["status", "view", "view_ready", "cancel", "recover"]) {
    const r = await relayAction(action, { request_id: REQ, session_id: "s" }, opts(f, owners, "Bearer bob"));
    assert.equal(r.status, 403, action);
  }
  assert.equal(f.calls.length, 1);
  const own = await relayAction("status", { request_id: REQ }, opts(f, owners, "Bearer alice"));
  assert.equal(own.status, 200);
  assert.equal(f.calls.length, 2);
});

test("an unknown request is refused, and a second start of the same request is never forwarded", async () => {
  const f = fakeFetch();
  const owners = memoryOwners();
  assert.equal((await relayAction("view", { request_id: REQ }, opts(f, owners, "Bearer alice"))).status, 403);
  await relayAction("start", { request_id: REQ, operation: "claims", handoff }, opts(f, owners, "Bearer alice"));
  const again = await relayAction("start", { request_id: REQ, operation: "claims", handoff }, opts(f, owners, "Bearer alice"));
  assert.equal(again.status, 409);
  assert.equal(f.calls.length, 1);
});

test("without caller-authentication configuration the relay is not ready and refuses every action", async () => {
  const f = fakeFetch();
  const env = { FOUNDRY_INVOCATIONS_URL: URL_BASE, FOUNDRY_CLAIMS_READY: "1" };
  assert.equal(availability(env).ready, false);
  assert.match(availability(env).message, /sign-in/i);
  const r = await relayAction("status", { request_id: REQ }, { ...opts(f, memoryOwners(), "Bearer alice"), env });
  assert.equal(r.status, 503);
  assert.equal(f.calls.length, 0);
  assert.equal(availability(ENV).ready, true);
});

// --- the token check itself, with a locally generated signing key -------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function sign(claims, header = { alg: "RS256", kid: "k1", typ: "JWT" }, key = privateKey) {
  const data = `${b64(header)}.${b64(claims)}`;
  return `Bearer ${data}.${crypto.sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}`;
}
const now = Math.floor(Date.now() / 1000);
const good = {
  iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: "alice",
  azp: CLIENT, scp: "Handoff.Access", iat: now - 10, nbf: now - 10, exp: now + 600
};
const keys = async () => [jwk];
const verify = (header) => verifyHandoffAccessToken(header, { tenantId: TENANT, clientId: CLIENT, getKeys: keys });

test("a valid Handoff.Access token yields tenant:oid; api:// audience form is also accepted", async () => {
  assert.equal(await verify(sign(good)), `${TENANT}:alice`);
  assert.equal(await verify(sign({ ...good, aud: `api://${CLIENT}` })), `${TENANT}:alice`);
});

test("wrong audience, tenant, issuer, client, scope, expiry, algorithm or signature is rejected", async () => {
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const bad = [
    ["no header", undefined],
    ["not bearer", "Basic x"],
    ["audience", sign({ ...good, aud: "someone-else" })],
    ["tenant", sign({ ...good, tid: "33333333-3333-3333-3333-333333333333" })],
    ["issuer", sign({ ...good, iss: "https://evil.example/v2.0" })],
    ["client", sign({ ...good, azp: "44444444-4444-4444-4444-444444444444" })],
    ["scope", sign({ ...good, scp: "Test.Read" })],
    ["expired", sign({ ...good, exp: now - 600 })],
    ["not yet valid", sign({ ...good, nbf: now + 600 })],
    ["no oid", sign({ ...good, oid: "" })],
    ["alg none", sign(good, { alg: "none", kid: "k1" })],
    ["unknown key", sign(good, { alg: "RS256", kid: "k2" })],
    ["signature", sign(good, undefined, other)]
  ];
  for (const [name, header] of bad) {
    await assert.rejects(verify(header), undefined, name);
  }
});

test("prepare forwards only the request id, records no owner, and a later start still claims the request", async () => {
  const f = fakeFetch();
  const owners = memoryOwners();
  const prepared = await relayAction("prepare", { request_id: REQ, handoff, extra: "x" }, opts(f, owners, "Bearer alice"));
  assert.equal(prepared.status, 200);
  assert.deepEqual(f.calls, [{ action: "prepare", request_id: REQ }]);
  assert.equal(owners.rows.size, 0);
  const start = await relayAction("start", { request_id: REQ, operation: "claims", handoff }, opts(f, owners, "Bearer alice"));
  assert.equal(start.status, 200);
  assert.equal(owners.rows.get(REQ), `${TENANT}:alice`);
  // Another user's started run is not touched by their prepare; the owner's own is harmless.
  assert.equal((await relayAction("prepare", { request_id: REQ }, opts(f, owners, "Bearer bob"))).status, 403);
  assert.equal((await relayAction("prepare", { request_id: REQ }, opts(f, owners, "Bearer alice"))).status, 200);
  assert.equal(f.calls.length, 3);
});

test("prepare needs the caller's sign-in and the CCaaS enablement before anything is sent", async () => {
  const f = fakeFetch();
  const owners = memoryOwners();
  assert.equal((await relayAction("prepare", { request_id: REQ }, opts(f, owners, undefined))).status, 401);
  const off = { ...opts(f, owners, "Bearer alice"), env: { ...ENV, FOUNDRY_CLAIMS_READY: "" } };
  assert.equal((await relayAction("prepare", { request_id: REQ }, off)).status, 503);
  assert.equal((await relayAction("prepare", { request_id: "REQ-bad" }, opts(f, owners, "Bearer alice"))).status, 400);
  assert.equal(f.calls.length, 0);
});
