/*
 * contract.js - PURE helpers (no I/O) for the standalone handoff orchestrator.
 *
 * Dependency-free and side-effect-free so the whole request/response/result
 * mapping can be unit-tested with `node --test` (no Azure, no network, no DF
 * runtime). All Direct Line / Durable Functions I/O lives in the channel adapter
 * and the activity/HTTP functions; this module only shapes and interprets data.
 *
 * Two seams:
 *   Seam #1 (CCaaS app -> AI agent): the CallContext validated here, projected
 *     into a NEUTRAL-named context envelope (the "global variables" bag) so the
 *     same agent works whether the CCaaS layer is Zava (Direct Line adapter) or
 *     Dynamics 365 Contact Center (native Omnichannel channel). See
 *     docs/handoff-architecture-decision.md.
 *   Seam #2 (agent -> legacy app): NOT modelled here. The agent drives claims.exe
 *     on screen; the claim id returns via a STRUCTURED result (typed flow
 *     callback) - or, as a demo-speed fallback, a sentinel-wrapped JSON block in
 *     the bot's final message (parseActivities).
 */

"use strict";

const crypto = require("node:crypto");

const INTENTS = new Set([
  "auto_collision",
  "auto_theft",
  "auto_glass",
  "home_water",
  "home_fire",
  "home_wind",
  "liability",
  "fraud_investigation",
  "other"
]);

const ERROR_CODES = new Set([
  "POLICY_NOT_FOUND",
  "PREFILL_INVALID",
  "HOST_LINK_DOWN",
  "COVERAGE_NOT_APPLICABLE",
  "SUBMISSION_REJECTED",
  "USER_CANCELLED",
  "UNKNOWN"
]);

const CLAIM_ID_RE = /CLM-\d{4}-\d{6}/;

// A bot message may wrap a typed result as a JSON block when the tenant cannot
// emit outbound event activities. parseActivities reads this first.
const RESULT_SENTINEL_RE = /HANDOFF_RESULT_JSON:\s*([\s\S]*?)\s*END_HANDOFF_RESULT_JSON/;

/**
 * Validate the CallContext envelope (mirrors schemas/call-context.schema.json).
 * Returns { valid, errors }.
 */
function validateCallContext(body) {
  const errors = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { valid: false, errors: ["body must be a JSON object"] };
  }
  const reqStr = (k) => {
    if (typeof body[k] !== "string" || body[k].length === 0) {
      errors.push(`${k} is required and must be a non-empty string`);
    }
  };
  reqStr("request_id");
  reqStr("caller_phone");
  reqStr("summary");
  reqStr("timestamp");

  if (!INTENTS.has(body.intent)) {
    errors.push(`intent must be one of: ${[...INTENTS].join(", ")}`);
  }
  if (
    body.policy_number !== undefined &&
    body.policy_number !== null &&
    typeof body.policy_number !== "string"
  ) {
    errors.push("policy_number, when present, must be a string or null");
  }
  const rb = body.requested_by;
  if (typeof rb !== "object" || rb === null) {
    errors.push("requested_by is required and must be an object");
  } else {
    if (typeof rb.agent_id !== "string" || rb.agent_id.length === 0) {
      errors.push("requested_by.agent_id is required");
    }
    if (typeof rb.display_name !== "string" || rb.display_name.length === 0) {
      errors.push("requested_by.display_name is required");
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Project a validated CallContext into the NEUTRAL context envelope sent to the
 * agent (Copilot Studio Global variables marked "external sources can set
 * values"). Names are channel-agnostic on purpose: the Zava Direct Line adapter
 * sets them via a pvaSetContext event; a future D365 Contact Center adapter maps
 * the same concepts from msdyn_* variables. Flat strings only (Copilot Studio
 * global variables discourage nesting); the human agent identity travels for
 * audit (the handoff is attributable, never "faceless").
 */
function buildContextEnvelope(ctx) {
  const rb = ctx.requested_by || {};
  return {
    correlation_id: ctx.request_id,
    // The durable handoff id the agent must echo into its result callback URL
    // (POST /api/handoff/{handoff_id}/result). The HTTP layer does not know the
    // final instance id yet (retry suffixes), so the orchestrator stamps the
    // real value before the envelope reaches the agent; default empty here.
    handoff_id: ctx.handoff_id == null ? "" : ctx.handoff_id,
    source_system: "Zava",
    caller_phone: ctx.caller_phone,
    policy_number: ctx.policy_number == null ? "" : ctx.policy_number,
    intent: ctx.intent,
    summary: ctx.summary,
    transcript_excerpt: ctx.transcript_excerpt == null ? "" : ctx.transcript_excerpt,
    agent_user_id: rb.agent_id || "",
    agent_display_name: rb.display_name || "",
    agent_email: rb.email || "",
    requested_at: ctx.timestamp
  };
}

/**
 * Idempotency key for exactly-once FNOL. Stable across retries of the SAME
 * logical handoff so the deterministic instance id dedupes duplicate POSTs.
 * NOTE: backend dedupe is necessary but NOT sufficient - the agent must also do
 * a pre-create duplicate check in claims.exe and a human reviews the result.
 */
function idempotencyKey(ctx) {
  const parts = [
    "zava",
    ctx.request_id || "",
    ctx.policy_number || "",
    ctx.caller_phone || "",
    ctx.intent || ""
  ];
  return parts.join("|");
}

/** Deterministic Durable Functions instance id derived from the idempotency key. */
function instanceIdFor(ctx) {
  const hash = crypto.createHash("sha256").update(idempotencyKey(ctx)).digest("hex");
  return `handoff-${hash.slice(0, 32)}`;
}

/**
 * The trigger message the agent receives (after pvaSetContext) to start the FNOL
 * business logic. Context is read from global variables, not parsed from here -
 * this just kicks the topic.
 */
function buildTriggerText(triggerText) {
  return typeof triggerText === "string" && triggerText.length > 0
    ? triggerText
    : "start handoff";
}

function extractClaimId(text) {
  if (typeof text !== "string") return undefined;
  const m = text.match(CLAIM_ID_RE);
  return m ? m[0] : undefined;
}

function extractErrorCode(text) {
  if (typeof text !== "string") return undefined;
  const upper = text.toUpperCase();
  for (const code of ERROR_CODES) {
    if (upper.includes(code)) return code;
  }
  return undefined;
}

/**
 * Normalize a STRUCTURED completion payload (from the typed Power Automate flow
 * callback raised as the "handoffResult" external event, or an outbound event
 * activity) into the internal terminal-result shape. Trusts explicit fields over
 * text. Returns a terminal result object: { status, claim_id?, error_code?, ... }.
 */
function normalizeResult(payload) {
  if (typeof payload !== "object" || payload === null) {
    return { status: "error", error_code: "UNKNOWN", message: "Empty result payload." };
  }
  const status = String(payload.status || "").toLowerCase();
  const claimId = payload.claim_id || extractClaimId(payload.message);
  if (status === "succeeded" || status === "submitted" || (!status && claimId)) {
    if (!claimId) {
      return {
        status: "error",
        error_code: "UNKNOWN",
        message: "Success reported without a claim id."
      };
    }
    return {
      status: "succeeded",
      claim_id: claimId,
      policy_number: payload.policy_number,
      reserve_amount: payload.reserve_amount ?? null,
      legacy_agent_id: payload.legacy_agent_id || payload.agent_id,
      message: payload.message
    };
  }
  // Anything not an explicit success is treated as an error/disposition.
  return {
    status: "error",
    error_code: ERROR_CODES.has(payload.error_code) ? payload.error_code : "UNKNOWN",
    message: payload.message || `Agent reported status "${payload.status}".`
  };
}

/**
 * Inspect a batch of Direct Line activities (newest handling order is the
 * caller's responsibility) for a TERMINAL result. Used by the polling fallback
 * when no structured callback has arrived. Reads, in priority order:
 *   1. a custom event activity named "handoffResult" carrying a structured value
 *   2. a sentinel-wrapped JSON block in a bot message
 *   3. a bare claim id (success) or known error code (failure) in a bot message
 * Returns a terminal result object or null (not done yet). Only considers
 * activities whose correlation matches when a correlationId is supplied.
 */
function parseActivities(activities, correlationId) {
  if (!Array.isArray(activities)) return null;

  // Consider only bot-originated activities (ignore echoes of our own user
  // activities and anything with no sender).
  const botActs = activities.filter(
    (act) =>
      act &&
      act.from !== undefined &&
      !(act.from && act.from.id && String(act.from.role).toLowerCase() === "user")
  );

  // Priority is enforced GLOBALLY across the whole batch, not per-activity: a
  // later structured result must win over an earlier heuristic claim id in the
  // same poll. Hence three ordered passes.

  // Pass 1: structured outbound event activity named "handoffResult".
  for (const act of botActs) {
    if (act.type === "event" && act.name === "handoffResult" && act.value) {
      if (matchesCorrelation(act.value, correlationId)) return normalizeResult(act.value);
    }
  }

  // Pass 2: sentinel-wrapped JSON block in a bot message.
  for (const act of botActs) {
    if (act.type !== "message" || typeof act.text !== "string") continue;
    const m = act.text.match(RESULT_SENTINEL_RE);
    if (m) {
      try {
        const value = JSON.parse(m[1]);
        if (matchesCorrelation(value, correlationId)) return normalizeResult(value);
      } catch {
        /* fall through to text heuristics */
      }
    }
  }

  // Pass 3: bare claim id (success) or known error code (failure) - heuristic.
  for (const act of botActs) {
    if (act.type !== "message" || typeof act.text !== "string") continue;
    const claimId = extractClaimId(act.text);
    if (claimId) {
      return { status: "succeeded", claim_id: claimId, message: act.text };
    }
    const errorCode = extractErrorCode(act.text);
    if (errorCode) {
      return { status: "error", error_code: errorCode, message: act.text };
    }
  }

  return null;
}

function matchesCorrelation(value, correlationId) {
  if (!correlationId) return true;
  if (!value || typeof value !== "object") return true;
  const cid = value.correlation_id || value.request_id;
  // If the payload carries no correlation id we accept it (single-conversation).
  return cid === undefined || cid === null || cid === correlationId;
}

/**
 * Map the Durable Functions runtime + custom status onto the frontend's
 * HandoffStatusPayload. The frontend status union is unchanged
 * (idle|queued|prefilled|ready|submitted|error); the backend lifecycle
 * (queued -> working -> succeeded|failed|timed_out) maps onto it:
 *   working   -> ready     (agent is driving claims.exe; you're monitoring)
 *   succeeded -> submitted
 *   failed / timed_out -> error
 */
function mapJobToStatus(requestId, runtimeStatus, customStatus) {
  const base = { request_id: requestId, timestamp: new Date().toISOString() };
  const cs = customStatus && typeof customStatus === "object" ? customStatus : {};

  // A terminal custom status carries the result detail.
  if (cs.state === "succeeded" || cs.result?.status === "succeeded") {
    const r = cs.result || cs;
    return {
      ...base,
      status: "submitted",
      claim_id: r.claim_id,
      policy_number: r.policy_number,
      agent_id: r.legacy_agent_id,
      reserve_amount: r.reserve_amount ?? null,
      message: r.message
    };
  }
  if (cs.state === "failed" || cs.state === "timed_out" || cs.result?.status === "error") {
    const r = cs.result || cs;
    return {
      ...base,
      status: "error",
      error_code: ERROR_CODES.has(r.error_code) ? r.error_code : "UNKNOWN",
      message: r.message || (cs.state === "timed_out" ? "Handoff timed out." : "Handoff failed.")
    };
  }
  if (cs.state === "working") {
    return {
      ...base,
      status: "ready",
      window_title: cs.window_title,
      matched_policy_number: cs.matched_policy_number,
      matched_customer_name: cs.matched_customer_name
    };
  }
  if (cs.state === "queued") {
    return { ...base, status: "queued" };
  }

  // Fall back to the raw Durable runtime status when no custom status is set yet.
  switch (runtimeStatus) {
    case "Completed":
      // Completed with no terminal custom status => unexpected; treat as error.
      return { ...base, status: "error", error_code: "UNKNOWN", message: "Handoff completed without a result." };
    case "Failed":
    case "Terminated":
      return { ...base, status: "error", error_code: "UNKNOWN", message: `Handoff ${runtimeStatus}.` };
    case "Running":
    case "Pending":
    case "ContinuedAsNew":
      return { ...base, status: "queued" };
    default:
      return { ...base, status: "queued" };
  }
}

module.exports = {
  validateCallContext,
  buildContextEnvelope,
  idempotencyKey,
  instanceIdFor,
  buildTriggerText,
  extractClaimId,
  extractErrorCode,
  normalizeResult,
  parseActivities,
  mapJobToStatus,
  INTENTS,
  ERROR_CODES
};
