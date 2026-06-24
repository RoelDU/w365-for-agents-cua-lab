/*
 * msalLogin.ts — Microsoft Entra ID sign-in (the app's sole sign-in path). MSAL
 * is imported with a dynamic import() so the @azure/msal-browser bundle is split
 * out and only loaded when sign-in is actually exercised.
 *
 * Uses the REDIRECT flow (not popup): the desktop demo opens the app as an Edge
 * app-mode window (`--app=...`), where popup login is blocked by
 * Cross-Origin-Opener-Policy and the popup closes immediately. Redirect works in
 * both app-mode and normal tabs. signInWithMicrosoft() navigates the window to
 * Entra; completeRedirectSignIn() runs on app load to finish the round-trip and
 * map the account onto the app's AgentIdentity; signOutMicrosoft() clears the
 * MSAL session via logoutRedirect().
 */

import type { AgentIdentity } from "@/types/domain";

const AVATAR_COLORS = [
  "#2563eb",
  "#0891b2",
  "#7c3aed",
  "#db2777",
  "#ea580c",
  "#16a34a",
  "#ca8a04"
];

function initialsFrom(name: string, email: string): string {
  const source = name?.trim() || email?.trim() || "?";
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function colorFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export class MsalSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MsalSignInError";
  }
}

interface MsalAccount {
  username?: string;
  name?: string;
  localAccountId?: string;
  homeAccountId?: string;
}

function accountToIdentity(account: MsalAccount): AgentIdentity {
  const email = account.username ?? "";
  const displayName = account.name?.trim() || email || "Signed-in user";
  const id = account.localAccountId || account.homeAccountId || email;
  return {
    agent_id: `entra-${id}`,
    display_name: displayName,
    email,
    role: "csr",
    queue: "auto_claims",
    initials: initialsFrom(displayName, email),
    avatar_color: colorFor(id)
  };
}

/** Shared, lazily-created PublicClientApplication. MSAL requires a single
 * instance per app: the load-time handleRedirectPromise() and the click-time
 * loginRedirect() must use the SAME instance or MSAL throws
 * interaction_in_progress. */
let pcaPromise: Promise<import("@azure/msal-browser").IPublicClientApplication> | null = null;

async function getPca() {
  if (pcaPromise) return pcaPromise;
  pcaPromise = (async () => {
    const { getEntraConfig, buildMsalConfig, isConfigured } = await import("./msalConfig");
    const cfg = await getEntraConfig();
    if (!isConfigured(cfg.clientId)) {
      throw new MsalSignInError(
        "Microsoft sign-in is not configured yet for this deployment (no app-registration client id)."
      );
    }
    const { PublicClientApplication } = await import("@azure/msal-browser");
    const pca = new PublicClientApplication(buildMsalConfig(cfg));
    await pca.initialize();
    // Resolve any redirect response first so the interaction state is clean
    // before a subsequent loginRedirect() is attempted. Use the hash captured
    // synchronously at app entry (main.tsx) — by the time this async code runs,
    // React Router has already replaced "/" → "/login" and wiped the live hash.
    const capturedHash = (
      window as unknown as { __entraRedirectHash?: string }
    ).__entraRedirectHash;
    await pca.handleRedirectPromise(capturedHash ?? undefined).catch(() => null);
    return pca;
  })();
  try {
    return await pcaPromise;
  } catch (err) {
    pcaPromise = null; // allow retry on next attempt
    throw err;
  }
}

/**
 * Begin redirect-based sign-in. This navigates the window away to Microsoft
 * Entra, so the returned promise normally does not resolve (the page unloads).
 * It only rejects if starting the redirect fails before navigation.
 */
export async function signInWithMicrosoft(): Promise<void> {
  const { loginRequest } = await import("./msalConfig");
  let pca;
  try {
    pca = await getPca();
  } catch (err) {
    if (err instanceof MsalSignInError) throw err;
    throw new MsalSignInError(
      err instanceof Error ? err.message : "Microsoft sign-in could not start."
    );
  }
  await pca.loginRedirect(loginRequest);
}

/**
 * Complete a redirect sign-in on app load. Returns the signed-in user mapped to
 * an AgentIdentity if a redirect response was processed on this load, otherwise
 * null. Safe to call when entra is not configured (returns null).
 */
export async function completeRedirectSignIn(): Promise<AgentIdentity | null> {
  let pca;
  try {
    pca = await getPca();
  } catch {
    return null;
  }
  // getPca() already drained handleRedirectPromise(); read the resolved account.
  const accounts = pca.getAllAccounts();
  if (accounts.length > 0) {
    return accountToIdentity(accounts[0]);
  }
  return null;
}

/**
 * Sign out of Microsoft Entra ID. Triggers MSAL's redirect-based logout, which
 * clears the MSAL cache (sessionStorage) and navigates to the Entra logout
 * endpoint before returning to the app. If Entra is not configured (or MSAL
 * fails to initialize), this is a graceful no-op — the caller still clears the
 * local agent state.
 */
export async function signOutMicrosoft(): Promise<void> {
  let pca;
  try {
    pca = await getPca();
  } catch {
    return; // not configured / nothing to sign out of
  }
  const account = pca.getAllAccounts()[0];
  await pca.logoutRedirect(account ? { account } : undefined);
}
