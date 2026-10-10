/*
 * foundryRelay.js — server-side relay from the CCaaS Agent Desktop to the
 * Foundry hosted Claims agent (contract: ccaas-integration-contract.md).
 *
 *   GET  /api/foundry-claims/availability   { configured, ready, message, capacity_gate? }
 *   GET  /api/foundry-claims/capacity       signed-in only: { gate, state?, reason?, checked_at? }
 *   POST /api/foundry-claims/{action}       prepare | start | status | view | view_ready | cancel | recover
 *
 * prepare (optional) is sent while the person reads the transfer confirmation: Foundry
 * starts that request's sandbox and signs in early. It records no owner and no run, and
 * acquires no Cloud PC; start still claims ownership and does every step it must.
 *
 * The browser never holds a Foundry credential. This Function App's managed
 * identity gets a token for https://ai.azure.com and needs the Foundry Agent
 * Consumer role (Azure AI User for older projects) on the project or agent.
 * Every call sets agent_session_id = request_id, as the contract requires.
 *
 * Config (app settings):
 *   FOUNDRY_INVOCATIONS_URL  the agent's .../protocols/invocations?api-version=v1 URL
 *   FOUNDRY_RELAY_TENANT_ID  Entra tenant of the CCaaS sign-in
 *   FOUNDRY_RELAY_CLIENT_ID  the CCaaS app registration (exposes Handoff.Access)
 *   FOUNDRY_CLAIMS_READY     "1" only after the Foundry owner confirms Claims is
 *                            enabled for CCaaS; until then start is refused here.
 *   FOUNDRY_CAPACITY_GATE    "1" refuses a NEW start unless the Foundry pool reports a free
 *   FOUNDRY_CLOUDPC_POOL_ID  Cloud PC (cloudPcCapacity.js). Only start is gated: status, view,
 *                            cancel and recover of a started run never are, because that
 *                            run's own Cloud PC makes the free count zero.
 *
 * Caller sign-in: every action needs the Agent Desktop user's existing
 * api://<client>/Handoff.Access token (validated here). The starter's tenant:oid
 * is recorded once in AzureWebJobsStorage; only that user may read, view, cancel
 * or recover the request. Without the two FOUNDRY_RELAY_* settings every action
 * is refused and availability reports not ready.
 */

"use strict";

const { app } = require("@azure/functions");
const { verifyHandoffAccessToken } = require("../handoffAccessToken");
const { tableOwners } = require("../foundryOwners");
const { capacityGateOn, readPoolCapacity, sharedCapacityReader } = require("../cloudPcCapacity");

const sharedCapacity = sharedCapacityReader();

const REQUEST_ID = /^REQ-[0-9]{4}-[0-9]{4,}$/;
const ACTIONS = new Set(["prepare", "start", "status", "view", "view_ready", "cancel", "recover"]);
const MAX_BODY_BYTES = 32000;

// Caller sign-in reuses the CCaaS app registration's existing Handoff.Access scope.
function callerAuthConfigured(env) {
  return Boolean(env.FOUNDRY_RELAY_TENANT_ID && env.FOUNDRY_RELAY_CLIENT_ID);
}

function availability(env = process.env) {
  if (!env.FOUNDRY_INVOCATIONS_URL) {
    return { configured: false, ready: false, message: "Foundry hosted agent is not configured for this service." };
  }
  if (!callerAuthConfigured(env)) {
    return { configured: true, ready: false, message: "Foundry runs need caller sign-in to be configured for this service." };
  }
  if (String(env.FOUNDRY_CLAIMS_READY || "") !== "1") {
    return { configured: true, ready: false, message: "Foundry Claims runs are not enabled for CCaaS yet." };
  }
  const ready = { configured: true, ready: true, message: "Foundry hosted agent is available." };
  // Only whether the browser should ask for capacity; the reading itself needs sign-in.
  return capacityGateOn(env) ? { ...ready, capacity_gate: true } : ready;
}

const CAPACITY_REFUSAL = {
  none: "No Cloud PC is available for the Foundry agent yet. Nothing was started and this request ID was not used.",
  unknown: "Cloud PC availability could not be checked, so nothing was started and this request ID was not used."
};

/** The signed-in transfer directory's capacity reading (minimum fields, no counts). */
async function capacityStatus({
  env = process.env,
  authorization,
  authenticate = (header) => verifyHandoffAccessToken(header, {
    tenantId: env.FOUNDRY_RELAY_TENANT_ID, clientId: env.FOUNDRY_RELAY_CLIENT_ID
  }),
  readCapacity = (opts) => sharedCapacity(opts)
} = {}) {
  const state = availability(env);
  if (!state.configured || !callerAuthConfigured(env)) return fail(503, state.message);
  try {
    await authenticate(authorization);
  } catch {
    return fail(401, "Sign in to the Agent Desktop again; this request was not authorized.");
  }
  if (!capacityGateOn(env)) return { status: 200, body: { gate: false } };
  let r;
  try {
    r = await readCapacity({ env });
  } catch {
    r = { state: "unknown", reason: "read_failed", checked_at: new Date().toISOString() };
  }
  const body = { gate: true, state: r.state, checked_at: r.checked_at };
  if (r.state === "unknown") body.reason = r.reason;
  return { status: 200, body };
}

function fail(status, error) {
  return { status, body: { error } };
}

function outboundBody(action, input) {
  const requestId = input && input.request_id;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return fail(400, "A valid request_id is required.");
  const out = { action, request_id: requestId };
  if (action === "start") {
    const h = input.handoff;
    if (input.operation !== "claims") return fail(400, "CCaaS starts Claims runs only.");
    if (!h || typeof h !== "object" || Array.isArray(h)) return fail(400, "The handoff is required.");
    if (h.target_backend !== "foundry") return fail(400, "This handoff is not addressed to Foundry.");
    if (h.request_id !== requestId) return fail(400, "The handoff request_id must equal the run request_id.");
    out.operation = "claims";
    out.handoff = h;
  } else if (action === "view_ready") {
    const s = input.session_id;
    if (typeof s !== "string" || !s || s.length > 200) return fail(400, "A session_id is required.");
    out.session_id = s;
  } else if (action === "status" && Number.isSafeInteger(input.after_sequence) && input.after_sequence >= 0) {
    // Only events newer than this are returned; anything else asks for the full list.
    out.after_sequence = input.after_sequence;
  }
  return { out };
}

async function managedIdentityToken() {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) throw new Error("No managed identity is available to this service.");
  const res = await fetch(`${endpoint}?resource=${encodeURIComponent("https://ai.azure.com")}&api-version=2019-08-01`, {
    headers: { "X-IDENTITY-HEADER": header }
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Managed identity token request failed (${res.status}).`);
  return j.access_token;
}

async function relayAction(action, input, {
  env = process.env,
  fetchImpl = fetch,
  getToken = managedIdentityToken,
  authorization,
  authenticate = (header) => verifyHandoffAccessToken(header, {
    tenantId: env.FOUNDRY_RELAY_TENANT_ID, clientId: env.FOUNDRY_RELAY_CLIENT_ID
  }),
  owners = tableOwners(env),
  readCapacity = (opts) => readPoolCapacity(opts)
} = {}) {
  if (!ACTIONS.has(action)) return fail(404, "Unknown action.");
  const state = availability(env);
  if (!state.configured) return fail(503, state.message);
  if (!callerAuthConfigured(env)) return fail(503, state.message);

  let principal;
  try {
    principal = await authenticate(authorization);
  } catch {
    return fail(401, "Sign in to the Agent Desktop again; this request was not authorized.");
  }
  if ((action === "start" || action === "prepare") && !state.ready) return fail(503, state.message);

  const built = outboundBody(action, input);
  if (!built.out) return built;
  const payload = JSON.stringify(built.out);
  if (Buffer.byteLength(payload, "utf8") > MAX_BODY_BYTES) return fail(400, "The request is larger than Foundry accepts.");

  if (action === "start" && capacityGateOn(env)) {
    // A started request keeps its "already started" answer; its own Cloud PC must not turn
    // that into a capacity refusal. Otherwise read the pool fresh before the ID is claimed.
    try {
      if (await owners.owner(built.out.request_id)) {
        return fail(409, "This request was already started. Use its status; do not start it again.");
      }
    } catch {
      return fail(503, "Request ownership could not be checked; nothing was sent to Foundry.");
    }
    let capacity;
    try {
      capacity = await readCapacity({ env });
    } catch {
      capacity = { state: "unknown", reason: "read_failed" };
    }
    if (capacity.state !== "available") {
      const refused = capacity.state === "none" ? "none" : "unknown";
      const body = { error: CAPACITY_REFUSAL[refused], capacity: refused };
      if (refused === "unknown") body.reason = capacity.reason || "read_failed";
      return { status: 503, body };
    }
  }

  try {
    if (action === "start") {
      // Insert-only: the starter becomes the owner; a second start is never forwarded.
      if (!(await owners.claim(built.out.request_id, principal))) {
        return fail(409, "This request was already started. Use its status; do not start it again.");
      }
    } else if (action === "prepare") {
      // Preparing records no owner (start still claims it); it is refused only for another user's run.
      const current = await owners.owner(built.out.request_id);
      if (current && current !== principal) return fail(403, "This Foundry run is not one you started.");
    } else if ((await owners.owner(built.out.request_id)) !== principal) {
      return fail(403, "This Foundry run is not one you started.");
    }
  } catch {
    return fail(503, "Request ownership could not be checked; nothing was sent to Foundry.");
  }

  let token;
  try {
    token = await getToken();
  } catch {
    return fail(502, "This service could not get a Foundry token with its managed identity.");
  }

  const url = new URL(env.FOUNDRY_INVOCATIONS_URL);
  url.searchParams.set("agent_session_id", built.out.request_id);
  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: payload
    });
  } catch {
    return fail(502, "The Foundry hosted agent could not be reached.");
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: `Foundry returned an unreadable response (${res.status}).` };
  }
  return { status: res.status, body, noStore: action === "view" };
}

function toHttp(r) {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  return { status: r.status, headers, jsonBody: r.body };
}

app.http("foundryClaimsAvailability", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "foundry-claims/availability",
  handler: async () => toHttp({ status: 200, body: availability() })
});

app.http("foundryClaimsCapacity", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "foundry-claims/capacity",
  handler: async (request, context) => {
    const r = await capacityStatus({ authorization: request.headers.get("authorization") || undefined });
    context.log(`foundry-claims capacity -> ${r.status} ${r.body.state || (r.body.gate === false ? "gate-off" : "")} ${r.body.reason || ""}`.trim());
    return toHttp(r);
  }
});

app.http("foundryClaimsAction", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "foundry-claims/{action}",
  handler: async (request, context) => {
    const action = request.params.action;
    let input;
    try {
      input = await request.json();
    } catch {
      return toHttp(fail(400, "The request body must be JSON."));
    }
    const r = await relayAction(action, input, { authorization: request.headers.get("authorization") || undefined });
    context.log(`foundry-claims ${action} ${input && input.request_id} -> ${r.status}${r.body && r.body.capacity ? ` capacity=${r.body.capacity} ${r.body.reason || ""}` : ""}`);
    return toHttp(r);
  }
});

module.exports = { relayAction, availability, capacityStatus };
