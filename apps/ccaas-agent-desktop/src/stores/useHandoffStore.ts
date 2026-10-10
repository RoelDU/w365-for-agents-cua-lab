import { create } from "zustand";
import type {
  CallContext,
  ErrorCode,
  HandoffStatus,
  HandoffStatusPayload
} from "@/types/contracts";
import type { LiveActivity, LiveRelease, LiveStep } from "@/lib/directLineClient";
import type { FoundryFailure } from "@/lib/foundryHostedClient";

export interface FoundryRun {
  baseUrl: string;
  requestId: string;
  sessionId: string | null;
  ready: boolean;
  running: boolean;
}

export interface ActivityEntry {
  id: string;
  ts_iso: string;
  level: "info" | "warn" | "error";
  message: string;
  /** A logged Computer Use step shown for this handoff; withdrawn if attribution fails. */
  liveStep?: boolean;
}

interface HandoffStoreState {
  status: HandoffStatus;
  callContext: CallContext | null;
  /** Durable handoff id for the active run. Held in memory so the orchestrator
   * status endpoint can be polled; lost on a full page reload (acceptable for
   * the demo - start a fresh handoff after a reload). */
  handoffId: string | null;
  orchestratorUrl: string | null;
  executionMode: "simulation" | "live" | null;
  receivedActivityIds: Set<string>;
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
  /** Latest logged Computer Use action (trigger path): explanation, action, screenshot. */
  currentStep: LiveStep | null;
  /** Whether the shown activity is proven to belong to this handoff. */
  liveActivity: LiveActivity | null;
  /** Cloud PC release, reported separately from the claim. */
  release: LiveRelease | null;
  /** Foundry hosted run being watched in this interaction (no credentials are kept here). */
  foundryRun: FoundryRun | null;
  /** How a failed Foundry transfer stands (not sent, outcome unknown, ...); null for other errors. */
  failure: FoundryFailure | null;
  /** True once a handoff has been posted (drives the right-rail status card). */
  active: boolean;
  activity: ActivityEntry[];
  // actions
  reset: () => void;
  beginHandoff: (
    ctx: CallContext,
    meta?: { handoffId?: string | null; orchestratorUrl?: string; executionMode?: "simulation" | "live" }
  ) => void;
  applyStatus: (s: HandoffStatusPayload) => void;
  setError: (code: ErrorCode, msg: string, failure?: FoundryFailure | null) => void;
  pushActivity: (entry: Omit<ActivityEntry, "id" | "ts_iso">) => void;
  /** Direct Line streaming: record a new live screenshot. */
  pushScreenshot: (url: string) => void;
  /** Direct Line streaming: update the live narration line + status. */
  setNarration: (text: string) => void;
  /** Direct Line streaming: mark the agent as actively driving the desktop. */
  setStreamingStatus: (status: HandoffStatus) => void;
  /** Trigger path: show one logged action with its own screenshot. */
  pushStep: (step: LiveStep) => void;
  /** Trigger path: attribution state; a mismatch withdraws everything shown. */
  setLiveActivity: (activity: LiveActivity) => void;
  /** Trigger path: Cloud PC release state. */
  setRelease: (release: LiveRelease) => void;
  /** Foundry hosted path: record the acquired session and whether viewing can start. */
  setFoundryRun: (patch: Partial<FoundryRun> | null) => void;
}

let activityCounter = 0;

const initial: Pick<
  HandoffStoreState,
  | "status"
  | "callContext"
  | "handoffId"
  | "orchestratorUrl"
  | "executionMode"
  | "receivedActivityIds"
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
  | "currentStep"
  | "liveActivity"
  | "release"
  | "foundryRun"
  | "failure"
  | "active"
  | "activity"
> = {
  status: "idle",
  callContext: null,
  handoffId: null,
  orchestratorUrl: null,
  executionMode: null,
  receivedActivityIds: new Set(),
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
  currentStep: null,
  liveActivity: null,
  release: null,
  foundryRun: null,
  failure: null,
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
      orchestratorUrl: meta?.orchestratorUrl ?? null,
      executionMode: meta?.executionMode ?? null,
      receivedActivityIds: new Set(),
      status: "queued",
      active: true
    }),
  applyStatus: (s) => {
    const state = get();
    if (!state.active || s.request_id !== state.callContext?.request_id) return;
    if (state.status === "submitted" || state.status === "error") return;
    const patch: Partial<HandoffStoreState> = { status: s.status };
    if (s.execution_mode) patch.executionMode = s.execution_mode;
    if (s.activity) {
      const fresh = s.activity.filter((entry) => !state.receivedActivityIds.has(entry.id));
      patch.receivedActivityIds = new Set([...state.receivedActivityIds, ...fresh.map((entry) => entry.id)]);
      patch.activity = [...fresh.reverse(), ...state.activity].slice(0, 50);
      const narration = fresh.filter((entry) => entry.message.startsWith("Agent:") ||
        entry.message.startsWith("Agent summary:")).at(0);
      if (narration) patch.narration = narration.message;
    }
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
  setError: (code, msg, failure) =>
    set({ status: "error", errorCode: code, errorMessage: msg, failure: failure ?? null }),
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
    })),
  pushStep: (step) =>
    set((state) => ({
      currentStep: step,
      ...(step.imageUrl
        ? { latestScreenshotUrl: step.imageUrl, screenshotCount: state.screenshotCount + 1 }
        : {}),
      status: state.status === "submitted" || state.status === "error" ? state.status : "ready",
      active: true
    })),
  setLiveActivity: (activity) =>
    set((state) =>
      activity.state === "mismatch"
        ? {
            liveActivity: activity, currentStep: null, latestScreenshotUrl: null, screenshotCount: 0, narration: null,
            activity: state.activity.filter((entry) => !entry.liveStep)
          }
        : { liveActivity: activity }
    ),
  setRelease: (release) => set({ release }),
  setFoundryRun: (patch) =>
    set((state) => ({
      foundryRun: patch === null || !state.foundryRun
        ? (patch && patch.baseUrl && patch.requestId
          ? { sessionId: null, ready: false, running: true, ...patch } as FoundryRun
          : null)
        : { ...state.foundryRun, ...patch }
    }))
}));
