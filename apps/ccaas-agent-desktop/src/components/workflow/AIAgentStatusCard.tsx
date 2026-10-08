import * as React from "react";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import { copyToClipboard } from "@/lib/clipboard";
import { useToastsStore } from "@/stores/useToastsStore";
import { subscribeToStatus } from "@/lib/statusPolling";
import type { HandoffStatus } from "@/types/contracts";
import { ClipboardCopy, RefreshCw, Undo2, Maximize2, Minimize2, LogIn, Send, Search } from "lucide-react";
import { useT } from "@/stores/useLangStore";
import { FoundryViewer } from "./FoundryViewer";

interface AIAgentStatusCardProps {
  onReset: () => void;
  /** Foundry: reconnect the Microsoft sign-in, keeping this request (only when Microsoft requires it). */
  onReconnect?: () => void;
  /** Foundry: send the same handoff again under the same request ID (only when it was never sent). */
  onSendAgain?: () => void;
  /** Foundry: read the status of this same request (when its outcome is unknown); never starts. */
  onCheckStatus?: () => void;
  reconnecting?: boolean;
}

const STATUS_VARIANT_BADGE: Record<HandoffStatus, "muted" | "warn" | "ok" | "danger" | "accent"> = {
  idle: "muted",
  queued: "muted",
  prefilled: "warn",
  ready: "warn",
  submitted: "ok",
  error: "danger"
};

const STATUS_VARIANT_DOT: Record<HandoffStatus, "muted" | "warn" | "ok" | "danger" | "info"> = {
  idle: "muted",
  queued: "muted",
  prefilled: "warn",
  ready: "warn",
  submitted: "ok",
  error: "danger"
};

const STATUS_COPY_KEY: Record<HandoffStatus, string> = {
  idle: "ai.status.idle",
  queued: "ai.status.queued",
  prefilled: "ai.status.prefilled",
  ready: "ai.status.ready",
  submitted: "ai.status.submitted",
  error: "ai.status.error"
};

// How the demo's app-level status maps onto the Microsoft Copilot Studio agent
// run, reached over Bot Framework Direct Line (the Zava custom channel adapter).
// Surfaced as a tooltip so partner conversations can tie the demo to the real
// Copilot Studio + Computer Use lifecycle. See docs/handoff-architecture-decision.md.
const STATUS_RUN_HINT: Record<HandoffStatus, string> = {
  idle: "no active handoff",
  queued: "handoff queued — opening the Direct Line conversation",
  prefilled: "Copilot Studio agent has the context (pvaSetContext)",
  ready: "Computer Use loop — agent driving claims.exe; you're monitoring",
  submitted: "structured result returned — claim filed",
  error: "handoff failed / timed out"
};

// Attribution states that mean the activity cannot be shown as this handoff's.
const ACTIVITY_NOTE_KEY: Record<string, string> = {
  unattributed: "ai.activity.unattributed",
  mismatch: "ai.activity.mismatch",
  unavailable: "ai.activity.unavailable"
};

function formatTime(at: string | null | undefined): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
}

export function AIAgentStatusCard({ onReset, onReconnect, onSendAgain, onCheckStatus, reconnecting = false }: AIAgentStatusCardProps) {
  const t = useT();
  const status = useHandoffStore((s) => s.status);
  const callContext = useHandoffStore((s) => s.callContext);
  const handoffId = useHandoffStore((s) => s.handoffId);
  const claimId = useHandoffStore((s) => s.claimId);
  const policyNumber = useHandoffStore((s) => s.policyNumber);
  const legacyAgentId = useHandoffStore((s) => s.legacyAgentId);
  const reserveAmount = useHandoffStore((s) => s.reserveAmount);
  const errorCode = useHandoffStore((s) => s.errorCode);
  const errorMessage = useHandoffStore((s) => s.errorMessage);
  const failure = useHandoffStore((s) => s.failure);
  const active = useHandoffStore((s) => s.active);
  const applyStatus = useHandoffStore((s) => s.applyStatus);
  const setError = useHandoffStore((s) => s.setError);
  const pushActivity = useHandoffStore((s) => s.pushActivity);
  const latestScreenshotUrl = useHandoffStore((s) => s.latestScreenshotUrl);
  const screenshotCount = useHandoffStore((s) => s.screenshotCount);
  const narration = useHandoffStore((s) => s.narration);
  const currentStep = useHandoffStore((s) => s.currentStep);
  const liveActivity = useHandoffStore((s) => s.liveActivity);
  const release = useHandoffStore((s) => s.release);
  const foundryRun = useHandoffStore((s) => s.foundryRun);

  const simulated = liveActivity?.simulated === true;
  const activityNote =
    liveActivity && !simulated && ACTIVITY_NOTE_KEY[liveActivity.state]
      ? t(ACTIVITY_NOTE_KEY[liveActivity.state])
      : null;
  const stepMeta = currentStep
    ? [currentStep.action, currentStep.application, formatTime(currentStep.at)].filter(Boolean).join(" · ")
    : "";
  const releaseText = !release
    ? null
    : release.state === "released"
      ? t("ai.release.released", { time: formatTime(release.at) })
      : release.state === "ended"
        ? t("ai.release.ended", { time: formatTime(release.at) })
      : release.state === "ended-with-error"
        ? t("ai.release.error", { detail: release.detail ?? "", time: formatTime(release.at) })
        : t("ai.release.pending");
  const handoffUrl = useHandoffStore((s) => s.orchestratorUrl);
  const executionMode = useHandoffStore((s) => s.executionMode);
  const foundry = callContext?.target_backend === "foundry";
  const hosted = foundry && foundryRun !== null;
  const simulation = executionMode === "simulation";
  const foundryNoteKey = simulation ? "ai.simulation" : hosted ? "ai.foundryHosted" : "ai.foundryActivity";
  const hostedMeta = currentStep
    ? [currentStep.application, formatTime(currentStep.at)].filter(Boolean).join(" · ")
    : "";

  const orchestratorUrl = useSettingsStore((s) => s.orchestratorUrl);
  const cuaMode = useSettingsStore((s) => s.cuaMode);

  const push = useToastsStore((s) => s.push);

  // Theater/expand view for the live agent desktop (so the audience can see the
  // small Cloud-PC stream large during a demo). Updates live while open.
  const [expanded, setExpanded] = React.useState(false);
  // The Foundry live screen is bound to its element, so it is enlarged in place
  // (not moved into a dialog, which would remount it and drop the stream).
  const [foundryExpanded, setFoundryExpanded] = React.useState(false);
  // A failure must be readable without hunting: bring the error, its message and
  // the request ID into view inside the (scrollable) transfer panel.
  const errorRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (status === "error") errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [status]);
  React.useEffect(() => {
    if (!hosted) setFoundryExpanded(false);
  }, [hosted]);
  React.useEffect(() => {
    if (!foundryExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFoundryExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [foundryExpanded]);

  // Poll the orchestrator status endpoint while a handoff job is in flight.
  React.useEffect(() => {
    if (!active || !callContext || !handoffId) return;
    if (status === "submitted" || status === "error") return;
    const sub = subscribeToStatus({
      baseUrl: handoffUrl ?? orchestratorUrl,
      handoffId,
      requestId: callContext.request_id,
      executionMode,
      pollIntervalMs: cuaMode ? 500 : 1500,
      onUpdate: (payload) => {
        applyStatus(payload);
        pushActivity({
          level: payload.status === "error" ? "error" : "info",
          message: `Status update: ${payload.status}${payload.claim_id ? ` (${payload.claim_id})` : ""}`
        });
      },
      onError: (err) => {
        pushActivity({
          level: "warn",
          message: `Status poll error: ${err instanceof Error ? err.message : String(err)}`
        });
      },
      onFailure: (err) => setError("HOST_LINK_DOWN", err instanceof Error ? err.message : String(err))
    });
    return () => {
      sub.stop();
    };
  }, [
    active,
    callContext,
    handoffId,
    orchestratorUrl,
    handoffUrl,
    executionMode,
    cuaMode,
    status,
    applyStatus,
    setError,
    pushActivity
  ]);

  // On `submitted`, copy the claim ID and surface a desktop-style toast.
  const submittedOnce = React.useRef(false);
  React.useEffect(() => {
    if (status !== "submitted" || !claimId) return;
    if (submittedOnce.current) return;
    submittedOnce.current = true;
    if (!simulation) void copyToClipboard(claimId);
    push({
      variant: "success",
      title: t(simulation ? "ai.simulationResult" : "toast.claimReady.title"),
      description: t(simulation ? "ai.simulation" : "toast.claimReady.desc", { id: claimId }),
      toastId: "toast-claim-ready"
    });
    pushActivity({ level: "info", message: simulation ? `Simulation result: ${claimId}. No real claim filed.` : `Claim ${claimId} submitted.` });
  }, [status, claimId, push, pushActivity, t, simulation]);

  return (
    <Card data-testid="ai-status-card" className="mt-1 border-accent-500/30 bg-bg-800">
      <CardHeader>
        <CardTitle>{t("ai.title")}</CardTitle>
        <div className="flex items-center gap-2">
          <StatusDot
            variant={STATUS_VARIANT_DOT[status]}
            pulse={status === "prefilled" || status === "ready" || status === "queued"}
            aria-label={`Status: ${status}`}
          />
          <Badge
            variant={STATUS_VARIANT_BADGE[status]}
            data-testid="ai-status-badge"
            title={foundry ? t(foundryNoteKey) : STATUS_RUN_HINT[status]}
          >
            {status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {foundry && (
          <p data-testid="ai-execution-mode" className="rounded border border-warn-500/40 bg-bg-900 p-2 text-sm text-slate-200">
            {t(foundryNoteKey)}
          </p>
        )}
        <p
          data-testid="ai-status-copy"
          className="text-sm text-slate-200"
        >
          {t(simulation && status !== "error"
            ? status === "submitted" ? "ai.simulationResult" : "ai.simulationProgress"
            : STATUS_COPY_KEY[status])}
        </p>

        {status === "error" && (
          <div ref={errorRef} data-testid="ai-status-error" className="rounded-md border border-danger-500/40 bg-danger-500/10 p-3 text-sm">
            <div className="font-semibold text-danger-500" data-testid="ai-status-error-code">
              {failure?.outcome === "not_sent"
                ? t("ai.failure.notSent")
                : failure?.outcome === "unknown"
                  ? t("ai.failure.unknown")
                  : failure?.outcome === "stopped"
                    ? t("ai.failure.stopped")
                    : errorCode ?? "UNKNOWN"}
            </div>
            <div data-testid="ai-status-error-message" className="mt-1 whitespace-pre-line break-words text-slate-200">{errorMessage}</div>
            {callContext && (
              <div className="mt-2 text-xs text-muted-400">
                <span className="uppercase tracking-wider">{t("ai.request")}</span>{" "}
                <span data-testid="ai-status-request-id" className="select-all break-all font-mono text-slate-100">
                  {callContext.request_id}
                </span>
              </div>
            )}
            {releaseText && (
              <p data-testid="ai-status-release" className="mt-2 text-xs text-slate-200">
                {releaseText}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {failure?.interactionRequired && onReconnect ? (
                <Button
                  size="sm"
                  variant="warn"
                  data-testid="handoff-reconnect"
                  disabled={reconnecting}
                  onClick={onReconnect}
                  className="h-auto max-w-full gap-1.5 whitespace-normal text-left"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  {t("ai.reconnect")}
                </Button>
              ) : failure?.outcome === "not_sent" && onSendAgain ? (
                <Button size="sm" variant="warn" data-testid="handoff-send-again" onClick={onSendAgain} className="h-auto max-w-full gap-1.5 whitespace-normal text-left">
                  <Send className="h-3.5 w-3.5" />
                  {t("ai.sendAgain")}
                </Button>
              ) : failure?.outcome === "unknown" && onCheckStatus ? (
                <Button size="sm" variant="warn" data-testid="handoff-check-status" onClick={onCheckStatus} className="h-auto max-w-full gap-1.5 whitespace-normal text-left">
                  <Search className="h-3.5 w-3.5" />
                  {t("ai.checkStatus")}
                </Button>
              ) : !failure || failure.outcome === "rejected" ? (
                // A new transfer (new request ID) only after a confirmed outcome.
                <Button
                  size="sm"
                  variant="warn"
                  data-testid="handoff-retry"
                  onClick={onReset}
                  className="gap-1.5"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("ai.retry")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                data-testid="handoff-fallback"
                onClick={onReset}
                className="gap-1.5"
              >
                <Undo2 className="h-3.5 w-3.5" />
                {t("ai.fallbackManual")}
              </Button>
            </div>
          </div>
        )}

        {hosted && (
          <div
            data-testid="ai-foundry-hosted"
            data-expanded={foundryExpanded ? "true" : "false"}
            className={
              foundryExpanded
                ? "fixed inset-2 z-50 flex flex-col overflow-auto rounded-lg border border-accent-500/30 bg-black shadow-2xl sm:inset-6"
                : "overflow-hidden rounded-lg border border-accent-500/30 bg-black"
            }
          >
            <div className="flex items-center justify-end border-b border-accent-500/20 bg-bg-900/60 px-2.5 py-1.5">
              {foundryExpanded ? (
                <button
                  type="button"
                  data-testid="ai-foundry-collapse"
                  onClick={() => setFoundryExpanded(false)}
                  aria-label={t("ai.collapseAria")}
                  title={t("ai.collapseTitle")}
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded bg-bg-700 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-slate-100 shadow-md hover:bg-bg-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
                >
                  <Minimize2 className="h-4 w-4" />
                  {t("ai.collapse")}
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="ai-foundry-expand"
                  onClick={() => setFoundryExpanded(true)}
                  aria-label={t("ai.expandAria")}
                  title={t("ai.expandTitle")}
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded bg-accent-600 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white shadow-md hover:bg-accent-500 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
                >
                  <Maximize2 className="h-4 w-4" />
                  {t("ai.expand")}
                </button>
              )}
            </div>
            <FoundryViewer expanded={foundryExpanded} />
            <div className={foundryExpanded ? "border-t border-accent-500/20 bg-bg-900/60 px-4 py-3" : "border-t border-accent-500/20 bg-bg-900/60 px-2.5 py-1.5"}>
              <div className="flex flex-wrap items-baseline gap-x-2 text-xxs">
                <span
                  data-testid="ai-live-explanation-label"
                  className="font-semibold uppercase tracking-wider text-accent-400"
                >
                  {currentStep?.action ?? t("ai.explanationLabel")}
                </span>
                {hostedMeta && (
                  <span data-testid="ai-live-step-meta" className="tabular-nums text-muted-400">
                    {hostedMeta}
                  </span>
                )}
              </div>
              <p
                data-testid="ai-live-explanation"
                className={[
                  "mt-0.5 leading-snug",
                  foundryExpanded ? "text-2xl font-medium" : "text-sm",
                  currentStep?.explanation ? "whitespace-pre-line text-slate-200" : "italic text-muted-400"
                ].join(" ")}
              >
                {currentStep?.explanation ?? t("ai.foundry.noExplanation")}
              </p>
            </div>
          </div>
        )}
        {hosted && foundryExpanded && (
          <div
            aria-hidden="true"
            data-testid="ai-foundry-backdrop"
            onClick={() => setFoundryExpanded(false)}
            className="fixed inset-0 z-40 bg-black/80"
          />
        )}

        {!hosted && (!foundry || latestScreenshotUrl) && (active || latestScreenshotUrl) && status !== "error" && (
          <div
            data-testid="ai-live-desktop"
            className="overflow-hidden rounded-lg border border-accent-500/30 bg-black"
          >
            <div className="flex flex-wrap items-center gap-1.5 border-b border-accent-500/20 bg-bg-900/60 px-2.5 py-1.5">
              <span className="flex min-w-0 items-center gap-1.5 text-xxs font-semibold uppercase tracking-wider text-accent-400">
                <span
                  className={
                    status === "submitted"
                      ? "inline-block h-2 w-2 rounded-full bg-ok-500"
                      : "inline-block h-2 w-2 animate-pulse-dot rounded-full bg-danger-500"
                  }
                />
                {status === "submitted" ? t("ai.agentDesktopDone") : t("ai.liveAgentDesktop")}
              </span>
              <span className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
                {screenshotCount > 0 && (
                  <span className="text-xxs tabular-nums text-muted-400">
                    {t("ai.frames", { n: screenshotCount, s: screenshotCount === 1 ? "" : "s" })}
                  </span>
                )}

                {foundry && narration && !latestScreenshotUrl && (
                  <p data-testid="ai-foundry-narration" className="text-sm text-slate-200">{narration}</p>
                )}
                <button
                  type="button"
                  data-testid="ai-live-expand"
                  onClick={() => setExpanded(true)}
                  aria-label={t("ai.expandAria")}
                  title={t("ai.expandTitle")}
                  className="flex min-w-0 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded bg-accent-600 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white shadow-md hover:bg-accent-500 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
                >
                  <Maximize2 className="h-4 w-4" />
                  {t("ai.expand")}
                </button>
              </span>
            </div>
            <div className="relative aspect-video w-full bg-black">
              {latestScreenshotUrl ? (
                <img
                  data-testid="ai-live-screenshot"
                  src={latestScreenshotUrl}
                  alt={t("ai.liveScreenshotAlt")}
                  onClick={() => setExpanded(true)}
                  className="h-full w-full cursor-zoom-in object-contain"
                />
              ) : activityNote ? (
                <div className="flex h-full w-full items-center justify-center px-4 text-center">
                  <span data-testid="ai-live-activity-note" className="text-sm text-warn-500">
                    {activityNote}
                  </span>
                </div>
              ) : currentStep ? (
                <div className="flex h-full w-full items-center justify-center px-4 text-center">
                  <span className="text-xs text-muted-400">{t("ai.noScreenshot")}</span>
                </div>
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
                  <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-accent-500/40 border-t-accent-400" />
                  <span className="text-xs text-muted-400">
                    {liveActivity?.state === "waiting" ? t("ai.activity.waiting") : t("ai.acquiring")}
                  </span>
                </div>
              )}
            </div>
            {latestScreenshotUrl && activityNote && (
              <p
                data-testid="ai-live-activity-note"
                className="border-t border-accent-500/20 bg-bg-900/60 px-2.5 py-1.5 text-sm text-warn-500"
              >
                {activityNote}
              </p>
            )}
            {simulated ? (
              <div
                data-testid="ai-live-simulated"
                className="border-t border-warn-500/30 bg-warn-500/10 px-2.5 py-1.5 text-sm text-slate-200"
              >
                <p className="font-semibold text-warn-500">{t("ai.simulated")}</p>
                {currentStep?.note && <p data-testid="ai-live-sim-note">{currentStep.note}</p>}
              </div>
            ) : currentStep ? (
              <div className="border-t border-accent-500/20 bg-bg-900/60 px-2.5 py-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2 text-xxs">
                  <span
                    data-testid="ai-live-explanation-label"
                    className="font-semibold uppercase tracking-wider text-accent-400"
                  >
                    {t("ai.explanationLabel")}
                  </span>
                  {stepMeta && (
                    <span data-testid="ai-live-step-meta" className="tabular-nums text-muted-400">
                      {stepMeta}
                    </span>
                  )}
                </div>
                <p
                  data-testid="ai-live-explanation"
                  className={
                    currentStep.explanation
                      ? "mt-0.5 whitespace-pre-line text-sm leading-snug text-slate-200"
                      : "mt-0.5 text-sm italic leading-snug text-muted-400"
                  }
                >
                  {currentStep.explanation ?? t("ai.noExplanation")}
                </p>
                {!currentStep.imageUrl && latestScreenshotUrl && (
                  <p className="mt-0.5 text-xxs text-muted-400">{t("ai.previousScreenshot")}</p>
                )}
              </div>
            ) : (
              narration && (
                <p
                  data-testid="ai-live-narration"
                  className="border-t border-accent-500/20 bg-bg-900/60 px-2.5 py-1.5 text-sm leading-snug text-slate-200"
                >
                  {narration}
                </p>
              )
            )}
          </div>
        )}

        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent
            data-testid="ai-live-theater"
            className="max-w-[96vw] border-accent-500/30 bg-bg-900 p-0 sm:max-w-[92vw]"
          >
            <DialogTitle className="sr-only">{t("ai.theaterSrTitle")}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("ai.theaterSrDesc")}
            </DialogDescription>
            <div className="flex items-center justify-between border-b border-accent-500/20 px-4 py-2.5">
              <span className="flex items-center gap-2 text-lg font-semibold text-accent-400">
                <span
                  className={
                    status === "submitted"
                      ? "inline-block h-3 w-3 rounded-full bg-ok-500"
                      : "inline-block h-3 w-3 animate-pulse-dot rounded-full bg-danger-500"
                  }
                />
                {status === "submitted"
                  ? t("ai.theaterTitleDone")
                  : t("ai.theaterTitleLive")}
              </span>
              <span className="flex items-center gap-3">
                {screenshotCount > 0 && (
                  <span className="text-sm tabular-nums text-muted-400">
                    {t("ai.frames", { n: screenshotCount, s: screenshotCount === 1 ? "" : "s" })}
                  </span>
                )}
                <button
                  type="button"
                  data-testid="ai-live-collapse"
                  onClick={() => setExpanded(false)}
                  aria-label={t("ai.collapseAria")}
                  title={t("ai.collapseTitle")}
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded bg-bg-700 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-slate-100 shadow-md hover:bg-bg-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
                >
                  <Minimize2 className="h-4 w-4" />
                  {t("ai.collapse")}
                </button>
              </span>
            </div>
            <div className="flex max-h-[78vh] w-full items-center justify-center bg-black">
              {latestScreenshotUrl ? (
                <img
                  data-testid="ai-live-screenshot-large"
                  src={latestScreenshotUrl}
                  alt={t("ai.liveScreenshotLargeAlt")}
                  className="max-h-[78vh] w-full object-contain"
                />
              ) : (
                <div className="flex h-[60vh] w-full flex-col items-center justify-center gap-3 text-center">
                  <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-accent-500/40 border-t-accent-400" />
                  <span className="text-sm text-muted-400">
                    {t("ai.acquiring")}
                  </span>
                </div>
              )}
            </div>
            {(narration || claimId || currentStep) && (
              <div className="border-t border-accent-500/20 px-4 py-4">
                {claimId && status === "submitted" ? (
                  <p className="text-2xl text-slate-100">
                    {t("ai.claimFiled")}{" "}
                    <span className="font-mono text-3xl text-ok-500">{claimId}</span>
                  </p>
                ) : currentStep && !simulated ? (
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-wider text-accent-400">
                      {t("ai.explanationLabel")}
                      {stepMeta && <span className="ml-2 font-normal normal-case text-muted-400">{stepMeta}</span>}
                    </p>
                    <p
                      data-testid="ai-live-explanation-large"
                      className={
                        currentStep.explanation
                          ? "mt-1 whitespace-pre-line text-2xl font-medium leading-snug text-slate-100"
                          : "mt-1 text-2xl italic leading-snug text-muted-400"
                      }
                    >
                      {currentStep.explanation ?? t("ai.noExplanation")}
                    </p>
                  </div>
                ) : (
                  narration && (
                    <p
                      data-testid="ai-live-narration-large"
                      className="text-2xl font-medium leading-snug text-slate-100"
                    >
                      {narration}
                    </p>
                  )
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {status === "submitted" && claimId && (
          <div className="rounded-md border border-ok-500/40 bg-ok-500/10 p-3">
            <div className="text-xxs uppercase tracking-wider text-ok-500">
              {t(simulation ? "ai.simulationResult" : "ai.claimSubmitted")}
            </div>
            <div
              data-testid="ai-status-claim-id"
              className="mt-1 font-mono text-2xl tracking-tight text-slate-100"
            >
              {claimId}
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-400">
              {policyNumber && (
                <div>
                  <dt className="uppercase tracking-wider">{t("ai.policy")}</dt>
                  <dd
                    data-testid="ai-status-policy"
                    className="font-mono text-slate-100"
                  >
                    {policyNumber}
                  </dd>
                </div>
              )}
              {legacyAgentId && (
                <div>
                  <dt className="uppercase tracking-wider">{t("ai.submittedBy")}</dt>
                  <dd className="text-slate-100">{legacyAgentId}</dd>
                </div>
              )}
              {reserveAmount != null && (
                <div>
                  <dt className="uppercase tracking-wider">{t("ai.reserve")}</dt>
                  <dd className="text-slate-100">
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits: 0
                    }).format(reserveAmount)}
                  </dd>
                </div>
              )}
            </dl>
            {releaseText && (
              <p data-testid="ai-status-release" className="mt-2 text-xs text-slate-200">
                {releaseText}
              </p>
            )}
            <Button
              size="sm"
              variant="subtle"
              className="mt-3 gap-1.5"
              data-testid="copy-claim-id"
              onClick={() => copyToClipboard(claimId)}
            >
              <ClipboardCopy className="h-3.5 w-3.5" />
              {t("ai.copyClaimId")}
            </Button>
          </div>
        )}

        {callContext && status !== "error" && (
          <div className="rounded-md border border-border bg-bg-700 p-2 text-xxs text-muted-400">
            <span className="uppercase tracking-wider">{t("ai.request")}</span>{" "}
            <span
              data-testid="ai-status-request-id"
              className="font-mono text-slate-100"
            >
              {callContext.request_id}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
