import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { RegionOption, ResolvedRegionConfig } from "@/lib/regionConfig";

export type AgentBackend = "mcs" | "foundry";

export interface SettingsState {
  /** The handoff endpoint the desktop posts to (derived from the selected backend). */
  orchestratorUrl: string;
  /** Which agent backend is active: Copilot Studio (mcs) or Foundry + W365A (foundry). */
  backend: AgentBackend;
  cuaMode: boolean;
  typewriterCps: number; // characters per second
  /** CUA regions available to the live-desktop stream (runtime-resolved). */
  regions: RegionOption[];
  /** The id of the region the Transfer button currently targets. */
  activeRegionId: string;
  /** Direct Line token endpoint for the active region (runtime source of truth). */
  directLineTokenUrl: string;
  /**
   * Orchestrator base URL (ending /api) for the "autonomous trigger + Dataverse
   * poll" path (Option A). When set, the Transfer button fires the run via this
   * endpoint and renders a NEAR-LIVE view by polling progress — the supported
   * path when the agent uses "Authenticate with Microsoft" (Direct Line is dead
   * under MS auth). Empty = use the directLineTokenUrl stream / orchestrator.
   */
  cuaRunBaseUrl: string;
  setOrchestratorUrl: (url: string) => void;
  setBackend: (backend: AgentBackend) => void;
  setCuaMode: (on: boolean) => void;
  setTypewriterCps: (cps: number) => void;
  /** Switch the active CUA region (no rebuild; persists across reloads). */
  setActiveRegion: (id: string) => void;
  /** Apply a runtime-resolved region set (from /region-config.json) at boot. */
  hydrateRegions: (cfg: ResolvedRegionConfig) => void;
  resetToDefaults: () => void;
}

function viteEnv(name: string): string | undefined {
  return (
    (typeof import.meta !== "undefined" && ((import.meta as any).env?.[name] as string | undefined)) || undefined
  );
}

/** Copilot Studio (MCS) handoff endpoint - the Durable Functions orchestrator. */
const MCS_URL = viteEnv("VITE_ORCHESTRATOR_URL") || "/api";
/**
 * Whether the MCS orchestrator URL was explicitly baked at build time. When false the
 * desktop has fallen back to the SWA-managed `/api`, which on the MCS path is the
 * deprecated Foundry endpoint that 502s. The handoff flow uses this to fail loudly
 * (with an actionable message) instead of silently posting to a dead backend.
 */
export const MCS_URL_CONFIGURED = Boolean(viteEnv("VITE_ORCHESTRATOR_URL"));
/** Foundry + Windows 365 for Agents handoff endpoint - the local-orchestrator paired with the runner (the orchestrator serves HTTP; the runner watches its file-drop). */
const FOUNDRY_URL = viteEnv("VITE_FOUNDRY_ORCHESTRATOR_URL") || "http://localhost:4000";

/**
 * The backend toggle is offered only when a distinct Foundry endpoint is configured
 * (i.e. the build baked VITE_FOUNDRY_ORCHESTRATOR_URL). Otherwise the desktop behaves
 * exactly as before - a single backend, no toggle.
 */
export const BACKEND_SELECTABLE = Boolean(viteEnv("VITE_FOUNDRY_ORCHESTRATOR_URL"));

const DEFAULT_BACKEND: AgentBackend = viteEnv("VITE_DEFAULT_BACKEND") === "foundry" ? "foundry" : "mcs";

/**
 * Copilot Studio Direct Line token endpoint. When baked, the Transfer button
 * streams the live agent desktop in-app (browser-direct Direct Line) instead of
 * posting to the orchestrator. Unset = legacy orchestrator path, unchanged.
 *
 * This is the BUILD-TIME fallback only. At runtime the store's `directLineTokenUrl`
 * (resolved from /region-config.json via hydrateRegions) is the source of truth;
 * these consts seed it before hydration and remain for back-compat.
 */
export const DIRECTLINE_TOKEN_URL = viteEnv("VITE_DIRECTLINE_TOKEN_URL") || "";
export const DIRECTLINE_CONFIGURED = Boolean(DIRECTLINE_TOKEN_URL);

/**
 * Base URL (ending /api) of the orchestrator that exposes the Option A
 * "autonomous trigger + Dataverse poll" endpoints (POST /cua-run,
 * GET /cua-run/{id}/progress). Seeded from VITE_CUA_RUN_BASE_URL at build time;
 * a `?cuaRunBaseUrl=` URL param overrides at runtime (handy for pointing the app
 * at a local mock during testing). When empty, the legacy paths are unchanged.
 */
function resolveCuaRunBaseUrl(): string {
  const fromEnv = viteEnv("VITE_CUA_RUN_BASE_URL") || "";
  if (typeof window !== "undefined") {
    const q = new URLSearchParams(window.location.search).get("cuaRunBaseUrl");
    if (q && q.trim()) return q.trim();
  }
  return fromEnv;
}
export const CUA_RUN_BASE_URL = resolveCuaRunBaseUrl();

/**
 * The `?cuaRunBaseUrl=` URL param, when present, is an explicit per-session override
 * (handy for pointing the deployed app at a local mock). It must win over a region's
 * configured cuaRunBaseUrl, so region hydration honours it.
 */
function cuaRunBaseUrlOverride(): string {
  if (typeof window === "undefined") return "";
  const q = new URLSearchParams(window.location.search).get("cuaRunBaseUrl");
  return q && q.trim() ? q.trim() : "";
}

export function urlForBackend(backend: AgentBackend): string {
  return backend === "foundry" ? FOUNDRY_URL : MCS_URL;
}

const STORAGE_KEY = "ccaas:settings";

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      orchestratorUrl: urlForBackend(DEFAULT_BACKEND),
      backend: DEFAULT_BACKEND,
      cuaMode: false,
      typewriterCps: 32,
      regions: [],
      activeRegionId: "",
      directLineTokenUrl: DIRECTLINE_TOKEN_URL,
      cuaRunBaseUrl: CUA_RUN_BASE_URL,
      setOrchestratorUrl: (orchestratorUrl) => set({ orchestratorUrl }),
      setBackend: (backend) => set({ backend, orchestratorUrl: urlForBackend(backend) }),
      setCuaMode: (cuaMode) => set({ cuaMode }),
      setTypewriterCps: (typewriterCps) => set({ typewriterCps }),
      setActiveRegion: (id) => {
        const { regions } = get();
        const region = regions.find((r) => r.id === id);
        if (!region) return;
        set({
          activeRegionId: region.id,
          directLineTokenUrl: region.directLineTokenUrl,
          cuaRunBaseUrl: cuaRunBaseUrlOverride() || region.cuaRunBaseUrl || CUA_RUN_BASE_URL,
          ...(region.orchestratorUrl ? { orchestratorUrl: region.orchestratorUrl } : {})
        });
      },
      hydrateRegions: (cfg) => {
        const regions = cfg.regions ?? [];
        if (regions.length === 0) return;
        // Honour a persisted region choice when it still exists in the served
        // config; otherwise fall back to the config's declared active region.
        const persisted = get().activeRegionId;
        const activeRegionId =
          persisted && regions.some((r) => r.id === persisted)
            ? persisted
            : cfg.activeRegionId && regions.some((r) => r.id === cfg.activeRegionId)
              ? cfg.activeRegionId
              : regions[0].id;
        const active = regions.find((r) => r.id === activeRegionId);
        set({
          regions,
          activeRegionId,
          directLineTokenUrl: active?.directLineTokenUrl ?? DIRECTLINE_TOKEN_URL,
          cuaRunBaseUrl: cuaRunBaseUrlOverride() || active?.cuaRunBaseUrl || CUA_RUN_BASE_URL,
          ...(active?.orchestratorUrl ? { orchestratorUrl: active.orchestratorUrl } : {})
        });
      },
      resetToDefaults: () =>
        set({
          orchestratorUrl: urlForBackend(DEFAULT_BACKEND),
          backend: DEFAULT_BACKEND,
          cuaMode: false,
          typewriterCps: 32
        })
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Never persist orchestratorUrl - it is always derived from `backend` so a stale URL
      // from a previous deploy to the same origin can't override the freshly baked endpoints.
      // activeRegionId IS persisted so a user's region choice survives reloads; it is
      // re-validated against the served region set in hydrateRegions.
      partialize: (s) => ({
        backend: s.backend,
        cuaMode: s.cuaMode,
        typewriterCps: s.typewriterCps,
        activeRegionId: s.activeRegionId
      }),
      // Recompute the endpoint from the (validated) backend on every rehydrate, and clamp a
      // persisted 'foundry' selection back to the build default when this build did not bake a
      // Foundry endpoint (so an old localStorage value can't strand the desktop on a dead URL).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        let backend: AgentBackend = p.backend === "foundry" ? "foundry" : "mcs";
        if (backend === "foundry" && !BACKEND_SELECTABLE) backend = DEFAULT_BACKEND;
        return {
          ...current,
          ...p,
          backend,
          orchestratorUrl: urlForBackend(backend)
        };
      }
    }
  )
);
