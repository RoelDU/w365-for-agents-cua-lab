import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bot, Users, ChevronRight, LogIn, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/stores/useLangStore";
import { useSettingsStore, type AgentBackend } from "@/stores/useSettingsStore";

interface QueueDestination {
  id: string;
  nameKey: string;
  detailKey: string;
}

// Human routing destinations the agent could transfer to instead of the AI.
// Selecting one is a realistic no-op in the demo (a toast), but it makes the
// point that the AI agent is just another destination in the same directory.
const QUEUE_DESTINATIONS: QueueDestination[] = [
  { id: "q-claims-t2", nameKey: "dir.queue.claimsT2", detailKey: "dir.queue.claimsT2.detail" },
  { id: "q-property", nameKey: "dir.queue.property", detailKey: "dir.queue.property.detail" },
  { id: "q-supervisor", nameKey: "dir.queue.supervisor", detailKey: "dir.queue.supervisor.detail" }
];

interface TransferDirectoryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the interaction is in a phase where a transfer is allowed. */
  canHandoff: boolean;
  /** Select an AI agent destination → advances to the handover confirmation. */
  onSelectAi: (backend: AgentBackend) => void;
  /** Whether the Foundry destination can take a transfer now, and why not. When
   * Microsoft requires the person to reconnect their sign-in, onReconnect is the
   * single action that does it (reconnecting: already started). */
  foundry: { enabled: boolean; message: string | null; hosted: boolean; onReconnect?: () => void; reconnecting?: boolean;
    /** Cloud PC availability could not be checked: the one action that checks again (detail: why, for the tooltip). */
    onRefresh?: () => void; detail?: string };
  /** Whether the separate new-harness destination can take a transfer now, and why not. */
  newHarness: { enabled: boolean; message: string | null };
  /** Copilot Studio (MCS): blocked only while an earlier MCS request may have filed a claim. */
  mcs?: { enabled: boolean; message: string | null };
  /** Select a human queue destination (demo no-op). */
  onRouteToQueue: (name: string) => void;
  /** When true, auto-select the AI destination shortly after opening so the
   * unattended (CUA) demo flows through the realistic directory step. */
  cuaMode: boolean;
}

export function TransferDirectory({
  open,
  onOpenChange,
  canHandoff,
  onSelectAi,
  onRouteToQueue,
  cuaMode,
  foundry,
  newHarness,
  mcs = { enabled: true, message: null }
}: TransferDirectoryProps) {
  const t = useT();
  const backend = useSettingsStore((s) => s.backend);
  const viaTrigger = !!useSettingsStore((s) => s.cuaRunBaseUrl);
  const autoPick =
    (backend === "mcs" && mcs.enabled) ||
    (backend === "foundry" && foundry.enabled) ||
    (backend === "mcs-new-harness" && newHarness.enabled);
  // CUA mode: visibly open the directory, then auto-pick the selected AI
  // destination so an unattended demo still demonstrates the realistic
  // transfer-to-destination gesture (rather than silently skipping it).
  React.useEffect(() => {
    if (!open || !cuaMode || !canHandoff || !autoPick) return;
    const id = setTimeout(() => onSelectAi(backend), 700);
    return () => clearTimeout(id);
  }, [open, cuaMode, canHandoff, autoPick, backend, onSelectAi]);

  const destinations: { id: AgentBackend; enabled: boolean; nameKey: string; subtitleKey: string; ariaKey: string; noteTestId: string; note: string | null }[] = [
    { id: "mcs", enabled: canHandoff && mcs.enabled, nameKey: "dir.mcsAgentName", subtitleKey: viaTrigger ? "dir.aiAgentSubtitleTrigger" : "dir.aiAgentSubtitle", ariaKey: "dir.mcsAgentAria", noteTestId: "handoff-mcs-availability", note: mcs.message },
    { id: "foundry", enabled: canHandoff && foundry.enabled, nameKey: "dir.foundryAgentName", subtitleKey: foundry.hosted ? "dir.foundryHostedSubtitle" : "dir.foundrySubtitle", ariaKey: "dir.foundryAgentAria", noteTestId: "handoff-foundry-availability", note: foundry.message },
    { id: "mcs-new-harness", enabled: canHandoff && newHarness.enabled, nameKey: "dir.newHarnessAgentName", subtitleKey: "dir.newHarnessSubtitle", ariaKey: "dir.newHarnessAgentAria", noteTestId: "handoff-new-harness-availability", note: newHarness.message }
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="transfer-directory"
        aria-describedby="transfer-directory-desc"
      >
        <DialogHeader>
          <DialogTitle>{t("dir.title")}</DialogTitle>
          <DialogDescription id="transfer-directory-desc">
            {t("dir.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section>
            <div className="mb-1.5 flex items-center gap-1.5 text-xxs uppercase tracking-wider text-accent-400">
              <Bot className="h-3.5 w-3.5" />
              {t("dir.aiAgents")}
            </div>
            <ul className="space-y-1.5">
              {destinations.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    data-testid={`handoff-to-ai-${d.id}`}
                    aria-label={t(d.ariaKey)}
                    disabled={!d.enabled}
                    onClick={() => onSelectAi(d.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border border-border bg-bg-800 p-3 text-left transition-colors",
                      d.enabled
                        ? "hover:border-accent-500 hover:bg-bg-700"
                        : "cursor-not-allowed opacity-50"
                    )}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-500/15 text-accent-400">
                      <Bot className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-100">
                          {t(d.nameKey)}
                        </span>
                        <Badge variant="accent">AI</Badge>
                      </div>
                      <div className="mt-0.5 text-xxs text-muted-400">{t(d.subtitleKey)}</div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-500" />
                  </button>
                  {d.note && (
                    <p
                      data-testid={d.noteTestId}
                      title={d.id === "foundry" && foundry.detail ? foundry.detail : undefined}
                      className="mt-1 px-1 text-xxs text-warn-500"
                    >
                      {d.note}
                    </p>
                  )}
                  {d.id === "foundry" && foundry.onRefresh && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      data-testid="handoff-foundry-capacity-refresh"
                      disabled={!canHandoff}
                      onClick={foundry.onRefresh}
                      className="ml-1 mt-1.5 gap-1.5"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      {t("dir.capacityRefresh")}
                    </Button>
                  )}
                  {d.id === "foundry" && foundry.onReconnect && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      data-testid="handoff-foundry-reconnect"
                      disabled={foundry.reconnecting || !canHandoff}
                      onClick={foundry.onReconnect}
                      className="ml-1 mt-1.5 gap-1.5"
                    >
                      <LogIn className="h-3.5 w-3.5" />
                      {t("dir.signInReconnectButton")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <div className="mb-1.5 flex items-center gap-1.5 text-xxs uppercase tracking-wider text-muted-400">
              <Users className="h-3.5 w-3.5" />
              {t("dir.queuesTeams")}
            </div>
            <ul className="space-y-1.5">
              {QUEUE_DESTINATIONS.map((q) => (
                <li key={q.id}>
                  <button
                    type="button"
                    data-testid={`transfer-queue-${q.id}`}
                    disabled={!canHandoff}
                    onClick={() => onRouteToQueue(t(q.nameKey))}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border border-border bg-bg-800 p-2.5 text-left transition-colors",
                      canHandoff
                        ? "hover:border-slate-500 hover:bg-bg-700"
                        : "cursor-not-allowed opacity-50"
                    )}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-900 text-muted-400">
                      <Users className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-100">
                        {t(q.nameKey)}
                      </div>
                      <div className="text-xxs text-muted-500">{t(q.detailKey)}</div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-500" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
