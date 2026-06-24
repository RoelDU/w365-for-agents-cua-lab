import * as React from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { TopBar } from "@/components/layout/TopBar";
import { LeftNav } from "@/components/layout/LeftNav";
import { StatusBar } from "@/components/layout/StatusBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastViewport } from "@/components/ui/toast";
import { useAgentStateStore } from "@/stores/useAgentStateStore";
import { useCallStore } from "@/stores/useCallStore";
import {
  ShortcutsOverlay
} from "@/components/workflow/ShortcutsOverlay";
import { useKeyboardShortcuts } from "@/components/workflow/useKeyboardShortcuts";

const NAV_ROUTES: Record<number, string> = {
  1: "/workspace",
  2: "/workspace/interactions",
  3: "/workspace/knowledge",
  4: "/workspace/stats",
  5: "/settings"
};

export function AppShell() {
  const tick = useAgentStateStore((s) => s.tick);
  const phase = useCallStore((s) => s.phase);
  const answerCall = useCallStore((s) => s.answerCall);
  const toggleHold = useCallStore((s) => s.toggleHold);
  const toggleMute = useCallStore((s) => s.toggleMute);
  const endCall = useCallStore((s) => s.endCall);
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = React.useState(false);

  React.useEffect(() => {
    const id = setInterval(() => tick(), 1000);
    return () => clearInterval(id);
  }, [tick]);

  useKeyboardShortcuts({
    onAnswer: () => phase === "ringing" && answerCall(),
    onToggleHold: () => phase === "talking" && toggleHold(),
    onToggleMute: () => phase === "talking" && toggleMute(),
    onEnd: () => (phase === "talking" || phase === "ringing") && endCall(),
    onHandoff: () => window.dispatchEvent(new CustomEvent("ccaas:open-handoff")),
    onNav: (idx) => navigate(NAV_ROUTES[idx]),
    onHelp: () => setHelpOpen(true)
  });

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-screen min-h-0 flex-col bg-bg-900 text-slate-100">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <LeftNav />
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </main>
        </div>
        <StatusBar />
        <ToastViewport />
        <ShortcutsOverlay open={helpOpen} onOpenChange={setHelpOpen} />
      </div>
    </TooltipProvider>
  );
}
