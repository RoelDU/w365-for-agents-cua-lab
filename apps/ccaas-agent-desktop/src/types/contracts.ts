/**
 * TypeScript mirror of the shared JSON schemas at C:\Dev\Work\CCaaSDemoApp\schemas\.
 * These are the contract types between this app, the orchestrator, and the
 * sibling Legacy Claims Workstation. Do NOT diverge from the schemas — they
 * are the source of truth and are validated at runtime via Ajv.
 */

export type Intent =
  | "auto_collision"
  | "auto_theft"
  | "auto_glass"
  | "home_water"
  | "home_fire"
  | "home_wind"
  | "liability"
  | "fraud_investigation"
  | "other";

export interface RequestedBy {
  agent_id: string;
  display_name: string;
  email?: string;
}

/** The AI backend a handoff is routed to (the desktop backend toggle). */
export type TargetBackend = "mcs" | "foundry";

/** call-context.schema.json — emitted by this app at handoff time. */
export interface CallContext {
  request_id: string;
  caller_phone: string;
  policy_number?: string | null;
  intent: Intent;
  summary: string;
  transcript_excerpt?: string;
  requested_by: RequestedBy;
  timestamp: string;
  /** Which backend the presenter routed this handoff to. Consumers that drive the
   * Cloud PC via CUA must ignore handoffs not addressed to them. */
  target_backend?: TargetBackend;
}

/** prefill.schema.json — projection the orchestrator (or this app, in file
 * mode) writes into the legacy app's handoff `in\` folder. */
export interface Prefill {
  request_id: string;
  caller_phone: string;
  policy_number?: string | null;
  intent: Intent;
  summary: string;
  requested_by: string;
  target_backend?: TargetBackend;
}

/** ready.schema.json — written by the legacy app to handoff `out\`. */
export interface ReadyMessage {
  request_id: string;
  status: "ready";
  window_title: string;
  matched_policy_number?: string | null;
  matched_customer_name?: string | null;
  timestamp: string;
}

/** result.schema.json — written by the legacy app after submit. */
export interface ResultMessage {
  request_id: string;
  status: "submitted";
  claim_id: string;
  policy_number?: string;
  agent_id: string;
  reserve_amount?: number | null;
  timestamp: string;
}

export type ErrorCode =
  | "POLICY_NOT_FOUND"
  | "PREFILL_INVALID"
  | "HOST_LINK_DOWN"
  | "COVERAGE_NOT_APPLICABLE"
  | "SUBMISSION_REJECTED"
  | "USER_CANCELLED"
  | "UNKNOWN";

/** error.schema.json — written by the legacy app on unrecoverable error. */
export interface ErrorMessage {
  request_id: string;
  status: "error";
  error_code: ErrorCode;
  message: string;
  timestamp: string;
}

/** State machine for the AI Agent Status card, as observed from the orchestrator. */
export type HandoffStatus =
  | "idle"
  | "queued"
  | "prefilled"
  | "ready"
  | "submitted"
  | "error";

export interface HandoffStatusPayload {
  request_id: string;
  status: HandoffStatus;
  window_title?: string;
  matched_policy_number?: string | null;
  matched_customer_name?: string | null;
  claim_id?: string;
  policy_number?: string;
  agent_id?: string;
  reserve_amount?: number | null;
  error_code?: ErrorCode;
  message?: string;
  timestamp?: string;
}
