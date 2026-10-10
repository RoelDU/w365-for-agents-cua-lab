import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import callContextSchema from "@/schemas/call-context.schema.json";
import prefillSchema from "@/schemas/prefill.schema.json";
import readySchema from "@/schemas/ready.schema.json";
import resultSchema from "@/schemas/result.schema.json";
import errorSchema from "@/schemas/error.schema.json";

import type {
  CallContext,
  Prefill,
  ReadyMessage,
  ResultMessage,
  ErrorMessage,
  HandoffStatusPayload,
  HandoffAcknowledgement
} from "@/types/contracts";

const ajv = new Ajv2020({
  allErrors: true,
  strict: false
});
addFormats(ajv);

function compile<T>(schema: object): ValidateFunction<T> {
  return ajv.compile<T>(schema);
}

export const validateCallContext = compile<CallContext>(callContextSchema as object);
export const validatePrefill = compile<Prefill>(prefillSchema as object);
export const validateReady = compile<ReadyMessage>(readySchema as object);
export const validateResult = compile<ResultMessage>(resultSchema as object);
export const validateError = compile<ErrorMessage>(errorSchema as object);

const statusProperties = {
  ...readySchema.properties, ...resultSchema.properties, ...errorSchema.properties,
  status: { enum: ["queued", "prefilled", "ready", "submitted", "error"] },
  execution_mode: { enum: ["simulation", "live"] },
  activity: {
    type: "array", maxItems: 50,
    items: {
      type: "object", required: ["id", "ts_iso", "level", "message"],
      properties: {
        id: { type: "string", minLength: 1 },
        ts_iso: { type: "string", format: "date-time" },
        level: { enum: ["info", "warn", "error"] },
        message: { type: "string", maxLength: 4000 }
      }
    }
  }
};

export const validateHandoffStatus = compile<HandoffStatusPayload>({
  type: "object", required: ["request_id", "status"],
  properties: statusProperties,
  allOf: [
    { if: { properties: { status: { const: "submitted" } } }, then: { required: ["claim_id"] } },
    { if: { properties: { status: { const: "error" } } }, then: { required: ["error_code", "message"] } }
  ]
});

export const validateHandoffAcknowledgement = compile<HandoffAcknowledgement>({
  type: "object", required: ["request_id", "status"],
  properties: {
    request_id: statusProperties.request_id, status: statusProperties.status,
    handoff_id: { type: "string", minLength: 1 }, status_url: { type: "string" },
    execution_mode: statusProperties.execution_mode
  }
});

export interface ValidationResult<T> {
  ok: boolean;
  errors: string[];
  data: T;
}

function runValidator<T>(validator: ValidateFunction<T>, data: unknown): ValidationResult<T> {
  const ok = validator(data) as boolean;
  const errors = ok
    ? []
    : (validator.errors ?? []).map(
        (e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`.trim()
      );
  return { ok, errors, data: data as T };
}

export const validators = {
  callContext: (data: unknown) => runValidator(validateCallContext, data),
  prefill: (data: unknown) => runValidator(validatePrefill, data),
  ready: (data: unknown) => runValidator(validateReady, data),
  result: (data: unknown) => runValidator(validateResult, data),
  error: (data: unknown) => runValidator(validateError, data)
};

/**
 * Dev-mode strict throw / production-mode warn-and-continue.
 * Use for outbound payloads we are about to emit.
 */
export function assertValid<T>(
  result: ValidationResult<T>,
  label: string,
  isDev: boolean
): T {
  if (result.ok) return result.data;
  const message = `[${label}] schema validation failed: ${result.errors.join("; ")}`;
  if (isDev) {
    throw new Error(message);
  }
  console.warn(message);
  return result.data;
}
