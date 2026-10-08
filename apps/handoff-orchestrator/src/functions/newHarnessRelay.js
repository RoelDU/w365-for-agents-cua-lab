/*
 * newHarnessRelay.js — the third CCaaS destination, "MCS - new harness
 * (experimental)": a separate GitHub Copilot-harness Copilot Studio agent.
 * Contract: third-path-contract.json (session artifact owned by the shared-app
 * integration owner). Isolated from cuaRun.js (standard MCS) and
 * foundryRelay.js (Foundry); nothing here falls back to either.
 *
 *   GET  /api/nh-claims/availability   truthful gates read from the request host itself
 *   POST /api/nh-claims/start          register the interaction on the request host with
 *                                      the caller's own Entra bearer, then write ONE row to
 *                                      the isolated dispatch table whose "row added" event
 *                                      starts the Copilot Studio workflow (Agent node)
 *   POST /api/nh-claims/status         host request report + workflow row
 *   POST /api/nh-claims/cancel         close the owned host request (host releases the PC)
 *
 * This service never validates or mints the caller's identity. The request host
 * validates the forwarded bearer (signature, issuer, audience, azp, scope) and
 * owns the request record, principal binding and Cloud PC release. A claim is
 * reported only from the host's observed-UI evidence plus completed cleanup,
 * never from the agent's own words.
 *
 * Config (app settings):
 *   NH_REQUEST_HOST_URL     request host base, e.g. https://<host>/api
 *   NH_DISPATCH_ENTITYSET   isolated Dataverse table (never the standard MCS trigger table)
 *   NH_WORKFLOW_READY       "1" only after the workflow that invokes the new-harness
 *                           agent is confirmed published against that table
 */

"use strict";

const { app } = require("@azure/functions");

const REQUEST_ID = /^REQ-[0-9]{4}-[0-9]{4,}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROW_ID = /^[A-Za-z0-9-]{1,64}$/;
const CLAIM_ID = /^CLM-[0-9]{4}-[0-9]{6}$/;
const ACTIONS = new Set(["start", "status", "cancel"]);
const TARGET = "mcs-new-harness";
const STANDARD_MCS_TRIGGER_SET = "crcce_claimrequests";
const HOST_TIMEOUT_MS = 20000;
const UNCERTAIN_HOST_STATES = new Set(["allocation_uncertain", "release_uncertain", "identity_conflict"]);

const FIELDS = {
  name: "crcce_name",
  correlation: "crcce_correlationid",
  nhRequestId: "crcce_nhrequestid",
  handoff: "crcce_nhhandoff",
  status: "crcce_status",
  agentResponse: "crcce_agentresponse"
};

function fail(status, error) {
  return { status, body: { error } };
}

function hostBase(env) {
  return String(env.NH_REQUEST_HOST_URL || "").replace(/\/+$/, "");
}

function dispatchSetProblem(env) {
  const set = String(env.NH_DISPATCH_ENTITYSET || "").trim();
  if (!set) return "No isolated new-harness dispatch table is configured.";
  const standard = [STANDARD_MCS_TRIGGER_SET, env.CUA_TRIGGER_ENTITYSET].filter(Boolean).map((s) => String(s).toLowerCase());
  if (standard.includes(set.toLowerCase())) {
    return "The configured dispatch table is the standard MCS trigger table; the new harness will not start there.";
  }
  return null;
}

async function availability(env = process.env, fetchImpl = fetch) {
  const base = hostBase(env);
  const gates = { configured: !!base, ready: false, stage: null, desktop: false, registration: false, invocation: false };
  if (!base) return { ...gates, message: "The new-harness request host is not configured for this service." };

  const setProblem = dispatchSetProblem(env);
  gates.invocation = !setProblem && String(env.NH_WORKFLOW_READY || "") === "1";

  let res;
  try {
    res = await fetchImpl(`${base}/.well-known/oauth-protected-resource`, { signal: AbortSignal.timeout(5000) });
  } catch {
    return { ...gates, message: "The new-harness request host could not be reached." };
  }
  const header = (name) => (res.headers.get(name) || "").trim().toLowerCase();
  gates.stage = res.headers.get("x-zava-stage") || null;
  gates.desktop = res.ok && header("x-zava-gateway") === "enabled";
  gates.registration = res.ok && header("x-zava-request-registration") === "enabled";
  gates.ready = gates.desktop && gates.registration && gates.invocation;

  const stage = gates.stage ? ` (${gates.stage})` : "";
  let message = "MCS new harness (experimental) is available.";
  if (!res.ok) message = `The new-harness request host did not answer its readiness probe (HTTP ${res.status}).`;
  else if (!gates.desktop) message = `New-harness host${stage} is authentication-only: desktop control is not enabled.`;
  else if (!gates.registration) message = `New-harness host${stage}: request registration is not enabled.`;
  else if (setProblem) message = setProblem;
  else if (!gates.invocation) message = "The Copilot Studio workflow that invokes the new-harness agent is not confirmed published.";
  return { ...gates, message };
}

async function hostCall(env, fetchImpl, authorization, method, path, body) {
  let res;
  try {
    res = await fetchImpl(`${hostBase(env)}${path}`, {
      method,
      // The request host sits behind Static Web Apps, which replaces Authorization;
      // it reads the copied bearer and validates it in full.
      headers: { Authorization: authorization, "X-Zava-Authorization": authorization, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS)
    });
  } catch {
    return { status: 502, body: { error: "The new-harness request host could not be reached." } };
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: `The new-harness request host returned an unreadable response (${res.status}).` };
  }
  return { status: res.status, body: parsed };
}

function validStart(input) {
  const h = input.handoff;
  if (input.operation !== "claims") return "CCaaS starts Claims runs only.";
  if (!h || typeof h !== "object" || Array.isArray(h)) return "The handoff is required.";
  if (h.target_backend !== TARGET) return "This handoff is not addressed to the new harness.";
  if (h.request_id !== input.request_id) return "The handoff request_id must equal the run request_id.";
  return null;
}

async function start(input, { env, fetchImpl, dataverse, authorization }) {
  const problem = validStart(input);
  if (problem) return fail(400, problem);
  const state = await availability(env, fetchImpl);
  if (!state.ready) return fail(503, state.message);

  const registered = await hostCall(env, fetchImpl, authorization, "POST", "/requests", { interaction_id: input.request_id });
  if (registered.status !== 201) return { status: registered.status, body: registered.body };
  const nhRequestId = registered.body && registered.body.request_id;
  if (typeof nhRequestId !== "string" || !OPAQUE_ID.test(nhRequestId)) {
    return fail(502, "The request host returned no usable request id; nothing was dispatched.");
  }

  let row;
  try {
    row = await dataverse.create(env.NH_DISPATCH_ENTITYSET, {
      [FIELDS.name]: input.request_id,
      [FIELDS.correlation]: input.request_id,
      [FIELDS.nhRequestId]: nhRequestId,
      [FIELDS.handoff]: JSON.stringify(input.handoff),
      [FIELDS.status]: "dispatched"
    });
  } catch {
    // The row may or may not exist. Closing the host request makes every desktop
    // tool call for it fail, so an uncertain dispatch can never acquire a PC.
    await hostCall(env, fetchImpl, authorization, "DELETE", `/requests/${nhRequestId}`);
    return fail(502, "The new-harness dispatch could not be confirmed; the registered request was closed and nothing will run.");
  }
  const dispatchId = row && (row.crcce_nhclaimrequestid || row.id);
  return { status: 202, body: { request_id: input.request_id, nh_request_id: nhRequestId, dispatch_id: dispatchId || null, state: "dispatched" } };
}

function outcomeFrom(report, row) {
  const claim = report.claim && typeof report.claim === "object" ? report.claim : null;
  const cleaned = report.cleanup_completed === true;
  const workflowDone = row && (row[FIELDS.status] === "agent_completed" || row[FIELDS.status] === "agent_failed");
  if (report.requires_reconciliation === true || UNCERTAIN_HOST_STATES.has(report.state)) {
    return { status: "error", error_code: "UNKNOWN", message: `The new-harness request needs reconciliation (host state ${report.state}). It was not retried.` };
  }
  if (!cleaned) return null;
  if (claim && claim.status === "submitted" && claim.evidence === "observed_ui" && CLAIM_ID.test(String(claim.claim_id))) {
    return { status: "submitted", claim_id: claim.claim_id };
  }
  if (claim && claim.status === "error" && claim.evidence === "observed_ui") {
    return { status: "error", error_code: claim.error_code || "UNKNOWN", message: String(claim.message || "The Claims application reported an error.").slice(0, 1000) };
  }
  if (workflowDone) {
    return { status: "error", error_code: "UNKNOWN", message: "The new-harness agent finished, but the host has no verified claim evidence. No claim is reported; check Claims before any new transfer." };
  }
  return null;
}

function releaseFrom(report) {
  if (report.cleanup_completed === true) return { state: "released" };
  if (report.state === "release_uncertain") return { state: "uncertain" };
  if (report.state === "release_accepted") return { state: "pending" };
  return null;
}

async function status(input, { env, fetchImpl, dataverse, authorization }) {
  const { nh_request_id: nhRequestId, dispatch_id: dispatchId } = input;
  if (typeof nhRequestId !== "string" || !OPAQUE_ID.test(nhRequestId)) return fail(400, "A valid nh_request_id is required.");
  if (typeof dispatchId !== "string" || !ROW_ID.test(dispatchId)) return fail(400, "A valid dispatch_id is required.");

  const report = await hostCall(env, fetchImpl, authorization, "GET", `/requests/${nhRequestId}`);
  if (report.status !== 200) return { status: report.status, body: report.body };

  let row;
  try {
    row = await dataverse.get(`${env.NH_DISPATCH_ENTITYSET}(${dispatchId})?$select=${Object.values(FIELDS).filter((f) => f !== FIELDS.handoff).join(",")}`);
  } catch {
    return fail(502, "The new-harness workflow record could not be read.");
  }
  if (!row || row[FIELDS.correlation] !== input.request_id || row[FIELDS.nhRequestId] !== nhRequestId) {
    return fail(409, "The workflow record does not belong to this request.");
  }

  const r = report.body || {};
  const outcome = outcomeFrom(r, row);
  const agentResponse = typeof row[FIELDS.agentResponse] === "string" ? row[FIELDS.agentResponse].slice(0, 2000) : null;
  return {
    status: 200,
    body: {
      request_id: input.request_id,
      nh_request_id: nhRequestId,
      host_state: r.state || null,
      workflow_status: row[FIELDS.status] || null,
      agent_response: agentResponse,
      events: Array.isArray(r.events) ? r.events.slice(-200) : [],
      release: releaseFrom(r),
      outcome,
      running: outcome === null
    }
  };
}

async function cancel(input, { env, fetchImpl, authorization }) {
  if (typeof input.nh_request_id !== "string" || !OPAQUE_ID.test(input.nh_request_id)) return fail(400, "A valid nh_request_id is required.");
  return hostCall(env, fetchImpl, authorization, "DELETE", `/requests/${input.nh_request_id}`);
}

async function relayAction(action, input, { env = process.env, fetchImpl = fetch, dataverse = require("../dataverse/client"), authorization } = {}) {
  if (!ACTIONS.has(action)) return fail(404, "Unknown action.");
  if (!input || typeof input !== "object" || typeof input.request_id !== "string" || !REQUEST_ID.test(input.request_id)) {
    return fail(400, "A valid request_id is required.");
  }
  if (!hostBase(env)) return fail(503, "The new-harness request host is not configured for this service.");
  if (typeof authorization !== "string" || !/^Bearer [A-Za-z0-9._~+/=-]+$/.test(authorization) || authorization.length > 8192) {
    return fail(401, "A signed-in Entra access token for the handoff API is required.");
  }
  const opts = { env, fetchImpl, dataverse, authorization };
  if (action === "start") return start(input, opts);
  if (action === "status") return status(input, opts);
  return cancel(input, opts);
}

function toHttp(r) {
  return { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" }, jsonBody: r.body };
}

app.http("newHarnessClaimsAvailability", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "nh-claims/availability",
  handler: async () => toHttp({ status: 200, body: await availability() })
});

app.http("newHarnessClaimsAction", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "nh-claims/{action}",
  handler: async (request, context) => {
    const action = request.params.action;
    let input;
    try {
      input = await request.json();
    } catch {
      return toHttp(fail(400, "The request body must be JSON."));
    }
    const r = await relayAction(action, input, { authorization: request.headers.get("authorization") || undefined });
    context.log(`nh-claims ${action} ${input && input.request_id} -> ${r.status}`);
    return toHttp(r);
  }
});

module.exports = { relayAction, availability };
