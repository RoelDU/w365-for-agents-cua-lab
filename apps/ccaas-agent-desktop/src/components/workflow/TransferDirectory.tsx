import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Bot, Users, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/stores/useLangStore";

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
  /** Select the AI agent destination → advances to the handover confirmation. */
  onSelectAi: () => void;
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
  cuaMode
}: TransferDirectoryProps) {
  const t = useT();
  // CUA mode: visibly open the directory, then auto-pick the AI destination so
  // an unattended demo still demonstrates the realistic transfer-to-destination
  // gesture (rather than silently skipping it).
  React.useEffect(() => {
    if (!open || !cuaMode || !canHandoff) return;
    const id = setTimeout(() => onSelectAi(), 700);
    return () => clearTimeout(id);
  }, [open, cuaMode, canHandoff, onSelectAi]);

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
            <button
              type="button"
              data-testid="handoff-to-ai"
              aria-label={t("dir.aiAgentAria")}
              disabled={!canHandoff}
              onClick={onSelectAi}
              className={cn(
                "flex w-full items-center gap-3 rounded-md border border-border bg-bg-800 p-3 text-left transition-colors",
                canHandoff
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
                    {t("dir.aiAgentName")}
                  </span>
                  <Badge variant="accent">AI</Badge>
                </div>
                <div className="mt-0.5 text-xxs text-muted-400">
                  {t("dir.aiAgentSubtitle")}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-500" />
            </button>
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
