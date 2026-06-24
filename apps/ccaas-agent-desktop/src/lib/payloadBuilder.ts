import type { CallContext, TargetBackend } from "@/types/contracts";
import type { HeroScenario, AgentIdentity } from "@/types/domain";

/**
 * Build a monotonically-increasing request ID of the form REQ-YYYY-NNNN.
 * The numeric suffix is derived from a localStorage counter so successive
 * handoffs from the same browser don't collide and the format always
 * matches the schema pattern `^REQ-[0-9]{4}-[0-9]{4,}$`.
 */
const REQ_COUNTER_KEY = "ccaas:request-counter";

export function generateRequestId(now: Date = new Date()): string {
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  let counter = 1;
  try {
    const raw = window.localStorage.getItem(REQ_COUNTER_KEY);
    counter = raw ? Math.max(1, parseInt(raw, 10) + 1) : 1;
    window.localStorage.setItem(REQ_COUNTER_KEY, String(counter));
  } catch {
    // SSR / locked-down storage fallback
    counter = Math.floor(1000 + Math.random() * 9000);
  }
  const suffix = String(counter).padStart(4, "0");
  return `REQ-${year}-${suffix}`;
}

/**
 * Reset the counter — only used by the "Reset demo state" Settings action
 * and by tests that need a deterministic starting point.
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
