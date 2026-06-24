# Authentication — Microsoft Entra ID (MSAL)

This app uses **Microsoft Entra ID** as its single, default, and only sign-in
path, implemented with MSAL.js (`@azure/msal-browser`). There is no "simulated"
authentication mode and no agent picker — every session starts at the dedicated
Microsoft sign-in screen.

> **Note:** This is the authentication layer only. The app still ships an
> intentional **simulated CCaaS telephony layer** (canned call data, queue
> timers, the "Simulated CCaaS" status indicator). That demo content is
> unrelated to sign-in and is unaffected by this document.

## App registration

In your demo M365 E5 tenant, register a **Single-page application (SPA)** with:

- **Name:** `Zava CCaaS Agent Desktop (demo)`
- **Supported account types:** Accounts in this organizational directory only
- **Redirect URIs (SPA):**
  - `http://localhost:5173/` (for `npm run dev`)
  - Your production Static Web App URL, if applicable (must match the configured
    redirect URI exactly)
- **API permissions:** delegated `openid`, `profile`, `email`, `User.Read`
  (Microsoft Graph). Grant admin consent if your tenant requires it.
- **Token configuration:** add the `email` and `preferred_username` optional
  claims to the ID token.

> **Do not** grant any application (app-only) permissions, mailbox/calendar
> permissions, or write scopes. This app does not call Microsoft Graph beyond
> the basic identity token issued at sign-in.

## Runtime configuration

Sign-in configuration is resolved at **runtime** (see `src/lib/msalConfig.ts`),
so the same build can be pointed at any tenant without a rebuild. Resolution
order, lowest → highest precedence:

1. **Build-time env vars** (`VITE_AZURE_*`) — inlined by Vite at build/dev time.
2. **Served `/entra-config.json`** — drop a JSON file at the site root with
   `clientId` / `tenantId` / `redirectUri` to turn sign-in on post-build.
3. **URL params** — `?entraClientId=...&entraTenantId=...` (per-tab override).

### Build-time env vars

```env
VITE_AZURE_CLIENT_ID=<your-app-client-id>
VITE_AZURE_TENANT_ID=<your-tenant-id-or-"common">
VITE_AZURE_REDIRECT_URI=http://localhost:5173/
```

Restart the dev server (`npm run dev`) after changing env values — Vite inlines
`VITE_*` variables at build/start time.

### `entra-config.json`

The shipped `public/entra-config.json` holds all-zero placeholder values. While
the client id is the all-zero placeholder, `isConfigured()` returns `false` and
the sign-in button surfaces a "not configured yet for this deployment" error —
this is expected for a fresh checkout. Replace the placeholder client id (and
tenant id / redirect URI) with your app registration's values to enable sign-in.

## Sign-in flow (redirect)

The app uses MSAL's **redirect** flow (not popup). The desktop demo opens the
app as an Edge app-mode window (`--app=...`), where popup login is blocked by
Cross-Origin-Opener-Policy; redirect works in both app-mode and normal tabs.

1. The login screen shows a single **Sign in with Microsoft** action.
2. Clicking it calls `signInWithMicrosoft()` → `loginRedirect` with scopes
   `openid profile email User.Read`. The window navigates to Microsoft Entra.
3. On return, `completeRedirectSignIn()` (invoked on app load in `App.tsx`)
   finishes the round-trip, reads the signed-in account, and maps it onto the
   app's `AgentIdentity`.
4. The identity is written to `useAuthStore` and the app routes to
   `/workspace`.

### How identity maps to the workspace

`accountToIdentity()` (in `src/lib/msalLogin.ts`) derives the workspace agent
from the Entra account:

- `display_name` ← account name (falls back to email)
- `email` ← account username
- `agent_id` ← `entra-<oid/localAccountId>`
- `initials` / `avatar_color` ← derived from the name/email
- `role` ← `csr`, `queue` ← `auto_claims` (fixed defaults so the demo workspace
  always has a valid role/queue)

### Session persistence and sign-out

MSAL's own cache (`sessionStorage`) is the **source of truth** for the session.
`useAuthStore` is intentionally **not** persisted to `localStorage`, so a stale
agent is never restored without a real MSAL session — the identity is re-derived
from MSAL on each load. **Sign out** (agent menu, top-right) clears the local
agent and calls `signOutMicrosoft()` → `logoutRedirect()`, ending the Entra
session.

## Tests

Auth-store tests live in `tests/stores.auth.test.ts` and exercise the plain
store (starts unauthenticated, `setAgent`, `signOut`). `tests/LoginScreen.test.tsx`
asserts the Entra sign-in button renders, is enabled, and invokes
`signInWithMicrosoft` on click (the MSAL helper is mocked). Tests use the
`tests/fixtures/agent.ts` sample identity rather than any agent directory.
