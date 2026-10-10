import { beforeEach, describe, expect, it, vi } from "vitest";

const msal = vi.hoisted(() => ({
  error: null as unknown,
  accounts: [{ username: "tu1@contoso.example", homeAccountId: "h" }] as unknown[],
  redirects: [] as unknown[],
  redirectResult: null as unknown,
  redirectError: null as unknown,
  active: null as unknown,
  silentAccounts: [] as unknown[]
}));

vi.mock("@/lib/msalConfig", () => ({
  getEntraConfig: async () => ({ clientId: "client-id", tenantId: "tenant-id", redirectUri: "https://app/" }),
  buildMsalConfig: () => ({}),
  isConfigured: () => true,
  loginRequest: { scopes: [] }
}));

vi.mock("@azure/msal-browser", () => {
  class InteractionRequiredAuthError extends Error {
    constructor(public errorCode: string, public errorMessage = "") { super(errorMessage); }
  }
  return {
    InteractionRequiredAuthError,
    PublicClientApplication: class {
      async initialize() {}
      async handleRedirectPromise() {
        if (msal.redirectError) throw msal.redirectError;
        return msal.redirectResult;
      }
      getAllAccounts() { return msal.accounts; }
      getActiveAccount() { return msal.active; }
      setActiveAccount(account: unknown) { msal.active = account; }
      async acquireTokenSilent(request: { account: unknown }) {
        msal.silentAccounts.push(request.account);
        if (msal.error) throw msal.error;
        return { accessToken: "relay-token" };
      }
      async acquireTokenRedirect(request: unknown) { msal.redirects.push(request); }
    }
  };
});

async function tokenError(error: unknown) {
  msal.error = error;
  const { acquireHandoffAccessToken } = await import("@/lib/msalLogin");
  return acquireHandoffAccessToken().then(() => null, (e: Error & { code?: string; interactionRequired?: boolean }) => e);
}

describe("acquireHandoffAccessToken errors (mocked MSAL, not live proof)", () => {
  beforeEach(() => {
    vi.resetModules();
    msal.accounts = [{ username: "tu1@contoso.example", homeAccountId: "h" }];
    msal.redirects = [];
    msal.redirectResult = null;
    msal.redirectError = null;
    msal.active = null;
    msal.silentAccounts = [];
    msal.error = null;
  });

  it("R3: reports a failed or cancelled Microsoft redirect instead of discarding it", async () => {
    msal.redirectError = Object.assign(new Error("user_cancelled"), {
      errorCode: "user_cancelled", errorMessage: "User cancelled the flow. Bearer abc.def.ghi"
    });
    const m = await import("@/lib/msalLogin");
    expect(await m.completeRedirectSignIn()).not.toBeNull(); // the cached account still signs the app in
    const outcome = m.takeRedirectOutcome();
    expect(outcome?.error).toEqual({ code: "user_cancelled", message: "User cancelled the flow. [redacted]" });
    expect(m.takeRedirectOutcome()).toBeNull(); // read once
  });

  it("R3: uses the account the redirect actually signed in, for identity and for the relay token", async () => {
    const first = { username: "other@contoso.example", homeAccountId: "oid-2.tid", tenantId: "tid" };
    const returned = { username: "tu1@contoso.example", homeAccountId: "oid-1.tid", tenantId: "tid" };
    msal.accounts = [first, returned];
    msal.redirectResult = { account: returned };
    const m = await import("@/lib/msalLogin");
    expect(await m.getSignedInAccount()).toEqual({ homeAccountId: "oid-1.tid", tenantId: "tid", username: "tu1@contoso.example", agentId: "entra-oid-1.tid" });
    expect(m.takeRedirectOutcome()).toEqual({ account: { homeAccountId: "oid-1.tid", tenantId: "tid", username: "tu1@contoso.example", agentId: "entra-oid-1.tid" } });
    await m.acquireHandoffAccessToken();
    expect(msal.silentAccounts).toEqual([returned]);
  });

  it.each(["login_required", "interaction_required", "consent_required", "monitor_window_timeout"])(
    "names the sign-in problem (%s) without naming another AI destination",
    async (code) => {
      const error = await tokenError(Object.assign(new Error("msal"), { errorCode: code }));
      expect(error?.message).toContain(`(${code})`);
      expect(error?.message).not.toMatch(/new-harness/i);
    }
  );

  it("marks only Microsoft's interaction-required answers as needing a reconnect", async () => {
    const { InteractionRequiredAuthError } = await import("@azure/msal-browser");
    const required = await tokenError(new (InteractionRequiredAuthError as unknown as new (c: string, m: string) => Error)(
      "no_tokens_found", "AADSTS50058: silent sign-in found no session."));
    expect(required).toMatchObject({ code: "no_tokens_found", interactionRequired: true });
    expect(required?.message).toContain("AADSTS50058");
    const byCode = await tokenError(Object.assign(new Error("msal"), { errorCode: "login_required" }));
    expect(byCode?.interactionRequired).toBe(true);
    const timeout = await tokenError(Object.assign(new Error("msal"), { errorCode: "monitor_window_timeout" }));
    expect(timeout?.interactionRequired).toBe(false);
  });

  it("asks for sign-in when no account is cached, without naming another AI destination", async () => {
    msal.accounts = [];
    const error = await tokenError(null);
    expect(error?.message).toMatch(/sign in/i);
    expect(error?.message).not.toMatch(/new-harness/i);
    expect(error?.interactionRequired).toBe(true);
  });

  it("reconnects with one redirect for the relay scope and the same account, returning via the login page", async () => {
    const { startHandoffReconnect } = await import("@/lib/msalLogin");
    await startHandoffReconnect();
    expect(msal.redirects).toEqual([
      expect.objectContaining({
        scopes: ["api://client-id/Handoff.Access"],
        account: msal.accounts[0],
        redirectStartPage: `${window.location.origin}/login`
      })
    ]);
  });

  it("E2: with no cached account, reconnects by naming the expected owner, and the agent ID matches the identity", async () => {
    msal.accounts = [];
    const m = await import("@/lib/msalLogin");
    await m.startHandoffReconnect({ loginHint: "tu1@contoso.example" });
    expect(msal.redirects).toHaveLength(1);
    expect(msal.redirects[0]).toMatchObject({ scopes: ["api://client-id/Handoff.Access"], loginHint: "tu1@contoso.example" });
    expect(msal.redirects[0]).not.toHaveProperty("account");

    const returned = { username: "tu1@contoso.example", homeAccountId: "oid-1.tid", localAccountId: "oid-1", tenantId: "tid" };
    msal.accounts = [returned];
    msal.active = returned;
    expect((await m.getSignedInAccount())?.agentId).toBe((await m.completeRedirectSignIn())?.agent_id);
  });
});
