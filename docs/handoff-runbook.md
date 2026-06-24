# Handoff Orchestrator — Setup & Run Runbook

> ### ⚠️ This is the **Phase 2** unattended-handoff path — not required for the demo
> For the **live demo**, use **[`demo-minimal-path.md`](demo-minimal-path.md)**: trigger
> the agent natively (Test pane / standard channel / a one-step Power Automate flow) and
> let it drive `claims.exe` on the W365A Cloud PC — **no orchestrator, no Direct Line, no
> Entra app**. This runbook automates the *browser → agent unattended handoff*, which is
> more complex (a custom Direct Line channel needs **Authenticate manually** because the
> built-in *Authenticate with Microsoft* disconnects custom channels). Pursue it only as
> roadmap, after the core demo works.

How to deploy and run the standalone **Handoff Orchestrator** (the AI invocation
backend) and wire it to a published **Microsoft Copilot Studio** agent so the Zava
desktop can hand a live call to the AI, which drives `claims.exe` via Computer Use
(CUA) and returns a claim id.

> This runbook covers the **invocation seam** (CCaaS desktop → orchestrator →
> Copilot Studio → CUA → result). It assumes you already built the agent and the
> Windows 365 for Agents (W365A) Cloud PC pool per `docs/agent-cua-setup.md` and
> `docs/w365a-pool.md`. **`claims.exe` is pre-installed via Intune** as a required
> Win32 app on the agent pool (see
> [`w365a-pool.md` → Getting claims.exe onto the pool](w365a-pool.md#getting-claimsexe-onto-the-pool)).
> The design rationale lives in `docs/handoff-architecture-decision.md`.

> ### 🤖 Automated by the build script
> [`scripts/Build-DemoFromScratch.ps1`](../scripts/Build-DemoFromScratch.ps1) now
> **deploys the orchestrator for you** (phase C): it creates the resource group,
> Storage account, Function app (Node 24, managed identity), Key Vault, stores the
> Direct Line secret + an auto-generated callback key, wires app settings + CORS, and
> runs `func azure functionapp publish`. It also bakes the orchestrator URL into the
> desktop build and prints the callback URL + key for the Copilot Studio result flow.
> The only secret you supply is the Direct Line secret (in
> `handoffOrchestrator.directLineSecret`). **The sections below are the
> under-the-hood reference** — what the script automates, and the Copilot Studio-side
> wiring (§2) that stays a manual gate. Run them by hand only for a manual deploy or
> to understand/debug what the script does.

---

## 0. What changed (read first)

The AI invocation moved **from Azure AI Foundry threads/runs to Microsoft Copilot
Studio over Bot Framework Direct Line**. The desktop no longer tracks
`thread_id`/`run_id` — it tracks a single durable **`handoff_id`** owned by the new
backend.

| Component | Old | New |
|---|---|---|
| AI platform | Azure AI Foundry agent | **Microsoft Copilot Studio** published agent |
| Invocation | Foundry REST (threads/runs) | **Copilot Studio Direct-to-Engine** (channel `pva-engine-direct`) — the CUA-supported channel (#112); classic Bot Framework Direct Line is kept only for non-CUA testing |
| Backend | SWA-managed Function (`apps/ccaas-agent-desktop/api`, ~45s cap) | **standalone Azure Durable Functions** (`apps/handoff-orchestrator`) |
| Browser tracks | `thread_id` + `run_id` | single **`handoff_id`** |

`apps/ccaas-agent-desktop/api` is now **legacy** — keep it for reference but do not
deploy it for new demos.

> **Dual backend.** This runbook is the **Copilot Studio (MCS)** invocation path
> (`agentBackend: mcs`). The **Azure AI Foundry + Windows 365 for Agents** backend
> (`agentBackend: foundry`) serves the **same** `handoff_id` contract via
> [`samples/foundry-w365a-runner`](../samples/foundry-w365a-runner) instead of this Durable
> Functions orchestrator, so the desktop is identical either way. With `both`, the desktop's
> backend toggle switches between them live. See
> [`config-reference.md`](config-reference.md#agentbackend--choose-the-ai-backend-optional-defaults-to-mcs).

---

## 1. Prerequisites

- **Azure subscription** + Contributor on a resource group.
- **Azure CLI** (`az`) and **Azure Functions Core Tools v4** (`func`).
- **Node.js 20+** for local dev (the deployed Functions runtime is **Node 24**).
- A **published Copilot Studio agent** with **Generative Orchestration ON** and the
  **Computer Use** tool added, targeting your W365A Cloud PC pool. (Turn on generative
  orchestration **before** adding the tool; if **Add and configure** errors with
  `connectionReference is not defined`, see
  [`build-the-agent.md` step 3](build-the-agent.md#3-add-the-computer-use-tool-and-point-it-at-your-pool).)
- The agent's **Direct Line secret** — see [§2d](#2d-get-the-direct-line-secret) for
  the exact click-path. This is the one value you paste into
  `handoffOrchestrator.directLineSecret`.
- A **durable Copilot Studio entitlement** for the agent's environment. Publishing to the
  **Direct Line / Web / Mobile app** channel is premium usage; without entitlement Copilot Studio
  shows a *"60-days free trial"* prompt, which is not durable for a reusable demo. Recommended:
  **pay-as-you-go billing** linked to an Azure subscription — see
  [`licensing-and-entitlement.md`](licensing-and-entitlement.md).

---

## 2. Configure the Copilot Studio agent

The agent must (a) accept inbound context, (b) start on an explicit trigger, and
(c) call back with a **structured** result. Do all three.

> **Prerequisite — require authentication, and use *Authenticate manually*.** Before any of this
> works, set **Settings → Security → Authentication** to **Authenticate manually** (a custom Entra app
> registration), **not** *No authentication* and **not** *Authenticate with Microsoft*. **Computer Use
> is disabled for unauthenticated agents**, so an open agent errors the moment a topic routes to
> Computer Use (Test pane: *"CUA is disabled for unauthenticated agents. Please change your agent
> security settings."*) and the handoff hangs at `ready` with the pool showing 0 runs. But the built-in
> *Authenticate with Microsoft* **disconnects custom channels, including the Direct Line channel** the
> orchestrator uses to trigger the handoff — *Authenticate manually* keeps Direct Line connected **and**
> authenticates the agent. **One more critical setting: turn *Require users to sign in* OFF** — with it
> ON the agent returns an OAuth/sign-in card the headless orchestrator can't satisfy, so the handoff
> stalls. Also set the **Computer Use tool to *Maker-provided credentials*** (the unattended path has no
> end user). App-registration steps + fields:
> [`build-the-agent.md` → step 2](build-the-agent.md#2-turn-on-generative-orchestration). Save +
> Publish, then re-copy the Direct Line secret (§2d) if it rotated.

### 2a. Inbound context — Global variables + `pvaSetContext`
1. Create **Global variables** the topics read from, e.g. `Global.callerName`,
   `Global.callerPhone`, `Global.policyNumber`, `Global.intent`,
   `Global.correlationId`, `Global.handoff_id`, `Global.agentDisplayName`.
2. For each, enable **"External sources can set values."**
3. The orchestrator sends a Direct Line **event activity** named **`pvaSetContext`**
   whose `value` is the neutral context envelope *before* any trigger. Map the
   envelope fields onto the global variables. (Use **neutral** variable names so a
   future D365 channel can populate the same agent — see §7.)

### 2b. Explicit trigger
- The orchestrator's **trigger message** is a **natural-language instruction**, so the agent's
  **generative orchestration** routes it to the Computer Use tool. This is the **confirmed-working
  path** (it drove the Cloud PC end-to-end in testing). Set `HANDOFF_TRIGGER_TEXT` (§4) to that
  instruction; the default/example is the verified live string. Caller data arrives via the
  `pvaSetContext` Global variables (§2a), so the trigger text itself stays generic.
- **Do not use the bare token `start_fnol_handoff`.** It only matches a **classic custom topic**, and a
  classic topic that invokes the autonomous Computer Use tool via a **`Redirect to` node**
  instant-`SystemError`s (`isUserError: false`, 0 Cloud PC runs) — the build-side bug that blocked this
  demo (#69). Natural language + generative orchestration **bypasses the topic entirely**.
- **Requirements for reliable routing:** a clear, specific **Computer Use tool description**, and
  **web search / other knowledge disabled** on the agent so the instruction routes to Computer Use
  instead of being answered by search.
- If you *do* keep a classic topic, invoke Computer Use with a **tool/action call node — never
  `Redirect to`** (it's an autonomous tool, not a topic), and **pass the caller context as the run/task
  message** (compose it from the
  `pvaSetContext` globals). The exact node-by-node recipe is in
  [`build-the-agent.md` §5 → The exact wiring](build-the-agent.md#the-exact-wiring-this-is-the-fix-for-the-instant-systemerror).

### 2c. Structured result callback (authoritative)
The agent's final step must call a **typed Power Automate flow / custom connector**
that POSTs the result back to the orchestrator:

```
POST {orchestratorBaseUrl}/api/handoff/{handoff_id}/result
Headers: x-handoff-key: <HANDOFF_CALLBACK_KEY>
Body (JSON):
{
  "correlation_id": "<the Global.correlationId you received>",
  "status": "succeeded",          // or "failed"
  "claim_id": "CLM-2024-000123",  // on success
  "confidence": 0.97,
  "error": null                    // { "code": "...", "message": "..." } on failure
}
```

- `handoff_id` is delivered to the agent as a global variable (pass it through
  `pvaSetContext`) so the flow can build the callback URL.
- `correlation_id` **must** match the envelope the agent received, or the callback
  is rejected (409).
- `x-handoff-key` must equal `HANDOFF_CALLBACK_KEY` (401 otherwise).

> **Why structured?** Computer Use has **no proactive completion push**. The typed
> callback is the authoritative terminal signal; the orchestrator also polls Direct
> Line by watermark as a fallback, and parses a sentinel JSON block / claim-id only
> if no structured callback arrives. Never depend on regex over free chat text.
>
> ⚠️ **Validate in your tenant** that Copilot Studio can emit the outbound callback
> from a flow (it can via Power Automate HTTP); do not assume it can emit raw
> outbound Direct Line event activities.

### 2d. Get the Direct Line secret

This is the single secret the build needs (it goes in
`handoffOrchestrator.directLineSecret`; the build stores it in Key Vault for you). To
copy it from your **published** agent:

1. In **Copilot Studio**, open your agent.
2. **Publish** it first if you haven't — the channel/secret isn't available until the
   agent has been published at least once.
   > **See a *"Start a 60-days free trial"* prompt here instead of the channel?** That's the
   > Copilot Studio premium-entitlement gate. The trial is not durable — set up a durable
   > entitlement (recommended: pay-as-you-go billing) first:
   > [`licensing-and-entitlement.md`](licensing-and-entitlement.md).
3. Go to **Settings** (top-right gear) → **Security** → **Channels**
   *(in some tenants this is under Settings → Channels → "Direct Line" / "Web channel")*.
4. Open the **Direct Line** channel (or the **Web** channel, which exposes Direct Line).
5. Under **Secret keys**, click the **copy** (or **Show** then copy) icon next to one of
   the two keys.
6. Paste that string into `handoffOrchestrator.directLineSecret` in your
   `demo-config.local.json`.

> The secret is a long (~50+ char) random string. Treat it like a password — it lives
> only in the git-ignored `demo-config.local.json`, and the build moves it into Key
> Vault (secret name `DirectLineSecret`). Never commit it. If it ever leaks, return to
> this screen and **Regenerate** the key, then re-run the build.

---

## 3. Run locally (smoke test)

```powershell
cd apps\handoff-orchestrator
npm install
Copy-Item local.settings.sample.json local.settings.json
# edit local.settings.json: set DIRECTLINE_SECRET, HANDOFF_TRIGGER_TEXT,
# and HANDOFF_CALLBACK_KEY. For local dev WITHOUT a key, set
# HANDOFF_ALLOW_INSECURE_CALLBACK=true (the result callback otherwise returns
# 503 when no key is configured - it fails closed in Azure). Leave
# AzureWebJobsStorage as the dev-storage value and run Azurite, or point it at a
# real Storage account connection string.
npm test          # 25 unit tests, no network needed
func start        # starts the Functions host on http://localhost:7071
```

Quick checks:
```powershell
curl http://localhost:7071/api/health
# -> { "status": "ok" }

curl -Method POST http://localhost:7071/api/handoff -ContentType application/json -Body (Get-Content .\sample-callcontext.json -Raw)
# -> 202 { "handoff_id": "handoff-...", "status": "queued", "status_url": "..." }
```

> Durable Functions needs a Storage account. Locally, run **Azurite** (or set
> `AzureWebJobsStorage` to a real connection string).

---

## 4. Backend settings reference

| Setting | Purpose | Demo value |
|---|---|---|
| `AzureWebJobsStorage` | Durable state (required) | Storage connection string / `UseDevelopmentStorage=true` |
| `AzureWebJobsFeatureFlags` | Required for the v4 Node model on Linux Consumption (trigger indexing); without it publish syncs fail with BadRequest and routes return 503 | `EnableWorkerIndexing` |
| `HANDOFF_CHANNEL` | Channel adapter | **`engine`** (Direct-to-Engine, CUA-supported, #112); `directline` for non-CUA testing; future `d365` |
| `DIRECTLINE_SECRET` | Direct Line secret → token (only when `HANDOFF_CHANNEL=directline`) | **Key Vault reference** |
| `DIRECTLINE_BASE_URL` | Direct Line endpoint | `https://directline.botframework.com` |
| `ENGINE_CONVERSATIONS_URL` | Direct-to-Engine conversations endpoint (per-environment, copy verbatim; only when `HANDOFF_CHANNEL=engine`) | `https://{env}.environment.api.powerplatform.com/powervirtualagents/botsbyschema/{schema}/conversations?api-version=2022-03-01-preview` |
| `ENGINE_TENANT_ID` / `ENGINE_CLIENT_ID` / `ENGINE_CLIENT_SECRET` | Entra app-only credentials for the Direct-to-Engine token (client-credentials mode) | secret → **Key Vault reference** |
| `ENGINE_SCOPE` | OAuth scope for the engine token | `https://api.powerplatform.com/.default` (default) |
| `ENGINE_TOKEN_ENDPOINT` / `ENGINE_TOKEN` | Inject a token instead of client credentials (use if app-only tokens aren't permitted — the M365 Agents SDK path is delegated-only) | endpoint URL / pre-obtained token |
| `HANDOFF_TRIGGER_TEXT` | Natural-language trigger → generative orchestration (not the broken `start_fnol_handoff` token, #69) | `A customer phone call has been handed off … return the resulting claim ID.` |
| `HANDOFF_POLL_INTERVAL_MS` | Watermark poll cadence | `5000` |
| `HANDOFF_EXECUTION_TIMEOUT_MS` | Hard cap per handoff | `900000` (15 min) |
| `HANDOFF_CALLBACK_KEY` | Shared key for the result callback | **Key Vault reference** |
| `HANDOFF_ALLOW_INSECURE_CALLBACK` | Permit an unauthenticated callback when no key is set (LOCAL DEV ONLY) | unset in Azure |

Secrets (`DIRECTLINE_SECRET`, `ENGINE_CLIENT_SECRET`, `ENGINE_TOKEN`, `HANDOFF_CALLBACK_KEY`) must
**never** be committed or exposed to the browser — see §6.

---

## 5. Deploy to Azure

```powershell
# 1. Create the Function app (Node 24, Functions v4) + its Storage account, e.g.:
az group create -n Zava-CCaaS-Demo -l <region>
az storage account create -n zavahandoffstg -g Zava-CCaaS-Demo -l <region> --sku Standard_LRS
az functionapp create -g Zava-CCaaS-Demo -n zava-handoff-orchestrator `
  --storage-account zavahandoffstg --consumption-plan-location <region> `
  --runtime node --runtime-version 24 --functions-version 4 --assign-identity

# 2. Publish the code
cd apps\handoff-orchestrator
func azure functionapp publish zava-handoff-orchestrator

# 3. App settings (non-secret)
az functionapp config appsettings set -g Zava-CCaaS-Demo -n zava-handoff-orchestrator --settings `
  AzureWebJobsFeatureFlags=EnableWorkerIndexing `
  HANDOFF_CHANNEL=directline `
  DIRECTLINE_BASE_URL=https://directline.botframework.com `
  HANDOFF_TRIGGER_TEXT="A customer phone call has been handed off to you for automated processing. Using the caller phone, policy number, intent, and summary from the handoff context, open the Zava Mutual Claims Workstation and file a new First Notice of Loss, then return the resulting claim ID." `
  HANDOFF_POLL_INTERVAL_MS=5000 `
  HANDOFF_EXECUTION_TIMEOUT_MS=900000
```

> **v4 Node model:** `AzureWebJobsFeatureFlags=EnableWorkerIndexing` must be set
> **before** publish. Without it, `func publish` uploads successfully but
> "Syncing triggers..." returns `BadRequest` and every `/api/*` route returns
> HTTP 503. `Build-DemoFromScratch.ps1` sets this automatically.

The base URL of the deployed app (e.g. `https://zava-handoff-orchestrator.azurewebsites.net`)
is what the desktop's `orchestratorUrl` setting points at (§7).

---

## 6. Secrets via Key Vault + managed identity

Never put the Direct Line secret or callback key in app settings directly.

```powershell
az keyvault create -n zava-handoff-kv -g Zava-CCaaS-Demo -l <region>
az keyvault secret set --vault-name zava-handoff-kv -n DirectLineSecret --value "<direct-line-secret>"
az keyvault secret set --vault-name zava-handoff-kv -n HandoffCallbackKey --value "<random-strong-key>"

# Grant the Function app's managed identity 'get' on secrets
$mi = az functionapp identity show -g Zava-CCaaS-Demo -n zava-handoff-orchestrator --query principalId -o tsv
az keyvault set-policy -n zava-handoff-kv --object-id $mi --secret-permissions get

# Wire app settings as Key Vault references
az functionapp config appsettings set -g Zava-CCaaS-Demo -n zava-handoff-orchestrator --settings `
  "DIRECTLINE_SECRET=@Microsoft.KeyVault(VaultName=zava-handoff-kv;SecretName=DirectLineSecret)" `
  "HANDOFF_CALLBACK_KEY=@Microsoft.KeyVault(VaultName=zava-handoff-kv;SecretName=HandoffCallbackKey)"
```

Use the **same** `HandoffCallbackKey` value in the Copilot Studio result flow's
`x-handoff-key` header (§2c).

---

## 7. Point the desktop at the orchestrator

The desktop reads an **`orchestratorUrl`** runtime setting and polls it directly —
there is no SWA coupling. Set it to the Function app base URL:

- In the desktop Settings, or via URL param / config, set
  `orchestratorUrl = https://zava-handoff-orchestrator.azurewebsites.net`.
- Ensure the Function app **CORS** allows the desktop origin
  (`az functionapp cors add ...`).

The desktop flow:
1. `POST {orchestratorUrl}/api/handoff` with the CallContext → `202 { handoff_id }`.
2. Polls `GET {orchestratorUrl}/api/handoff/{handoff_id}/status` until a terminal
   status (`submitted` with a `claim_id`, or `error`).

Status mapping (backend → desktop union): `queued → queued`, `working → ready`,
`succeeded → submitted`, `failed`/`timed_out → error`. The custom status is
**authoritative** (a runtime "Completed" can still be a timeout/error).

### Validate the chain yourself (no agent, no second person)

`scripts/Test-Handoff.ps1` drives a real handoff and watches it advance
`queued → ready → submitted`, so you can confirm the orchestrator end-to-end on
your own:

```powershell
# Prove the full chain WITHOUT a live agent: it starts a handoff, waits for
# 'ready', then injects the result callback the agent's flow would send.
pwsh -File .\scripts\Test-Handoff.ps1 -SimulateResult `
  -BaseUrl https://<func>.azurewebsites.net/api -CallbackKey <HANDOFF_CALLBACK_KEY>

# Watch a REAL run (no -SimulateResult): shows exactly how far the live agent gets.
# If it sits at 'ready', that is the #69 wiring gap (trigger topic must invoke
# Computer Use + result flow), not an orchestrator fault.
pwsh -File .\scripts\Test-Handoff.ps1 -BaseUrl https://<func>.azurewebsites.net/api
```

`-BaseUrl` / `-CallbackKey` are printed by the build (`Orchestrator` / `Callback
key`); if omitted, the script reads them from `scripts/demo-config.local.json`.
`-SimulateResult` reaching `submitted` proves the orchestrator + callback work
independently of the still-manual agent wiring.

---

## 8. Pre-demo checklist

- [ ] `func start` health endpoint returns ok; `npm test` green (25).
- [ ] Copilot Studio agent **published**; Computer Use tool points at the W365A pool.
- [ ] **Authentication = *Authenticate manually*** (custom Entra app) **with *Require users to sign in*
      = OFF**, **verified end-to-end over Direct Line ahead of time**. *Authenticate with Microsoft* is
      unsupported on the Direct Line channel (silent or explicit auth-channel error, #81); *No
      authentication* disables Computer Use; and *Authenticate manually* **with sign-in required** returns
      an OAuth card the headless orchestrator can't satisfy. Only **manual auth + sign-in OFF** satisfies
      both Direct Line and CUA. Keep the Direct Line trigger path free of `Authenticate` nodes/auth
      variables. Set it up **days before**, never minutes before a live call (§2 of
      [`build-the-agent.md`](build-the-agent.md#2-turn-on-generative-orchestration)).
- [ ] **Computer Use tool → Credentials = *Maker-provided credentials*** (not end-user), with the legacy
      app/machine credential preconfigured — the unattended Direct Line path has no end user to sign in.
- [ ] A **topic on the `HANDOFF_TRIGGER_TEXT` trigger invokes Computer Use** (§2b) — not just
      the tool present; web search / other knowledge **disabled** (else stuck at `ready`, #69).
- [ ] **Inbound-context Global variables** created with "External sources can set values" (§2a).
- [ ] Direct Line secret in Key Vault; managed identity can read it.
- [ ] `HANDOFF_CALLBACK_KEY` matches the result flow's `x-handoff-key`.
- [ ] Trigger text matches `HANDOFF_TRIGGER_TEXT`.
- [ ] Pool warm before the demo. **Note (live-verified 2026-06-13, #93):** if the agent
      pool is a **Copilot Studio *Hosted* Agent** pool (Intune → Devices → All Cloud PCs shows
      "Copilot Studio Hosted Agent Machine"), the **Intune `Always available Cloud PCs` setting
      does NOT apply** — `Devices → Provisioning policies (Agents)` is empty for this pool type,
      so there is no policy to set the count on. Warm-up there is governed by Copilot Studio /
      pre-warm. The `Always available Cloud PCs = 1` step below applies only to a **self-managed**
      Windows 365-for-Agents provisioning policy. Either way, **confirm a machine shows
      Running/Provisioned before the demo** (Intune → Devices → All Cloud PCs).
- [ ] (Self-managed pools only) W365A pool set to **`Always available Cloud PCs` = 1** (Intune
      provisioning policy) — a warm Cloud PC that never releases/resets → **no cold start**.
- [ ] **Pre-warm (the reliable lever for a hosted-agent pool)**: run **one throwaway handoff
      ~10–15 min before** going live so a machine is already `Provisioned` and the agent session
      and Computer Use model are hot for the real run.
- [ ] **Plan the async handoff**: in the live narrative the CSR can **end the call** after handoff;
      the AI files the claim in the background (the desktop polls/SSE for status), so any boot or
      automation latency stays **off the customer's call path**.
- [ ] **Verify `claims.exe` is installed on the pool Cloud PC**: run
      `scripts/Verify-IntuneClaimsAssignment.ps1` or check Intune portal → the pool device
      shows "Zava Claims Workstation" as installed. If missing, run
      `Deploy-DemoEnvironment.ps1 -Phase Apps -BuildPackages` and wait for Intune sync.
- [ ] `claims.exe` reset to a known start state; no stale claim windows open.
- [ ] Desktop `orchestratorUrl` set; CORS allows the desktop origin.
- [ ] **Disclose accurately**: Computer Use is GA **and** the W365A Cloud PC pool
      is **GA** (announced at Microsoft Build, 2026-06-02). No preview caveat.

---

## 9. Future swap → Dynamics 365 Contact Center

The agent, Computer Use logic, and result contract are **portable** — only the
channel adapter changes. For D365 Contact Center:

- Connect the **same** Copilot Studio agent to D365's **native Omnichannel channel**
  (zero-code); you do **not** need this Durable Functions backend for invocation.
- D365 provides routing / hold-resume / interaction timeline / wrap-up natively.
- Context arrives as **`msdyn_*` context variables** (ConversationId, Customer,
  Case, phone, WorkstreamId). Map those onto the **same neutral global variables**
  the agent already reads (§2a) — that is why neutral names matter.
- `HANDOFF_CHANNEL=d365` is reserved; `src/channel/d365Adapter.js` is a stub that
  points here intentionally (the native channel replaces the custom adapter).

One published agent can serve **both** the Zava Direct Line channel and the D365
Omnichannel channel simultaneously.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401` from `/result` | `x-handoff-key` ≠ `HANDOFF_CALLBACK_KEY` | Align the values (§2c/§6). |
| `409` from `/result` | `correlation_id` mismatch | Send back the exact `correlationId` you received. |
| `404` from `/status` | Wrong `handoff_id` / different hub | Use the `handoff_id` from the 202; confirm `host.json` hub name. |
| First handoff slow / stuck in `queued` — **cold boot** | The pool is **on-demand / scale-to-zero** (`Always available Cloud PCs` = 0), so the first session must **cold-boot a Cloud PC from image** (several minutes) — too slow for a live call | **Set `Always available Cloud PCs` = 1** in the Intune provisioning policy (a warm machine that never releases/resets → **no cold start**); **pre-warm** with one throwaway handoff before going live; and lean on the **async handoff** (CSR ends the call, the AI files in the background) so boot latency is **off the customer's call path**. Cold boot is a *configuration* symptom, not an architecture limit. See [`w365a-pool.md` → Cost / always-available](w365a-pool.md#cost) and §8. |
| Status flips to `error` at ~15 min | Execution timeout hit | Raise `HANDOFF_EXECUTION_TIMEOUT_MS`; verify the agent calls back. |
| Stuck at `ready`, then times out — agent **does reply on the conversation** with *"Sorry, something went wrong. Error code: SystemError"* (it **fires** & routes to Computer Use), but the pool's run history shows **0 runs ever** | **The agent has authentication set to *No authentication*** — Computer Use is **disabled for unauthenticated agents**, so the topic errors before queuing a run. Test pane shows *"CUA is disabled for unauthenticated agents. Please change your agent security settings."* | **Enable authentication using *Authenticate manually*** (custom Entra app reg) **with *Require users to sign in* = OFF** — **not** *Authenticate with Microsoft* (disconnects Direct Line): Settings → Security → Authentication → *Authenticate manually* → set **Require users to sign in OFF** → Save → Publish; re-copy the Direct Line secret if it rotated. Also confirm the Computer Use tool uses **Maker-provided credentials**. (Only if it still fails: check tool binding, then the pool has ≥1 machine.) See [`build-the-agent.md` → step 2](build-the-agent.md#2-turn-on-generative-orchestration) and [`w365a-pool.md` → pool healthy but Computer Use never runs](w365a-pool.md#if-the-pool-is-healthy-but-computer-use-never-runs-handoff-times-out-at-ready). |
| Stuck at `ready`, then times out at ~15 min — but the agent **never replies on the conversation at all** (no SystemError, no activities), **no Cloud PC provisions**, pool shows **0 runs** — **or** the handoff fires and the agent **replies with an explicit auth-channel error** (e.g. *authentication mode not supported on this channel* / *"Authenticate with Microsoft" is not supported over Direct Line*) | **The agent is set to the built-in *Authenticate with Microsoft*** — it **disconnects / is unsupported on custom channels, including the Direct Line channel** the orchestrator triggers over (Copilot Studio warns about this on save). Depending on tenant/version this surfaces **two ways**: the bot is detached from the channel so the trigger is never received (**silent**, 0 runs), **or** the channel rejects the turn with an **explicit auth-channel error**. Both are the **same #81 conflict** — *not* cold boot, *not* the instructions bug, *not* the pool. (Rule out a missing/rotated Direct Line secret or wrong `directLineTokenEndpoint` too, which can look silent.) | Switch to **Authenticate manually** (custom Entra app reg) **with *Require users to sign in* = OFF** so Direct Line stays connected **and** CUA is enabled: Settings → Security → Authentication → *Authenticate manually* → **Require users to sign in OFF** → Save → Publish; then re-copy the Direct Line secret / token endpoint into the orchestrator settings (§2c). After the fix, the agent replies on the conversation **and** the pool provisions a Cloud PC. **No safe shortcut:** *No authentication* re-enables Direct Line but disables Computer Use, so manual auth (sign-in OFF) is the only mode that satisfies both — set it up **ahead of** any live demo, not minutes before. See [`build-the-agent.md` → authentication note](build-the-agent.md#2-turn-on-generative-orchestration). |
| Handoff fires and the agent **returns an OAuth / sign-in card** (or stalls waiting for one) instead of running Computer Use; nothing reaches the pool | **Auth is *Authenticate manually* but *Require users to sign in* is ON** — the agent demands an interactive sign-in on the first turn, but the orchestrator's Azure Function is a **headless caller with no user**, so it can never complete the card. (Also check for stray `Authenticate` nodes or auth variables on the trigger path.) | Set **Require users to sign in = OFF** (Settings → Security → Authentication), remove any `Authenticate` nodes/auth variables from the Direct Line trigger path, **Save → Publish**, and re-run the exact Direct Line test. The agent stays maker-authenticated (CUA works) while the unattended channel is never prompted. See [`build-the-agent.md` → step 2](build-the-agent.md#2-turn-on-generative-orchestration). |
| Orchestrator logs an explicit **`IntegratedAuthenticationNotSupportedInChannel`** (the adapter now names it: *"agent uses 'Authenticate with Microsoft' … which Direct Line does not support"*, error `code: AUTH_CHANNEL_UNSUPPORTED`) **and the auth change *seemed* applied but the error persists after Save+Publish** | The published **runtime / Direct Line channel binding is still on integrated (Teams/M365) auth** — switching the auth *mode* in the editor doesn't always re-bind the existing channel/token endpoint, **or** the change silently reverted on validation (seen before), **or** the orchestrator's token endpoint points at a different/old channel. **This is *not* orchestrator caching** — the adapter mints a fresh Direct Line token on **every** handoff, so a *successful* republish takes effect on the very next run. | **Locate the layer first:** the adapter logs *which* call carried it — `token endpoint HTTP …` (channel binding, before any topic) vs `… conversations HTTP …`. **Decisive isolation test:** `curl` the **Direct Line token endpoint directly** (no orchestrator, no topic) — if it still returns the error, the channel is still integrated-bound and *waiting won't help*. **Force a clean re-bind:** set auth → *No authentication* → Save+Publish, then → *Authenticate manually* (sign-in OFF) → Save+Publish; **remove the Teams + Microsoft 365 channel** the integrated mode auto-added; then **re-copy the token endpoint/secret** from the freshly published agent into the orchestrator (§2c/§2d) and confirm it targets the **exact** agent/environment edited. |
| Agent **replies "reached its usage limit"** (Test pane or any channel), often after several runs the same day | **Copilot Studio usage quota**, *not* an architecture/auth/billing-policy fault. Two flavors: a short **rate-limit/throttle** (trial GenAI caps are low — ~**10 requests/min, ~200/hour**), or the **monthly message capacity** is exhausted (burned by the day's runs; new enforcement blocks new invocations past ~125% of pack capacity). **Distinct from the "0 runs / `SystemError`" case** (that's a *missing* billing policy, #77). | **Tell them apart by waiting:** re-run after **~3–5 min** — if it works, it was the **rate limit** (zero-build, $0). If it **persistently** fails, the **monthly capacity** is gone → attach **pay-as-you-go billing** to lift it now (the durable fix, #77) or wait for the **1st-of-month** reset. Confirm consumption in **Power Platform admin center → environment usage**. See [`licensing-and-entitlement.md`](licensing-and-entitlement.md) and Microsoft's [Resolve usage limit / agent unavailable errors](https://learn.microsoft.com/en-us/troubleshoot/power-platform/copilot-studio/licensing/throttling-errors-agents). |
| No terminal result | Result flow not firing | Verify the typed callback flow; check Direct Line watermark fallback logs. |
| Handoff reaches the Cloud PC (`ready`) but **Computer Use never executes** and the run ends with *"…requires one of the following supported channels… msteams, pva-engine-direct, pva-studio, pva-maker-evaluation, pva-autonomous… The current channel does not meet these requirements."* (Test pane drives the Cloud PC fine) | **Computer Use is not supported on classic Bot Framework Direct Line** (channel `directline`), which is what the Direct Line adapter uses (#112). The adapter now names this as `code: CUA_CHANNEL_UNSUPPORTED`. | **Switch the orchestrator to Direct-to-Engine** (the CUA-supported channel `pva-engine-direct`): set `HANDOFF_CHANNEL=engine` and the `ENGINE_*` settings (§4). Same `pvaSetContext` + natural-language trigger contract; only the invocation channel changes. **Demo-viable today without a redeploy:** drive the handoff from the Copilot Studio **Test pane** (itself a supported channel). |
| Agent runs but **`claims.exe` never opens** | The Intune Win32 app assignment is missing or the app failed to install | Verify in Intune that `claims.exe` shows as installed on the agent Cloud PC device. Check the device's app install status. Re-assign if needed. |
| Pool Cloud PC stuck at OOBE **"Account setup"** for ~17–60 min during provisioning | ESP timeout is too long or a broken app assignment is blocking | Check ESP profile settings. Ensure the required app installs successfully within the ESP timeout window. Use an always-available pool to avoid reprovisioning. |

### Reading a `SystemError` — don't jump to the auth rework

A `SystemError` is reported on the **Copilot Studio** side, not by this orchestrator. The
orchestrator's parser (`contract.js → parseActivities`) only recognizes a structured
`handoffResult`, a sentinel JSON block, a `CLM-####-######` claim id, or one of the seven
`ERROR_CODES`; **`SystemError` is none of these**, so to the orchestrator it looks like *no
result yet* and the job simply **times out at `ready`** (→ `UNKNOWN`). The orchestrator never
prints the string "SystemError". So if you're seeing it, you're reading the **Test pane / run
analytics** — and the **web-chat Test pane canvas has a known JS rendering bug** (*"Cannot read
properties of undefined"*); the **authoritative** error is the **Computer Use tool's built-in
Test action**, not the chat canvas.

> ✅ **Confirmed root cause (issue #69): a generic `SystemError` was masking a
> `ContentValidationError` from curly braces in the tool instructions.** Decisive test — invoke
> Computer Use in **plain language** (which routes via generative orchestration, *bypassing* the
> `start_fnol_handoff` topic). If that surfaces a **specific** error like
> *`ContentValidationError: ... 'New' isn't recognized` / `Item` / `ItemType` / `Force` / `Unexpected
> characters ($)`*, the agent is **failing validation before it runs**: Copilot Studio parses any
> **curly-brace segment in the tool/agent instructions as a Power Fx expression**. **Fix:** make the
> instructions **brace-free** — see
> [`CUA-TOOL-INSTRUCTIONS.md`](../apps/legacy-claims-workstation/samples/foundry-agent/CUA-TOOL-INSTRUCTIONS.md)
> (**no curly braces anywhere** in text pasted as instructions). That a plain-language invocation
> reproduces it proves it is **not**
> the topic wiring and not the platform.

**Key disambiguation — a `SystemError` *reply* is NOT the Direct Line ↔ auth conflict.** Per
issue #81: *No authentication* → the agent **replies `SystemError`** (CUA disabled), while
*Authenticate with Microsoft* → the agent **goes silent** (custom Direct Line channel
disconnected). So if the agent **answers at all**, the trigger is reaching it and Direct Line is
up — which **rules out** the silent-disconnect case and means the **Entra-app / manual-auth
rework is almost certainly not the fix**. Decide between the two remaining causes with one cheap,
read-only check:

1. **Run the Computer Use tool's built-in Test action** and read the agent's **Authentication**
   setting (Settings → Security → Authentication), and check the **pool run count**:
   - *"CUA is disabled for unauthenticated agents"* + **0 pool runs** → auth is on **No
     authentication** (it can silently revert when the environment/billing is recreated or
     repointed) → fix is simply setting authentication back on (#81). **Failure is *before* CUA.**
   - Auth is fine and a **Cloud PC actually attempts to provision but the run fails** → it's a
     **machine/pool** problem *during* CUA: pool binding (#95), **no always-available/ready
     machine** under the (new) billing policy, or a manual prerequisite (cross-geo / ESP /
     enrollment) — re-run the [CUA prereq checker](w365a-pool.md) against the **current**
     environment. **Failure is *during* CUA.**

In short: **0 pool runs = failed before CUA (auth/topic); a provisioning attempt = failed during
CUA (machine/pool).** Neither outcome requires the custom Entra app.

#### Auth correct, but an instant `SystemError` with zero pool runs: the topic-to-Computer-Use invocation wiring

If you have **verified** (a) the agent answers (`Hello` works), (b) authentication is on a CUA-compatible
setting, (c) billing/usage-limit is clear, and (d) the Computer Use tool config is complete (model,
machine pool, connection, supervision off) — yet typing the trigger (`start_fnol_handoff`) in the
**Test pane** instant-fails (~2 s) with `SystemError` (`isUserError: false`) and the **pool shows no run
at all** (no Cloud PC is touched), then the fault is in **how the trigger topic invokes the Computer Use
tool** — the run fails *before* a machine is ever acquired. Check these, in order (the first is the most
common and is decisive):

1. **The Test pane sends no inbound context — so any required CUA input is empty.** The orchestrator
   delivers the claim context via a Direct Line `pvaSetContext` event (§2a) that populates `Global.*`.
   **The Test pane cannot send that event**, so those globals are **blank** when you test there. If the
   topic invokes Computer Use with a *required* input (e.g. the task instruction or `policyNumber`) bound
   to a global that is empty, the tool **cannot start a run → instant `SystemError`, 0 pool runs**.
   **Decisive test:** in the Test pane's **variables panel set those globals manually** (or run the full
   path through the orchestrator, which *does* send `pvaSetContext`) and retrigger. If it now drives a
   Cloud PC, the instant `SystemError` was the **empty-context artifact of Test-pane testing**, not a
   platform fault — harden the topic so a required CUA input is never passed blank (give the task
   instruction a literal/templated default, or gate the tool call behind a check that the context is
   present) and validate end-to-end through the orchestrator.
2. **A classic custom topic is imperatively redirecting to the tool.** Under **generative
   orchestration**, Computer Use is an **agent tool the orchestrator selects from its description** — it
   is *not* meant to be called from a classic topic via a *Redirect / activate-tool* node. A classic-topic
   invocation of the autonomous tool can instant-`SystemError`. **Fix:** let generative orchestration
   route the trigger to the tool (clear, specific **tool description** + the trigger phrase, web search /
   other knowledge **off** so it isn't answered elsewhere), or use the supported tool-activation action
   with **every required input explicitly bound** — not a classic redirect.
   **Fastest demo-safe lever (no live topic surgery):** the trigger text is orchestrator config, so set
   **`HANDOFF_TRIGGER_TEXT`** to a **natural-language** phrase that generative orchestration routes to
   Computer Use (e.g. *"Start the FNOL claim now using the claims workstation"*) **instead of the bare
   `start_fnol_handoff`** token — the token only matches the broken classic topic, whereas natural
   language goes through the **confirmed-working generative path**, bypassing the topic entirely. Caller
   context still arrives via the `pvaSetContext` Global variables (§2a), so nothing is lost. Gate this on
   first confirming the **generative path files a claim end-to-end** (not just that `ContentValidationError`
   cleared), then flip the env var — it's fully reversible.
3. **The tool still has unresolved validation errors** (the *"Save tool with (N) errors"* state in
   [build-the-agent.md §3](build-the-agent.md#3-add-the-computer-use-tool-and-point-it-at-your-pool)).
   A half-defined required input (missing type/description, or required-but-unbound) makes generative
   orchestration fail to invoke cleanly. Drive the tool to **0 errors**.

This branch is the build-side wiring fault tracked in **#69** — the topic exists only in the live agent
(no supported creation API), so it cannot be fixed from the repo; apply the correction in the maker
portal and re-validate. Capture the corrected wiring back into [build-the-agent.md §5](build-the-agent.md#5-add-the-start-trigger).
