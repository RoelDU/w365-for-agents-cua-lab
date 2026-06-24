import * as React from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useAuthStore, type AuthState } from "@/stores/useAuthStore";
import { useSettingsStore, type SettingsState } from "@/stores/useSettingsStore";
import { AppShell } from "@/components/layout/AppShell";
import { LoginPage } from "@/pages/LoginPage";
import { WorkspacePage } from "@/pages/WorkspacePage";
import { InteractionsPage } from "@/pages/InteractionsPage";
import { KnowledgePage } from "@/pages/KnowledgePage";
import { StatsPage } from "@/pages/StatsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { readUrlOverrides } from "@/lib/urlParams";
import { useLang } from "@/stores/useLangStore";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const agent = useAuthStore((s: AuthState) => s.agent);
  if (!agent) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  const setAgent = useAuthStore((s: AuthState) => s.setAgent);
  const setCuaMode = useSettingsStore((s: SettingsState) => s.setCuaMode);
  const navigate = useNavigate();
  const lang = useLang();

  // Keep the document language attribute in sync for correct typography and a11y.
  // Also set a language-specific document title so the two Edge web-app desktop
  // icons (English + ?lang=ja) install with distinct, recognizable names.
  React.useEffect(() => {
    document.documentElement.lang = lang;
    document.title =
      lang === "ja"
        ? "Zava コンタクトセンター — エージェント"
        : "Zava Contact Center — Agent Workspace";
  }, [lang]);

  React.useEffect(() => {
    const overrides = readUrlOverrides();
    if (overrides.cua) setCuaMode(true);

    // Resolve the CUA region set at RUNTIME (served /region-config.json, with the
    // build-time VITE_DIRECTLINE_TOKEN_URL as fallback) so the live-desktop stream
    // can target any region without a rebuild. Hydrate the settings store with it.
    import("@/lib/regionConfig")
      .then(async ({ getRegionConfig }) => {
        const cfg = await getRegionConfig();
        useSettingsStore.getState().hydrateRegions(cfg);
      })
      .catch(() => {
        /* no region config — keep build-time fallback */
      });

    // Complete a Microsoft Entra ID redirect sign-in. On return from Entra the
    // URL carries the auth response; finish it, set the real identity, and land
    // on the workspace. Always attempted — Entra is the sole sign-in path.
    import("@/lib/msalLogin")
      .then(async ({ completeRedirectSignIn }) => {
        const identity = await completeRedirectSignIn();
        if (identity) {
          setAgent(identity);
          navigate("/workspace", { replace: true });
        }
      })
      .catch(() => {
        /* not configured or no redirect in progress — stay on login */
      });
  }, [setCuaMode, setAgent, navigate]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/workspace" element={<WorkspacePage />} />
        <Route path="/workspace/interactions" element={<InteractionsPage />} />
        <Route path="/workspace/knowledge" element={<KnowledgePage />} />
        <Route path="/workspace/stats" element={<StatsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
