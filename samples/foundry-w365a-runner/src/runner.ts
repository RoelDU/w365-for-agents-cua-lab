import type { RunnerConfig } from "./config";
import type { Prefill, DriveOutcome, ReadySignal, ErrorCode } from "./types";
import type { W365AProvider } from "./w365aSession";
import { createW365AProvider } from "./w365aSession";
import { runComputerUse, loadInstructions } from "./computerUse";

export interface DriverHooks {
  /** Called once the Cloud PC app is up and the policy is on screen. */
  onReady?: (ready: ReadySignal) => void | Promise<void>;
}

export interface AgentDriver {
  /** Drive one captured handoff end-to-end and return its outcome. */
  run(prefill: Prefill, hooks?: DriverHooks): Promise<DriveOutcome>;
}

/** Strip the "ccaas-desktop:" prefix the orchestrator adds to requested_by. */
export function agentIdFromPrefill(prefill: Prefill): string {
  const raw = prefill.requested_by ?? "";
  const colon = raw.lastIndexOf(":");
  const id = colon >= 0 ? raw.slice(colon + 1) : raw;
  return id || "unknown-agent";
}

/** Deterministically derive a demo claim ID from the request ID (CLM-YYYY-NNNNNN). */
export function deriveClaimId(requestId: string): string {
  const m = requestId.match(/^REQ-(\d{4})-(\d+)$/);
  const year = m ? m[1] : "2024";
  const seq = (m ? m[2] : "000000").slice(-6).padStart(6, "0");
  return `CLM-${year}-${seq}`;
}

const ERROR_CODES: ErrorCode[] = [
  "POLICY_NOT_FOUND",
  "PREFILL_INVALID",
  "HOST_LINK_DOWN",
  "COVERAGE_NOT_APPLICABLE",
  "SUBMISSION_REJECTED",
  "USER_CANCELLED",
  "UNKNOWN"
];

/** Interpret the model's final message into a result or a typed error. */
export function interpretFinalMessage(text: string, prefill: Prefill): DriveOutcome {
  const claim = text.match(/CLM-\d{4}-\d{6}/);
  if (claim) {
    return {
      kind: "result",
      claim_id: claim[0],
      policy_number: prefill.policy_number ?? null,
      agent_id: agentIdFromPrefill(prefill),
      reserve_amount: null
    };
  }
  const code = ERROR_CODES.find((c) => text.includes(c)) ?? "UNKNOWN";
  return {
    kind: "error",
    error_code: code,
    message: text.trim().slice(0, 1000) || "The agent finished without reporting a claim ID."
  };
}

function buildTask(prefill: Prefill): string {
  return [
    "A contact-center handoff has arrived. Launch the Zava Mutual Claims Workstation,",
    "find the caller's policy, file a First Notice of Loss, and then state the resulting",
    "claim ID in your final message. The handoff details are:",
    "```json",
    JSON.stringify(prefill, null, 2),
    "```"
  ].join("\n");
}

/**
 * Live driver: check out a Windows 365 for Agents Cloud PC, drive the legacy app
 * with the Foundry Computer Use loop, then check the Cloud PC back in.
 */
export class LiveAgentDriver implements AgentDriver {
  constructor(
    private readonly config: RunnerConfig,
    private readonly provider: W365AProvider = createW365AProvider(config)
  ) {}

  async run(prefill: Prefill, hooks?: DriverHooks): Promise<DriveOutcome> {
    const { session, computer } = await this.provider.checkout();
    try {
      await computer.launch(this.config.w365a.launchCommand);
      await hooks?.onReady?.({
        window_title: "Zava Mutual \u2014 Claims Workstation v1.0",
        matched_policy_number: prefill.policy_number ?? null,
        matched_customer_name: null
      });

      const instructions = await loadInstructions();
      const finalText = await runComputerUse(this.config, computer, {
        instructions,
        task: buildTask(prefill)
      });
      return interpretFinalMessage(finalText, prefill);
    } finally {
      await this.provider.checkin(session).catch((err) =>
        console.error(`[runner] check-in failed for ${session.sessionId}:`, err)
      );
    }
  }
}

/**
 * Simulation driver: deterministic, no Azure calls. Emits a ready signal and a
 * synthesized claim result so the full capture -> drive -> relay loop is
 * exercisable (and testable) without a Cloud PC or model access.
 */
export class SimulationAgentDriver implements AgentDriver {
  constructor(private readonly delayMs = 0) {}

  async run(prefill: Prefill, hooks?: DriverHooks): Promise<DriveOutcome> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    await hooks?.onReady?.({
      window_title: "Zava Mutual \u2014 Claims Workstation v1.0",
      matched_policy_number: prefill.policy_number ?? null,
      matched_customer_name: null
    });
    return {
      kind: "result",
      claim_id: deriveClaimId(prefill.request_id),
      policy_number: prefill.policy_number ?? null,
      agent_id: agentIdFromPrefill(prefill),
      reserve_amount: null
    };
  }
}

export function createDriver(config: RunnerConfig): AgentDriver {
  return config.mode === "live" ? new LiveAgentDriver(config) : new SimulationAgentDriver();
}
