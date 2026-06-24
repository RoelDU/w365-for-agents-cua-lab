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
import { ClipboardCopy, RefreshCw, Undo2, Maximize2, Minimize2 } from "lucide-react";
import { useT } from "@/stores/useLangStore";

interface AIAgentStatusCardProps {
  onReset: () => void;
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

export function AIAgentStatusCard({ onReset }: AIAgentStatusCardProps) {
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
  const active = useHandoffStore((s) => s.active);
  const applyStatus = useHandoffStore((s) => s.applyStatus);
  const pushActivity = useHandoffStore((s) => s.pushActivity);
  const latestScreenshotUrl = useHandoffStore((s) => s.latestScreenshotUrl);
  const screenshotCount = useHandoffStore((s) => s.screenshotCount);
  const narration = useHandoffStore((s) => s.narration);

  const orchestratorUrl = useSettingsStore((s) => s.orchestratorUrl);
  const cuaMode = useSettingsStore((s) => s.cuaMode);

  const push = useToastsStore((s) => s.push);

  // Theater/expand view for the live agent desktop (so the audience can see the
  // small Cloud-PC stream large during a demo). Updates live while open.
  const [expanded, setExpanded] = React.useState(false);

  // Poll the orchestrator status endpoint while a handoff job is in flight.
  React.useEffect(() => {
    if (!active || !callContext || !handoffId) return;
    if (status === "submitted" || status === "error") return;
    const sub = subscribeToStatus({
      baseUrl: orchestratorUrl,
      handoffId,
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
      }
    });
    return () => {
      sub.stop();
    };
  }, [
    active,
    callContext,
    handoffId,
    orchestratorUrl,
    cuaMode,
    status,
    applyStatus,
    pushActivity
  ]);

  // On `submitted`, copy the claim ID and surface a desktop-style toast.
  const submittedOnce = React.useRef(false);
  React.useEffect(() => {
    if (status !== "submitted" || !claimId) return;
    if (submittedOnce.current) return;
    submittedOnce.current = true;
    void copyToClipboard(claimId);
    push({
      variant: "success",
      title: t("toast.claimReady.title"),
      description: t("toast.claimReady.desc", { id: claimId }),
      toastId: "toast-claim-ready"
    });
    pushActivity({ level: "info", message: `Claim ${claimId} submitted.` });
  }, [status, claimId, push, pushActivity, t]);

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
            title={STATUS_RUN_HINT[status]}
          >
            {status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p
          data-testid="ai-status-copy"
          className="text-sm text-slate-200"
        >
          {t(STATUS_COPY_KEY[status])}
        </p>

        {(active || latestScreenshotUrl) && status !== "error" && (
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
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
                  <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-accent-500/40 border-t-accent-400" />
                  <span className="text-xs text-muted-400">
                    {t("ai.acquiring")}
                  </span>
                </div>
              )}
            </div>
            {narration && (
              <p
                data-testid="ai-live-narration"
                className="border-t border-accent-500/20 bg-bg-900/60 px-2.5 py-1.5 text-sm leading-snug text-slate-200"
              >
                {narration}
              </p>
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
            {(narration || claimId) && (
              <div className="border-t border-accent-500/20 px-4 py-4">
                {claimId && status === "submitted" ? (
                  <p className="text-2xl text-slate-100">
                    {t("ai.claimFiled")}{" "}
                    <span className="font-mono text-3xl text-ok-500">{claimId}</span>
                  </p>
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
              {t("ai.claimSubmitted")}
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

        {status === "error" && (
          <div className="rounded-md border border-danger-500/40 bg-danger-500/10 p-3 text-sm">
            <div className="font-semibold text-danger-500">
              {errorCode ?? "UNKNOWN"}
            </div>
            <div className="mt-1 text-slate-200">{errorMessage}</div>
            <div className="mt-3 flex gap-2">
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

        {callContext && (
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
