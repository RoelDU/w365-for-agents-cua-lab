import type { CallContext, TargetBackend } from "@/types/contracts";
import type { HeroScenario, AgentIdentity } from "@/types/domain";

/**
 * Build a request ID of the form REQ-YYYY-NNNNNNNNNNNN. The 12-digit suffix is
 * random (crypto), so IDs are new for every claim, do not collide across
 * browsers, and cannot be guessed from a previous one. It always matches the
 * schema pattern `^REQ-[0-9]{4}-[0-9]{4,}$`.
 */
const REQ_COUNTER_KEY = "ccaas:request-counter";
const SUFFIX_DIGITS = 12;

export function generateRequestId(now: Date = new Date()): string {
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const bytes = new Uint8Array(SUFFIX_DIGITS);
  globalThis.crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => String(b % 10)).join("");
  return `REQ-${year}-${suffix}`;
}

/**
 * Clears the counter left by earlier builds. Used by the "Reset demo state"
 * action; IDs no longer depend on it.
 */
export function resetRequestIdCounter(): void {
  try {
    window.localStorage.removeItem(REQ_COUNTER_KEY);
  } catch {
    /* ignore */
  }
}

export interface BuildCallContextInput {
  scenario: HeroScenario;
  agent: AgentIdentity;
  summary: string;
  transcriptExcerpt?: string;
  requestId?: string;
  now?: Date;
  /** The backend the presenter selected; stamped onto the handoff so the
   * non-selected agent stands down and never drives the Cloud PC in parallel. */
  backend?: TargetBackend;
}

/**
 * Build a CallContext payload conforming to call-context.schema.json.
 * Truncates fields to schema maxLengths defensively.
 */
export function buildCallContext(input: BuildCallContextInput): CallContext {
  const now = input.now ?? new Date();
  const requestId = input.requestId ?? generateRequestId(now);
  const summary = (input.summary || input.scenario.summary_seed).slice(0, 1000);
  const transcriptExcerpt = input.transcriptExcerpt
    ? input.transcriptExcerpt.slice(0, 4000)
    : undefined;

  const ctx: CallContext = {
    request_id: requestId,
    caller_phone: input.scenario.caller_phone,
    policy_number: input.scenario.policy_number ?? null,
    intent: input.scenario.intent,
    summary,
    requested_by: {
      agent_id: input.agent.agent_id,
      display_name: input.agent.display_name,
      ...(input.agent.email ? { email: input.agent.email } : {})
    },
    timestamp: now.toISOString()
  };
  if (transcriptExcerpt) {
    ctx.transcript_excerpt = transcriptExcerpt;
  }
  if (input.backend) {
    ctx.target_backend = input.backend;
  }
  return ctx;
}
