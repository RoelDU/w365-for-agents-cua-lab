import { EventEmitter } from "node:events";
import type { HandoffStatus, HandoffStatusPayload } from "./types";

/**
 * Monotonic rank for handoff status. State must never regress: a late `ready`
 * event must not overwrite a terminal `submitted`/`error`. `submitted` and
 * `error` are both terminal (same rank) and the first one wins.
 */
const RANK: Record<HandoffStatus, number> = {
  idle: 0,
  queued: 1,
  prefilled: 2,
  ready: 3,
  submitted: 4,
  error: 4
};

const TERMINAL: ReadonlyArray<HandoffStatus> = ["submitted", "error"];

export function isTerminal(status: HandoffStatus): boolean {
  return TERMINAL.includes(status);
}

export class HandoffStore {
  private readonly states = new Map<string, HandoffStatusPayload>();
  private readonly emitter = new EventEmitter();

  constructor() {
    // SSE subscribers can be numerous; lift the default listener cap.
    this.emitter.setMaxListeners(0);
  }

  get(requestId: string): HandoffStatusPayload | undefined {
    return this.states.get(requestId);
  }

  has(requestId: string): boolean {
    return this.states.has(requestId);
  }

  /** True if a request exists and has not reached a terminal state. */
  isActive(requestId: string): boolean {
    const s = this.states.get(requestId);
    return s !== undefined && !isTerminal(s.status);
  }

  /** request_id of the single non-terminal handoff, if any (single-flight). */
  activeRequestId(): string | undefined {
    for (const [id, s] of this.states) {
      if (!isTerminal(s.status)) return id;
    }
    return undefined;
  }

  /**
   * Apply an update, enforcing monotonic, non-regressing transitions.
   * Returns the resulting payload, or undefined if the update was rejected
   * (lower rank than current, or current already terminal).
   */
  apply(update: HandoffStatusPayload): HandoffStatusPayload | undefined {
    const current = this.states.get(update.request_id);
    if (current) {
      if (isTerminal(current.status)) {
        // Already done; ignore anything except an identical terminal repeat.
        return current.status === update.status ? current : undefined;
      }
      if (RANK[update.status] < RANK[current.status]) {
        return undefined;
      }
    }
    const merged: HandoffStatusPayload = { ...current, ...update };
    this.states.set(update.request_id, merged);
    this.emitter.emit(update.request_id, merged);
    return merged;
  }

  subscribe(requestId: string, listener: (payload: HandoffStatusPayload) => void): () => void {
    this.emitter.on(requestId, listener);
    return () => this.emitter.off(requestId, listener);
  }
}
