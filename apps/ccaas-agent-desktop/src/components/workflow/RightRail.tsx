import * as React from "react";
import { useCallStore } from "@/stores/useCallStore";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useToastsStore } from "@/stores/useToastsStore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ArrowRightLeft } from "lucide-react";
import { dispositionLabel } from "@/lib/format";
import type { Disposition } from "@/types/domain";
import { HandoffModal } from "./HandoffModal";
import { TransferDirectory } from "./TransferDirectory";
import { AIAgentStatusCard } from "./AIAgentStatusCard";
import { buildCallContext, generateRequestId } from "@/lib/payloadBuilder";
import { validators, assertValid, validateHandoffStatus } from "@/lib/schemas";
import { isDevMode } from "@/lib/env";
import { postHandoff } from "@/lib/orchestratorClient";
import { runDirectLineHandoff } from "@/lib/directLineClient";
import { runCuaViaTrigger } from "@/lib/cuaRunClient";
import {
  getFoundryAvailability,
  getFoundryCapacity,
  prepareFoundryHosted,
  POSSIBLY_FILED,
  readFoundryOutcome,
  runFoundryHosted,
  type FoundryEvent
} from "@/lib/foundryHostedClient";
import { getNewHarnessAvailability, runNewHarness } from "@/lib/newHarnessClient";
import { useFoundryCapacity } from "./useFoundryCapacity";
import { acquireHandoffAccessToken, getSignedInAccount, startHandoffReconnect } from "@/lib/msalLogin";
import {
  acknowledgeTransfer,
  discardSavedCall,
  dismissTransfer,
  installTransferRecorder,
  isCheckable,
  isUnresolved,
  recordAuthDiagnostic,
  redactSecrets,
  clearAuthDiagnostic,
  saveCallForReconnect,
  useRecoveryStore,
  type ReconnectStage
} from "@/lib/handoffRecovery";
import type { CallContext } from "@/types/contracts";
import type { ErrorCode } from "@/types/contracts";
import { useT, useLang } from "@/stores/useLangStore";
import {
  useSettingsStore,
  MCS_URL_CONFIGURED,
  BACKEND_SELECTABLE,
  type AgentBackend
} from "@/stores/useSettingsStore";

const DISPOSITIONS: Disposition[] = [
  "resolved",
  "escalated_ai",
  "callback",
  "wrong_number",
  "abandoned"
];

// The Foundry relay accepts request bodies up to 32,000 bytes. Japanese text is
// up to 3 bytes per character, so the transcript excerpt is capped well below.
const FOUNDRY_HOSTED_EXCERPT_CHARS = 6_000;
const DEFAULT_EXCERPT_CHARS = 30_000;

/** Whether the Foundry destination is the hosted agent (via this app's relay) or the older local path. */
type FoundryAvailabilityState =
  | { mode: "local" }
  | { mode: "checking" }
  | { mode: "hosted"; ready: boolean; message: string; capacityGate: boolean }
  | { mode: "unavailable"; message: string }
  | { mode: "unknown"; detail: string };

/** Whether the separate new-harness destination can take a transfer, as its own relay reports. */
type NewHarnessAvailabilityState =
  | { mode: "unconfigured" }
  | { mode: "checking" }
  | { mode: "known"; ready: boolean; message: string }
  | { mode: "unknown"; detail: string };

/** Whether this user's relay token (Handoff.Access) can be obtained for a Foundry hosted transfer. */
type HandoffSignInState =
  | { mode: "checking" }
  | { mode: "ready" }
  | { mode: "reconnect"; code: string; detail: string }
  | { mode: "failed"; detail: string };

// Keep each transfer's request ID and outcome across a page reload (no tokens).
installTransferRecorder();

/** Plain activity-log line for a Foundry event; explanation, release and outcome are handled separately. */
function describeFoundryEvent(e: FoundryEvent): string | null {
  switch (e.type) {
    case "plan":
      return `Application plan: ${e.message ?? ""}`;
    case "computer":
      return `Foundry acquired Cloud PC session ${e.session_id ?? "(unknown)"}.`;
    case "session_details":
      return `Cloud PC session details: ${e.message ?? e.session_id ?? "(received)"}`;
    case "readiness":
      return `Cloud PC readiness: ${e.message ?? e.status ?? "(no message)"}`;
    case "viewer_connected":
      return `The view-only screen reported connected for session ${e.session_id ?? "(unknown)"}.`;
    case "tool_started":
    case "tool_completed":
      return `${e.type === "tool_started" ? "Computer Use tool started" : "Computer Use tool completed"}: ${e.tool ?? "(unnamed)"}${e.message ? ` - ${e.message}` : ""}`;
    case "model_started":
      return "Model step started.";
    case "model_completed":
      return "Model step completed.";
    case "observation":
      return `Screen text read: ${e.message ?? ""}`;
    case "error":
      return `Foundry error: ${e.message ?? "(no message)"}`;
    case "explanation":
    case "release":
      return null;
    default:
      return e.message ? `${e.type}: ${e.message}` : e.type;
  }
}

/**
 * Build the natural-language FNOL trigger sent to the Computer Use agent, from
 * the live call context — so pushing "Transfer to AI Agent" needs no typing.
 * Mirrors the orchestrator's HANDOFF_TRIGGER_TEXT shape, proven end-to-end.
 */
function buildTriggerText(
  summary: string,
  policyNumber: string | null | undefined,
  lang: "en" | "ja" = "en"
): string {
  const policy = policyNumber ? ` Policy ${policyNumber}.` : "";
  
  // Language instruction MUST come first to set the narration language for the entire session
  const languageInstruction = lang === "ja"
    ? "【重要】すべての進捗説明を日本語で行ってください。あなたの説明・推論・ナレーションはすべて日本語です。英語を使わないでください。\n\n"
    : "";
  
  // Explicit, ordered procedure that matches the Zava Claims Workstation UI, so the
  // agent follows a known-good path instead of exploring (which slows the demo and
  // causes failed first attempts). The app is already installed on the Cloud PC; the
  // UI labels below are literal English controls (the claims app is English-only).
  const procedure =
    ` Follow these steps exactly, without exploring other options:` +
    ` 1) Open the "Zava Claims Workstation" desktop shortcut (it is already installed — do not reinstall or search the web).` +
    ` 2) Under "Search by", select "Policy #", type the policy number, click "Search", and open the matching customer record.` +
    ` 3) Click the "New FNOL" tab.` +
    ` 4) Step 1 (Incident): fill Loss Date, Time, Loss Location, set Loss Type to "COLLISION", add a brief Narrative, then click "Next >".` +
    ` 5) Click "Next >" through Vehicles, Parties, and Coverage (the defaults are acceptable).` +
    ` 6) On Step 5 (Review & Submit), click "Submit Claim".` +
    ` 7) A modal dialog titled "FNOL Submitted" appears showing the new Claim ID (format CLM-YYYY-NNNNNN). Read and return that claim number, then click the "OK" button to dismiss the dialog. You MUST click "OK" — the application is blocked by this modal until it is dismissed, so nothing else (closing the app, signing out) can happen until you do.` +
    ` 8) Close the Zava Claims Workstation application: use the File menu → Exit, or click the window's red "X" close button. If an "exit?" / save confirmation prompt appears, confirm it.` +
    ` 9) Sign out of Windows to RELEASE the Cloud PC for the next demo: open the Start menu, click the user account icon, and choose "Sign out". This is mandatory — do not just lock or minimize. The task is only complete once the Windows sign-in / lock screen is visible, confirming the session has ended.`;
  
  const task =
    `A customer was just handed off to you. ${summary.trim()}.${policy} ` +
    `CRITICAL: You MUST complete ALL of these steps in order: (1) File the First Notice of Loss (FNOL) in the Zava Claims Workstation using computer use, (2) give me the claim number, (3) click "OK" to dismiss the "FNOL Submitted" confirmation dialog, (4) close the Zava Claims Workstation application, and (5) sign out of Windows via Start menu → user icon → "Sign out" to release the Cloud PC. Reporting the claim number is NOT the end of the task. DO NOT STOP until you have signed out of Windows and the sign-in / lock screen is visible.` +
    procedure;
  
  return languageInstruction + task;
}

export function RightRail() {
  const t = useT();
  const lang = useLang();
  const phase = useCallStore((s) => s.phase);
  const scenario = useCallStore((s) => s.scenario);
  const summarySeed = scenario?.summary_seed ?? "";
  const getExcerpt = useCallStore((s) => s.getTranscriptExcerpt);
  const disposition = useCallStore((s) => s.disposition);
  const setDisposition = useCallStore((s) => s.setDisposition);

  const agent = useAuthStore((s) => s.agent);
  const orchestratorUrl = useSettingsStore((s) => s.orchestratorUrl);
  const backend = useSettingsStore((s) => s.backend);
  const activeRegionId = useSettingsStore((s) => s.activeRegionId);
  const cuaMode = useSettingsStore((s) => s.cuaMode);
  // Runtime-resolved Direct Line endpoint for the active CUA region. When present
  // the Transfer button streams the live agent desktop in-app; empty = orchestrator
  // path. Region is chosen at install/deploy time (region-config.json) or in Settings.
  const directLineTokenUrl = useSettingsStore((s) => s.directLineTokenUrl);
  const cuaRunBaseUrl = useSettingsStore((s) => s.cuaRunBaseUrl);
  const newHarnessBaseUrl = useSettingsStore((s) => s.newHarnessBaseUrl);

  const handoffStatus = useHandoffStore((s) => s.status);
  const beginHandoff = useHandoffStore((s) => s.beginHandoff);
  const pushActivity = useHandoffStore((s) => s.pushActivity);
  const resetHandoff = useHandoffStore((s) => s.reset);
  const pushScreenshot = useHandoffStore((s) => s.pushScreenshot);
  const setNarration = useHandoffStore((s) => s.setNarration);
  const setStreamingStatus = useHandoffStore((s) => s.setStreamingStatus);
  const pushStep = useHandoffStore((s) => s.pushStep);
  const setLiveActivity = useHandoffStore((s) => s.setLiveActivity);
  const setRelease = useHandoffStore((s) => s.setRelease);
  const applyStatus = useHandoffStore((s) => s.applyStatus);
  const setHandoffError = useHandoffStore((s) => s.setError);
  const setFoundryRun = useHandoffStore((s) => s.setFoundryRun);

  const push = useToastsStore((s) => s.push);

  const [modalOpen, setModalOpen] = React.useState(false);
  const [directoryOpen, setDirectoryOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [foundryAvailability, setFoundryAvailability] = React.useState<FoundryAvailabilityState>(
    cuaRunBaseUrl ? { mode: "checking" } : { mode: "local" }
  );
  const [newHarnessAvailability, setNewHarnessAvailability] = React.useState<NewHarnessAvailabilityState>(
    newHarnessBaseUrl ? { mode: "checking" } : { mode: "unconfigured" }
  );
  const [handoffSignIn, setHandoffSignIn] = React.useState<HandoffSignInState>({ mode: "checking" });
  const [reconnecting, setReconnecting] = React.useState(false);
  const reconnectingRef = React.useRef(false);
  const transferRecord = useRecoveryStore((s) => s.record);
  const loadedRecordId = useRecoveryStore((s) => s.loadedId);
  const dismissedRecordId = useRecoveryStore((s) => s.dismissedId);
  const authDiag = useRecoveryStore((s) => s.authDiag);
  const recoveryNotice = useRecoveryStore((s) => s.notice);
  const resumeRequest = useRecoveryStore((s) => s.resume);
  const foundryBlocked = isUnresolved(transferRecord);
  // Generated when the AI destination is selected so the request ID shown in the
  // context-card preview / JSON disclosure matches the payload actually sent.
  const [previewRequestId, setPreviewRequestId] = React.useState<string | null>(null);

  // Aborts the in-flight Direct Line streaming run when the agent panel is reset.
  const directLineAbortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => directLineAbortRef.current?.abort(), []);

  // Reset wrapper that also cancels any live Direct Line stream.
  const handleReset = React.useCallback(() => {
    directLineAbortRef.current?.abort();
    directLineAbortRef.current = null;
    resetHandoff();
  }, [resetHandoff]);

  // The TopBar "Reset demo" button dispatches ccaas:reset-demo; abort any live
  // Direct Line stream here so a new run starts from a clean conversation.
  React.useEffect(() => {
    const onReset = () => {
      directLineAbortRef.current?.abort();
      directLineAbortRef.current = null;
      // A resolved record is cleared; an unresolved Foundry transfer stays until its status is checked.
      dismissTransfer();
    };
    window.addEventListener("ccaas:reset-demo", onReset);
    return () => window.removeEventListener("ccaas:reset-demo", onReset);
  }, []);

  const canHandoff = phase === "talking" || phase === "wrap_up";
  const handoffActive = handoffStatus !== "idle";

  // The realistic entry point: open the transfer directory (the AI agent is one
  // destination among human queues), mirroring how real CCaaS desktops route an
  // interaction to an AI worker.
  const openDirectory = React.useCallback(() => {
    if (!canHandoff || handoffActive) return;
    setDirectoryOpen(true);
  }, [canHandoff, handoffActive]);

  // Selecting an AI agent destination advances to the handover confirmation.
  // MCS and Foundry are separate destinations; the choice decides the route.
  const selectAiDestination = React.useCallback((target: AgentBackend) => {
    const settings = useSettingsStore.getState();
    if (settings.backend !== target) settings.setBackend(target);
    setDirectoryOpen(false);
    setPreviewRequestId(generateRequestId());
    setConfirmNotice(null);
    setModalOpen(true);
  }, []);

  // Ask this app's service, each time the directory opens, whether the Foundry
  // hosted agent can take a transfer now. Without a service URL, or when the
  // service has no Foundry agent configured, the older local Foundry path applies.
  React.useEffect(() => {
    if (!directoryOpen) return;
    if (!cuaRunBaseUrl) {
      setFoundryAvailability({ mode: "local" });
      return;
    }
    const controller = new AbortController();
    setFoundryAvailability({ mode: "checking" });
    getFoundryAvailability(cuaRunBaseUrl, controller.signal)
      .then((a) => {
        if (controller.signal.aborted) return;
        // The older local path is offered only when this build names a Foundry
        // orchestrator; otherwise there is nowhere real to send the transfer.
        setFoundryAvailability(a.configured
          ? { mode: "hosted", ready: a.ready, message: a.message, capacityGate: a.capacityGate }
          : BACKEND_SELECTABLE ? { mode: "local" } : { mode: "unavailable", message: a.message });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setFoundryAvailability({ mode: "unknown", detail: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, [directoryOpen, cuaRunBaseUrl]);

  // Before the hosted Foundry destination is offered, get this user's relay token
  // silently (MSAL reuses or renews it). Only Microsoft's interaction-required
  // answer leads to the one Reconnect action; nothing is sent to the relay here.
  const foundryHostedReady = foundryAvailability.mode === "hosted" && foundryAvailability.ready;
  React.useEffect(() => {
    if (!directoryOpen || !foundryHostedReady) return;
    let cancelled = false;
    setHandoffSignIn({ mode: "checking" });
    acquireHandoffAccessToken()
      .then(() => {
        if (cancelled) return;
        setHandoffSignIn({ mode: "ready" });
        if (useRecoveryStore.getState().authDiag?.stage === "precheck") clearAuthDiagnostic();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const e = (err ?? {}) as { code?: string; interactionRequired?: boolean; message?: string };
        const detail = redactSecrets(e.message || String(err));
        // Kept across a reload even though no transfer was started.
        recordAuthDiagnostic({ stage: "precheck", code: e.code || (e.interactionRequired ? "interaction_required" : "token_unavailable"), detail });
        setHandoffSignIn(e.interactionRequired === true
          ? { mode: "reconnect", code: e.code || "interaction_required", detail }
          : { mode: "failed", detail });
      });
    return () => { cancelled = true; };
  }, [directoryOpen, foundryHostedReady]);

  // Cloud PC capacity for a NEW Foundry start, only while the directory is open and only
  // when the relay gates starts on it. Never consulted once a run has started.
  const capacityGate = foundryAvailability.mode === "hosted" && foundryAvailability.capacityGate;
  const { state: foundryCapacity, refresh: refreshCapacity } = useFoundryCapacity(
    directoryOpen && foundryHostedReady && capacityGate && handoffSignIn.mode === "ready",
    cuaRunBaseUrl || null
  );
  // Shown in the confirmation when Confirm finds no Cloud PC free; nothing was started.
  const [confirmNotice, setConfirmNotice] = React.useState<string | null>(null);
  const admittingRef = React.useRef(false);

  // The single reconnect, shared by the transfer list (precheck), a start that was
  // not sent, and a run being watched (status). The call must be saved - and read
  // back - before the page leaves; otherwise Zava stays here and says why.
  const beginReconnect = React.useCallback(async (stage: ReconnectStage, requestId?: string) => {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    setReconnecting(true);
    const stop = (code: string, detail: string) => {
      reconnectingRef.current = false;
      setReconnecting(false);
      recordAuthDiagnostic({ stage: "reconnect", code, detail, request_id: requestId });
      push({ variant: "error", title: t("toast.reconnectFailed.title"), description: detail, toastId: "toast-reconnect-failed" });
      pushActivity({ level: "error", message: detail });
    };
    const account = await getSignedInAccount().catch(() => null);
    // MSAL may have lost its account while this Zava agent is still signed in: the
    // call is then saved for this agent and Microsoft is asked to sign in as them.
    const owner = agent ? { agent_id: agent.agent_id, username: agent.email ?? "" } : null;
    if (!account && !owner) {
      stop("no_account", t("recovery.noAccount"));
      return;
    }
    const saved = saveCallForReconnect({ account, owner, stage, request_id: requestId });
    if (!saved.ok) {
      stop("call_not_saved", t("recovery.notSaved", { detail: saved.error }));
      return;
    }
    pushActivity({
      level: "info",
      message: account
        ? `Reconnecting the Microsoft sign-in${requestId ? ` for ${requestId}` : ""}; the call was saved.`
        : `No Microsoft account was cached; signing in again as ${owner?.username || owner?.agent_id}${requestId ? ` for ${requestId}` : ""}. The call was saved.`
    });
    try {
      await startHandoffReconnect(account ? {} : { loginHint: owner?.username || undefined });
    } catch (err) {
      discardSavedCall();
      stop("redirect_not_started", t("recovery.redirectNotStarted", { detail: err instanceof Error ? err.message : String(err) }));
    }
  }, [agent, push, pushActivity, t]);

  // The new-harness destination asks only its own relay; it never borrows the
  // MCS or Foundry availability, and without a relay URL it is "not configured".
  React.useEffect(() => {
    if (!directoryOpen) return;
    if (!newHarnessBaseUrl) {
      setNewHarnessAvailability({ mode: "unconfigured" });
      return;
    }
    const controller = new AbortController();
    setNewHarnessAvailability({ mode: "checking" });
    getNewHarnessAvailability(newHarnessBaseUrl, controller.signal)
      .then((a) => {
        if (controller.signal.aborted) return;
        setNewHarnessAvailability({ mode: "known", ready: a.configured && a.ready, message: a.message });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setNewHarnessAvailability({ mode: "unknown", detail: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, [directoryOpen, newHarnessBaseUrl]);

  const newHarnessDestination = React.useMemo(() => {
    // Another Copilot Studio agent that can file a claim: not while an earlier one may have.
    if (transferRecord && isUnresolved(transferRecord)) {
      return { enabled: false, message: t("dir.possiblyFiled", { id: transferRecord.request_id }) };
    }
    switch (newHarnessAvailability.mode) {
      case "unconfigured":
        return { enabled: false, message: t("dir.newHarnessNotConfigured") };
      case "checking":
        return { enabled: false, message: t("dir.newHarnessChecking") };
      case "known":
        return { enabled: newHarnessAvailability.ready, message: newHarnessAvailability.ready ? null : newHarnessAvailability.message };
      case "unknown":
        return { enabled: false, message: t("dir.newHarnessUnknown", { detail: newHarnessAvailability.detail }) };
    }
  }, [newHarnessAvailability, transferRecord, t]);

  const foundryHosted = backend === "foundry" && !!cuaRunBaseUrl && foundryAvailability.mode === "hosted";
  const excerptChars = foundryHosted || backend === "mcs-new-harness" ? FOUNDRY_HOSTED_EXCERPT_CHARS : DEFAULT_EXCERPT_CHARS;
  const foundryDestination = React.useMemo(() => {
    switch (foundryAvailability.mode) {
      case "local":
        return { enabled: true, message: null, hosted: false };
      case "checking":
        return { enabled: false, message: t("dir.foundryChecking"), hosted: false };
      case "hosted":
        if (!foundryAvailability.ready) return { enabled: false, message: foundryAvailability.message, hosted: true };
        // One unresolved request per interaction: reconcile it before any new start.
        if (foundryBlocked && transferRecord) {
          return {
            enabled: false,
            message: t(transferRecord.backend === "mcs" ? "dir.possiblyFiled" : "dir.foundryUnresolved", { id: transferRecord.request_id }),
            hosted: true
          };
        }
        switch (handoffSignIn.mode) {
          case "ready":
            if (!foundryAvailability.capacityGate) return { enabled: true, message: null, hosted: true };
            switch (foundryCapacity.mode) {
              case "off":
              case "available":
                return { enabled: true, message: null, hosted: true };
              case "checking":
                return { enabled: false, message: t("dir.capacityChecking"), hosted: true };
              case "none":
                return { enabled: false, message: t("dir.capacityNone"), hosted: true };
              case "error":
                return { enabled: false, message: t("dir.capacityError"), detail: foundryCapacity.detail, hosted: true, onRefresh: refreshCapacity };
            }
            return { enabled: false, message: null, hosted: true };
          case "checking":
            return { enabled: false, message: t("dir.signInChecking"), hosted: true };
          case "reconnect":
            return {
              enabled: false,
              message: reconnecting ? t("dir.signInRedirecting") : t("dir.signInReconnect", { detail: handoffSignIn.detail }),
              hosted: true,
              onReconnect: () => void beginReconnect("precheck"),
              reconnecting
            };
          case "failed":
            return { enabled: false, message: t("dir.signInFailed", { detail: handoffSignIn.detail }), hosted: true };
        }
        return { enabled: false, message: null, hosted: true };
      case "unavailable":
        return { enabled: false, message: foundryAvailability.message, hosted: false };
      case "unknown":
        return { enabled: false, message: t("dir.foundryUnknown", { detail: foundryAvailability.detail }), hosted: false };
    }
  }, [foundryAvailability, handoffSignIn, reconnecting, beginReconnect, foundryBlocked, transferRecord, foundryCapacity, refreshCapacity, t]);

  // While the person reads the Foundry confirmation, ask the relay once to prepare this exact
  // request: Foundry starts its sandbox and signs in, but no Cloud PC is taken and no run
  // exists until Confirm. Failure only means start does that work itself. It takes no Cloud
  // PC, so it does not wait on the capacity reading (which stops when the directory closes).
  const preparedRequestRef = React.useRef<string | null>(null);
  const prepareAllowed = foundryAvailability.mode === "hosted" && foundryAvailability.ready &&
    !(foundryBlocked && transferRecord) && handoffSignIn.mode === "ready";
  React.useEffect(() => {
    if (!modalOpen || !foundryHosted || !cuaRunBaseUrl || !previewRequestId) return;
    if (!prepareAllowed || preparedRequestRef.current === previewRequestId) return;
    preparedRequestRef.current = previewRequestId;
    void prepareFoundryHosted(cuaRunBaseUrl, previewRequestId);
  }, [modalOpen, foundryHosted, cuaRunBaseUrl, previewRequestId, prepareAllowed]);

  const routeToQueue = React.useCallback(
    (name: string) => {
      setDirectoryOpen(false);
      push({
        variant: "info",
        title: t("toast.transferQueue.title"),
        description: t("toast.transferQueue.desc", { name }),
        toastId: "toast-transfer-queue"
      });
    },
    [push, t]
  );

  // Build a preview of the exact CallContext that will be transferred, for the
  // rendered context card and the developer JSON disclosure in the modal.
  const buildPreview = React.useCallback(
    (summary: string) => {
      if (!scenario || !agent) return null;
      return buildCallContext({
        scenario,
        agent,
        summary,
        transcriptExcerpt: getExcerpt(excerptChars),
        requestId: previewRequestId ?? undefined,
        backend
      });
    },
    [scenario, agent, getExcerpt, excerptChars, previewRequestId, backend]
  );

  // Open the transfer directory from the global keyboard shortcut (Ctrl+Shift+H)
  // and from the call-toolbar Transfer button (ccaas:open-transfer).
  React.useEffect(() => {
    const handler = () => openDirectory();
    window.addEventListener("ccaas:open-handoff", handler);
    window.addEventListener("ccaas:open-transfer", handler);
    return () => {
      window.removeEventListener("ccaas:open-handoff", handler);
      window.removeEventListener("ccaas:open-transfer", handler);
    };
  }, [openDirectory]);

  // One Foundry hosted run for an exact handoff. resume=false sends start once (the
  // relay refuses a second start of the same request ID); resume=true only reads
  // status of an already started request and never sends start.
  const runFoundry = React.useCallback((ctx: CallContext, { resume }: { resume: boolean }) => {
    if (!cuaRunBaseUrl || !agent) return;
    directLineAbortRef.current?.abort();
    const controller = new AbortController();
    directLineAbortRef.current = controller;
    const baseUrl = cuaRunBaseUrl;

    beginHandoff(ctx, { handoffId: null });
    setFoundryRun({ baseUrl, requestId: ctx.request_id, sessionId: null, ready: false, running: true });
    pushActivity({
      level: "info",
      message: resume
        ? `Checking the status of Foundry request ${ctx.request_id} (no new start).`
        : `Starting Foundry hosted Claims run for ${ctx.request_id}.`
    });

    const current = () =>
      !controller.signal.aborted && useHandoffStore.getState().callContext?.request_id === ctx.request_id;
    const terminal = () => {
      const s = useHandoffStore.getState().status;
      return s === "submitted" || s === "error";
    };
    let submitEvidence: boolean | undefined;

    void runFoundryHosted({
      baseUrl,
      requestId: ctx.request_id,
      handoff: ctx,
      resume,
      signal: controller.signal,
      onUpdate: (u) => {
        if (!current()) return;
        switch (u.type) {
          case "event": {
            const e = u.event;
            // An older agent reports whether Submit Claim was sent only on its error event.
            if (e.type === "error" && typeof e.context?.submit_sent === "boolean") submitEvidence = e.context.submit_sent;
            if (e.type === "computer" && e.session_id) setFoundryRun({ sessionId: e.session_id });
            // Contract 4/5: the live service sends readiness with only a message (never "Ready");
            // any readiness event opens the 120-second viewer window.
            if (e.type === "readiness") {
              setFoundryRun({ ready: true });
              if (!terminal()) setStreamingStatus("ready");
            }
            if (e.type === "explanation" && e.message) {
              const label = t(e.explanation_type === "model_summary" ? "ai.foundry.summaryLabel" : "ai.foundry.visibleTextLabel");
              pushStep({
                explanation: e.message,
                note: null,
                action: label,
                application: "Foundry hosted agent",
                at: e.timestamp ?? null,
                imageUrl: null
              });
              pushActivity({ level: "info", message: `${label}: ${e.message}` });
            }
            if (e.type === "release") {
              const ok = e.status === "accepted";
              setRelease({
                state: ok ? "released" : "ended-with-error",
                at: e.timestamp,
                ...(ok ? {} : { detail: e.status ?? "unknown" })
              });
              pushActivity({
                level: ok ? "info" : "warn",
                message: ok
                  ? `Cloud PC session ${e.session_id ?? ""} released.`
                  : `Cloud PC release ${e.status ?? "unknown"}; an administrator may need to clean up session ${e.session_id ?? ""}.`
              });
            }
            const line = describeFoundryEvent(e);
            if (line) pushActivity({ level: e.type === "error" ? "error" : "info", message: line });
            break;
          }
          case "outcome": {
            const o = u.outcome;
            setFoundryRun({ running: false });
            const read = readFoundryOutcome(o, ctx.request_id, submitEvidence);
            const submitted = read.kind === "submitted" ? {
              request_id: ctx.request_id,
              status: "submitted" as const,
              claim_id: read.claimId,
              policy_number: ctx.policy_number ?? undefined,
              agent_id: read.agentId
            } : null;
            if (submitted && validateHandoffStatus(submitted)) {
              applyStatus(submitted);
              pushActivity({ level: "info", message: `Claim ${submitted.claim_id} filed by the Foundry hosted agent.` });
            } else if (read.kind === "error" && !read.possiblySubmitted) {
              const code = (validateHandoffStatus({ request_id: ctx.request_id, status: "error", error_code: read.code, message: read.message })
                ? read.code : "UNKNOWN") as ErrorCode;
              setHandoffError(code, read.message);
              pushActivity({ level: "error", message: `Foundry run ended: ${read.message}` });
            } else {
              // Submit Claim may have been sent: keep this request unresolved (no Retry, kept
              // across reset and reload) until a person has checked the claims system.
              const message = `${read.kind === "error" ? read.message : ""} A claim may have been filed for ${ctx.request_id}. Check the claims system before any new transfer.`.trim();
              setHandoffError("UNKNOWN", message, POSSIBLY_FILED);
              pushActivity({ level: "error", message: `Foundry run ended: ${message}` });
            }
            break;
          }
          case "error": {
            setFoundryRun({ running: false });
            const message = redactSecrets(u.message);
            if (!terminal()) setHandoffError("UNKNOWN", message, u.failure);
            if (u.failure.auth) {
              recordAuthDiagnostic({
                stage: u.failure.stage,
                code: u.failure.code || (u.failure.interactionRequired ? "interaction_required" : "token_unavailable"),
                detail: message,
                request_id: ctx.request_id
              });
            }
            pushActivity({ level: "error", message });
            break;
          }
          case "done":
            setFoundryRun({ running: false });
            break;
        }
      }
    });
  }, [
    cuaRunBaseUrl,
    agent,
    beginHandoff,
    setFoundryRun,
    pushActivity,
    setStreamingStatus,
    pushStep,
    setRelease,
    applyStatus,
    setHandoffError,
    t
  ]);

  // After a reconnect while a run was being watched: resume its status (never a start).
  React.useEffect(() => {
    if (!resumeRequest || !cuaRunBaseUrl || !agent) return;
    useRecoveryStore.setState({ resume: null });
    const record = useRecoveryStore.getState().record;
    if (record?.request_id !== resumeRequest.request_id || !record.handoff || !isCheckable(record)) return;
    if (useHandoffStore.getState().status !== "idle") return;
    runFoundry(record.handoff, { resume: true });
  }, [resumeRequest, cuaRunBaseUrl, agent, runFoundry]);

  // Whether the recorded request was started by someone other than the signed-in agent.
  const recordOwnedByOther = !!(transferRecord?.handoff?.requested_by?.agent_id && agent &&
    transferRecord.handoff.requested_by.agent_id !== agent.agent_id);

  // "Check status" for an unresolved request (same request ID, status only), and
  // "Send this transfer" for a start that was proven never sent (same ID and summary).
  const checkRecordStatus = React.useCallback(() => {
    const record = useRecoveryStore.getState().record;
    if (!record?.handoff || !isCheckable(record) || handoffActive) return;
    if (record.handoff.requested_by?.agent_id && agent && record.handoff.requested_by.agent_id !== agent.agent_id) {
      push({
        variant: "error",
        title: t("toast.otherAccount.title"),
        description: t("toast.otherAccount.desc", { id: record.request_id, who: record.handoff.requested_by.display_name }),
        toastId: "toast-other-account"
      });
      return;
    }
    runFoundry(record.handoff, { resume: true });
  }, [handoffActive, agent, push, runFoundry, t]);

  const sendRecordedTransfer = React.useCallback(() => {
    const record = useRecoveryStore.getState().record;
    if (!record?.handoff || record.state !== "not_sent" || record.backend !== "foundry" || handoffActive) return;
    if (record.handoff.requested_by?.agent_id && agent && record.handoff.requested_by.agent_id !== agent.agent_id) {
      push({
        variant: "error",
        title: t("toast.otherAccount.title"),
        description: t("toast.otherAccount.desc", { id: record.request_id, who: record.handoff.requested_by.display_name }),
        toastId: "toast-other-account"
      });
      return;
    }
    runFoundry(record.handoff, { resume: false });
  }, [handoffActive, agent, push, runFoundry, t]);

  // Actions offered on the status card for a Foundry failure, by how it stands.
  const cardReconnect = React.useCallback(() => {
    const s = useHandoffStore.getState();
    if (!s.callContext || !s.failure?.interactionRequired) return;
    void beginReconnect(s.failure.stage, s.callContext.request_id);
  }, [beginReconnect]);
  const cardSendAgain = React.useCallback(() => {
    const s = useHandoffStore.getState();
    if (s.status !== "error" || s.failure?.outcome !== "not_sent" || s.callContext?.target_backend !== "foundry") return;
    runFoundry(s.callContext, { resume: false });
  }, [runFoundry]);
  const cardCheckStatus = React.useCallback(() => {
    const s = useHandoffStore.getState();
    if (s.status !== "error" || s.failure?.outcome !== "unknown" || s.callContext?.target_backend !== "foundry") return;
    runFoundry(s.callContext, { resume: true });
  }, [runFoundry]);

  const submitHandoff = React.useCallback(
    async (summary: string) => {
      if (!scenario || !agent) return;

      // New-harness path: the separate experimental Copilot Studio agent, only
      // through its isolated relay. It always returns here, so it can never fall
      // through to the standard MCS trigger, Direct Line, Foundry or /handoff.
      if (backend === "mcs-new-harness") {
        if (!newHarnessBaseUrl || newHarnessAvailability.mode !== "known" || !newHarnessAvailability.ready) {
          push({
            variant: "error",
            title: t("dir.newHarnessAgentName"),
            description: newHarnessDestination.message ?? t("dir.newHarnessNotConfigured"),
            toastId: "toast-new-harness-unavailable"
          });
          return;
        }
        if (useHandoffStore.getState().status !== "idle") return;
        // Backstop: never a new claim run while an earlier request may have filed one.
        if (isUnresolved(useRecoveryStore.getState().record)) return;
        const ctx = buildCallContext({
          scenario,
          agent,
          summary: summary || scenario.summary_seed,
          transcriptExcerpt: getExcerpt(FOUNDRY_HOSTED_EXCERPT_CHARS),
          requestId: previewRequestId ?? undefined,
          backend
        });
        const ctxResult = validators.callContext(ctx);
        try {
          assertValid(ctxResult, "CallContext", isDevMode());
        } catch {
          push({
            variant: "error",
            title: t("toast.callContextInvalid.title"),
            description: ctxResult.errors.join("; "),
            toastId: "toast-callcontext-invalid"
          });
          return;
        }

        directLineAbortRef.current?.abort();
        const controller = new AbortController();
        directLineAbortRef.current = controller;

        beginHandoff(ctx, { handoffId: null });
        setModalOpen(false);
        push({
          variant: "success",
          title: t("toast.handoffInitiated.title"),
          description: t("toast.handoffConnecting.desc"),
          toastId: "toast-handoff-sent"
        });
        pushActivity({ level: "info", message: `Starting MCS new-harness (experimental) Claims request for ${ctx.request_id}.` });

        const current = () =>
          !controller.signal.aborted && useHandoffStore.getState().callContext?.request_id === ctx.request_id;
        const terminal = () => {
          const s = useHandoffStore.getState().status;
          return s === "submitted" || s === "error";
        };

        void runNewHarness({
          baseUrl: newHarnessBaseUrl,
          requestId: ctx.request_id,
          handoff: ctx,
          getToken: acquireHandoffAccessToken,
          signal: controller.signal,
          onUpdate: (u) => {
            if (u.type === "cancelled") {
              pushActivity({ level: "warn", message: u.detail });
              return;
            }
            if (!current()) return;
            switch (u.type) {
              case "accepted":
                pushActivity({ level: "info", message: `New-harness request ${u.nhRequestId} registered for ${ctx.request_id}; workflow dispatched.` });
                break;
              case "host_state":
                if ((u.state === "allocated" || u.state === "observable") && !terminal()) setStreamingStatus("ready");
                pushActivity({ level: "info", message: `New-harness host state: ${u.state}.` });
                break;
              case "event": {
                const e = u.event;
                const label = e.tool || e.type || "event";
                pushActivity({ level: e.type === "error" ? "error" : "info", message: `${label}: ${e.message ?? ""}`.trim() });
                break;
              }
              case "agent_response":
                pushActivity({ level: "info", message: `Agent reply (not verification): ${u.text}` });
                break;
              case "release": {
                const r = u.release.state;
                if (r === "released") {
                  setRelease({ state: "released" });
                  pushActivity({ level: "info", message: "The new-harness host confirmed the Cloud PC was released." });
                } else if (r === "uncertain") {
                  setRelease({ state: "ended-with-error", detail: "release_uncertain" });
                  pushActivity({ level: "warn", message: "The new-harness host could not confirm Cloud PC release; an administrator may need to check it." });
                } else {
                  setRelease({ state: "pending" });
                }
                break;
              }
              case "outcome": {
                const o = u.outcome;
                const submitted = {
                  request_id: ctx.request_id,
                  status: "submitted" as const,
                  claim_id: o.status === "submitted" ? o.claim_id : undefined,
                  policy_number: ctx.policy_number ?? undefined,
                  agent_id: agent.agent_id
                };
                if (o.status === "submitted" && validateHandoffStatus(submitted)) {
                  applyStatus(submitted);
                  pushActivity({ level: "info", message: `Claim ${o.claim_id} filed by the new-harness agent (host-verified on screen).` });
                } else {
                  const message = (o.status === "submitted"
                    ? "The new-harness result does not match the claims contract."
                    : o.message || "The new-harness run ended without filing a claim.").slice(0, 1000);
                  const reported = { request_id: ctx.request_id, status: "error" as const, error_code: o.status === "error" ? o.error_code : undefined, message };
                  const code: ErrorCode = o.status === "error" && validateHandoffStatus(reported) ? reported.error_code as ErrorCode : "UNKNOWN";
                  setHandoffError(code, message);
                  pushActivity({ level: "error", message: `New-harness run ended: ${message}` });
                }
                break;
              }
              case "error":
                if (!terminal()) setHandoffError("UNKNOWN", u.message);
                pushActivity({ level: "error", message: u.message });
                break;
            }
          }
        });
        return;
      }

      // Foundry hosted path: the separate Foundry destination, through this
      // app's service relay (which holds the Foundry credential). One run per
      // transfer, no automatic retry; the result returns to this interaction.
      if (foundryHosted && cuaRunBaseUrl) {
        if (foundryAvailability.mode !== "hosted" || !foundryAvailability.ready) return;
        if (handoffSignIn.mode !== "ready") return;
        // Backstop: never a new Foundry start while an earlier request is unresolved.
        if (isUnresolved(useRecoveryStore.getState().record)) return;
        if (useHandoffStore.getState().status !== "idle") return;
        if (foundryAvailability.capacityGate) {
          // Ask again at Confirm (the relay also checks before it accepts the start). If no
          // Cloud PC is free, or that cannot be confirmed, keep this confirmation and call as
          // they are: nothing is started and the request ID is not used. No automatic retry.
          if (admittingRef.current) return;
          admittingRef.current = true;
          setSubmitting(true);
          setConfirmNotice(null);
          let verdict: "available" | "none" | "error";
          try {
            const c = await getFoundryCapacity(cuaRunBaseUrl);
            verdict = !c.gate || c.state === "available" ? "available" : c.state === "none" ? "none" : "error";
          } catch {
            verdict = "error";
          } finally {
            admittingRef.current = false;
            setSubmitting(false);
          }
          if (verdict !== "available") {
            const notice = t(verdict === "none" ? "handoff.capacityNone" : "handoff.capacityError");
            setConfirmNotice(notice);
            pushActivity({ level: "warn", message: `Foundry transfer not started: ${notice}` });
            return;
          }
          if (isUnresolved(useRecoveryStore.getState().record) || useHandoffStore.getState().status !== "idle") return;
        }
        const ctx = buildCallContext({
          scenario,
          agent,
          summary: summary || scenario.summary_seed,
          transcriptExcerpt: getExcerpt(FOUNDRY_HOSTED_EXCERPT_CHARS),
          requestId: previewRequestId ?? undefined,
          backend
        });
        const ctxResult = validators.callContext(ctx);
        try {
          assertValid(ctxResult, "CallContext", isDevMode());
        } catch {
          push({
            variant: "error",
            title: t("toast.callContextInvalid.title"),
            description: ctxResult.errors.join("; "),
            toastId: "toast-callcontext-invalid"
          });
          return;
        }

        directLineAbortRef.current?.abort();
        directLineAbortRef.current = null;
        setModalOpen(false);
        push({
          variant: "success",
          title: t("toast.handoffInitiated.title"),
          description: t("toast.handoffConnecting.desc"),
          toastId: "toast-handoff-sent"
        });
        runFoundry(ctx, { resume: false });
        return;
      }
      // Option A — "autonomous trigger + Dataverse poll". When cuaRunBaseUrl is
      // configured, the Transfer button fires the run via the orchestrator (which
      // writes a Dataverse row whose "row created" event is the agent's autonomous
      // trigger) and renders a NEAR-LIVE view by polling progress. This is the
      // supported path when the agent uses "Authenticate with Microsoft" (the
      // browser-direct Direct Line stream returns nothing under MS auth), and it
      // preserves the Activity / Session-replay audit trail.
      if (backend === "mcs" && cuaRunBaseUrl) {
        // Backstop: never a new MCS transfer while an earlier one may have filed a claim.
        const pending = useRecoveryStore.getState().record;
        if (isUnresolved(pending) && pending?.backend === "mcs") return;
        const effectiveSummary = summary || scenario.summary_seed;
        const ctx = buildCallContext({
          scenario,
          agent,
          summary: effectiveSummary,
          transcriptExcerpt: getExcerpt(30_000),
          requestId: previewRequestId ?? undefined,
          backend
        });
        const ctxResult = validators.callContext(ctx);
        try {
          assertValid(ctxResult, "CallContext", isDevMode());
        } catch {
          push({
            variant: "error",
            title: t("toast.callContextInvalid.title"),
            description: ctxResult.errors.join("; "),
            toastId: "toast-callcontext-invalid"
          });
          return;
        }

        directLineAbortRef.current?.abort();
        const controller = new AbortController();
        directLineAbortRef.current = controller;

        beginHandoff(ctx, { handoffId: null });
        setModalOpen(false);
        push({
          variant: "success",
          title: t("toast.handoffInitiated.title"),
          description: t("toast.handoffConnecting.desc"),
          toastId: "toast-handoff-sent"
        });
        pushActivity({
          level: "info",
          message: `Filing claim for ${ctx.request_id} via AI agent (audit-tracked run).`
        });

        void runCuaViaTrigger({
          baseUrl: cuaRunBaseUrl,
          callContext: ctx,
          lang,
          regionId: activeRegionId,
          signal: controller.signal,
          onUpdate: (u) => {
            if (controller.signal.aborted || useHandoffStore.getState().callContext?.request_id !== ctx.request_id) return;
            switch (u.type) {
              case "queued":
                setStreamingStatus("queued");
                break;
              case "step":
                if (u.step) {
                  pushStep(u.step);
                  const what = [u.step.action, u.step.application].filter(Boolean).join(" in ");
                  const said = u.step.explanation ?? u.step.note;
                  pushActivity({
                    level: "info",
                    message: said ? `${what ? `${what}: ` : ""}${said}` : `${what || "Action"} (no explanation logged)`,
                    liveStep: true
                  });
                }
                break;
              case "activity":
                if (u.activity) {
                  setLiveActivity(u.activity);
                  if (u.activity.message) pushActivity({ level: "warn", message: u.activity.message });
                }
                break;
              case "release":
                if (u.release) {
                  setRelease(u.release);
                  if (u.release.state !== "pending" && u.release.state !== "unknown") {
                    const what = u.release.state === "ended" ? "ended; sign-out not observed" : u.release.state;
                    pushActivity({ level: u.release.state === "released" ? "info" : "warn", message: `Cloud PC session ${what}${u.release.at ? ` at ${u.release.at}` : ""}.` });
                  }
                }
                break;
              case "claim":
                applyStatus({
                  request_id: ctx.request_id,
                  status: "submitted",
                  claim_id: u.claimId,
                  policy_number: ctx.policy_number ?? undefined,
                  agent_id: agent.agent_id
                });
                pushActivity({ level: "info", message: `Claim ${u.claimId} filed by the AI agent.` });
                break;
              case "error":
                if (u.errorMessage) {
                  // A claim may or may not have been filed: no Retry on the card.
                  setHandoffError("UNKNOWN", u.errorMessage, u.uncertain
                    ? POSSIBLY_FILED
                    : undefined);
                  pushActivity({ level: "error", message: u.errorMessage });
                }
                break;
              case "done":
                break;
            }
          }
        });
        return;
      }

      // Direct Line streaming path: when the Copilot Studio token endpoint is
      // baked, the Transfer button opens its OWN Direct Line conversation in the
      // browser and streams the live Computer Use desktop into the status panel —
      // no orchestrator, no test pane, no typing. The agent drives a real Cloud
      // PC and returns a real claim id, rendered in-app.
      if (backend === "mcs" && directLineTokenUrl) {
        const effectiveSummary = summary || scenario.summary_seed;
        const ctx = buildCallContext({
          scenario,
          agent,
          summary: effectiveSummary,
          transcriptExcerpt: getExcerpt(30_000),
          requestId: previewRequestId ?? undefined,
          backend
        });
        const ctxResult = validators.callContext(ctx);
        try {
          assertValid(ctxResult, "CallContext", isDevMode());
        } catch {
          push({
            variant: "error",
            title: t("toast.callContextInvalid.title"),
            description: ctxResult.errors.join("; "),
            toastId: "toast-callcontext-invalid"
          });
          return;
        }

        directLineAbortRef.current?.abort();
        const controller = new AbortController();
        directLineAbortRef.current = controller;

        beginHandoff(ctx, { handoffId: null });
        setModalOpen(false);
        push({
          variant: "success",
          title: t("toast.handoffInitiated.title"),
          description: t("toast.handoffConnecting.desc"),
          toastId: "toast-handoff-sent"
        });
        pushActivity({
          level: "info",
          message: `Streaming live agent desktop for ${ctx.request_id} via Direct Line.`
        });

        const triggerText = buildTriggerText(effectiveSummary, ctx.policy_number, lang);
        void runDirectLineHandoff({
          tokenUrl: directLineTokenUrl,
          triggerText,
          signal: controller.signal,
          onUpdate: (u) => {
            if (controller.signal.aborted || useHandoffStore.getState().callContext?.request_id !== ctx.request_id) return;
            switch (u.type) {
              case "queued":
                setStreamingStatus("queued");
                break;
              case "narration":
                if (u.text) {
                  setNarration(u.text);
                  pushActivity({ level: "info", message: u.text });
                }
                break;
              case "screenshot":
                if (u.imageUrl) pushScreenshot(u.imageUrl);
                break;
              case "claim":
                applyStatus({
                  request_id: ctx.request_id,
                  status: "submitted",
                  claim_id: u.claimId,
                  policy_number: ctx.policy_number ?? undefined,
                  agent_id: agent.agent_id
                });
                pushActivity({ level: "info", message: `Claim ${u.claimId} filed by the AI agent.` });
                break;
              case "error":
                if (u.errorMessage) {
                  setHandoffError("UNKNOWN", u.errorMessage);
                  pushActivity({ level: "error", message: u.errorMessage });
                }
                break;
              case "done":
                break;
            }
          }
        });
        return;
      }

      // Guard the silent fallback: on the MCS path with no VITE_ORCHESTRATOR_URL baked, the
      // orchestrator URL defaults to the SWA-managed `/api`, which is the deprecated Foundry
      // endpoint and returns HTTP 502. Fail loudly instead of posting to it. (An explicitly
      // set orchestrator URL is honoured even when the build did not bake one.)
      if (backend === "mcs" && !MCS_URL_CONFIGURED && orchestratorUrl === "/api") {
        const reason =
          "MCS orchestrator URL is not configured (VITE_ORCHESTRATOR_URL). The desktop fell " +
          "back to the SWA-managed /api, which is the deprecated Foundry endpoint and will 502.";
        push({
          variant: "error",
          title: t("toast.orchestratorUnconfigured.title"),
          description: `${reason} Set the Direct Line orchestrator URL in Settings, then retry.`,
          toastId: "toast-orchestrator-unconfigured"
        });
        pushActivity({ level: "error", message: reason });
        return;
      }
      setSubmitting(true);
      try {
        const ctx = buildCallContext({
          scenario,
          agent,
          summary,
          transcriptExcerpt: getExcerpt(30_000),
          requestId: previewRequestId ?? undefined,
          backend
        });

        // Validate the outbound CallContext locally — schema is the contract.
        const ctxResult = validators.callContext(ctx);
        try {
          assertValid(ctxResult, "CallContext", isDevMode());
        } catch (err) {
          push({
            variant: "error",
            title: t("toast.callContextInvalid.title"),
            description: ctxResult.errors.join("; "),
            toastId: "toast-callcontext-invalid"
          });
          throw err;
        }

        // Post the handoff to the orchestrator, which starts the durable
        // handoff job and returns the handoff_id to poll for status.
        let res;
        directLineAbortRef.current?.abort();
        const controller = new AbortController();
        directLineAbortRef.current = controller;
        try {
          res = await postHandoff(orchestratorUrl, ctx, { signal: controller.signal });
          if (controller.signal.aborted) return;
        } catch (err) {
          if (controller.signal.aborted) return;
          const reason =
            err instanceof Error ? err.message : "Unknown network error";
          push({
            variant: "error",
            title: t("toast.handoffFailed.title"),
            description: t("toast.handoffFailed.desc", { reason }),
            toastId: "toast-handoff-failed"
          });
          pushActivity({
            level: "error",
            message: `Handoff POST failed: ${reason}`
          });
          return;
        }

        if (!res.handoff_id) {
          // The orchestrator status endpoint is keyed on the handoff_id.
          push({
            variant: "error",
            title: t("toast.handoffIncomplete.title"),
            description: t("toast.handoffIncomplete.desc"),
            toastId: "toast-handoff-incomplete"
          });
          pushActivity({
            level: "error",
            message: `Handoff ${ctx.request_id} returned no handoff_id.`
          });
          return;
        }

        pushActivity({
          level: "info",
          message: `Posted handoff ${ctx.request_id} to ${orchestratorUrl} (job ${res.handoff_id}).`
        });
        beginHandoff(ctx, {
          handoffId: res.handoff_id,
          orchestratorUrl,
          executionMode: res.execution_mode
        });
        push({
          variant: "success",
          title: t("toast.handoffInitiated.title"),
          description: t("toast.handoffSent.desc", { id: ctx.request_id }),
          toastId: "toast-handoff-sent"
        });
        setModalOpen(false);
      } finally {
        setSubmitting(false);
      }
    },
    [
      runFoundry,
      scenario,
      agent,
      getExcerpt,
      orchestratorUrl,
      backend,
      activeRegionId,
      cuaRunBaseUrl,
      directLineTokenUrl,
      previewRequestId,
      lang,
      foundryHosted,
      foundryAvailability,
      handoffSignIn,
      newHarnessBaseUrl,
      newHarnessAvailability,
      newHarnessDestination,
      beginHandoff,
      pushActivity,
      push,
      setStreamingStatus,
      setNarration,
      pushScreenshot,
      pushStep,
      setLiveActivity,
      setRelease,
      applyStatus,
      setHandoffError,
      t
    ]
  );

  return (
    <Card data-testid="right-rail" className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>{t("rail.title")}</CardTitle>
        {handoffActive && <Badge variant="accent">{t("rail.aiEngaged")}</Badge>}
      </CardHeader>
      <CardContent data-testid="right-rail-content" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <NotesSection />
        <div>
          <label
            htmlFor="disposition-select"
            className="mb-1 block text-xxs uppercase tracking-wider text-muted-400"
          >
            {t("rail.disposition")}
          </label>
          <Select
            id="disposition-select"
            data-testid="disposition-select"
            value={disposition}
            onChange={(e) => setDisposition(e.target.value as Disposition)}
            disabled={phase === "idle"}
            className="w-full"
          >
            <option value="">{t("rail.selectPlaceholder")}</option>
            {DISPOSITIONS.map((d) => (
              <option key={d} value={d}>
                {dispositionLabel(d, lang)}
              </option>
            ))}
          </Select>
        </div>

        {recoveryNotice && (
          <div data-testid="reconnect-notice" className="rounded-md border border-ok-500/40 bg-ok-500/10 p-3 text-xs text-slate-200">
            <p className="whitespace-pre-line break-words">{recoveryNotice}</p>
            <Button
              size="sm"
              variant="ghost"
              data-testid="reconnect-notice-dismiss"
              className="mt-2"
              onClick={() => useRecoveryStore.setState({ notice: null })}
            >
              {t("rail.prevTransfer.dismiss")}
            </Button>
          </div>
        )}

        {authDiag && (
          <div data-testid="auth-diagnostic" className="rounded-md border border-danger-500/40 bg-danger-500/10 p-3 text-xs text-slate-200">
            <div className="font-semibold uppercase tracking-wider text-danger-500">{t("rail.authDiag.title")}</div>
            <p className="mt-1 whitespace-pre-line break-words">{authDiag.detail}</p>
            <p className="mt-1 text-muted-400">
              {t(`rail.authDiag.stage.${authDiag.stage}`)}
              {" · "}<span className="font-mono">{authDiag.code}</span>
              {authDiag.request_id && <>{" · "}<span className="select-all break-all font-mono text-slate-100">{authDiag.request_id}</span></>}
              {" · "}{new Date(authDiag.at).toLocaleTimeString()}
            </p>
            <Button size="sm" variant="ghost" data-testid="auth-diagnostic-dismiss" className="mt-2" onClick={clearAuthDiagnostic}>
              {t("rail.prevTransfer.dismiss")}
            </Button>
          </div>
        )}

        {!handoffActive && transferRecord && transferRecord.request_id !== dismissedRecordId &&
          (isUnresolved(transferRecord) || (transferRecord.state === "not_sent" && transferRecord.backend === "foundry") ||
            transferRecord.request_id === loadedRecordId) && (
          <div
            data-testid="previous-transfer"
            data-state={transferRecord.state}
            className="rounded-md border border-warn-500/40 bg-warn-500/10 p-3 text-xs text-slate-200"
          >
            <div className="font-semibold uppercase tracking-wider text-warn-500">{t("rail.prevTransfer.title")}</div>
            <p className="mt-1 whitespace-pre-line break-words">
              {t(`rail.prevTransfer.${transferRecord.state}`, {
                code: transferRecord.error_code ?? "UNKNOWN",
                message: transferRecord.message ?? "",
                claim: transferRecord.claim_id ?? ""
              })}
            </p>
            {isUnresolved(transferRecord) && recordOwnedByOther && (
              <p data-testid="previous-transfer-other-account" className="mt-1 text-warn-500">
                {t("rail.prevTransfer.otherAccount", { who: transferRecord.handoff?.requested_by?.display_name ?? "" })}
              </p>
            )}
            <p className="mt-1 text-muted-400">
              <span className="uppercase tracking-wider">{t("ai.request")}</span>{" "}
              <span className="select-all break-all font-mono text-slate-100">{transferRecord.request_id}</span>
              {" · "}{transferRecord.backend}{" · "}{new Date(transferRecord.updated_at).toLocaleTimeString()}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {isCheckable(transferRecord) && transferRecord.handoff && !recordOwnedByOther && (
                <Button size="sm" variant="secondary" data-testid="previous-transfer-check" onClick={checkRecordStatus}>
                  {t("ai.checkStatus")}
                </Button>
              )}
              {isUnresolved(transferRecord) && (transferRecord.state === "stopped" || recordOwnedByOther) && (
                <Button size="sm" variant="secondary" data-testid="previous-transfer-acknowledge" onClick={() => {
                  if (acknowledgeTransfer()) {
                    pushActivity({ level: "warn", message: `${transferRecord.request_id} was marked as checked in the claims system by the agent; AI transfers can be used again.` });
                  }
                }}>
                  {t("rail.prevTransfer.acknowledge")}
                </Button>
              )}
              {transferRecord.state === "not_sent" && transferRecord.backend === "foundry" && transferRecord.handoff && (
                <Button size="sm" variant="secondary" data-testid="previous-transfer-send" disabled={!canHandoff} onClick={sendRecordedTransfer}>
                  {t("ai.sendAgain")}
                </Button>
              )}
              {!isUnresolved(transferRecord) && (
                <Button size="sm" variant="ghost" data-testid="previous-transfer-dismiss" onClick={() => dismissTransfer()}>
                  {t("rail.prevTransfer.dismiss")}
                </Button>
              )}
            </div>
          </div>
        )}

        {!handoffActive ? (
          <Button
            data-testid="open-transfer-directory"
            aria-label={t("rail.transferAria")}
            variant="secondary"
            size="lg"
            disabled={!canHandoff}
            onClick={openDirectory}
            className="mt-1 gap-2"
          >
            <ArrowRightLeft className="h-4 w-4" />
            {t("rail.transferInteraction")}
          </Button>
        ) : (
          <AIAgentStatusCard
            onReset={handleReset}
            onReconnect={cardReconnect}
            onSendAgain={cardSendAgain}
            onCheckStatus={cardCheckStatus}
            reconnecting={reconnecting}
          />
        )}

        <TransferDirectory
          open={directoryOpen}
          onOpenChange={(o) => setDirectoryOpen(o)}
          canHandoff={canHandoff}
          onSelectAi={selectAiDestination}
          onRouteToQueue={routeToQueue}
          cuaMode={cuaMode}
          foundry={foundryDestination}
          newHarness={newHarnessDestination}
          mcs={transferRecord && isUnresolved(transferRecord) && transferRecord.backend === "mcs"
            ? { enabled: false, message: t("dir.possiblyFiled", { id: transferRecord.request_id }) }
            : { enabled: true, message: null }}
        />

        <HandoffModal
          open={modalOpen}
          onOpenChange={(o) => !submitting && setModalOpen(o)}
          submitting={submitting}
          onConfirm={submitHandoff}
          notice={confirmNotice}
          summarySeed={summarySeed}
          callerLabel={scenario?.caller_display_name ?? ""}
          intentLabelText={scenario?.intent ?? ""}
          cuaMode={cuaMode}
          buildPreview={buildPreview}
        />
      </CardContent>
    </Card>
  );
}

function NotesSection() {
  const t = useT();
  const notes = useCallStore((s) => s.notes);
  const setNotes = useCallStore((s) => s.setNotes);
  return (
    <div>
      <label
        htmlFor="agent-notes"
        className="mb-1 block text-xxs uppercase tracking-wider text-muted-400"
      >
        {t("rail.agentNotes")}
      </label>
      <Textarea
        id="agent-notes"
        data-testid="agent-notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={t("rail.notesPlaceholder")}
        rows={4}
      />
    </div>
  );
}
