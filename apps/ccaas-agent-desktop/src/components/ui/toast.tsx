import * as React from "react";
import { useToastsStore } from "@/stores/useToastsStore";
import { cn } from "@/lib/cn";
import { X } from "lucide-react";

/**
 * Lightweight toast viewport. We deliberately avoid Radix Toast's animation
 * gymnastics to keep the test surface simple and to honor the CUA-friendly
 * requirement that toasts stay visible for ≥5 seconds.
 */
export function ToastViewport() {
  const toasts = useToastsStore((s) => s.toasts);
  const dismiss = useToastsStore((s) => s.dismiss);

  React.useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) =>
      setTimeout(() => dismiss(t.id), t.durationMs ?? 5500)
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismiss]);

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid={t.toastId ?? `toast-${t.variant}`}
          role={t.variant === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto rounded-md border px-3 py-2 shadow-panel animate-slide-in",
            t.variant === "info" && "border-accent-500/40 bg-bg-700 text-slate-100",
            t.variant === "success" && "border-ok-500/40 bg-bg-700 text-slate-100",
            t.variant === "warn" && "border-warn-500/40 bg-bg-700 text-slate-100",
            t.variant === "error" && "border-danger-500/40 bg-bg-700 text-slate-100"
          )}
        >
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <div className="text-sm font-semibold">{t.title}</div>
              {t.description && (
                <div className="mt-1 text-xs text-muted-400">{t.description}</div>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
              className="rounded p-1 text-muted-400 hover:bg-bg-600 hover:text-slate-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
