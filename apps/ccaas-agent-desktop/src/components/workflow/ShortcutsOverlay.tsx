import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: "Ctrl + A", label: "Answer the current call" },
  { keys: "Ctrl + H", label: "Toggle hold" },
  { keys: "Ctrl + M", label: "Toggle mute" },
  { keys: "Ctrl + E", label: "End the call" },
  { keys: "Ctrl + Shift + H", label: "Hand off the call to AI Agent" },
  { keys: "Ctrl + 1 … 5", label: "Switch left-nav sections (Calls / Interactions / Knowledge / Statistics / Settings)" },
  { keys: "?", label: "Open this shortcuts overlay" }
];

interface ShortcutsOverlayProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function ShortcutsOverlay({ open, onOpenChange }: ShortcutsOverlayProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shortcuts-overlay" className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <ul className="divide-y divide-border text-sm">
          {SHORTCUTS.map((s) => (
            <li key={s.keys} className="flex items-center justify-between py-2">
              <span className="text-slate-200">{s.label}</span>
              <kbd className="rounded border border-border bg-bg-800 px-2 py-0.5 font-mono text-xs text-slate-100">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
