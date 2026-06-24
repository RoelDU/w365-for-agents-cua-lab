import * as React from "react";
import { useAgentStateStore } from "@/stores/useAgentStateStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useCallStore } from "@/stores/useCallStore";
import { INITIAL_QUEUE_SNAPSHOT } from "@/mocks/queueStats";
import { queueLabel, roleLabel } from "@/mocks/agents";
import { formatClock, formatMmSs, auxLabel, auxDotClass } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuItem
} from "@/components/ui/dropdown";
import { ChevronDown, LogOut, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { useToastsStore } from "@/stores/useToastsStore";
import { resetRequestIdCounter } from "@/lib/payloadBuilder";
import { useT, useLang, useLangStore } from "@/stores/useLangStore";
import { SUPPORTED_LANGS, type Lang } from "@/i18n";

const AUX_OPTIONS = [
  "available",
  "acw",
  "break",
  "lunch",
  "training",
  "outbound",
  "tech_issue"
] as const;

const LANG_LABELS: Record<Lang, string> = {
  en: "EN",
  ja: "日本語"
};

/** Compact EN | 日本語 segmented language toggle (matches the BackendToggle style). */
function LangToggle() {
  const lang = useLang();
  const setLang = useLangStore((s) => s.setLang);
  const t = useT();
  return (
    <span
      data-testid="lang-toggle"
      aria-label={t("topbar.langToggleAria")}
      className="inline-flex overflow-hidden rounded-md border border-border"
    >
      {SUPPORTED_LANGS.map((l) => (
        <button
          key={l}
          type="button"
          data-testid={`lang-option-${l}`}
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          className={
            "px-2 py-1 text-xs font-semibold transition-colors " +
            (lang === l
              ? "bg-accent-500/20 text-accent-300"
              : "text-muted-400 hover:bg-bg-700 hover:text-slate-200")
          }
        >
          {LANG_LABELS[l]}
        </button>
      ))}
    </span>
  );
}

export function TopBar() {
  const t = useT();
  const lang = useLang();
  const agent = useAuthStore((s) => s.agent);
  const signOut = useAuthStore((s) => s.signOut);
  const aux = useAgentStateStore((s) => s.aux);
  const setAux = useAgentStateStore((s) => s.setAux);
  const nowSec = useAgentStateStore((s) => s.nowSec);
  const callPhase = useCallStore((s) => s.phase);
  const callDuration = useCallStore((s) => s.durationSec);
  const resetCall = useCallStore((s) => s.reset);
  const resetHandoff = useHandoffStore((s) => s.reset);
  const setAuxState = useAgentStateStore((s) => s.setAux);
  const pushToast = useToastsStore((s) => s.push);

  // One-click demo reset: clears the active call, AI handoff/live-desktop stream,
  // notes/disposition, and the request-id counter so the next demo starts clean —
  // no page reload needed. Dispatches ccaas:reset-demo so the RightRail aborts any
  // in-flight Direct Line stream.
  const resetDemo = React.useCallback(() => {
    window.dispatchEvent(new CustomEvent("ccaas:reset-demo"));
    resetHandoff();
    resetCall();
    resetRequestIdCounter();
    setAuxState("available");
    pushToast({
      variant: "info",
      title: t("toast.demoReset.title"),
      description: t("toast.demoReset.desc"),
      toastId: "toast-demo-reset"
    });
  }, [resetHandoff, resetCall, setAuxState, pushToast, t]);

  // Live queue snapshot — small wobble every few seconds for visual realism.
  const queueId = agent?.queue ?? "auto_claims";
  const queue = INITIAL_QUEUE_SNAPSHOT[queueId];
  const [queueState, setQueueState] = React.useState(queue);
  React.useEffect(() => {
    setQueueState(queue);
    const id = setInterval(() => {
      setQueueState((prev) => {
        const delta = Math.random() < 0.5 ? -1 : 1;
        const newCount = Math.max(0, prev.calls_waiting + (Math.random() < 0.35 ? delta : 0));
        const newLongest = Math.max(0, prev.longest_wait_seconds + 1);
        return { ...prev, calls_waiting: newCount, longest_wait_seconds: newLongest };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [queue]);

  // Signing out clears the previous agent's call/handoff state and ends the
  // Microsoft Entra session (logoutRedirect). The local agent is cleared first
  // so the UI returns to the login screen even if the redirect is delayed.
  const handleSignOut = React.useCallback(() => {
    resetDemo();
    signOut();
    import("@/lib/msalLogin")
      .then(({ signOutMicrosoft }) => signOutMicrosoft())
      .catch(() => {
        /* not configured — local sign-out already applied */
      });
  }, [resetDemo, signOut]);

  const effectiveAux = callPhase === "talking" ? "in_call" : aux;


  return (
    <header
      data-testid="topbar"
      className="flex h-12 items-center justify-between border-b border-border bg-bg-800 px-4"
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-accent-500 text-bg-900">
            <span className="block h-2 w-2 rounded-full bg-bg-900" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-slate-100">Zava</div>
            <div className="text-xxs uppercase tracking-wider text-muted-400">{t("brand.contactCenter")}</div>
          </div>
        </div>
        <Badge variant="muted" data-testid="brand-version">v3.2</Badge>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-testid="queue-card"
            className="flex items-center gap-3 rounded-md border border-border bg-bg-700/70 px-3 py-1.5"
          >
            <div className="flex items-center gap-1.5">
              <span className="text-xxs uppercase tracking-wider text-muted-400">{t("topbar.queue")}</span>
              <span className="text-sm font-semibold uppercase text-slate-100">
                {queueLabel(queueState.queue_id, lang)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-400">
              <span
                data-testid="queue-waiting-count"
                className="font-mono tabular-nums text-slate-100"
              >
                {queueState.calls_waiting}
              </span>
              <span>{t("topbar.waiting")}</span>
              <span className="text-muted-500">•</span>
              <span className="text-muted-400">{t("topbar.longest")}</span>
              <span
                data-testid="queue-longest-wait"
                className="font-mono tabular-nums text-slate-100"
              >
                {formatMmSs(queueState.longest_wait_seconds)}
              </span>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {t("topbar.queueTooltip", {
            queue: queueLabel(queueState.queue_id, lang),
            pct: queueState.service_level_pct
          })}
        </TooltipContent>
      </Tooltip>

      <div className="flex items-center gap-3">
        <LangToggle />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="reset-demo"
              aria-label={t("topbar.resetDemo")}
              onClick={resetDemo}
              className="gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("topbar.resetDemo")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("topbar.resetDemoTooltip")}
          </TooltipContent>
        </Tooltip>

        {callPhase === "talking" && (
          <div
            data-testid="topbar-call-timer"
            className="flex items-center gap-2 rounded-md border border-accent-500/30 bg-accent-500/10 px-2 py-1 text-xs text-accent-400"
          >
            <span className="font-semibold">{t("topbar.onCall")}</span>
            <span className="font-mono tabular-nums">{formatMmSs(callDuration)}</span>
          </div>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="agent-aux-trigger"
              aria-label={t("topbar.agentAria", {
                name: agent?.display_name ?? "unknown",
                state: auxLabel(effectiveAux, lang)
              })}
              className="flex items-center gap-2 rounded-md border border-border bg-bg-700 px-2 py-1.5 text-sm hover:bg-bg-600"
            >
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold"
                style={{ backgroundColor: agent?.avatar_color ?? "#475569" }}
              >
                {agent?.initials}
              </span>
              <div className="text-left leading-tight">
                <div className="text-xs font-semibold text-slate-100">
                  {agent?.display_name}
                </div>
                <div className="text-xxs text-muted-400">{agent ? roleLabel(agent.role, lang) : ""}</div>
              </div>
              <span
                data-testid="agent-aux-dot"
                className={`ml-1 inline-block h-2.5 w-2.5 rounded-full ${auxDotClass(effectiveAux)} ${effectiveAux === "available" ? "animate-pulse-dot" : ""}`}
              />
              <span className="hidden text-xxs uppercase tracking-wider text-muted-400 lg:inline">
                {auxLabel(effectiveAux, lang)}
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-400" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>{t("topbar.auxState")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={effectiveAux === "in_call" ? "available" : aux}
              onValueChange={(v) => setAux(v as typeof aux)}
            >
              {AUX_OPTIONS.map((opt) => (
                <DropdownMenuRadioItem
                  key={opt}
                  value={opt}
                  data-testid={`aux-opt-${opt}`}
                  disabled={callPhase === "talking"}
                >
                  {auxLabel(opt, lang)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="sign-out"
              onSelect={() => {
                handleSignOut();
              }}
            >
              <LogOut className="h-4 w-4" />
              {t("topbar.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger asChild>
            <div
              data-testid="clock"
              className="rounded-md border border-border bg-bg-700/70 px-2 py-1 font-mono text-xs text-slate-100"
            >
              {formatClock(new Date(nowSec * 1000))}
            </div>
          </TooltipTrigger>
          <TooltipContent>{t("topbar.clockTooltip")}</TooltipContent>
        </Tooltip>

        <Button
          variant="ghost"
          size="icon"
          aria-label={t("topbar.signOut")}
          data-testid="topbar-signout"
          onClick={handleSignOut}
          className="hidden lg:inline-flex"
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
