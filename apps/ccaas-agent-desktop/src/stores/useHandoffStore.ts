import { create } from "zustand";
import type {
  CallContext,
  ErrorCode,
  HandoffStatus,
  HandoffStatusPayload
} from "@/types/contracts";

export interface ActivityEntry {
  id: string;
  ts_iso: string;
  level: "info" | "warn" | "error";
  message: string;
}

interface HandoffStoreState {
  status: HandoffStatus;
  callContext: CallContext | null;
  /** Durable handoff id for the active run. Held in memory so the orchestrator
   * status endpoint can be polled; lost on a full page reload (acceptable for
   * the demo - start a fresh handoff after a reload). */
  handoffId: string | null;
  windowTitle: string | null;
  matchedPolicyNumber: string | null;
  matchedCustomerName: string | null;
  claimId: string | null;
  policyNumber: string | null;
  legacyAgentId: string | null;
  reserveAmount: number | null;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  /** Latest live Computer Use desktop screenshot (data URI or URL); drives the
   * in-app live-desktop view on the Direct Line streaming path. */
  latestScreenshotUrl: string | null;
  /** Count of screenshots streamed in the active run (for the "N frames" hint). */
  screenshotCount: number;
  /** Latest agent narration line shown under the live desktop. */
  narration: string | null;
  /** True once a handoff has been posted (drives the right-rail status card). */
  active: boolean;
  activity: ActivityEntry[];
  // actions
  reset: () => void;
  beginHandoff: (
    ctx: CallContext,
    meta?: { handoffId?: string | null }
  ) => void;
  applyStatus: (s: HandoffStatusPayload) => void;
  setError: (code: ErrorCode, msg: string) => void;
  pushActivity: (entry: Omit<ActivityEntry, "id" | "ts_iso">) => void;
  /** Direct Line streaming: record a new live screenshot. */
  pushScreenshot: (url: string) => void;
  /** Direct Line streaming: update the live narration line + status. */
  setNarration: (text: string) => void;
  /** Direct Line streaming: mark the agent as actively driving the desktop. */
  setStreamingStatus: (status: HandoffStatus) => void;
}

let activityCounter = 0;

const initial: Pick<
  HandoffStoreState,
  | "status"
  | "callContext"
  | "handoffId"
  | "windowTitle"
  | "matchedPolicyNumber"
  | "matchedCustomerName"
  | "claimId"
  | "policyNumber"
  | "legacyAgentId"
  | "reserveAmount"
  | "errorCode"
  | "errorMessage"
  | "latestScreenshotUrl"
  | "screenshotCount"
  | "narration"
  | "active"
  | "activity"
> = {
  status: "idle",
  callContext: null,
  handoffId: null,
  windowTitle: null,
  matchedPolicyNumber: null,
  matchedCustomerName: null,
  claimId: null,
  policyNumber: null,
  legacyAgentId: null,
  reserveAmount: null,
  errorCode: null,
  errorMessage: null,
  latestScreenshotUrl: null,
  screenshotCount: 0,
  narration: null,
  active: false,
  activity: []
};

function nextActivity(
  entry: Omit<ActivityEntry, "id" | "ts_iso">
): ActivityEntry {
  activityCounter += 1;
  return {
    id: `act-${activityCounter}`,
    ts_iso: new Date().toISOString(),
    ...entry
  };
}

export const useHandoffStore = create<HandoffStoreState>((set, get) => ({
  ...initial,
  reset: () => set({ ...initial, activity: get().activity }),
  beginHandoff: (callContext, meta) =>
    set({
      ...initial,
      activity: get().activity,
      callContext,
      handoffId: meta?.handoffId ?? null,
      status: "queued",
      active: true
    }),
  applyStatus: (s) => {
    const patch: Partial<HandoffStoreState> = { status: s.status };
    if (s.window_title !== undefined) patch.windowTitle = s.window_title;
    if (s.matched_policy_number !== undefined)
      patch.matchedPolicyNumber = s.matched_policy_number ?? null;
    if (s.matched_customer_name !== undefined)
      patch.matchedCustomerName = s.matched_customer_name ?? null;
    if (s.claim_id !== undefined) patch.claimId = s.claim_id;
    if (s.policy_number !== undefined) patch.policyNumber = s.policy_number;
    if (s.agent_id !== undefined) patch.legacyAgentId = s.agent_id;
    if (s.reserve_amount !== undefined)
      patch.reserveAmount = s.reserve_amount ?? null;
    if (s.error_code !== undefined) patch.errorCode = s.error_code;
    if (s.message !== undefined) patch.errorMessage = s.message;
    set(patch);
  },
  setError: (code, msg) =>
    set({ status: "error", errorCode: code, errorMessage: msg }),
  pushActivity: (entry) =>
    set((state) => ({ activity: [nextActivity(entry), ...state.activity].slice(0, 50) })),
  pushScreenshot: (url) =>
    set((state) => ({
      latestScreenshotUrl: url,
      screenshotCount: state.screenshotCount + 1,
      // Receiving frames means the agent is actively driving the desktop.
      status: state.status === "submitted" || state.status === "error" ? state.status : "ready",
      active: true
    })),
  setNarration: (text) => set({ narration: text }),
  setStreamingStatus: (status) =>
    set((state) => ({
      status,
      active: status !== "idle" ? true : state.active
    }))
}));
