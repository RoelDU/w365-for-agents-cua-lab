/*
 * contract.js - PURE helpers (no I/O) shared by the handoff + status Functions.
 *
 * Kept dependency-free and side-effect-free so the request/response mapping can
 * be unit-tested with `node --test` without any Azure or network access.
 *
 * Two seams:
 *   Seam #1 (CCaaS app -> AI agent): the call-context JSON validated here and
 *     posted to Foundry as the agent's first run message. This is realistic.
 *   Seam #2 (agent -> legacy app): NOT modelled here at all. The agent drives
 *     the legacy Win32 app purely on screen; the claim id comes back only in the
 *     agent's final natural-language message, which we parse below.
 */

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

/**
 * Validate the CallContext envelope (mirrors schemas/call-context.schema.json,
 * additionalProperties:false). Returns { valid, errors }.
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
 * The message the agent receives as the start of its run. The agent's
 * instructions tell it to read caller_phone / policy_number / intent / summary
 * from this payload and then drive the legacy app on screen.
 */
function buildHandoffMessage(ctx) {
  return [
    "A contact-center representative has transferred a First Notice of Loss task to you.",
    "File a single FNOL in the Zava Mutual Claims Workstation and reply with the claim ID.",
    "Handoff payload:",
    JSON.stringify(
      {
        request_id: ctx.request_id,
        caller_phone: ctx.caller_phone,
        policy_number: ctx.policy_number ?? null,
        intent: ctx.intent,
        summary: ctx.summary,
        requested_by: ctx.requested_by
      },
      null,
      2
    )
  ].join("\n");
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
 * Map a Foundry run object (+ the agent's final assistant text, if any) onto the
 * desktop's HandoffStatusPayload contract.
 *
 * Foundry run.status: queued | in_progress | requires_action | completed |
 *                     failed | cancelled | expired
 */
function mapRunToStatus(requestId, run, lastAssistantText) {
  const base = { request_id: requestId, timestamp: new Date().toISOString() };
  const runStatus = run && run.status;

  switch (runStatus) {
    case "queued":
      return { ...base, status: "queued" };
    case "in_progress":
    case "requires_action":
      // The agent is actively driving the legacy app on the Cloud PC.
      return { ...base, status: "ready" };
    case "completed": {
      const claimId = extractClaimId(lastAssistantText);
      if (claimId) {
        return { ...base, status: "submitted", claim_id: claimId, message: lastAssistantText };
      }
      // Completed without a claim id => the agent reported a handled failure
      // (e.g. "Filing failed: POLICY_NOT_FOUND - ...") in its final message.
      return {
        ...base,
        status: "error",
        error_code: extractErrorCode(lastAssistantText) || "UNKNOWN",
        message: lastAssistantText || "Agent completed without returning a claim ID."
      };
    }
    case "failed":
    case "cancelled":
    case "expired":
      return {
        ...base,
        status: "error",
        error_code: extractErrorCode(lastAssistantText) || "UNKNOWN",
        message:
          (run && run.last_error && run.last_error.message) ||
          lastAssistantText ||
          `Foundry run ${runStatus}.`
      };
    default:
      return { ...base, status: "queued" };
  }
}

module.exports = {
  validateCallContext,
  buildHandoffMessage,
  extractClaimId,
  extractErrorCode,
  mapRunToStatus,
  INTENTS,
  ERROR_CODES
};
