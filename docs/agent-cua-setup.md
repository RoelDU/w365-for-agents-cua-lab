# Agent + Computer Use (CUA) setup

> **Which backend is this?** This document covers the **Azure AI Foundry** Computer-Use
> agent. As of the dual-backend update it is a **first-class, selectable backend** — choose
> it with `Build-DemoFromScratch.ps1 -AgentBackend foundry` (or `both`), or set
> `agentBackend` in the config. It **does** drive the **W365A Cloud PC pool**: the runtime is
> [`samples/foundry-w365a-runner`](../samples/foundry-w365a-runner), which checks out a
> Windows 365 for Agents session and drives `claims.exe` via the Foundry Computer Use loop,
> behind the **same `handoff_id` handoff contract** as the Copilot Studio path. For the
> **Copilot Studio (MCS)** backend instead, see **[`build-the-agent.md`](build-the-agent.md)**.
> Both backends are equally supported; pick per demo. (The older SWA-managed `/api`
> thread_id/run_id flow under `apps/ccaas-agent-desktop/api` is deprecated and is **not** the
> path described here.)

How to stand up the **Zava claims-intake agent** that the CCaaS desktop hands off
to — the agent that drives the legacy `claims.exe` inside a Windows 365 Cloud PC
via **Computer Use (CUA)**.

## TL;DR — one manual step

For **this demo**, exactly **one** thing can't be automated: the one-time **access
approval** for the `computer-use-preview` model (a human request form). Everything
else is scripted or automatic:

1. **(Manual, once)** Request `computer-use-preview` access → <https://aka.ms/oai/cuaaccess>.
2. **(Scripted)** Run `Deploy-Agent.ps1 -CreateModelDeployment …` — deploys the model
   **and** creates the agent (knowledge, instructions, tools, Computer Use) in one go.
3. **(Automatic)** Publish the agent to Agent 365 → it gets its **Entra Agent ID**
   auto-provisioned. No manual app registration.
4. **(One click + refresh)** Point Computer Use at your agent Cloud PC (e.g.
   `<your-cloud-pc-name>`)
   in **Settings → Connections**, and refresh that connection before each demo.

That's it. The long "enablement" section near the bottom is **optional enterprise
hardening** (governed Agent ID blueprints, a Windows 365 *for Agents* pool) — you do
**not** need it to run the demo.

> **Preview:** the Foundry Agent Service data-plane, `computer-use-preview` model,
> Microsoft Graph **beta** agent-identity APIs, and Windows 365 for Agents APIs are
> all preview. No SLA; acceptable for this private demo. API specifics are flagged
> "verify on first run (as of 2026-05-31)" where they haven't been run live here.

---

## At a glance

| Item | What | How |
|---|---|---|
| **Manual** | `computer-use-preview` **access approval** | ⛔ **The one manual step** — human gate, no API |
| Prereq 1 | Foundry project + resource | Portal / ARM (one-time) |
| Prereq 2 | `computer-use-preview` **deployment** | ✅ `Deploy-Agent.ps1 -CreateModelDeployment` (ARM) |
| Step 3 | Create the agent (knowledge, instructions, tools, model) | ✅ **`Deploy-Agent.ps1`** (Foundry data-plane) |
| Step 4 | Agent 365 identity (Entra Agent ID) | ✅ **Auto-provisioned** on publish to Agent 365 |
| Step 5 | Point Computer Use at the Cloud PC | 🖱️ One click in Settings → Connections (+ refresh before demos) |
| Step 6 | Import evaluations, run a smoke test | Portal |
| *Optional* | *Enterprise hardening: Agent ID blueprints, W365-for-Agents pool* | 🔶 Scriptable — see end |

Legend: ✅ scripted/automatic · 🖱️ one click · ⛔ the single manual gate · 🔶 optional.

---

## Prerequisites (one-time, greenfield)

These mirror **Part B.0** of [`demo-environment-setup.md`](./demo-environment-setup.md).

### 1. Foundry project + resource
Create a Microsoft Foundry resource and a **project** in the demo tenant. Note the
**project endpoint**, e.g.
`https://<resource>.services.ai.azure.com/api/projects/<project>` (older form:
`https://<resource>.ai.azure.com/api/projects/<project>`). Grant whoever runs the
script the **Azure AI User** role on the project (least privilege; not Owner). To
also script the model deployment (step 2b) you need rights to create deployments on
the backing Azure AI Services account (e.g. **Cognitive Services Contributor**).
<https://learn.microsoft.com/azure/ai-foundry/agents/environment-setup>

### 2. `computer-use-preview` — access (manual) then deployment (scripted)
The Computer Use tool runs on the access-gated **`computer-use-preview`** model.

**2a — Access approval (the one true manual gate).** Request access:
<https://aka.ms/oai/cuaaccess>. This is a human approval; there is no API.

**2b — Deployment (scriptable).** Once access is approved, the deployment itself is
a standard ARM control-plane operation — `Deploy-Agent.ps1` does it for you:
```powershell
pwsh -File .\scripts\Deploy-Agent.ps1 `
  -ProjectEndpoint https://<resource>.services.ai.azure.com/api/projects/<project> `
  -CreateModelDeployment `
  -SubscriptionId <sub> -ResourceGroup <rg> -AccountName <aiservices-account> `
  -WhatIf
```
(Equivalently: `az cognitiveservices account deployment create --model-name computer-use-preview ...`.)
The script resolves the newest offered model version automatically (or pass
`-ModelVersion`). Use the deployment name for `-ModelDeploymentName`.

Tool how-to: <https://learn.microsoft.com/azure/ai-foundry/agents/how-to/tools/computer-use>

> If access isn't approved yet, you can still provision the rest of the agent
> with `-SkipComputerUseTool` and add Computer Use later (re-run the script).

---

## Step 3 — Create the agent (automated)

Run under **PowerShell 7** (`pwsh`) from the repo root. Preview first with
`-WhatIf`, then run for real:

```powershell
pwsh -File .\scripts\Deploy-Agent.ps1 `
  -ProjectEndpoint https://<resource>.services.ai.azure.com/api/projects/<project> `
  -ModelDeploymentName computer-use-preview `
  -DeviceCode `
  -WhatIf
```

Drop `-WhatIf` to apply. The script:

- **Signs you in** to Azure (`Connect-AzAccount`; `-DeviceCode` to auth from your
  phone) and gets a Foundry data-plane token.
- **Uploads `KNOWLEDGE.md`** and builds a vector store so the agent retrieves it on
  demand (`file_search`).
- **Sets the instructions** from `AGENT-INSTRUCTIONS.md` (behaviour) +
  `CUA-TOOL-INSTRUCTIONS.md` (UI navigation), with the markdown headers stripped.
- **Registers the 3 function tools** from `samples/foundry-agent/tools/*.json`
  (`launch_claims_app`, `wait_for_file`, `read_json_file`).
- **Adds the Computer Use tool** (`computer_use_preview`, Windows) unless
  `-SkipComputerUseTool`.
- **Leaves web search OFF** (the demo must stay self-contained).
- Targets your **model deployment**.

It's **idempotent**: it finds the agent, vector store, and knowledge file by name
and updates in place, so re-running is safe.

### Parameters

| Parameter | Default | Notes |
|---|---|---|
| `-ProjectEndpoint` | *(required)* | Foundry project endpoint (see Prereq 1). |
| `-ModelDeploymentName` | `computer-use-preview` | Your model deployment (Prereq 2). |
| `-AgentName` | `Zava Claims Intake (CUA)` | Used for idempotent lookup. |
| `-AssetRoot` | in-repo `foundry-agent` folder | Where the assets live. |
| `-ApiVersion` | `2025-05-15-preview` | Pin/bump as the preview evolves. |
| `-DeviceCode` | off | Browser-free sign-in (auth on another device). |
| `-SkipComputerUseTool` | off | Provision everything except Computer Use. |
| `-TenantId` | *(optional)* | Force a specific tenant for sign-in. |
| `-CreateModelDeployment` | off | Also create the `computer-use-preview` deployment via ARM (Prereq 2b). |
| `-AccountResourceId` | *(optional)* | ARM id of the backing AI Services account; or use the three params below. |
| `-SubscriptionId` / `-ResourceGroup` / `-AccountName` | *(optional)* | Identify the AI Services account for `-CreateModelDeployment`. |
| `-ModelName` / `-ModelVersion` | `computer-use-preview` / *(newest)* | Model to deploy; version auto-resolved if omitted. |
| `-DeploymentSku` / `-DeploymentCapacity` | `GlobalStandard` / `1` | Deployment SKU + capacity. |
| `-ForceUpdateModelDeployment` | off | Overwrite an existing deployment whose settings differ (otherwise it stops and asks). |
| `-AdoptExisting` | off | Reuse/update an agent or vector store of the same name that this script didn't create. |
| `-WhatIf` | off | Preflight + sign-in + read-only checks; makes **no** changes. |

> **Re-runnable & safe:** the script runs a **preflight** first (assets, tool JSON,
> ARM parameters, module availability) so a missing prerequisite fails in seconds —
> *before* the interactive sign-in. It's **idempotent**: the agent and vector store
> are matched by name (paginated), the model deployment is compared before any
> change, and knowledge is keyed by a content hash so edits to `KNOWLEDGE.md` are
> re-uploaded on the next run. Every failure prints a `DEPLOYMENT FAILED` block with
> a `What to do` list and exits non-zero.

> **Verify the assets first** (no tenant needed):
> `.\scripts\Confirm-AgentAssets.ps1`

---

## Step 4 — Agent 365 identity (Entra Agent ID) — automatic

**No manual work for the demo.** When you publish the Foundry agent into **Agent 365**,
its **Entra Agent ID** (a first-class directory identity for per-call auth,
Conditional Access, and audit) is **auto-provisioned** — you don't register an app
yourself. After publishing, the only thing you may approve is the
`computer-use-preview` permission on the agent's enterprise app (Step 1).
<https://learn.microsoft.com/windows-365/agents/identity-security-secure-by-design>

> Want to manage identities explicitly (blueprints, least-privilege scopes, governance
> at scale)? That's the optional enterprise path — see
> [Enterprise hardening](#optional--enterprise-hardening-scale-out) at the end.

---

## Step 5 — Point Computer Use at the Cloud PC — one click

In the agent platform, **Settings → Connections**:

1. Add/select the **Windows 365** connection and point the Computer Use tool at the
   Cloud PC — for this demo, your existing Enterprise CPC (e.g. `<your-cloud-pc-name>`).
2. **Refresh this connection before every demo.** The token expires when the Cloud
   PC session disconnects or restarts. If the agent asks you to re-authenticate,
   come back here and refresh.

That's the whole demo path. The programmatic Cloud-PC session API (for a governed
Windows 365 *for Agents* pool instead of the portal connection) is the optional
enterprise path — see [Enterprise hardening](#optional--enterprise-hardening-scale-out).

---

## Step 6 — Evaluate + smoke test

- Import the 4 evaluation CSVs in `samples/foundry-agent/evaluations/` **in order**
  (5 / 7 / 7 / 4 tests). Reset legacy data before batches 3 and 4. Don't run them
  concurrently — they share the one CUA connection.
- Try the **Step 6** prompts in the top-level [`README.md`](../README.md) with the
  legacy app running on the Cloud PC and the CCaaS desktop open.

---

## Troubleshooting

The script prints a `DEPLOYMENT FAILED` block with a `What to do` section for every
error, and exits non-zero. Common cases:

| Symptom (from the error block) | What it means / fix |
|---|---|
| `this script needs PowerShell 7` | Launch with `pwsh`, not Windows PowerShell 5.1. `winget install --id Microsoft.PowerShell`. |
| `-ProjectEndpoint doesn't look like a Foundry project endpoint` | Copy the endpoint from the Foundry portal (project → Overview). Form: `https://<resource>.services.ai.azure.com/api/projects/<project>`. |
| `agent asset folder not found` / `required agent asset is missing` | Run from the repo, or pass `-AssetRoot` at a folder with AGENT-INSTRUCTIONS.md, CUA-TOOL-INSTRUCTIONS.md, KNOWLEDGE.md. |
| `tool definition file is not valid JSON` | Fix the JSON in `tools\*.json` (the path is in the error), or move the non-tool file out. |
| `could not load the 'Az.Accounts' module` | `Install-Module Az.Accounts -Scope CurrentUser -Force`; register PSGallery if needed. |
| `Azure sign-in failed` | Re-run and complete sign-in; add `-DeviceCode` on headless/RDP; pass `-TenantId` for the right tenant. |
| `could not obtain a Foundry data-plane access token` | Check `Get-AzContext`; sign into the project's tenant; `Update-Module Az.Accounts`. |
| **HTTP 401** (Foundry/ARM) | Token expired/wrong tenant — re-run; pass `-TenantId`. |
| **HTTP 403** (Foundry) | Grant **Azure AI Developer** (or Contributor) on the Foundry project/resource. |
| **HTTP 403** (ARM deploy) | Grant **Cognitive Services Contributor** on the account **and** confirm model access (<https://aka.ms/oai/cuaaccess>). |
| **HTTP 404** (Foundry) | Wrong `-ProjectEndpoint` or stale `-ApiVersion` — both are shown in the error. |
| `model 'computer-use-preview' is not available` | Access not approved yet — request it at <https://aka.ms/oai/cuaaccess>, then re-run with `-CreateModelDeployment`. |
| `model deployment named '…' already exists with DIFFERENT settings` | Re-run with `-ForceUpdateModelDeployment` to overwrite, or omit `-CreateModelDeployment` to keep it. |
| `already exists but was not created by this script` | A same-named agent/vector store exists that the script doesn't own — re-run with `-AdoptExisting`, or rename/delete it. |
| `N agents already exist with the name …` | Duplicate agents — delete the extras in the portal so one (or none) remains, then re-run. |
| **HTTP 409** (ARM deploy) | A deployment with that name conflicts — pass `-ForceUpdateModelDeployment`, or delete it. |
| **HTTP 429** / quota | Lower `-DeploymentCapacity`, or request more quota for the model. |
| Computer Use tool rejected | Access not approved yet — re-run with `-SkipComputerUseTool`, finish access, then re-run without it. |
| Agent runs but can't see the Cloud PC | Refresh the Windows 365 connection (Step 5). |

Every failure is safe to retry: the script runs a preflight before sign-in and is
**idempotent** — the agent and vector store are matched by name (paginated), the
model deployment is compared before any change, and knowledge is keyed by a content
hash so edits to `KNOWLEDGE.md` are re-uploaded on the next run.

---

## What's automated vs. manual (summary)

**Demo path = one manual step.**

- ⛔ **Manual (the only one):** request `computer-use-preview` access
  (<https://aka.ms/oai/cuaaccess>) — a human approval, no API.
- ✅ **Scripted** (`Deploy-Agent.ps1`): the `computer-use-preview` **deployment**
  (`-CreateModelDeployment`, ARM), knowledge upload, instructions, function tools,
  Computer Use tool attach, model selection, web-search-off, idempotent create/update.
- ✅ **Automatic:** the Entra **Agent ID** is provisioned when the agent is published
  to Agent 365.
- 🖱️ **One click (+ refresh before demos):** pointing Computer Use at your agent Cloud PC (e.g. `<your-cloud-pc-name>`)
  in Settings → Connections.

Everything below this line is **optional** and only needed for enterprise scale-out.

---

## Optional — enterprise hardening (scale-out)

You do **not** need any of this to run the demo. Adopt it when you want governed
identities and a dedicated, stateless Cloud PC pool for many agents. These are
preview APIs (verify in your tenant, as of 2026-05-31).

### Governed Entra Agent ID (blueprints)
Instead of relying on auto-provisioning, manage identities explicitly. One-time
enablement: roles **Agent ID Developer** (create blueprints) + **Agent ID
Administrator** (manage), **Entra ID P1/P2** for Conditional Access / ID Protection,
and admin-consented Graph permissions (`AgentIdentityBlueprint.Create`,
`AgentIdentityBlueprint.ReadWrite.All`, `AgentIdentityBlueprintPrincipal.Create`,
`User.Read`). Then create a blueprint and provision child identities from it via
Microsoft Graph **beta**. Admin center: **Entra ID → Agents**.
Docs: <https://learn.microsoft.com/entra/agent-id/> ·
<https://learn.microsoft.com/graph/api/resources/agentidentity?view=graph-rest-beta>

### Windows 365 *for Agents* pool (instead of the portal Connection)
One-time enablement: set up **billing** (pay-as-you-go) and create an **agent
provisioning policy** (provisions the Cloud PC agent pool); needs **Entra ID P1/P2**
+ **Intune**, and an authorized trusted caller. Then drive Cloud PCs with the session
lifecycle API:
```http
POST   /api/pools/{poolId}/sessions?api-version=2.0     # check out a Cloud PC
POST   /computers/{computerId}/mcp?api-version=1.0       # drive it (keyboard/mouse/shell)
DELETE /api/sessions/{sessionId}?api-version=2.0         # check in
```
Docs: <https://learn.microsoft.com/windows-365/agents/billing-w365a> ·
<https://learn.microsoft.com/windows-365/agents/create-provisioning-policy-agents> ·
<https://learn.microsoft.com/windows-365/agents/agent-session-lifecycle> ·
<https://learn.microsoft.com/windows-365/agents/mcp-tool-overview>

These two aren't baked into `Deploy-Agent.ps1` because they depend on your tenant's
blueprint/pool setup; the requests above are ready to adapt once enabled.

### Runnable Foundry + W365A backend (`samples/foundry-w365a-runner`)
The session-lifecycle requests above are implemented end-to-end in
[`samples/foundry-w365a-runner`](../samples/foundry-w365a-runner). It watches the
orchestrator handoff (captures the CCaaS outcome from `in/prefill.json`), checks out a
Windows 365 for Agents Cloud PC session, runs the Foundry **responses** Computer Use
loop to drive `claims.exe`, then writes `out/ready.json` + `out/result.json` back for the
orchestrator to relay — no changes to the CCaaS desktop or orchestrator (identical JSON
contract). It ships a default offline **simulation** mode (`RUNNER_MODE=simulation`) and a
gated **live** mode. Select this backend at build time with
`Build-DemoFromScratch.ps1 -AgentBackend foundry` (or `both` to keep the Copilot Studio
path too and switch between them with the desktop's backend toggle). See the package
README for `.env` keys and the run command.
