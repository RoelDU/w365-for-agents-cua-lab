import * as React from "react";
import { useSettingsStore, BACKEND_SELECTABLE, MCS_URL_CONFIGURED, type AgentBackend } from "@/stores/useSettingsStore";
import { pingOrchestrator } from "@/lib/orchestratorClient";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildVersion } from "@/lib/env";
import { useT } from "@/stores/useLangStore";

const BACKEND_LABELS: Record<AgentBackend, string> = {
  mcs: "Copilot Studio",
  foundry: "Foundry + W365A"
};

function BackendToggle() {
  const backend = useSettingsStore((s) => s.backend);
  const setBackend = useSettingsStore((s) => s.setBackend);
  const t = useT();
  if (!BACKEND_SELECTABLE) return null;
  return (
    <span data-testid="backend-toggle" className="flex items-center gap-1">
      <span className="text-muted-500">{t("status.agent")}:</span>
      <span className="inline-flex overflow-hidden rounded border border-border">
        {(["mcs", "foundry"] as AgentBackend[]).map((b) => (
          <button
            key={b}
            type="button"
            data-testid={`backend-option-${b}`}
            aria-pressed={backend === b}
            onClick={() => setBackend(b)}
            className={
              "px-1.5 py-0.5 normal-case transition-colors " +
              (backend === b ? "bg-accent-500/20 text-accent-300" : "text-muted-400 hover:text-muted-200")
            }
          >
            {BACKEND_LABELS[b]}
          </button>
        ))}
      </span>
    </span>
  );
}

export function StatusBar() {
  const t = useT();
  const orchestratorUrl = useSettingsStore((s) => s.orchestratorUrl);
  const backend = useSettingsStore((s) => s.backend);
  const cuaMode = useSettingsStore((s) => s.cuaMode);

  // On the MCS path with no VITE_ORCHESTRATOR_URL baked, orchestratorUrl is the deprecated
  // SWA-managed /api (Foundry) that 502s the handoff. Flag it as misconfigured up front so
  // the presenter sees the problem before attempting a handoff, not after a 502.
  const unconfigured = backend === "mcs" && !MCS_URL_CONFIGURED && orchestratorUrl === "/api";

  const [orchestratorOnline, setOrchestratorOnline] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    if (unconfigured) {
      setOrchestratorOnline(false);
      return;
    }
    let alive = true;
    const probe = async () => {
      const ok = await pingOrchestrator(orchestratorUrl);
      if (alive) setOrchestratorOnline(ok);
    };
    probe();
    const id = setInterval(probe, 8000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [orchestratorUrl, unconfigured]);

  return (
    <footer
      data-testid="statusbar"
      className="flex h-7 items-center justify-between border-t border-border bg-bg-800 px-3 text-xxs uppercase tracking-wider text-muted-400"
    >
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <StatusDot variant="muted" pulse aria-label={t("status.simulatedCcaasAria")} />
          {t("status.simulatedCcaas")}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid="orchestrator-status"
              className="flex cursor-help items-center gap-1.5"
            >
              <StatusDot
                variant={orchestratorOnline === null ? "muted" : orchestratorOnline ? "ok" : "danger"}
                pulse={orchestratorOnline === true}
                aria-label={
                  orchestratorOnline === null
                    ? t("status.orchestratorUnknownAria")
                    : orchestratorOnline
                      ? t("status.orchestratorReachableAria")
                      : t("status.orchestratorUnreachableAria")
                }
              />
              {t("status.orchestrator")}: <span className="font-mono normal-case">{orchestratorUrl}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {unconfigured
              ? t("status.orchestratorUnconfiguredTip")
              : orchestratorOnline === null
                ? t("status.orchestratorCheckingTip")
                : orchestratorOnline
                  ? t("status.orchestratorOnlineTip")
                  : t("status.orchestratorOfflineTip")}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center gap-3">
        <BackendToggle />
        {cuaMode && (
          <span
            data-testid="cua-mode-indicator"
            className="rounded border border-accent-500/40 bg-accent-500/10 px-1.5 py-0.5 text-accent-400"
          >
            {t("status.cuaMode")}
          </span>
        )}
        <span data-testid="build-version">{t("status.build")} {buildVersion()}</span>
        <span className="hidden md:inline normal-case text-muted-500">
          {t("status.demoNotice")}
        </span>
      </div>
    </footer>
  );
}
