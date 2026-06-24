# `demo-config.local.json` — field reference

A plain-English legend for every value in `scripts/demo-config.sample.json`. Copy the
sample to `demo-config.local.json` (git-ignored) and edit it — that one file is the
**only** thing you configure.

```powershell
Copy-Item .\scripts\demo-config.sample.json .\scripts\demo-config.local.json
```

> **For your first build you fill in just 3 values** (subscription, tenant, region).
> The 4th, the Direct Line secret, you add **after** you build the agent — leave it blank to
> start. Everything else has a working default or is **auto-generated** — see
> [The short list](#the-short-list-edit-these) below.

### Why isn't it *just* tenant + subscription?

Almost is. The build **creates a whole demo** for you — a backend (the handoff
orchestrator: a Function app, Storage, a Key Vault) and a website (a Static Web App).
Those need names, and Azure requires some of them to be unique across all of Azure. But
**you don't have to invent them**: leave the name fields blank and the build generates
stable, unique names from your subscription id automatically.

So the real list is just **four** things:
- **subscription + tenant** — *where* to build.
- **region** — *which* Azure region.
- **the Direct Line secret** — *how* to reach your Copilot Studio agent (the one value
  you can't auto-generate).

**The many tables further down are just a reference** documenting *every* field for
completeness. You do **not** act on most of them — nearly every row says "Keep default"
or "Auto." Set the 3 below (plus the Direct Line secret, which you get after you build the
agent) and you're done.

Legend for the **Required?** column:
- **Yes** — the build refuses to run until you set it (you'll get a clear error naming the field).
- **Keep default** — required, but the value already in the sample works; change only if you want to.
- **Auto** — leave it blank and the build fills it in (a generated name, a derived region, etc.). You *can* override by setting it.
- **No** — optional; leave blank/as-is unless you have a reason.

---

## The short list (edit these)

These are the only fields you fill in. For your **first build** set just the first 3; the
4th — the Direct Line secret — is added **after** you build the agent (see
[`build-the-agent.md`](build-the-agent.md)).

| # | Field | What to put |
|---|-------|-------------|
| 1 | `azure.subscriptionId` | Your Azure subscription GUID |
| 2 | `azure.tenantId` | Your Entra tenant GUID |
| 3 | `azure.location` | Your nearest Azure region, e.g. `westeurope` |
| 4 | `handoffOrchestrator.directLineSecret` | The Direct Line secret from your **published** Copilot Studio agent — added after the agent exists (leave blank to start). If your channel exposes no classic secret (60-day trial / Agents SDK), use `directLineTokenEndpoint` instead |

That's it. The resource names (Function app, Storage, Key Vault, Static Web App) are
**left blank in the sample on purpose** — the build auto-generates unique names from your
subscription id (the same names every run, so re-runs and teardown line up). Only set a
name explicitly if you want a specific one.

### #4 — the Direct Line secret (the one value you can't auto-generate)

Everything else is either your subscription/tenant/region or an auto-generated name.
The Direct Line secret is different: it's a **password-like key you copy** from your
Copilot Studio agent — it's how the handoff backend is allowed to talk to your agent.

> **You must build + publish the agent first to get this value.** Full step-by-step:
> **[`build-the-agent.md`](build-the-agent.md)**. The short version is below.

**How to get it:**
1. In **Copilot Studio**, open your agent and **Publish** it (the secret isn't
   available until the agent has been published at least once).
2. **Settings** (top-right gear) → **Security** → **Channels**
   *(some tenants: Settings → Channels)*.
3. Open the **Direct Line** channel (or the **Web** channel, which exposes Direct Line).
4. Under **Secret keys**, copy one of the keys.
5. Paste it into `handoffOrchestrator.directLineSecret`.

It's a long (~50+ character) random string like `8aB3xZ...`. Treat it like a password —
it stays only in your git-ignored `demo-config.local.json`, and the build moves it into
Key Vault for you. See [`handoff-runbook.md` §2d](handoff-runbook.md#2d-get-the-direct-line-secret)
for the same steps with more detail.

> ### ⏱️ When do I do this — before or after the script?
> **Create and publish the Copilot Studio agent *before* you run the build**, because the
> build needs its Direct Line secret. The agent itself is finished *after*: the build
> prints an **orchestrator callback URL + callback key** that you paste back into the
> agent's result flow (then re-publish). So it's: **publish agent → run build → finish the
> agent's callback wiring.**
>
> **You don't have to decide anything here — just run the build.** What it does depends only on
> whether the Direct Line secret is filled in:
> - **Secret filled in** → the build deploys the orchestrator (the full path).
> - **Secret still blank** (e.g. you haven't created the agent yet) → the build **automatically
>   skips** the orchestrator, stands up the website + infrastructure, and prints a reminder at the
>   end. Later, publish the agent, paste its Direct Line secret into the config, and run the
>   **same** build command again to add the orchestrator.
>
> You normally never pass `-SkipOrchestrator` yourself — the script handles this for you; the flag
> is only an explicit override.

## What happens if I leave an optional field blank?

Short version: **nothing breaks.** Every non-required field has a safe fallback, so the
minimal config (just the 4 fields above) still produces a complete build. Here is exactly
what each optional field does when left blank:

| Field left blank | What the build does |
|------------------|---------------------|
| `staticWebApp.location` | Auto-picks the nearest supported Static Web App region. |
| `staticWebApp.name`, `handoffOrchestrator.functionAppName` / `storageAccountName` / `keyVaultName` | Auto-generates a unique, **stable** name from your subscription id (same name on every run and at teardown). |
| `handoffOrchestrator.location` | Falls back to `azure.location`. |
| `handoffOrchestrator.directLineSecret` / `directLineTokenEndpoint` | If **both** are blank, auto-skips the orchestrator phase; the website + infrastructure still build, and you re-run after pasting one in (see the box above). Provide exactly one. |
| `handoffOrchestrator.callbackKey` | Auto-generates one and **prints it** for you to paste into the agent's result flow. |
| `handoffOrchestrator.mcsAgentName` | Nothing — it's a display-only label. |
| `agentPool.pilotCloudPcName` | The agent-pool **device** group is created **empty** — add your pool's Cloud PC device to it later. The group **is** used to push the claims app: `claims.exe` is deployed via Intune as a **required Win32 app** to every enrolled pool Cloud PC in the group. |
| `agentWorkstation.agentUserName` | The workstation **user** group is created **empty** — add the human agent's account to it later (the web link follows them once they're a member). |
| `agentWorkstation.webLink.url` | Uses the URL of the Static Web App the build just created. |
| `azure.globalAdminUpn` | Nothing — it's only a reminder; you still sign in interactively. |
| `agentBackend` | Defaults to `mcs` (Copilot Studio). Set `foundry` or `both`, or override with `-AgentBackend`. See the section below. |
| `handoffOrchestrator.baseUrl` | Filled in automatically after deploy. |
| `foundry.orchestratorUrl` | Defaults to `http://localhost:4000` (the local-orchestrator paired with the Foundry + W365A runner — the orchestrator serves HTTP, the runner watches its file-drop). Only used when `agentBackend` is `foundry`/`both`. |

The only value with **no** fallback is the **Direct Line secret** — and even that just
defers the orchestrator instead of failing.

---

Everything below is the full reference, section by section.

---

## `agentBackend` — choose the AI backend (optional, defaults to `mcs`)

Which engine captures the CCaaS outcome and drives Computer Use on the Windows 365 for
Agents Cloud PC. This is a primary, up-front choice (like tenant/subscription). Set it in
the config **or** override per run with `-AgentBackend` on `Build-DemoFromScratch.ps1`.

| Value | What it does |
|-------|--------------|
| `mcs` (default) | **Microsoft Copilot Studio** over Direct Line. Deploys the `handoffOrchestrator` (phase C) that drives your published agent; the pool is bound in the agent's Machine field. Needs the Copilot Studio entitlement + a published agent (the Direct Line secret). |
| `foundry` | **Azure AI Foundry** Computer-Use agent (phase D), driven by [`samples/foundry-w365a-runner`](../samples/foundry-w365a-runner) which checks out a W365A session and runs the Foundry responses Computer Use loop against `claims.exe`. The MCS orchestrator phase is skipped. Needs `computer-use-preview` model access. |
| `both` | Configures **both** and bakes both endpoints into the SPA so the desktop's backend toggle can switch between them live for A/B demos. (The MCS half still needs the Copilot Studio entitlement to actually run.) |

Resolution order: `-AgentBackend` param → config `agentBackend` → legacy `-IncludeFoundryAgent` → `mcs`.

### `both` mode — only one agent acts per handoff

In `both` mode the **presenter decides live** which agent handles each handoff using the desktop's
backend toggle. To guarantee the *other* agent never also drives the Cloud PC via Computer Use, the
desktop stamps the chosen backend onto the handoff as `target_backend` (`mcs` | `foundry`):

- **MCS** is reached over Direct Line — when the presenter picks Foundry, the MCS agent is simply
  never triggered (the desktop posts to the Foundry endpoint, not the Copilot Studio orchestrator).
- The **Foundry runner** watches the shared `in\prefill.json` file-drop, so it self-filters: it acts
  only on a handoff whose `target_backend` matches its own `RUNNER_BACKEND_ID` (default `foundry`),
  and ignores any prefill addressed to another backend. A legacy prefill with no `target_backend` is
  still processed (single-backend setups are unaffected).

So flipping the desktop toggle is the whole decision — exactly one agent ever drives `claims.exe`.

---

## `azure` — your subscription & region

| Field | Required? | Description | Example |
|-------|-----------|-------------|---------|
| `subscriptionId` | **Yes** | The Azure subscription the demo resources are billed to / created in. | `1a2b3c4d-...` |
| `tenantId` | **Yes** | Your Microsoft Entra (Azure AD) tenant ID. | `9f8e7d6c-...` |
| `globalAdminUpn` | No | The admin you sign in as. Informational — handy as a reminder; the build prompts you to sign in regardless. | `admin@contoso.onmicrosoft.com` |
| `location` | **Yes** | Your one workload region — the **single source of truth** for region. The build uses it for every Azure resource it creates and **auto-derives** anything region-specific from it (nearest Static Web Apps region, the Power Platform geo it checks for, etc.), choosing the closest available when the exact region isn't offered. Set it once; you're never asked again. | `australiaeast` |

> The build does **not** create the Windows 365 for Agents Cloud PC pool or the
> Power Platform/Dataverse environment — those are separate, mostly manual steps. But
> the pool **inherits its Power Platform environment's geography**, so to keep
> everything in your `location` you must create that Dataverse environment in the
> matching geo (e.g. `australiaeast` → Australia). The build's Copilot Studio preflight
> derives that geo from `location` and **warns** if your existing environments don't
> match. See [`docs/w365a-pool.md`](w365a-pool.md#why-the-geography-may-show-us-central).

## `staticWebApp` — the host for the CCaaS web app (Free, $0)

| Field | Required? | Description | Example |
|-------|-----------|-------------|---------|
| `location` | No | Region for the SWA's managed Functions. **Leave blank (`""`)** to auto-pick the nearest supported region. Only certain regions are supported (`westus2`, `centralus`, `eastus2`, `westeurope`, `eastasia`). | `""` |
| `resourceGroup` | Keep default | Resource group for the Static Web App (shared with the orchestrator). | `Zava-CCaaS-Demo` |
| `name` | **Auto** | Name of the Static Web App. **Leave blank** to auto-generate a unique name from your subscription id. Set it only if you want a specific name. | `""` |
| `sku` | Keep default | Pricing tier. `Free` = $0 and is all the demo needs. | `Free` |
| `appLocation` | Keep default | Path to the web app source (relative to repo root). **Don't change.** | `apps/ccaas-agent-desktop` |
| `apiLocation` | Keep default | Path to the `/api` Function. **Don't change.** | `apps/ccaas-agent-desktop/api` |
| `outputLocation` | Keep default | Build output folder. **Don't change.** | `apps/ccaas-agent-desktop/dist` |

## `appRegistration` — optional (unattended / app-only runs only)

You do **not** need this for a normal interactive build (you sign in when prompted). It's only
used if you run the deployment **unattended / app-only** — create it with
`Bootstrap-DemoServicePrincipal.ps1` and set the values below.

| Field | Required? | Description | Example |
|-------|-----------|-------------|---------|
| `displayName` | No | Name of the app registration created by `Bootstrap-DemoServicePrincipal.ps1`. | `W365-Demo-Automation` |
| `clientId` | No | App (client) ID. Only used for unattended / app-only sign-in. | `00000000-...` |
| `clientSecret` | No | Client secret for unattended runs. Never committed. | `""` |

## `handoffOrchestrator` — the AI handoff backend (deployed automatically)

This is the current path — a standalone Durable Functions app that drives your
published Copilot Studio agent over Direct Line. The build creates the resource group,
Storage, Function app, and Key Vault for you.

| Field | Required? | Description | Example |
|-------|-----------|-------------|---------|
| `enabled` | Keep default | `true` deploys the orchestrator. Set `false` (or use `-SkipOrchestrator`) to skip it. | `true` |
| `functionAppName` | **Auto** | **Leave blank** to auto-generate a unique name. If you set it: globally-unique, 2–60 chars, letters/digits/hyphens, start & end alphanumeric. | `""` |
| `storageAccountName` | **Auto** | **Leave blank** to auto-generate. If you set it: globally-unique, 3–24 chars, **lowercase letters and digits only — no hyphens.** | `""` |
| `keyVaultName` | **Auto** | **Leave blank** to auto-generate. If you set it: globally-unique, 3–24 chars, start with a letter, letters/digits/hyphens, no `--`. | `""` |
| `resourceGroup` | Keep default | Resource group for the orchestrator (shared with the SWA). | `Zava-CCaaS-Demo` |
| `location` | No | Region for the Function app/Storage/Key Vault. Blank = use `azure.location`. | `""` |
| `baseUrl` | Auto | Filled in after deploy (the URL baked into the desktop). Don't set it. | `""` |
| `channel` | **Set to `engine`** | Invocation channel the orchestrator uses. **`engine`** = Copilot Studio Direct-to-Engine (`pva-engine-direct`), the **CUA-supported** path (#112). `directline` = classic Bot Framework Direct Line — Computer Use does **NOT** run on it, so use it only for non-CUA testing. Future: `d365`. | `engine` |
| `mcsAgentName` | No | Friendly name of your Copilot Studio agent (display only). Blank = no effect. | `Zava Claims Intake (CUA)` |
| `triggerText` | Keep default | **Natural-language** instruction the orchestrator sends so the agent's **generative orchestration** routes to Computer Use (the confirmed-working path). **Must match the live `HANDOFF_TRIGGER_TEXT`.** Do **not** use the bare token `start_fnol_handoff` — it only matches the broken classic topic (#69). | `A customer phone call has been handed off … file a new First Notice of Loss, then return the resulting claim ID.` |
| `engine.conversationsUrl` | **Required when `channel=engine`** | The per-environment Direct-to-Engine **conversations endpoint** — copy it verbatim (the host segment is environment-specific). | `https://<env>.environment.api.powerplatform.com/powervirtualagents/botsbyschema/<schema>/conversations?api-version=2022-03-01-preview` |
| `engine.tenantId` / `engine.clientId` / `engine.clientSecret` | **One auth option (engine)** | Entra **app-only** (client-credentials) creds for the engine bearer token. `clientSecret` is stored in Key Vault for you. | tenant/app GUIDs + secret |
| `engine.scope` | No | OAuth scope for the engine token. Blank = `https://api.powerplatform.com/.default`. | `""` |
| `engine.tokenEndpoint` / `engine.token` | **One auth option (engine)** | Inject a token **instead** of client credentials (use if app-only tokens aren't permitted — the M365 Agents SDK Copilot Studio client is delegated-only). `token` is stored in Key Vault. | endpoint URL / pre-obtained token |
| `directLineBaseUrl` | Keep default | Direct Line endpoint (only used when `channel=directline`). Only change for a regional/sovereign cloud. | `https://directline.botframework.com` |
| `directLineSecret` | **One of two (directline)** | **A secret you provide** (a password-like key you *copy*, not invent). From your *published* Copilot Studio agent → *Settings → Security → Channels → Direct Line/Web channel → Secret keys*. Stored in Key Vault for you. See [About #7](#about-7--the-direct-line-secret-the-only-value-you-cant-invent). | `8aB3xZ...` |
| `directLineTokenEndpoint` | **One of two (directline)** | Use **instead** of `directLineSecret` when your channel exposes no classic secret (60-day premium trial / Microsoft 365 Agents SDK). Paste the Direct Line **token endpoint** URL (`.../directline/token?api-version=...`); the orchestrator GETs it for a conversation-bound token. Stored in Key Vault for you. | `https://<env>.environment.api.powerplatform.com/.../directline/token?api-version=2022-03-01-preview` |
| `callbackKey` | No | Shared key the Copilot Studio result-flow presents on its callback. **Leave blank** to auto-generate & reuse; the build prints it for you to paste into the flow. | `""` |
| `pollIntervalMs` | Keep default | How often the orchestrator polls for a result (ms). | `5000` |
| `executionTimeoutMs` | Keep default | Max time to wait for the agent to finish (ms). 900000 = 15 min. | `900000` |

## `agentPool` — Machine 1: the AI agent's W365A Cloud PC pool

This Entra **device** group exists for the agent-pool Cloud PCs. `claims.exe` is deployed
here via Intune as a **required Win32 app**, so every enrolled pool Cloud PC in the group gets
the app automatically. You create the pool yourself; here you just name the targeting group.

| Field | Required? | Description | Example |
|-------|-----------|-------------|---------|
| `deviceGroupName` | Keep default | Entra **device** security group for the agent pool. Use the dynamic `CPCPool_*` group from `Enable-W365aPrereqs.ps1` (set this to its name and leave `pilotCloudPcName` empty) **or** an assigned group whose Cloud PC device object(s) you add. This group **is** used to install the claims app via Intune required Win32 assignment. See [intune-w365.md](intune-w365.md#choosing-the-agent-pool-device-group). | `Zava-Demo-Agent-CPCs` |
| `scopeTagName` | Keep default | Intune scope tag for the demo objects. | `Zava-Demo` |
| `pilotCloudPcName` | No | Optional list of existing Cloud PC device names to seed into an **assigned** group. Blank = group created empty; add the pool's Cloud PC device yourself later. Ignored when `deviceGroupName` is a dynamic group (the rule owns membership). | `[]` |

## `agentWorkstation` — Machine 2: the human agent's Cloud PC

Gets only the CCaaS web app as a managed Edge web link (a **user** group).

| Field | Required? | Description | Example |
|-------|-----------|-------------|---------|
| `userGroupName` | Keep default | Entra **user** security group the web link targets. Add the human agent's account to it. | `Zava-Demo-Agent-Users` |
| `agentUserName` | No | Optional list of user accounts to seed into the group. Blank = group created empty; add the human agent's account yourself later. | `[]` |
| `webLink.displayName` | Keep default | Label of the pinned shortcut on the agent's Cloud PC. | `Zava Contact Center` |
| `webLink.url` | Auto | Taken from the deployed Static Web App. Set only if you front it with a custom domain. | `""` |

## `foundry` — the Foundry + Windows 365 for Agents backend

Only used when `agentBackend` is `foundry` or `both` (otherwise leave this block as-is).
The Foundry Computer-Use agent is created in phase D; the runtime that drives the Cloud
PC is [`samples/foundry-w365a-runner`](../samples/foundry-w365a-runner), run on/near the
Cloud PC.

> **Don't have a Foundry project yet?** Create or locate one *before* you run the build —
> validation fails fast on a missing/placeholder `foundry.endpoint`. You need:
> 1. A **Microsoft Foundry project** (in a Foundry resource), and its **Project endpoint**
>    `https://<resource>.services.ai.azure.com/api/projects/<project>` → goes in `foundry.endpoint`.
> 2. The deploying identity granted **Azure AI User** on the project (least privilege).
> 3. **`computer-use-preview` access** approved (manual gate: <https://aka.ms/oai/cuaaccess>).
> 4. A **`computer-use-preview` model deployment** → its name goes in `foundry.modelDeployment`
>    (or run `Deploy-Agent.ps1 -CreateModelDeployment`, which also needs `foundry.accountResourceId`).
>
> Full step-by-step: [`docs/agent-cua-setup.md`](./agent-cua-setup.md#prerequisites-one-time-greenfield) → *Prerequisites (one-time, greenfield)*.

| Field | Required? | Description | Example |
|-------|-----------|-------------|---------|
| `endpoint` | **Yes** (foundry) | Your Azure AI Foundry project endpoint. | `https://<res>.services.ai.azure.com/api/projects/<proj>` |
| `orchestratorUrl` | No | Desktop endpoint for the Foundry backend — the local-orchestrator paired with the runner (the orchestrator serves HTTP; the runner watches its file-drop). Baked into the SPA as `VITE_FOUNDRY_ORCHESTRATOR_URL` so the backend toggle can switch to it. Blank = `http://localhost:4000`. | `""` |
| `agentName` | **Yes** (foundry) | Display name for the Foundry agent. | `Zava Claims Intake (CUA)` |
| `agentId` | Auto | Captured after the agent is created; falls back here if the build can't capture it. | `""` |
| `modelDeployment` | **Yes** (foundry) | The Computer-Use model deployment name. | `computer-use-preview` |
| `apiVersion` | **Yes** (foundry) | Foundry API version. | `2025-05-15-preview` |
| `tokenAudience` | Legacy `/api` only | AAD audience the **deprecated SWA-managed `/api`** uses for its Foundry token. **Not** needed by the first-class `foundry` runner backend (the runner uses its own `@azure/identity` credentials) — required only for the explicit legacy `-IncludeFoundryAgent` path. | `https://ai.azure.com` |
| `accountResourceId` | No | ARM id of the backing Azure AI Services account; only needed for `-CreateModelDeployment`. | `""` |

> **`orchestratorUrl` reachability:** the value is baked into the SPA and resolved **by the
> browser**, so it must be reachable from wherever the desktop is opened. `http://localhost:4000`
> only works when the browser runs on the **same machine** as the local-orchestrator — i.e. the
> Cloud PC itself (open the deployed SWA from the Cloud PC's browser), or during local `npm run dev`.
> For a demo where the desktop is opened from another machine, run the orchestrator somewhere the
> browser can reach (e.g. a tunnel or a host/port reachable from that machine) and set
> `foundry.orchestratorUrl` to that URL.

---

## After you edit — validate before building

Preview everything without touching Azure (this also runs the config validation, so
it's the fastest way to confirm you filled the file in correctly):

```powershell
pwsh -File .\scripts\Build-DemoFromScratch.ps1 -WhatIf
```

If a required field is missing or a name is invalid, the script stops immediately and
names the exact field(s) to fix.
