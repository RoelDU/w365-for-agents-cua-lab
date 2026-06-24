/**
 * TypeScript mirror of the shared JSON contracts in the repo's schemas\ folder.
 * These are the contract between the CCaaS Agent Desktop, the local orchestrator
 * (which captures the CCaaS outcome into in\prefill.json), THIS Foundry + Windows
 * 365 for Agents runner, and the legacy Zava Claims Workstation.
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

/** call-context.schema.json - emitted by the CCaaS desktop at handoff time. */
export interface CallContext {
  request_id: string;
  caller_phone: string;
  policy_number?: string | null;
  intent: Intent;
  summary: string;
  transcript_excerpt?: string;
  requested_by: RequestedBy;
  timestamp: string;
}

/** prefill.schema.json - the captured CCaaS outcome the runner reads from in\prefill.json. */
export interface Prefill {
  request_id: string;
  caller_phone: string;
  policy_number?: string | null;
  intent: Intent;
  summary: string;
  requested_by: string;
  /** Which backend the presenter routed this handoff to. The runner ignores a prefill
   * whose target_backend is set and does not match its own backendId, so the MCS and
   * Foundry agents never both drive the Cloud PC for the same handoff. */
  target_backend?: "mcs" | "foundry";
}

/** ready.schema.json - written to out\ when the app is up and the policy is on screen. */
export interface ReadyMessage {
  request_id: string;
  status: "ready";
  window_title: string;
  matched_policy_number?: string | null;
  matched_customer_name?: string | null;
  timestamp: string;
}

/** result.schema.json - written to out\ after the FNOL is submitted. */
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

/** error.schema.json - written to out\ on an unrecoverable error. */
export interface ErrorMessage {
  request_id: string;
  status: "error";
  error_code: ErrorCode;
  message: string;
  timestamp: string;
}

// --------------------------------------------------------------------------
// Runner-internal types (not part of the cross-app JSON contract)
// --------------------------------------------------------------------------

export type RunnerMode = "simulation" | "live";

/** The normalized outcome a driver returns for one captured handoff. */
export type DriveOutcome =
  | {
      kind: "result";
      claim_id: string;
      policy_number?: string | null;
      agent_id: string;
      reserve_amount?: number | null;
    }
  | {
      kind: "error";
      error_code: ErrorCode;
      message: string;
    };

/** Emitted once the Cloud PC app is up and the policy is on screen. */
export interface ReadySignal {
  window_title: string;
  matched_policy_number?: string | null;
  matched_customer_name?: string | null;
}

/** A live Windows 365 for Agents Cloud PC session (check-out -> drive -> check-in). */
export interface W365ASession {
  sessionId: string;
  computerId: string;
  /** Optional connection metadata returned by the pool (kept opaque). */
  connection?: Record<string, unknown>;
}

/**
 * A Computer Use action as returned by the Foundry responses API in a
 * `computer_call.actions[]` array (screenshot, click, type, keypress, scroll, ...).
 * Kept loose because the preview surface evolves; the live driver maps these onto
 * the Windows 365 for Agents MCP tool calls.
 */
export interface ComputerAction {
  type: string;
  [key: string]: unknown;
}
