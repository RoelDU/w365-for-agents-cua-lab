/**
 * Self-contained copies of the shared JSON Schemas (schemas/v1/*.json in the
 * monorepo root) plus compiled Ajv validators.
 *
 * They are embedded here — rather than read from ../../schemas at runtime — so
 * the orchestrator is fully portable as a standalone release artifact
 * (LocalOrchestrator.zip) with no dependency on the surrounding repo layout.
 * If the canonical schemas change, update these copies to match (they are
 * version-pinned to the `v1` $id segment).
 */
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

export const callContextSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/RoelDU/CCaaSDemoApp/schemas/v1/call-context.schema.json",
  title: "CallContext",
  type: "object",
  required: ["request_id", "caller_phone", "intent", "summary", "requested_by", "timestamp"],
  additionalProperties: false,
  properties: {
    request_id: { type: "string", pattern: "^REQ-[0-9]{4}-[0-9]{4,}$" },
    caller_phone: { type: "string", pattern: "^\\(\\d{3}\\) \\d{3}-\\d{4}$" },
    policy_number: { type: ["string", "null"], pattern: "^POL-\\d{4}-\\d{6}$" },
    intent: {
      type: "string",
      enum: [
        "auto_collision",
        "auto_theft",
        "auto_glass",
        "home_water",
        "home_fire",
        "home_wind",
        "liability",
        "fraud_investigation",
        "other"
      ]
    },
    summary: { type: "string", minLength: 1, maxLength: 1000 },
    transcript_excerpt: { type: "string", maxLength: 4000 },
    requested_by: {
      type: "object",
      required: ["agent_id", "display_name"],
      additionalProperties: false,
      properties: {
        agent_id: { type: "string" },
        display_name: { type: "string" },
        email: { type: "string", format: "email" }
      }
    },
    timestamp: { type: "string", format: "date-time" },
    target_backend: { type: "string", enum: ["mcs", "foundry"] }
  }
} as const;

export const prefillSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/RoelDU/CCaaSDemoApp/schemas/v1/prefill.schema.json",
  title: "Prefill",
  type: "object",
  required: ["request_id", "caller_phone", "intent", "summary", "requested_by"],
  additionalProperties: false,
  properties: {
    request_id: { type: "string", pattern: "^REQ-[0-9]{4}-[0-9]{4,}$" },
    caller_phone: { type: "string", pattern: "^\\(\\d{3}\\) \\d{3}-\\d{4}$" },
    policy_number: { type: ["string", "null"], pattern: "^POL-\\d{4}-\\d{6}$" },
    intent: {
      type: "string",
      enum: [
        "auto_collision",
        "auto_theft",
        "auto_glass",
        "home_water",
        "home_fire",
        "home_wind",
        "liability",
        "fraud_investigation",
        "other"
      ]
    },
    summary: { type: "string", minLength: 1, maxLength: 1000 },
    requested_by: { type: "string" },
    target_backend: { type: "string", enum: ["mcs", "foundry"] }
  }
} as const;

export const readySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/RoelDU/CCaaSDemoApp/schemas/v1/ready.schema.json",
  title: "Ready",
  type: "object",
  required: ["request_id", "status", "window_title", "timestamp"],
  additionalProperties: false,
  properties: {
    request_id: { type: "string", pattern: "^REQ-[0-9]{4}-[0-9]{4,}$" },
    status: { const: "ready" },
    window_title: { type: "string" },
    matched_policy_number: { type: ["string", "null"], pattern: "^POL-\\d{4}-\\d{6}$" },
    matched_customer_name: { type: ["string", "null"] },
    timestamp: { type: "string", format: "date-time" }
  }
} as const;

export const resultSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/RoelDU/CCaaSDemoApp/schemas/v1/result.schema.json",
  title: "Result",
  type: "object",
  required: ["request_id", "status", "claim_id", "agent_id", "timestamp"],
  additionalProperties: false,
  properties: {
    request_id: { type: "string", pattern: "^REQ-[0-9]{4}-[0-9]{4,}$" },
    status: { const: "submitted" },
    claim_id: { type: "string", pattern: "^CLM-\\d{4}-\\d{6}$" },
    policy_number: { type: "string", pattern: "^POL-\\d{4}-\\d{6}$" },
    agent_id: { type: "string" },
    reserve_amount: { type: ["number", "null"], minimum: 0 },
    timestamp: { type: "string", format: "date-time" }
  }
} as const;

export const errorSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/RoelDU/CCaaSDemoApp/schemas/v1/error.schema.json",
  title: "Error",
  type: "object",
  required: ["request_id", "status", "error_code", "message", "timestamp"],
  additionalProperties: false,
  properties: {
    request_id: { type: "string", pattern: "^REQ-[0-9]{4}-[0-9]{4,}$" },
    status: { const: "error" },
    error_code: {
      type: "string",
      enum: [
        "POLICY_NOT_FOUND",
        "PREFILL_INVALID",
        "HOST_LINK_DOWN",
        "COVERAGE_NOT_APPLICABLE",
        "SUBMISSION_REJECTED",
        "USER_CANCELLED",
        "UNKNOWN"
      ]
    },
    message: { type: "string", minLength: 1, maxLength: 1000 },
    timestamp: { type: "string", format: "date-time" }
  }
} as const;

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);

export const validateCallContext: ValidateFunction = ajv.compile(callContextSchema);
export const validatePrefill: ValidateFunction = ajv.compile(prefillSchema);
export const validateReady: ValidateFunction = ajv.compile(readySchema);
export const validateResult: ValidateFunction = ajv.compile(resultSchema);
export const validateError: ValidateFunction = ajv.compile(errorSchema);

/** Render Ajv errors into a single human-readable string. */
export function formatErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`.trim())
    .join("; ");
}
