# 2. Tenant, Intune, and Cloud PC pools

> **Reference page.** The guided setup in the [install guide](README.md) does this page's work for you (steps 5-8, 18 and 19 there). Use this page to understand a step, to troubleshoot, or to install by hand.

## 2.1 Create or choose the Power Platform environment

Manual portal step.

1. Open the Power Platform admin center.
2. Create or choose an environment that has a Dataverse database.
3. Keep the environment in the geography where you want the MCS Cloud PC pool to run. Copilot Studio Cloud PC pools are hosted in the same geography as the Power Platform environment.
4. Enable Copilot Studio Computer Use for the environment.
5. If you keep the reference configuration's Anthropic models, have an administrator allow
   external models first: in the Microsoft 365 admin center, then for this environment in the
   Power Platform admin center (page 0, section 0.2).

Microsoft Dataverse reference: <https://learn.microsoft.com/en-us/power-platform/admin/create-database>

## 2.2 Prepare tenant prerequisites for Copilot Studio Cloud PC pools

Install the local PowerShell modules first (page 0, "Local tools"). If one is missing, the
script installs it for the current user even in a `-WhatIf` preview, because without it the
preview cannot sign in; that is a change to this computer only, never to the tenant.

The script parameters were checked with `Get-Command .\scripts\Enable-W365aPrereqs.ps1`. It supports `-TenantId`, `-CreateDynamicGroup`, `-DeviceCode`, and `-WhatIf`.

Preview first. It signs in to `<tenant-id>` as the administrator, reads the current settings and
lists what it would change, ending with "Preview only: nothing in the tenant was changed":

```powershell
pwsh -File .\scripts\Enable-W365aPrereqs.ps1 -TenantId <tenant-id> -CreateDynamicGroup -WhatIf
```

When the tenant owner approves the changes, run without `-WhatIf`:

```powershell
pwsh -File .\scripts\Enable-W365aPrereqs.ps1 -TenantId <tenant-id> -CreateDynamicGroup
```

This turns on Microsoft Entra authentication for RDP, creates the dynamic device group for
`CPCPool_` devices and hides the remote desktop consent prompt for it, as described in the
Copilot Studio Cloud PC pool documentation. It does **not** set the Intune enrolment
restriction: make sure Windows (MDM) corporate enrolment is allowed yourself (page 0, section
0.2). The dynamic group needs Microsoft Entra ID P1.

## 2.3 Claims app package (nothing to build)

The supported delivery is an Intune Win32 app. The built package is committed at:

```text
deploy\intune-packages\ZavaClaims.intunewin
```

A normal install uses this file and needs no compiler. Only if you changed the Win32 app's
source, rebuild it on a machine that also has MinGW `gcc` and `windres` on `PATH` (used by
`apps\legacy-claims-workstation\build.bat`):

```powershell
pwsh -File .\scripts\Build-IntunePackages.ps1 -CreateIntuneWin
Copy-Item .\out\intune\packages\ZavaClaims.intunewin .\deploy\intune-packages\ -Force
```

## 2.4 Upload the Claims app and assign it to the MCS pool devices

This uses the committed package (the script's default `-PackageRoot` is
`deploy\intune-packages`; do not pass `-BuildPackages`). It assigns the app as **Required** to
the dynamic group **Zava W365A Cloud PC Pools** created in step 2.2, which contains every
Copilot Studio hosted pool Cloud PC (`CPCPool_` enrolment profile). Use exactly that name: the
script reuses an existing group of that name, and the same name is `agentPool.deviceGroupName` in
`scripts\demo-config.sample.json`. It also creates the presenter user group; the Zava desktop
icon for presenters is added in step 3.6, once the Zava site exists.

Preview:

```powershell
pwsh -File .\scripts\Deploy-DemoEnvironment.ps1 `
  -TenantId <tenant-id> `
  -DeviceGroupName "Zava W365A Cloud PC Pools" `
  -UserGroupName "Zava-Demo-Agent-Users" `
  -WhatIf
```

Apply after review:

```powershell
pwsh -File .\scripts\Deploy-DemoEnvironment.ps1 `
  -TenantId <tenant-id> `
  -DeviceGroupName "Zava W365A Cloud PC Pools" `
  -UserGroupName "Zava-Demo-Agent-Users"
```

Microsoft Intune installs Win32 apps through the Intune Management Extension and supports detection rules, requirements, and required assignments.

Then add the agent launch icon to the same MCS group. It is a separate small app, **Zava Claims
Agent Launch Shortcut**: it copies one Public Desktop icon, "Zava Claims Agent Launch", which
starts Claims with the agent's launch options so Computer Use can double-click it (see
[the MCS instructions](../mcs-computer-use-instructions.md)). It does not change the Claims app or
its normal shortcuts, and it is not given to the Foundry pool. Run it **after** the Claims app
above exists: the script stops if it cannot find exactly one Intune app named **Zava Claims
Workstation** (change with `-ClaimsAppDisplayName`), makes the shortcut app depend on it so
Intune installs Claims first, and the shortcut's detection also requires `claims.exe`, so it
never reports installed before Claims is. The script uses the current Azure CLI sign-in with
`-UseAzureCliToken`, or an existing `Connect-MSIntuneGraph` session:

```powershell
az login --tenant <tenant-id>
az account show --query tenantId -o tsv   # must print <tenant-id>
pwsh -File .\scripts\Deploy-McsAgentShortcut.ps1 -TenantId <tenant-id> -UseAzureCliToken -WhatIf
pwsh -File .\scripts\Deploy-McsAgentShortcut.ps1 -TenantId <tenant-id> -UseAzureCliToken
```

`-TenantId` is required. The script asks the Azure CLI for a token for that tenant and stops
before reading or changing anything in Intune if the sign-in belongs to another tenant. The
Azure CLI sign-in needs Intune Administrator (it uses `DeviceManagementApps.ReadWrite.All` and
`Group.Read.All`).

An existing shortcut app is not re-uploaded: it keeps the detection it was created with, and a
rerun only adds the missing Claims dependency or assignment. To check it read-only, run the
`-WhatIf` line: it prints `Already depends on 'Zava Claims Workstation'.` and
`Already assigned to ...` when nothing is missing.

## 2.5 MCS Cloud PC pool

The MCS pool is created from the Copilot Studio agent's Computer Use tool, so it is a step on
the MCS page, after the agent exists: [4.3](05-mcs-path.md#43-build-and-publish-the-copilot-studio-agent).
Its Cloud PCs join the step 2.2 group automatically and receive the Claims app.
## 2.6 Create the Foundry Cloud PC agent pool

Manual portal step in Intune.

Do this after the Foundry agent exists (page 6, step 5.7), because the pool is assigned to the agent.

1. Create the Foundry pool's device group and give it the Claims app. A Windows 365 for Agents
   pool adds its Cloud PCs to an **assigned** group you select, so it cannot use the dynamic MCS
   group. This command creates the assigned group **Zava W365A Foundry Claims Devices** (empty
   until the pool fills it; the warning about that is expected) and assigns the same committed
   Claims app to it as Required:

   ```powershell
   pwsh -File .\scripts\Deploy-DemoEnvironment.ps1 `
     -TenantId <tenant-id> `
     -DeviceGroupName "Zava W365A Foundry Claims Devices" `
     -UserGroupName "Zava-Demo-Agent-Users"
   ```

   Run it with `-WhatIf` first. The reference tenant uses the same design with its own names
   (group `W365A-Foundry-Claims-Devices`, app `Zava Claims Workstation - Foundry Demo`).
2. In the Intune admin center, go to **Devices > Provision Cloud PCs > Provisioning policies (Agents) > Create policy**.
3. Choose the Windows 365 for Agents billing plan, Cloud PC count and geography. On the **Agents** page, select **Add Agents** and choose the Foundry Claims hosted agent. Choose the image. Under **Device grouping and preparation**, select **Zava W365A Foundry Claims Devices** from item 1.
4. For a one-PC demo pool, remember that the Cloud PC resets after each run. The reference one-PC pool took 15-17 minutes to become free again.
5. Record the pool ID for the worksheet (and, if you use it, the optional Foundry demo prep config).

These Cloud PCs use the Windows 365 for Agents pool model **Cloud PC for Agents** (`cloudPcAgentPool`).

Microsoft reference: <https://learn.microsoft.com/en-us/windows-365/agents/cloud-pc-agent-pools>

## 2.7 Optional: skip ESP account setup for Foundry-type agent pools

Use this only with owner approval. It changes the Windows first-sign-in experience for the selected Windows 365 for Agents pool.

The script parameters were checked with `Get-Command .\scripts\Set-AgentPoolEspSkip.ps1`. It supports `-TenantId`, `-PoolName`, `-Apply`, `-Remove`, `-ReceiptPath`, and `-UseDeviceCode`. It does **not** have `-WhatIf`.

Plan mode is the default. Run this first:

```powershell
pwsh -File .\scripts\Set-AgentPoolEspSkip.ps1 -TenantId <tenant-id> -PoolName "<pool display name>"
```

Apply only after the plan proves the Intune filter targets only the intended pool:

```powershell
pwsh -File .\scripts\Set-AgentPoolEspSkip.ps1 -TenantId <tenant-id> -PoolName "<pool display name>" -Apply
```

Important limits:

- This script only supports Windows 365 for Agents pools whose device model is **Cloud PC for Agents**. That is the Foundry-type `cloudPcAgentPool` path.
- It does **not** cover Copilot Studio hosted Cloud PC pools whose device model begins **Copilot Studio Hosted Agent Machine ...** and whose provisioning policy name begins `CPCPool_`.
- For Copilot Studio hosted pools, do not use this script as proof of safe ESP targeting. Use Intune policy review and Microsoft guidance for that specific hosted-pool device model.

Why this exists: Windows 365 supports ESP for Cloud PCs, but Cloud PCs use userless enrolment and custom ESP targeting must use an `enrollmentProfileName` filter. Dynamic group targeting for ESP is not supported for this scenario.
