# Demo environment setup - Central SWA /api -> Foundry CUA -> Windows 365 -> Legacy Claims

> ⚠️ **DEPRECATED VARIANT.** This runbook describes the **original** Azure AI Foundry +
> SWA `/api` handoff, where `apps/ccaas-agent-desktop/api` started a Foundry run and the
> desktop tracked `thread_id`/`run_id`. That `/api` flow is **deprecated** and kept for
> reference only.
>
> **Do not confuse this with the current Foundry backend.** The repo now supports two
> first-class, selectable backends behind the **same `handoff_id` contract**
> (`Build-DemoFromScratch.ps1 -AgentBackend mcs|foundry|both`):
> - **`mcs`** — Microsoft Copilot Studio over Direct Line via the standalone handoff
>   orchestrator (`apps/handoff-orchestrator`). Follow
>   **[`handoff-runbook.md`](handoff-runbook.md)**.
> - **`foundry`** — Azure AI Foundry + Windows 365 for Agents via
>   **[`samples/foundry-w365a-runner`](../samples/foundry-w365a-runner)** (NOT the SWA `/api`
>   below). Follow **[`agent-cua-setup.md`](agent-cua-setup.md)**.
>
> The infra portions below — SWA host, Entra groups, legacy-app/Edge-web-app assignment —
> still apply to both. Backend selection:
> [`config-reference.md`](config-reference.md#agentbackend--choose-the-ai-backend-optional-defaults-to-mcs).

This runbook stands up the Zava CCaaS / Computer-Use demo with the **deprecated**
centralized architecture:

1. The **CCaaS Agent Desktop** is hosted centrally on **Azure Static Web Apps**
   (Free tier).
2. The same Static Web App hosts the `/api` handoff endpoint through SWA managed
   Azure Functions.
3. The `/api` endpoint starts an **Azure AI Foundry Computer-Use agent** run.
4. The agent connects to an existing Windows 365 Cloud PC and drives the
   **Zava Claims Workstation** on screen.

There are two seams:

| Seam | Mechanism |
|---|---|
| CCaaS desktop -> AI agent | JSON `POST` to the SWA-hosted `/api/handoff` endpoint. This is the interim, realistic stand-in for a Genesys / Five9 / NICE transfer webhook. |
| AI agent -> legacy app | **On-screen Computer Use only.** The agent clicks and types in the legacy Win32 app; it never hands the legacy app a file. |

The old `samples/local-orchestrator` path is now optional / legacy local testing.
The source of truth for the current handoff API is
`apps\ccaas-agent-desktop\api\` (especially `api\README.md` and
`api\src\foundry.js`).

---

## What the scripts do and do not do

The one from-scratch entry point is:

```powershell
pwsh -File .\scripts\Build-DemoFromScratch.ps1
```

It reads exactly one local config file:

```powershell
Copy-Item .\scripts\demo-config.sample.json .\scripts\demo-config.local.json
# Edit demo-config.local.json with your tenant, subscription, regions, Foundry,
# app-registration, Intune group, and seed Cloud PC/user values.
```

`demo-config.local.json` is git-ignored and must not be committed.

The build script runs these phases, in order:

1. Validate config and prerequisites (`az`, `node`, `npm`, `pwsh`).
2. Sign the Azure CLI into the configured tenant and subscription.
3. Create or update the Foundry Computer-Use agent and capture its agent id.
4. Create/update the Free Static Web App, build/deploy the CCaaS app plus `/api`,
   and set the `/api` app settings.
5. Create the Entra targeting group(s), add the seed device/user memberships,
   deploy the legacy claims Win32 app, and publish the CCaaS app as an Edge
   force-installed web app (PWA) that puts a desktop icon opening the SWA URL.

The scripts **do not** provision or deprovision Cloud PCs, assign Windows 365
licenses, or create Windows 365 provisioning policies. Onboarding means adding an
existing Cloud PC device or agent user to the configured Entra group.

---

## Configuration and regions

The scripts are config-driven. They do not hardcode subscription id, tenant id,
admin UPN, Azure region, Cloud PC name, Static Web App name, or group names.

Important region split:

- `azure.location` is the workload/resource-group region and may be a region such
  as `australiaeast` for the Foundry workload.
- `staticWebApp.location` must be an Azure Static Web Apps supported region.

At the time of writing, the script accepts these SWA regions:

```text
westus2, centralus, eastus2, westeurope, eastasia
```

Azure Static Web Apps is **not** available in `australiaeast`; the nearest
supported SWA region for Australia East is `eastasia`. The build script validates
this early and prints the supported list plus the nearest match when an
unsupported SWA region is chosen. Static content is served from the SWA global
edge network; the SWA region controls where the managed Functions run.

---

## Prerequisites

1. An Azure subscription and tenant where you can create the configured resources.
2. A Foundry project with access to the `computer-use-preview` model. The access
   request is still a one-time human gate: <https://aka.ms/oai/cuaaccess>.
3. The automation app registration created by the bootstrap script and granted
   access to the Foundry project (for the SWA `/api` client-credentials call).
4. The two demo machines to target (both are used in a normal run):
   - The W365A agent-pool Cloud PC(s) -> the **device** group (`agentPool`).
   - The human agent user account(s) -> the **user** group (`agentWorkstation`).
5. Tooling on the machine running the script: Azure CLI, Node.js/npm, and
   PowerShell 7 (`pwsh`).

---

## Run from scratch

```powershell
# 1. Create the local config once.
Copy-Item .\scripts\demo-config.sample.json .\scripts\demo-config.local.json
notepad .\scripts\demo-config.local.json

# 2. Run the one-time app-registration bootstrap as needed.
pwsh -File .\scripts\Bootstrap-DemoServicePrincipal.ps1 -TenantId <tenant-id>

# 3. Build/deploy everything from the config.
pwsh -File .\scripts\Build-DemoFromScratch.ps1 -DeviceCode
```

Use `-WhatIf` to preview and the skip switches (`-SkipAgent`,
`-SkipStaticWebApp`, `-SkipIntune`) for reruns of a subset.

After a successful run, the CCaaS desktop URL is the Static Web App URL. The
Intune app catalog contains:

| App | Type | Purpose |
|---|---|---|
| Zava Contact Center | Intune Edge web-app (PWA) policy (`WebAppInstallForceList`) | Force-installs the centrally hosted SWA app as an Edge web app with a desktop icon. A plain managed web link was removed because it cannot install on Windows - see `docs/intune-w365.md` and issue #60. |
| Zava Claims Workstation | Win32 app (`ZavaClaims.intunewin`) | Legacy claims workstation driven by Computer Use. |

There is no `CCaaSAgentDesktop.intunewin` package in the current architecture.

---

## Two-machine targeting

The demo uses two separate Cloud PCs, each targeted independently (Cloud PC
lifecycle itself is out of scope - the scripts only create/update assignment
targets and add memberships from the config):

| Machine | Config block | App delivered | Group model | What to add |
|---|---|---|---|---|
| Agent pool (W365A) | `agentPool` | Legacy claims Win32 app | DEVICE group (`agentPool.deviceGroupName`) | Pool Cloud PC device object(s) by display name (`agentPool.pilotCloudPcName`). |
| Human workstation | `agentWorkstation` | CCaaS Edge web-app (PWA) policy | USER group (`agentWorkstation.userGroupName`) | Agent user account(s) by UPN (`agentWorkstation.agentUserName`). |

The claims app is assigned ONLY to the agent-pool device group; the CCaaS Edge
web-app policy is assigned ONLY to the workstation user group. Adding another
machine later is the same operation: add the device or user to the configured
group. No Cloud PC is created or deleted by these scripts.

---

## Demo-day checklist

- Static Web App is reachable and the CCaaS desktop icon (Edge web app) opens it.
- SWA `/api` settings are present: Foundry endpoint, agent id, API version,
  token audience, tenant id, client id, and client secret.
- The Foundry agent exists and has Computer Use configured.
- The Windows 365 / Computer Use connection is refreshed before the demo.
- The target Cloud PC has the Zava Claims Workstation Win32 app installed.
- The legacy app data is reset for the hero scenario.

The human agent launches **Zava Contact Center** from the desktop icon (Edge web
app),
starts a simulated inbound call, and transfers to the AI agent. The desktop posts
the `CallContext` JSON to `/api/handoff`; the status card polls the returned
`status_url` until the Foundry run completes and the claim id is parsed from the
agent's final message.

---

## Optional local testing path

`samples\local-orchestrator` can still be useful for legacy or offline local
smoke tests, but it is no longer the recommended deployment path. Do not describe
it as required for the demo. For current API behavior and settings, read:

- `apps\ccaas-agent-desktop\api\README.md`
- `apps\ccaas-agent-desktop\api\src\foundry.js`

---

## Teardown

Teardown is preview-by-default:

```powershell
pwsh -File .\scripts\Remove-DemoEnvironment.ps1 -TenantId <tenant-id>
```

Add `-Execute` to apply deletions. The teardown has a `StaticWebApp` phase for
the central host:

```powershell
pwsh -File .\scripts\Remove-DemoEnvironment.ps1 `
  -TenantId <tenant-id> `
  -Phase StaticWebApp `
  -Execute
```

Add `-RemoveResourceGroup` only if the configured resource group contains no
other resources you need.

---

## Key contract facts

- `CallContext` is the CCaaS -> agent handoff payload.
- The primary endpoint is `POST /api/handoff` on the Static Web App.
- `POST /api/handoff` starts a Foundry thread/run and returns `thread_id`,
  `run_id`, and `status_url`.
- `GET /api/handoff/{requestId}/status?thread_id=&run_id=` polls the Foundry run
  and maps it to the desktop status payload.
- The legacy application integration is on-screen Computer Use only. Do not
  document a file as the agent -> legacy-app handoff.

See also `docs\demo-flow.md`, `docs\intune-w365.md`, and
`apps\ccaas-agent-desktop\api\README.md`.
