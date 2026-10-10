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
  constructor(
    message: string,
    /** MSAL error code, when there is one. */
    public readonly code = "",
    /** True only when Microsoft says the person must interact (sign in, consent, MFA). */
    public readonly interactionRequired = false
  ) {
    super(message);
    this.name = "MsalSignInError";
  }
}

interface MsalAccount {
  username?: string;
  name?: string;
  localAccountId?: string;
  homeAccountId?: string;
  tenantId?: string;
}

/** Identifiers of an account (no tokens), used to bind a saved call to its owner. */
export interface SignedInAccount {
  homeAccountId: string;
  tenantId: string;
  username: string;
  /** The Zava agent ID this account signs in as (see accountToIdentity). */
  agentId: string;
}

function agentIdFor(account: MsalAccount): string {
  return `entra-${account.localAccountId || account.homeAccountId || account.username || ""}`;
}

function toAccountRef(account: MsalAccount): SignedInAccount {
  return {
    homeAccountId: account.homeAccountId ?? "",
    tenantId: account.tenantId ?? "",
    username: account.username ?? "",
    agentId: agentIdFor(account)
  };
}

/** What this page load's redirect response did: the account it signed in, or why it failed. */
let redirectOutcome: { error?: { code: string; message: string }; account?: SignedInAccount } | null = null;

/** The redirect outcome of this page load, once (null when no redirect response was processed). */
export function takeRedirectOutcome(): typeof redirectOutcome {
  const outcome = redirectOutcome;
  redirectOutcome = null;
  return outcome;
}

function accountToIdentity(account: MsalAccount): AgentIdentity {
  const email = account.username ?? "";
  const displayName = account.name?.trim() || email || "Signed-in user";
  const id = account.localAccountId || account.homeAccountId || email;
  return {
    agent_id: agentIdFor(account),
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
    // Record the outcome instead of discarding it: a reconnect must know whether
    // Microsoft's redirect actually succeeded and which account it signed in.
    try {
      const result = await pca.handleRedirectPromise(capturedHash ?? undefined);
      if (result?.account) {
        pca.setActiveAccount(result.account);
        redirectOutcome = { account: toAccountRef(result.account) };
      }
    } catch (err) {
      const e = (err ?? {}) as { errorCode?: string; errorMessage?: string; message?: string };
      const { redactSecrets } = await import("./redact");
      redirectOutcome = {
        error: {
          code: e.errorCode || "redirect_error",
          message: redactSecrets(String(e.errorMessage || e.message || "")).trim().slice(0, 300)
        }
      };
    }
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
  const account = currentAccount(pca);
  return account ? accountToIdentity(account) : null;
}

/** The account Zava acts as: the one the last redirect signed in, else the first cached one. */
function currentAccount(pca: import("@azure/msal-browser").IPublicClientApplication) {
  return pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
}

/** Identifiers of the signed-in account, or null when there is none (or sign-in is not configured). */
export async function getSignedInAccount(): Promise<SignedInAccount | null> {
  let pca;
  try {
    pca = await getPca();
  } catch {
    return null;
  }
  const account = currentAccount(pca);
  return account ? toAccountRef(account) : null;
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

/**
 * Acquire an access token for the handoff API (`api://<clientId>/Handoff.Access`)
 * for the already signed-in user, silently. MSAL reuses a valid cached token,
 * renews it with its refresh token, or renews it through the Entra session, in
 * that order. Used by the AI agent destinations (Foundry hosted and new-harness),
 * whose relays validate the token and bind the request to this user's tenant:oid.
 * Never starts an interactive redirect mid-handoff: when Microsoft requires the
 * person to interact, the error says so (interactionRequired) and the caller
 * offers startHandoffReconnect().
 */
export async function acquireHandoffAccessToken(): Promise<string> {
  const { getEntraConfig } = await import("./msalConfig");
  const pca = await getPca();
  const account = currentAccount(pca);
  if (!account) {
    throw new MsalSignInError("Sign in with Microsoft before transferring to an AI agent.", "no_account", true);
  }
  const cfg = await getEntraConfig();
  try {
    const result = await pca.acquireTokenSilent({
      account,
      scopes: [`api://${cfg.clientId}/Handoff.Access`]
    });
    return result.accessToken;
  } catch (err) {
    const { InteractionRequiredAuthError } = await import("@azure/msal-browser");
    const e = (err ?? {}) as { errorCode?: string; errorMessage?: string; message?: string };
    const code = e.errorCode ?? "";
    const interactionRequired = err instanceof InteractionRequiredAuthError || INTERACTION_CODES.has(code);
    // Microsoft's own text (e.g. "AADSTS50058 ... Trace ID ...") is kept for diagnosis; never a token.
    const { redactSecrets } = await import("./redact");
    const detail = redactSecrets(String(e.errorMessage || e.message || "")).trim().slice(0, 300);
    const head = interactionRequired
      ? `Microsoft needs you to confirm your sign-in before an AI agent transfer (${code}).`
      : `Could not get a sign-in token for the AI agent transfer${code ? ` (${code})` : ""}.`;
    throw new MsalSignInError(detail && detail !== code ? `${head} ${detail}` : head, code, interactionRequired);
  }
}

const INTERACTION_CODES = new Set(["interaction_required", "consent_required", "login_required"]);

/**
 * The one reconnect action: renew the relay token through Microsoft's sign-in
 * page, using the same redirect flow as the app's own sign-in (popups are not
 * reliable in the Edge app window). The caller saves the call first; App.tsx
 * verifies the returned account and restores it. Nothing is transferred here.
 * When MSAL holds no account, loginHint names the expected owner so Microsoft
 * offers that account; the returned account is still verified on return.
 */
export async function startHandoffReconnect(opts: { loginHint?: string } = {}): Promise<void> {
  const { getEntraConfig } = await import("./msalConfig");
  const pca = await getPca();
  const account = currentAccount(pca);
  const cfg = await getEntraConfig();
  await pca.acquireTokenRedirect({
    scopes: [`api://${cfg.clientId}/Handoff.Access`],
    ...(account ? { account } : opts.loginHint ? { loginHint: opts.loginHint } : {}),
    // Return through /login, exactly like the app's own sign-in: the router sends an
    // unauthenticated load to /login before MSAL finishes, so a /workspace start page
    // would never match and MSAL would keep re-navigating without completing.
    redirectStartPage: new URL("/login", window.location.origin).href
  });
}
