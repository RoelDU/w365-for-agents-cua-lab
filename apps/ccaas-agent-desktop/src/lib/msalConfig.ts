/*
 * msalConfig.ts — Microsoft Entra ID (MSAL) configuration for the app's sign-in
 * path. Imported lazily by msalLogin.ts.
 *
 * Config is resolved at RUNTIME so the side-by-side deployment can be enabled
 * without a rebuild: drop the app-registration client id into the served
 * /entra-config.json (or pass ?entraClientId=...&entraTenantId=... on the URL)
 * and sign-in turns on. Build-time VITE_AZURE_* vars act as fallback defaults.
 */

export interface EntraConfig {
  clientId: string;
  tenantId: string;
  redirectUri: string;
}

interface ViteEnv {
  VITE_AZURE_CLIENT_ID?: string;
  VITE_AZURE_TENANT_ID?: string;
  VITE_AZURE_REDIRECT_URI?: string;
}

const env = ((import.meta as unknown as { env?: ViteEnv }).env ?? {}) as ViteEnv;
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

function defaultRedirect(): string {
  return typeof window !== "undefined" ? window.location.origin + "/" : "/";
}

/** True when a real (non-placeholder) app-registration client id is present. */
export function isConfigured(clientId: string | undefined): boolean {
  return !!clientId && clientId.trim().length > 0 && clientId !== PLACEHOLDER;
}

/**
 * Resolve Entra config from (lowest→highest precedence):
 *   build-time VITE_AZURE_* defaults → served /entra-config.json → URL params.
 */
export async function getEntraConfig(): Promise<EntraConfig> {
  let clientId = env.VITE_AZURE_CLIENT_ID ?? "";
  let tenantId = env.VITE_AZURE_TENANT_ID ?? "organizations";
  let redirectUri = env.VITE_AZURE_REDIRECT_URI ?? defaultRedirect();

  try {
    const res = await fetch("/entra-config.json", { cache: "no-store" });
    if (res.ok) {
      const j = (await res.json()) as Partial<EntraConfig>;
      if (j.clientId && j.clientId.trim()) clientId = j.clientId.trim();
      if (j.tenantId && j.tenantId.trim()) tenantId = j.tenantId.trim();
      if (j.redirectUri && j.redirectUri.trim()) redirectUri = j.redirectUri.trim();
    }
  } catch {
    /* no runtime config file — fall back to env defaults */
  }

  if (typeof window !== "undefined") {
    const p = new URLSearchParams(window.location.search);
    const qc = p.get("entraClientId");
    const qt = p.get("entraTenantId");
    if (qc && qc.trim()) clientId = qc.trim();
    if (qt && qt.trim()) tenantId = qt.trim();
  }

  return { clientId, tenantId, redirectUri };
}

/** Build the msal-browser Configuration object from a resolved EntraConfig. */
export function buildMsalConfig(cfg: EntraConfig) {
  return {
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: cfg.redirectUri
    },
    cache: {
      cacheLocation: "sessionStorage" as const,
      storeAuthStateInCookie: false
    }
  };
}

/** Minimal sign-in scopes; the returned account already carries name + email. */
export const loginRequest = {
  scopes: ["openid", "profile", "email", "User.Read"]
};
