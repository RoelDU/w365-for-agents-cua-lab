import type { RunnerConfig } from "./config";
import { writeReady, writeOutcome } from "./handoff";
import type { AgentDriver } from "./runner";
import type { Prefill } from "./types";

/**
 * Drives one captured handoff at a time (single-flight, matching the legacy app's
 * fixed-name prefill.json) and relays ready/result/error back to the out\ folder.
 */
export class HandoffProcessor {
  private busy = false;
  private readonly done = new Set<string>();

  constructor(
    private readonly config: RunnerConfig,
    private readonly driver: AgentDriver
  ) {}

  get isBusy(): boolean {
    return this.busy;
  }

  async process(prefill: Prefill): Promise<void> {
    // Demo safety: in "both" mode the presenter routes each handoff to one backend via
    // the desktop toggle. Only act on prefills addressed to THIS runner (or unaddressed
    // legacy prefills) so the MCS and Foundry agents never both drive the Cloud PC.
    if (prefill.target_backend && prefill.target_backend !== this.config.backendId) {
      console.log(
        `[runner] ignoring ${prefill.request_id}: addressed to '${prefill.target_backend}', this runner is '${this.config.backendId}'.`
      );
      return;
    }
    if (this.busy) {
      console.log(`[runner] busy; ignoring ${prefill.request_id} until the current run finishes.`);
      return;
    }
    if (this.done.has(prefill.request_id)) return;

    this.busy = true;
    console.log(`[runner] handling ${prefill.request_id} (${prefill.intent}) in ${this.config.mode} mode`);
    try {
      const outcome = await this.driver.run(prefill, {
        onReady: async (ready) => {
          await writeReady(this.config, prefill.request_id, ready);
          console.log(`[runner] ${prefill.request_id} -> ready (${ready.window_title})`);
        }
      });
      await writeOutcome(this.config, prefill.request_id, outcome);
      console.log(
        `[runner] ${prefill.request_id} -> ${
          outcome.kind === "result" ? `submitted (${outcome.claim_id})` : `error (${outcome.error_code})`
        }`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runner] ${prefill.request_id} failed:`, message);
      await writeOutcome(this.config, prefill.request_id, {
        kind: "error",
        error_code: "UNKNOWN",
        message: `Runner error: ${message}`.slice(0, 1000)
      }).catch((e) => console.error("[runner] could not write error.json:", e));
    } finally {
      this.done.add(prefill.request_id);
      this.busy = false;
    }
  }
}
