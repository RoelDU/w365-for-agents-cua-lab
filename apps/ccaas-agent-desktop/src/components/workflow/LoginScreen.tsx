import * as React from "react";
import { useToastsStore } from "@/stores/useToastsStore";
import { Headphones, ShieldCheck } from "lucide-react";
import { useT } from "@/stores/useLangStore";

export function LoginScreen() {
  const t = useT();
  const push = useToastsStore((s) => s.push);

  const [signingIn, setSigningIn] = React.useState(false);

  // Real Microsoft Entra ID sign-in — the sole sign-in path. Redirect flow:
  // this navigates away to Microsoft Entra. Completion is handled on app load
  // by completeRedirectSignIn() (see App.tsx).
  const handleMicrosoftSignIn = React.useCallback(async () => {
    setSigningIn(true);
    try {
      const { signInWithMicrosoft } = await import("@/lib/msalLogin");
      await signInWithMicrosoft();
    } catch (err) {
      push({
        variant: "error",
        title: t("toast.entra.title"),
        description:
          err instanceof Error ? err.message : "Microsoft sign-in failed.",
        toastId: "toast-entra-error"
      });
      setSigningIn(false);
    }
  }, [push, t]);

  return (
    <div className="flex min-h-screen flex-col bg-bg-900 text-slate-100">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded bg-accent-500 text-bg-900">
            <Headphones className="h-4 w-4" aria-hidden />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Zava</div>
            <div className="text-xxs uppercase tracking-wider text-muted-400">{t("login.workspaceSub")}</div>
          </div>
        </div>
        <span className="rounded border border-warn-500/40 bg-warn-500/10 px-2 py-0.5 text-xxs uppercase tracking-wider text-warn-400">
          {t("login.demoBadge")}
        </span>
      </header>

      <main className="relative flex min-h-screen flex-1 overflow-hidden" style={{ background: "#070b12" }}>
        <style>{`
          @keyframes zorb1 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(40px,-30px) scale(1.1)} }
          @keyframes zorb2 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(-36px,28px) scale(1.08)} }
          @keyframes zfloat { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-12px)} }
        `}</style>

        {/* LEFT — call-center illustration (agent with headset) */}
        <div className="relative hidden w-[56%] flex-col justify-between overflow-hidden p-12 lg:flex"
          style={{ background: "linear-gradient(150deg,#081222 0%,#0a1c2c 55%,#0a2230 100%)" }}>
          <div aria-hidden className="pointer-events-none absolute -left-28 -top-32 h-[32rem] w-[32rem] rounded-full blur-[90px]"
            style={{ background: "radial-gradient(circle, rgba(58,214,197,0.30), transparent 68%)", animation: "zorb1 18s ease-in-out infinite" }} />
          <div aria-hidden className="pointer-events-none absolute -bottom-36 -right-24 h-[34rem] w-[34rem] rounded-full blur-[90px]"
            style={{ background: "radial-gradient(circle, rgba(79,134,232,0.28), transparent 68%)", animation: "zorb2 22s ease-in-out infinite" }} />

          <div className="relative z-10 flex items-center gap-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent-400 to-[#4f86e8] text-bg-900 text-base font-bold shadow-panel">Z</span>
            <span className="text-base font-semibold tracking-tight text-white">Zava Contact Center</span>
          </div>

          <div className="relative z-10 flex flex-1 items-center justify-center py-6">
            <img src="/login-art.svg" alt="" aria-hidden className="w-full max-w-lg" style={{ animation: "zfloat 8s ease-in-out infinite" }} />
          </div>

          <div className="relative z-10 text-xs uppercase tracking-[0.28em] text-white/40">Agent Workspace</div>
        </div>

        {/* RIGHT — minimal sign-in */}
        <div className="relative flex w-full flex-col items-center justify-center px-6 lg:w-[44%]" style={{ background: "#070c14" }}>
          <div className="flex w-full max-w-sm flex-col items-center text-center">
            <div className="mb-10 flex items-center gap-2.5 lg:hidden">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent-400 to-[#4f86e8] text-bg-900 text-base font-bold shadow-panel">Z</span>
              <span className="text-base font-semibold tracking-tight text-white">Zava</span>
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-white">{t("login.title")}</h2>
            <p className="mt-2 text-sm text-muted-400">{t("login.subtitleEntra")}</p>

            <button
              type="button"
              data-testid="entra-signin"
              disabled={signingIn}
              onClick={handleMicrosoftSignIn}
              className="mt-8 inline-flex items-center justify-center gap-2.5 rounded-lg bg-white px-5 py-2.5 text-[13px] font-medium text-[#1b1b1b] shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-900"
            >
              <MicrosoftLogo className="h-4 w-4" />
              {signingIn ? t("login.signingIn") : t("login.signInMicrosoft")}
            </button>

            <div className="mt-6 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-500">
              <ShieldCheck className="h-3 w-3 text-accent-500/70" aria-hidden />
              Microsoft Entra ID
            </div>
          </div>

          <p className="absolute bottom-5 left-0 right-0 px-6 text-center text-[10px] text-muted-600">
            {t("login.disclaimer")}
          </p>
        </div>
      </main>
    </div>
  );
}

/** Microsoft four-square brand mark. */
function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}
