/*
 * regionConfig.ts — runtime selection of the Computer Use (CUA) region the
 * in-app "Transfer to AI Agent" live-desktop stream targets.
 *
 * Why this exists: the live Direct Line stream (directLineClient.ts) talks
 * straight to a Copilot Studio agent's per-environment Direct Line token
 * endpoint. That endpoint is region-specific (the agent's Cloud PC pool lives
 * in the same geography as its Power Platform environment). Baking a single
 * endpoint at build time (VITE_DIRECTLINE_TOKEN_URL) hard-pins the demo to one
 * region, so a US builder who clones this repo would still drive an Australian
 * Cloud PC (and vice-versa).
 *
 * This module resolves the region set + active region at RUNTIME — exactly like
 * msalConfig.ts resolves Entra config from /entra-config.json — so the region can
 * be chosen at install/deploy time (or switched in the UI) WITHOUT a rebuild:
 *
 *   precedence (low → high):
 *     build-time VITE_DIRECTLINE_TOKEN_URL  (back-compat: a single "default" region)
 *       → served /region-config.json        (install/deploy-time region set + default)
 *         → ?region=<id> URL param          (per-session override)
 *
 * The resolved value feeds useSettingsStore, which the Transfer button reads.
 */

export interface RegionOption {
  /** Stable id used in config, URL param, and persisted selection (e.g. "au", "us"). */
  id: string;
  /** Human-readable label shown in the Settings region picker. */
  label: string;
  /** Copilot Studio Direct Line token endpoint for this region's agent. */
  directLineTokenUrl: string;
  /** Optional per-region handoff orchestrator base URL (defaults to the app's). */
  orchestratorUrl?: string;
  /**
   * Optional per-region Option A base URL (orchestrator /api that exposes the
   * autonomous-trigger + Dataverse-poll endpoints). When set, the Transfer button
   * uses the near-live trigger path for this region instead of Direct Line. Switch
   * the whole region back to Direct Line by removing this field (config-only, no
   * rebuild).
   */
  cuaRunBaseUrl?: string;
}

export interface ResolvedRegionConfig {
  regions: RegionOption[];
  /** The id of the region that should be active by default. */
  activeRegionId: string;
}

interface ViteEnv {
  VITE_DIRECTLINE_TOKEN_URL?: string;
}

const env = ((import.meta as unknown as { env?: ViteEnv }).env ?? {}) as ViteEnv;

/** The synthetic region id used when only a build-time endpoint is available. */
export const DEFAULT_REGION_ID = "default";

function buildTimeFallback(): ResolvedRegionConfig {
  const url = (env.VITE_DIRECTLINE_TOKEN_URL ?? "").trim();
  if (!url) return { regions: [], activeRegionId: "" };
  return {
    regions: [{ id: DEFAULT_REGION_ID, label: "Default", directLineTokenUrl: url }],
    activeRegionId: DEFAULT_REGION_ID
  };
}

function sanitizeRegions(raw: unknown): RegionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: RegionOption[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const directLineTokenUrl =
      typeof o.directLineTokenUrl === "string" ? o.directLineTokenUrl.trim() : "";
    if (!id || !directLineTokenUrl) continue;
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : id;
    const orchestratorUrl =
      typeof o.orchestratorUrl === "string" && o.orchestratorUrl.trim()
        ? o.orchestratorUrl.trim()
        : undefined;
    const cuaRunBaseUrl =
      typeof o.cuaRunBaseUrl === "string" && o.cuaRunBaseUrl.trim()
        ? o.cuaRunBaseUrl.trim()
        : undefined;
    out.push({ id, label, directLineTokenUrl, orchestratorUrl, cuaRunBaseUrl });
  }
  return out;
}

/**
 * Resolve the region config from build-time fallback → served /region-config.json
 * → ?region= URL param. Never throws; on any failure returns the best resolved
 * value so the app still boots (Transfer simply falls back to the orchestrator
 * path when no region is configured, exactly as before).
 */
export async function getRegionConfig(): Promise<ResolvedRegionConfig> {
  let resolved = buildTimeFallback();

  try {
    const res = await fetch("/region-config.json", { cache: "no-store" });
    if (res.ok) {
      const j = (await res.json()) as { regions?: unknown; activeRegion?: unknown };
      const regions = sanitizeRegions(j.regions);
      if (regions.length > 0) {
        const requested =
          typeof j.activeRegion === "string" ? j.activeRegion.trim() : "";
        const activeRegionId = regions.some((r) => r.id === requested)
          ? requested
          : regions[0].id;
        resolved = { regions, activeRegionId };
      }
    }
  } catch {
    /* no runtime config file — keep build-time fallback */
  }

  if (typeof window !== "undefined") {
    const p = new URLSearchParams(window.location.search);
    const q = p.get("region");
    if (q && q.trim() && resolved.regions.some((r) => r.id === q.trim())) {
      resolved = { ...resolved, activeRegionId: q.trim() };
    }
  }

  return resolved;
}

/** The Direct Line token URL for a region id, or "" when not found. */
export function tokenUrlForRegion(
  cfg: ResolvedRegionConfig,
  regionId: string
): string {
  return cfg.regions.find((r) => r.id === regionId)?.directLineTokenUrl ?? "";
}
