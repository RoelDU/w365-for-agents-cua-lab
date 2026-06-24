# Build the Copilot Studio agent (step by step)

> **Which backend is this?** This guide builds the **Microsoft Copilot Studio (MCS)** agent —
> the backend used when `agentBackend` is `mcs` or `both` (`Build-DemoFromScratch.ps1
> -AgentBackend mcs|both`). If you instead chose the **Azure AI Foundry + Windows 365 for
> Agents** backend (`-AgentBackend foundry`), you do **not** need this guide — follow
> [`agent-cua-setup.md`](agent-cua-setup.md) and run
> [`samples/foundry-w365a-runner`](../samples/foundry-w365a-runner). Both backends are
> first-class; pick per demo. Backend selection: [`config-reference.md`](config-reference.md#agentbackend--choose-the-ai-backend-optional-defaults-to-mcs).

This is the one part of the demo you build by hand. It produces the **Direct Line secret**
the build needs to deploy the AI backend.

> **Where does the Direct Line secret come from?** You don't create it or get it from Azure.
> **Copilot Studio generates it for you automatically when you publish the agent** (step 6 below).
> Building + publishing the agent *is* how you obtain the secret — it's an output of this guide,
> not a separate thing you have to find.

**How this fits the deploy flow** (see the [README](../README.md#deploy-the-demo)): you run the
first build with the secret **blank** (the AI backend is simply skipped), then do steps 1-6 here
to get the secret, paste it into the config, and re-run the build. That build prints a callback
URL + key — come back and do step 7, then re-publish.

> **Prerequisite:** your **W365A Cloud PC pool** must already exist **and have a Windows 365 for
> Agents PAYG billing policy attached** (issue #77), because step 3 points the Computer Use tool at
> it — a provisioning policy needs an active billing plan to provision **real Cloud PCs**. (Note: a
> dead handoff with the pool showing *0 runs* is usually the **agent-authentication** gate in step 2,
> not billing.) See [`docs/w365a-pool.md`](w365a-pool.md) and
> [`docs/licensing-and-entitlement.md` → pool billing policy](licensing-and-entitlement.md#also-required-a-windows-365-for-agents-pool-billing-policy-separate-meter-issue-77).

> **Licensing gate (read before you spend time here).** Publishing to the **Direct Line / Web /
> Mobile app** channel in step 6 is **premium** Copilot Studio usage. If your tenant has no Copilot
> Studio entitlement, step 6 shows a *"Start a 60-days free trial"* prompt instead of the channel.
> A 60-day trial is **not durable** for a reusable demo. Set up a durable entitlement first - the
> recommended path is **pay-as-you-go billing linked to an Azure subscription** (cents per run).
> See [`docs/licensing-and-entitlement.md`](licensing-and-entitlement.md).

---

## Preflight: make sure Copilot Studio actually loads (Dataverse)

**Do this before step 1.** Copilot Studio runs on **Power Platform** and stores the agent in a
**Dataverse** database. If you open Copilot Studio against an environment that has **no Dataverse
database**, the app never finishes loading — you get only the **spinning "loading donut"** and a
blank page, on every route (`/home`, `/copilots`, `/create`, ...), in any browser. Network/console
traces show the tell-tale failures: `botcomponents?api-version=...-preview -> 400`,
`viral-signup/create/status -> 404`, and `oneshell` connection resets. **This is not a transient
outage — it means the environment is missing Dataverse.**

The **default environment** (often named like *"<Tenant> (default)"* / *ModernWorkplace (default)*)
frequently reports `databaseType: None` and **cannot reliably host a Copilot Studio agent**. Do not
use it for this demo.

### 1. Check the environment's database type

Power Platform Admin Center (recommended):

1. Go to **<https://admin.powerplatform.microsoft.com>** -> **Environments**.
2. Open the environment you intend to use. Under **Details**, confirm **Dataverse** shows a
   database (a Dataverse **URL** and **State: Ready**). If it says **None / no database**, that
   environment will only ever show the loading donut in Copilot Studio.

Or from the control terminal (read-only), using your signed-in Azure CLI token for the BAP API:

```powershell
$token = (az account get-access-token --resource "https://service.powerapps.com/" --query accessToken -o tsv)
$envs  = Invoke-RestMethod -Headers @{ Authorization = "Bearer $token" } `
  -Uri "https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments?api-version=2020-10-01&`$expand=properties"
$envs.value | ForEach-Object {
  [pscustomobject]@{
    Name         = $_.properties.displayName
    Id           = $_.name
    DatabaseType = $_.properties.databaseType          # 'CommonDataService' = Dataverse; 'None' = no DB
    State        = $_.properties.provisioningState
  }
} | Format-Table -AutoSize
```

`DatabaseType = CommonDataService` is good (Dataverse present). **`DatabaseType = None` is the
cause of the loading donut** — fix it with step 2.

### 2. Use (or create) a Dataverse-backed environment

You have two options; **creating a dedicated environment is the reliable path** for this demo:

- **Create a new environment with Dataverse (recommended).** In the Admin Center -> **Environments**
  -> **+ New**: choose **Type = Production** (or **Sandbox** for testing), and **set the Region to the
  geography that matches your `azure.location`** (e.g. `azure.location = australiaeast` -> Region =
  **Australia**), then set **Add a Dataverse data store = Yes**. This is the single most important
  choice for a demo: the agent's **Computer Use Cloud PC pool inherits this environment's
  geography**, so picking your own region here is what keeps the *entire* demo — including the Cloud
  PC the audience watches — out of the US. Use **your one configured region for everything**; only if
  Copilot Studio + Computer Use genuinely aren't available in that geography yet, pick the **closest
  available** region instead and be ready to say so (see
  [`docs/w365a-pool.md`](w365a-pool.md#why-the-geography-may-show-us-central) and the cross-geo note).
  Wait until **State: Ready**, then open Copilot Studio and **switch to this environment** (top-right
  environment picker) before step 1.
- **Add Dataverse to an existing environment** only if the Admin Center offers it for that
  environment. The default environment usually does **not** support this — prefer a new environment.
  If your only Dataverse environment is in the wrong geography (e.g. a US environment while
  `azure.location` is Australia), create a new one in the right region rather than reusing it — the
  pool can't be moved afterwards.

### 3. Confirm you can create an agent

- Sign in to Copilot Studio with an account that has the **Power Platform / environment maker** role
  and **CreateBot** permission on the chosen environment (the BAP `permissions` list above includes
  `CreateBot` when you have it).
- A correct environment loads the full Copilot Studio UI (not just the spinner) and shows
  **Create -> New agent**. If it still spins after Dataverse is **Ready**, hard-refresh, clear the
  environment picker to the new environment, and confirm the region supports Copilot Studio.

> **Why the default environment fails:** `databaseType: None` means there is no Dataverse instance to
> hold the bot components, so the Copilot Studio shell's `botcomponents` call 400s and the app cannot
> render. A Dataverse-backed environment in a supported region resolves it. Make sure Computer Use is
> enabled for your tenant/environment as noted in the
> [README prerequisites](../README.md).

---

## Get the Direct Line secret (steps 1-6)

### 1. Create the agent
In **Copilot Studio** (`copilotstudio.microsoft.com`), select your environment → **Create** →
**New agent**. Give it a name (e.g. *Zava Claims Intake (CUA)*) and a short description, then
**Create**.

### 2. Turn on generative orchestration
Open the agent → **Settings** → enable **Generative orchestration** (so it routes to the right
topic/tool from natural language instead of only keyword triggers), then **Save**. **Do this
before adding the Computer Use tool** — Computer Use is *only* available on agents that have
generative orchestration turned on. On a brand-new Dataverse environment it also helps to
**Publish the agent once** here so its bot backend is fully provisioned before you add the tool.

> **Require authentication — but use "Authenticate manually," not "Authenticate with Microsoft."**
> Computer Use is **disabled for unauthenticated agents**; only a **Microsoft Entra user account** can
> execute it, so an agent left on *No authentication* fails the instant a topic routes to Computer Use
> (Test pane: *"CUA is disabled for unauthenticated agents. Please change your agent security
> settings,"* the handoff times out at `ready`, and the pool shows **0 runs ever**). **Do not pick the
> built-in *Authenticate with Microsoft*** — it **disconnects custom channels, including the Direct Line
> channel** this demo's orchestrator uses to trigger the handoff (Copilot Studio warns about this on
> save). Instead choose **Settings → Security → Authentication → *Authenticate manually*** with a custom
> Entra app registration, so the agent is authenticated (CUA works) **and** Direct Line stays connected.
> Then **Save** and **Publish**.
>
> **Critical for unattended Direct Line — turn *Require users to sign in* OFF.** *Authenticate manually*
> by itself is **not** enough: if **"Require users to sign in"** is left **ON**, the agent returns an
> **OAuth/sign-in card** on the first turn — and the orchestrator's Azure Function is a **headless
> caller with no user to sign in**, so the handoff stalls and never reaches Computer Use. Set
> **Require users to sign in = OFF**, and keep the **Direct Line trigger path free of `Authenticate`
> nodes and auth variables**. The agent stays authenticated at the maker level (CUA enabled) while the
> unattended channel is **never prompted to sign in**.
>
> **CUA must use *maker-provided credentials*, not end-user.** In the **Computer Use tool → Credentials
> to use**, select **Maker-provided credentials** and preconfigure the stored credential for the legacy
> app / machine. Unattended Direct Line has **no end user**, so end-user credentials would have nothing
> to authenticate with. (This is the demo default — confirm it, don't change it.)
>
> **Change auth safely — never live-first.** An auth change requires a **Publish** and can break the
> currently working test path. Validate in a **cloned agent/environment** if at all possible; if you
> must change the live agent, **export/screenshot the current config first**, make the **smallest** auth
> change, publish, run the **exact** Direct Line test below, and be ready to **revert + republish**
> immediately. Prefer **Microsoft Entra ID v2 with a federated credential** over a client secret (a
> wrong/expired secret, missing consent, or wrong redirect URI burns demo time); if you use a client
> secret, create and test it **ahead of time** and keep scopes minimal (usually `openid profile`).
>
> **The Test pane does not prove this works.** Passing in the Test pane does **not** prove unattended
> Direct Line works. Final validation must be the exact path — **Direct Line token endpoint → start
> conversation → `pvaSetContext` → the natural-language `HANDOFF_TRIGGER_TEXT`** — confirming: no
> OAuth/sign-in card is returned, generative orchestration reaches Computer Use, a CUA session starts on
> the pool, the legacy app login uses the stored maker credential, and the final response returns to
> Direct Line. **Repeat once in a fresh conversation** to catch token/session assumptions.
>
> **App registration for *Authenticate manually*:** in Entra → **App registrations → New
> registration** (single tenant). Under **Authentication → Add a platform → Web**, add redirect URI
> **`https://token.botframework.com/.auth/web/redirect`** (use the exact value Copilot Studio shows).
> Copy the **Application (client) ID** and **Directory (tenant) ID**, and create a **client secret**.
> Then in Copilot Studio's manual-auth form set **Service provider = Microsoft Entra ID v2**, paste the
> **Client ID** + **Client secret**, set the **Token exchange URL** and **Scopes** (e.g.
> `openid profile`), **Save**, **Publish**. Reference:
> [Configure user authentication with Microsoft Entra ID](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configuration-authentication-azure-ad).
>
> After enabling auth the **Direct Line secret may rotate** — re-copy it (see
> [`handoff-runbook.md` §2d](handoff-runbook.md#2d-get-the-direct-line-secret)) and confirm the desktop
> handoff still connects. More:
> [`w365a-pool.md` → pool healthy but Computer Use never runs](w365a-pool.md#if-the-pool-is-healthy-but-computer-use-never-runs-handoff-times-out-at-ready).

### 3. Add the Computer Use tool and point it at your pool
In the agent, go to **Tools** → **Add a tool** → **Computer Use**. In the tool's **Machines**
setting, select your **W365A Cloud PC pool** (the one from `docs/w365a-pool.md`). This is the
binding that has no public API — it must be done here, by you, as the signed-in maker.

> **`claims.exe` is delivered via Intune** as a required Win32 app to the agent pool.
> It is pre-installed on the Cloud PC by the time the Computer Use agent session starts.
> The agent simply launches it from the desktop shortcut or known install path — no
> download or self-provisioning step is needed. See
> [`w365a-pool.md` → Getting claims.exe onto the pool](w365a-pool.md#getting-claimsexe-onto-the-pool).

> **Leave Human supervision OFF — no reviewer.** Copilot Studio's Computer Use tool can require a
> human to watch/approve each run (a "reviewer" / human-in-the-loop). This demo is an **unattended
> handoff**, so a reviewer just pauses the run and adds needless friction. Leave supervision off and
> do **not** set a reviewer. (Auto/human supervision routing is production-only and explicitly
> narrate-only for this demo — see [`handoff-architecture-decision.md`](handoff-architecture-decision.md).)

> **Save reports `Save tool with errors? This tool has (6) errors`?** Copilot Studio runs a
> completeness check when you **Save** the Computer Use tool and surfaces a count of validation
> issues. The tool still *executes* with errors, but the demo deliverable should save **clean** (zero
> errors). The dialog does not enumerate them, so identify each one in the editor: every field that is
> flagged shows an inline red marker / error text — **expand each section and hover the marked field**
> to read its message. Walk the tool top-to-bottom and clear them in this order:
>
> 1. **Name + Description** — both required. Generative orchestration also needs a **clear,
>    non-empty description** so the model can route to the tool; an empty description is a common flag.
> 2. **Inputs / outputs** — each declared input/output needs a **name, type, and description**, and any
>    input marked *required* must have a value or be wired to a variable. Blank descriptions on inputs
>    count as errors under generative orchestration. Remove inputs you do not use rather than leaving
>    them half-defined.
> 3. **Connection** — the tool's connection must be **created and authorized by you (the maker)**; an
>    unauthorized/expired connection reports as an error (see the `connectionReference` note below).
> 4. **Machines** — a **Cloud PC pool must be selected** in the *Machines* setting; an unbound tool
>    flags here.
> 5. **Human supervision** — this is the one that interacts with the unattended-demo requirement above.
>    Leaving the section *present with no reviewer* can itself be flagged. The supported way to run
>    **without** a human-in-the-loop is to set supervision so the agent does **not** require approval —
>    i.e. **turn the supervision/approval requirement OFF** (so there is no "assign requests to"
>    reviewer to fill in), rather than leaving an approval step configured with an empty reviewer. If
>    your build still flags an empty reviewer after turning supervision off, that is a product
>    validation quirk: it is safe to **Save with errors** as a stopgap for the demo, but the intended
>    clean state is *supervision off, no reviewer, zero errors*.
>
> **Desired clean Computer Use tool state for this demo:** non-empty name + description; only the
> inputs/outputs you actually use, each fully described; an authorized maker-owned connection; the
> W365A pool selected under *Machines*; and **human supervision off with no reviewer**. Saving in that
> state should report **0 errors**. (`Save with errors` is an acceptable stopgap, not the steady
> state.) The exact set of fields a given tenant flags can only be read live in the editor — capture
> them there; this repo cannot enumerate your specific six. Tracked as #90.

> **"Add and configure" fails with `Illegal state: connectionReference is not defined`?**
> (Often alongside `404`s on `.../dlpstatus`, `.../botauthoring/v1/auth/authorization`, or
> `.../makerevaluations/enabled` in the browser console.) The error means the tool's underlying
> **connection reference was never created/authorized** — the maker portal couldn't bootstrap the
> connection (the `botauthoring/.../auth/authorization` 404 is that failed call). Work through these
> in order; the first three are what most often fix it once publishing alone hasn't:
> 1. **Generative orchestration ON first, then publish once.** Computer Use is unavailable without
>    generative orchestration (Step 2). Turn it on, **Save**, **Publish the agent once**, reload.
>    *(If you already did this and it still fails — as is common — continue below.)*
> 2. **Pre-create and authorize the connection before adding the tool.** Don't rely on the inline
>    prompt. In a **new tab**, open Power Apps ([make.powerapps.com](https://make.powerapps.com))
>    → select **the same environment** → **Connections** → **+ New connection** → create/sign in to
>    the connection the Computer Use tool needs (and confirm it under Copilot Studio **Settings →
>    Connections**). Then go back and add the tool. The maker must **own** the connection.
> 3. **Retry in a clean browser session.** The `auth/authorization` + `dlpstatus` 404s are usually
>    the connection/auth bootstrap being blocked by cached cookies or an extension. Open an
>    **InPrivate/Incognito** window (no ad-/script-blockers), sign in fresh, and retry — or clear
>    cache for `*.powerapps.com` / `*.microsoft.com`.
> 4. **Delete stale/broken connections, then re-authenticate.** Power Platform admin center →
>    **Connections** (or Power Apps → Connections): remove any errored/expired connection for this
>    environment and recreate it.
> 5. **Check tenant DLP.** A `dlpstatus 404` can mean a Data Loss Prevention / tenant policy blocks
>    (or hasn't propagated for) the connectors Computer Use uses. Admin: Power Platform admin center
>    → **Policies → Data policies** → confirm nothing blocks this environment's connectors.
> 6. **Confirm per-environment enablement + capacity for THIS environment.** If you switched
>    environments (e.g. Australia → a US one), Computer Use / Cloud PC On and cross-geo support are
>    *per environment* (see
>    [w365a-pool.md troubleshooting](w365a-pool.md#if-the-machine-drop-down-has-no-cloud-pc-pool-option)).
>    Computer Use also consumes **Copilot Credits** (5/step), so the environment needs a
>    pay-as-you-go / Copilot Credits capacity. For an Anthropic model, an admin must allow external
>    models for the environment.
> 7. **Alternative + escalation.** Try the **Computer use** agent template (Create → from template),
>    which pre-wires the tool and its connection. If every step above fails on a fully provisioned,
>    published agent, this is likely a **product/region-side issue** — capture a browser HAR of the
>    failing **Add and configure** and report it (computeruse-feedback@microsoft.com / Microsoft
>    support) with the environment ID and the failing request URLs.

> **No `Cloud PC pool` option in the machine drop-down?** If you only see *Hosted browser* and
> *Bring-your-own machine*, the feature is gated by a prerequisite (most often the per-environment
> **cross-geo support** toggle, especially outside the US). Do **not** switch to *Bring-your-own
> machine* — see
> [w365a-pool.md → If the machine drop-down has no "Cloud PC pool" option](w365a-pool.md#if-the-machine-drop-down-has-no-cloud-pc-pool-option).

> Refresh this connection before each demo (**Settings → Connections**).

### 4. Accept the inbound call context
The orchestrator sends the call context as a Direct Line **`pvaSetContext`** event before any
trigger. Create the **Global variables** it maps onto (`Global.callerName`, `Global.callerPhone`,
`Global.policyNumber`, `Global.intent`, `Global.correlationId`, `Global.handoff_id`,
`Global.agentDisplayName`) and enable **"External sources can set values"** on each.
Full mapping: [`handoff-runbook.md` §2a](handoff-runbook.md#2a-inbound-context--global-variables--pvasetcontext).

### 5. Set the start trigger (generative orchestration — the confirmed-working path)
The orchestrator starts the handoff by sending a **trigger message**. The proven, demo-confirmed path
is **generative orchestration**: set `HANDOFF_TRIGGER_TEXT` to a **natural-language instruction** and let
the agent route it to the **Computer Use tool** from the tool's **description** — this is what drove the
Cloud PC end-to-end in testing. The verified live string is:

```
A customer phone call has been handed off to you for automated processing. Using the caller phone, policy number, intent, and summary from the handoff context, open the Zava Mutual Claims Workstation and file a new First Notice of Loss, then return the resulting claim ID.
```

Caller data arrives via the `pvaSetContext` Global variables (Step 4), so the trigger text stays generic.
**Requirements:** a clear, specific **Computer Use tool description**, and **web search / other knowledge
disabled** so the instruction routes to Computer Use instead of being answered by search.
Detail: [`handoff-runbook.md` §2b](handoff-runbook.md#2b-explicit-trigger).

> ⚠️ **Do not use the bare token `start_fnol_handoff` as the trigger.** It only matches a **classic custom
> topic**, and a classic topic that invokes the autonomous Computer Use tool via a **`Redirect to` node**
> instant-`SystemError`s (`isUserError: false`, **0 Cloud PC runs**) — the build-side bug that blocked this
> demo (issue #69). Natural language + generative orchestration **avoids the topic entirely**.

#### Optional: the classic-topic alternative (not required — generative orchestration above is preferred)

You only need this if you deliberately avoid generative orchestration. A classic topic whose only action
is a **`Redirect to` → Computer use** node with **no context mapped in** fails two ways at once and
produces the instant `SystemError` described above:

- **Wrong invocation node.** Computer Use is an **autonomous agent tool**, *not* a topic/sub-dialog —
  you **cannot `Redirect to` it**. `Redirect to` is for topics. Invoke the tool with the topic's
  **tool/action call node** (the same node you'd use to call any tool or flow), select **Computer Use**,
  and let it return inline.
- **No task / no context.** The Computer Use tool only knows the *static* navigation guide
  ([`CUA-TOOL-INSTRUCTIONS.md`](../apps/legacy-claims-workstation/samples/foundry-agent/CUA-TOOL-INSTRUCTIONS.md));
  the **per-run caller data** (`caller_phone`, `policy_number`, `summary`, `intent`) must be **passed in
  as the run/task message**. A redirect with nothing wired in gives the tool no task at all.

**If you build the classic `Start FNOL Handoff` topic, author it as exactly these steps:**

1. **Trigger** — *On message* with the condition `Activity.Text == <your `HANDOFF_TRIGGER_TEXT`>`.
2. **Compose the run message from the inbound context** (the `Global.*` populated by `pvaSetContext`,
   Step 4). Add a **Set a variable value** node, e.g. `Topic.cuaTask` =

   ```
   "File a First Notice of Loss (FNOL) claim in the Zava Mutual Claims Workstation.
   caller_name: " & Global.callerName &
   "; caller_phone: " & Global.callerPhone &
   "; policy_number: " & Global.policyNumber &
   "; intent: " & Global.intent &
   ". Find the policy, complete the 5-step FNOL wizard, submit, and return the claim ID.
   Follow the CUA Tool Instructions for all on-screen navigation."
   ```

   The literal scaffold means `Topic.cuaTask` is **never empty**, even if a global is blank — which is
   what prevents the empty-input instant-`SystemError` (see the Test-pane note below).
3. **Invoke Computer Use** with the **tool/action call node** (❌ *not* `Redirect to`). Bind the tool's
   **task / instruction input to `Topic.cuaTask`**, and bind any other *required* tool inputs to the
   matching globals. Capture the tool's text output into a variable (e.g. `Topic.cuaResult`).
4. **Return the result** via the Power Automate callback flow (Step 7), which POSTs the structured
   result to the orchestrator. End the topic.

> **This classic topic is the *fallback*, not the recommended path.** The confirmed-working design (top
> of this section) is **pure generative orchestration**: a **natural-language `HANDOFF_TRIGGER_TEXT`** + a
> clear **Computer Use tool description**, with **no custom topic at all**. The orchestrator now sends
> natural language (not the old `start_fnol_handoff` token), so orchestration routes to the tool directly
> — which is what drove the Cloud PC end-to-end in testing. Build the classic topic above only if you
> deliberately avoid generative orchestration.

> **The build does not provision this.** `Build-DemoFromScratch.ps1` deploys the orchestrator,
> website, and Intune assets, but **cannot** create the agent's topics, Global variables, or
> result flow — Copilot Studio exposes no supported creation API for the Computer Use tool
> binding (see *"Does any of this script?"* above). Steps 4–7 here are required **manual**
> wiring; the build's final summary reprints them with your live trigger text and callback key.

> **Invoke Computer Use the generative-orchestration way — don't imperatively "redirect" to it.**
> Computer Use is an **agent tool that generative orchestration selects from its description**. The
> reliable pattern is: give the tool a **clear, specific description**, turn **web search / other
> knowledge off**, and let the trigger route to it — or, if you author the topic explicitly, use the
> supported **tool-activation action with every required input bound**. A **classic topic that
> *redirects* to / force-activates** the autonomous tool can **instant-fail with `SystemError`**
> (`isUserError: false`) *before* any Cloud PC is acquired. If you see that, it's this wiring — not a
> platform defect, not the pool. (Issue #69.)

> **Test-pane testing has no inbound context — a required CUA input bound to an empty global will
> instant-`SystemError`.** The claim context arrives via the orchestrator's `pvaSetContext` event
> (Step 4), which the **Test pane cannot send**, so `Global.callerName`, `Global.policyNumber`, etc.
> are **blank** when you test there. If the topic passes a *required* Computer Use input (e.g. the task
> instruction or `policyNumber`) from one of those empty globals, the tool **can't start a run** and you
> get an instant `SystemError` with **no pool run**. To test from the Test pane, **set those globals in
> the variables panel first**, or test the **full path through the orchestrator** (which does send the
> context). Harden the topic so a required input is **never passed blank** (literal/templated default
> task, or gate the tool call on context being present). Full triage:
> [`handoff-runbook.md` §10 → topic→Computer Use invocation wiring](handoff-runbook.md#auth-correct-but-an-instant-systemerror-with-zero-pool-runs-the-topic-to-computer-use-invocation-wiring).

### 6. Publish, then copy the Direct Line secret
**Publish** the agent (the secret isn't available until it's been published once). Then
**Settings → Security → Channels → Direct Line** (or **Web**) → **Secret keys** → copy a key, and
paste it into `handoffOrchestrator.directLineSecret` in `demo-config.local.json`.
Exact click-path: [`handoff-runbook.md` §2d](handoff-runbook.md#2d-get-the-direct-line-secret).

> **No "Secret keys" — only a connection string / token endpoint?** Newer Copilot Studio channels
> (the 60-day premium trial and the **Microsoft 365 Agents SDK** Web/Native app) no longer expose a
> classic Direct Line **secret**. Instead they expose a **Direct Line token endpoint** such as
> `https://<env>.environment.api.powerplatform.com/powervirtualagents/botsbyschema/<bot>/directline/token?api-version=2022-03-01-preview`
> (a GET returns `{ token, expires_in, conversationId }`). In that case **leave `directLineSecret`
> blank** and paste that URL into `handoffOrchestrator.directLineTokenEndpoint` instead. The
> orchestrator GETs it to obtain a conversation-bound token. Provide **exactly one** of the two.

> **Channel shows "Start a 60-days free trial" instead of Direct Line/Web/Mobile app?** That's the
> Copilot Studio premium-entitlement gate, not a bug. The trial is **not durable** for a reusable
> demo - set up **pay-as-you-go billing** (or another durable entitlement) once, then the channel
> appears without the prompt. See [`licensing-and-entitlement.md`](licensing-and-entitlement.md).

**Paste the secret** (or the token endpoint) into `handoffOrchestrator` and **re-run the build**
(`Build-DemoFromScratch.ps1`). The AI backend now deploys and prints an **orchestrator callback
URL** and a **callback key**.

---

## Wire the result callback (step 7)

### 7. Add the result flow and re-publish
Add the agent's final step: a **Power Automate flow** that POSTs the claim result to the callback
URL the build printed, with the `x-handoff-key` header set to the callback key. Then **re-publish**.
Exact body + rules: [`handoff-runbook.md` §2c](handoff-runbook.md#2c-structured-result-callback-authoritative).

That's the whole agent.

---

## Can't this be automated?

Mostly no, and it's worth being precise about why:

- Copilot Studio agents can be exported as **Dataverse solutions** and imported with the
  **Power Platform CLI** (`pac solution import`), so the agent definition *can* be scripted.
- **What is not automatable today** is **step 3** — binding the Computer Use tool to
  your W365A Cloud PC pool and granting the maker connection consent. Those are interactive maker
  gestures with no documented supported creation API.
- **Why hand-built, then?** For a one-off demo, building the agent once by hand is simpler and
  more reliable than maintaining a solution-import + connection-binding pipeline. It is a
  pragmatic trade-off, not a hard limitation of "agents."
