import * as React from "react";
import { getFoundryCapacity } from "@/lib/foundryHostedClient";

/**
 * Cloud PC capacity for a NEW Foundry start, read from the relay while the transfer
 * directory is open. A readiness indicator only: it reserves nothing, and the relay checks
 * again before it accepts a start. Never consulted for a run that already started.
 *
 * - off: the relay does not gate starts (previous behaviour);
 * - checking / available / none / error: a failed, timed-out or unreadable check is
 *   "error", never "available" or "none".
 */
export type FoundryCapacityState =
  | { mode: "off" }
  | { mode: "checking" }
  | { mode: "available" }
  | { mode: "none" }
  | { mode: "error"; detail: string };

export const CAPACITY_REFRESH_MS = 20_000;
const CAPACITY_TIMEOUT_MS = 15_000;

export function useFoundryCapacity(active: boolean, baseUrl: string | null, intervalMs = CAPACITY_REFRESH_MS) {
  const [state, setState] = React.useState<FoundryCapacityState>({ mode: "checking" });
  const inflight = React.useRef<AbortController | null>(null);
  // Bumped whenever polling stops or restarts, so a late answer from before is dropped.
  const generation = React.useRef(0);

  const check = React.useCallback((manual = false) => {
    if (!active || !baseUrl || inflight.current) return;
    if (manual) setState({ mode: "checking" });
    const controller = new AbortController();
    inflight.current = controller;
    const gen = generation.current;
    const timer = setTimeout(() => controller.abort(), CAPACITY_TIMEOUT_MS);
    getFoundryCapacity(baseUrl, controller.signal)
      .then((c) => {
        if (gen !== generation.current) return;
        if (!c.gate) setState({ mode: "off" });
        else if (c.state === "available") setState({ mode: "available" });
        else if (c.state === "none") setState({ mode: "none" });
        else setState({ mode: "error", detail: c.reason ?? "unknown" });
      })
      .catch((err: unknown) => {
        if (gen !== generation.current) return;
        const detail = controller.signal.aborted ? "timed out" : err instanceof Error ? err.message : String(err);
        setState({ mode: "error", detail });
      })
      .finally(() => {
        clearTimeout(timer);
        if (inflight.current === controller) inflight.current = null;
      });
  }, [active, baseUrl]);

  React.useEffect(() => {
    if (!active || !baseUrl) return;
    generation.current += 1;
    check();
    const id = setInterval(() => check(), intervalMs);
    return () => {
      clearInterval(id);
      generation.current += 1;
      inflight.current?.abort();
      inflight.current = null;
      // The next opening starts from "checking", never from an old answer.
      setState({ mode: "checking" });
    };
  }, [active, baseUrl, check, intervalMs]);

  const refresh = React.useCallback(() => check(true), [check]);
  return { state, refresh };
}
