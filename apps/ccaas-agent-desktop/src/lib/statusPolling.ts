import type { HandoffStatusPayload } from "@/types/contracts";
import { getHandoffStatus, OrchestratorError } from "./orchestratorClient";

export interface StatusSubscriptionOptions {
  baseUrl: string;
  /** Durable handoff id; the only id the browser needs to poll status. */
  handoffId: string;
  requestId?: string;
  executionMode?: "simulation" | "live" | null;
  onUpdate: (payload: HandoffStatusPayload) => void;
  onError?: (err: unknown) => void;
  onFailure?: (err: unknown) => void;
  pollIntervalMs?: number;
}

export interface Subscription {
  stop(): void;
}

const DEFAULT_POLL_INTERVAL_MS = 1500;
const TERMINAL: ReadonlyArray<HandoffStatusPayload["status"]> = ["submitted", "error"];

/**
 * Poll the orchestrator `/api/handoff/{handoff_id}/status` endpoint until a
 * terminal status.
 *
 * The backend owns the long-running handoff (Durable Functions); it cannot push
 * to the browser, so polling is the transport. Only the durable handoff_id is
 * needed - the backend holds the Direct Line conversation and watermark.
 */
export function subscribeToStatus(opts: StatusSubscriptionOptions): Subscription {
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const payload = await getHandoffStatus(opts.baseUrl, opts.handoffId, {
        requestId: opts.requestId, executionMode: opts.executionMode
      });
      if (stopped) return;
      failures = 0;
      opts.onUpdate(payload);
      if (TERMINAL.includes(payload.status)) {
        stop();
        return;
      }
    } catch (err) {
      if (!stopped) opts.onError?.(err);
      failures += 1;
      if (!stopped && opts.onFailure && ((err instanceof OrchestratorError && err.fatal) || failures >= 3)) {
        opts.onFailure(err);
        stop();
        return;
      }
    }
    if (!stopped) {
      timer = setTimeout(tick, pollMs);
    }
  };

  timer = setTimeout(tick, 0);

  return { stop };
}
