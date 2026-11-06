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

Manual portal step in Intune. **Use Windows Autopilot Device Preparation (Automatic) for
this app-dependent Foundry path.** Microsoft supports both device-group linking and Device
Preparation (currently **public preview**), but explicitly recommends Device Preparation when
"Agents require specific applications when using Cloud PCs." Claims is such an application:
the lab delivers it through Intune rather than baking it into an image.

Device Preparation still uses an assigned device group; the difference is that the provisioning
policy links the **preparation policy**, not just the group. With installation failure/time-out
blocking left on, required selected apps install during provisioning **before agent checkout**.
An app's Required assignment to a group alone does not provide that validation.

Do this after the Foundry agent exists (page 6, step 5.7), because the pool is assigned to the agent.

1. Follow the [Automatic preparation tutorial's prerequisites and automatic Intune enrollment
   step](https://learn.microsoft.com/en-us/autopilot/device-preparation/tutorial/automatic/automatic-workflow).
   Create a dedicated **Security / Assigned** device group for the preparation policy and give
   it the Claims app. This command creates **Zava W365A Foundry Claims Devices** (empty until
   preparation adds the Cloud PCs; the warning about that is expected) and assigns the same
   committed Claims app to it as **Required**:

   ```powershell
   pwsh -File .\scripts\Deploy-DemoEnvironment.ps1 `
     -TenantId <tenant-id> `
     -DeviceGroupName "Zava W365A Foundry Claims Devices" `
     -UserGroupName "Zava-Demo-Agent-Users"
   ```

   Run it with `-WhatIf` first. If that group already serves another Autopilot scenario, use a
   separate dedicated group and pass its name as `-DeviceGroupName`. Do not reuse the MCS
   dynamic group. Match the exact Claims app ID in your tenant, not just its display name.
2. In the group's **Owners**, add **Intune Provisioning Client**, AppId
   `f1346770-5b25-470b-88bd-d5744ab7952c`. Some tenants call it **Intune Autopilot
   ConfidentialClient**; match the AppId. If it is absent, an authorized administrator must
   follow Microsoft's [group setup instructions](https://learn.microsoft.com/en-us/autopilot/device-preparation/tutorial/automatic/automatic-device-group).
   The package script does not add this owner or create the preparation policy.
3. Go to **Devices > Windows > Enrollment > Device preparation policies > Create > Automatic**.
   Name the policy, select the dedicated group, and under **Configuration settings > Apps**
   explicitly add the **Zava Claims Workstation** Win32 app assigned above. Verify that app
   installs in **System** context, is Required for that group, and uses the committed package's
   detection rule. The app must be both **assigned to the group and selected in the policy**.
   The lab needs no additional preparation scripts. Save the policy. See Microsoft's
   [Automatic policy instructions](https://learn.microsoft.com/en-us/autopilot/device-preparation/tutorial/automatic/automatic-autopilot-policy).
4. Go to **Devices > Provision Cloud PCs > Provisioning policies (Agents) > Create policy**.
   Choose the Windows 365 for Agents billing plan, Cloud PC count and geography. On **Agents**,
   select **Add Agents** and choose the Foundry Claims hosted agent. Choose the image.
5. On **Configuration > Device grouping and preparation**, choose **Link Autopilot device
   preparation policy** and select the Automatic policy from item 3, not the group-only option.
   Set **Minutes allowed before device preparation fails** to allow enough time for Claims
   installation. Keep **Prevent connection to Cloud PC upon installation failure or time-out**
   **selected** (the default). Clearing it permits agent checkout after failed preparation and
   defeats this readiness protection.
6. Create the policy and wait for preparation to succeed. Check **Devices > Enrollment >
   Monitor > Windows Autopilot device preparation deployment status**, including successful
   installation of the selected Claims app. Before enabling transfers, complete
   [verification section 7.1](08-verify.md#71-intune-delivery). The guided installer reads agent
   membership, but **does not read preparation configuration or app deployment results**: it
   asks you to verify these in Intune each run and reports that evidence as manually confirmed.
7. Record the pool ID for the worksheet and optional Foundry demo prep config. For a one-PC demo
   pool, remember that the Cloud PC resets after each run; the reference group-only pool took
   15-17 minutes to become free again. Preparation can change that timing.

### Existing Foundry pools: an owner-controlled migration

Changing the linked group, linked preparation policy, or switching between them requires
**reprovisioning the pool**; editing the setting is not enough. First record the current policy,
group/app IDs, assignments and affected Cloud PCs; confirm there are no active sessions and
obtain the owner's approval for downtime and data loss. Reprovision deletes and recreates
**all Cloud PCs in that pool**. The installer never performs this operation.

Prepare the dedicated group/app assignment and Automatic policy above, update the existing
pool's **Configuration**, then use the owner-approved **Reprovision** action. Wait for successful
preparation and app installation before resuming transfers. If migrating an older lab, its old
agent-membership confirmation is not preparation evidence. To roll back, restore the recorded
configuration and reprovision again as required; reverting a policy cannot restore deleted
Cloud PCs or their data. See [Microsoft's edit/reprovision guidance](https://learn.microsoft.com/en-us/windows-365/agents/edit-provisioning-policy-agents).

### Supported alternative: link only a device group

Microsoft also supports the group-only option and recommends it when fastest provisioning is
the priority and validation of installed apps before access is not required, for example when
using an appropriately prepared custom image. It is **not the guided default for this
Intune-installed Claims app** and is not equivalent to Device Preparation.

For that alternative, the linked group must be **Security / Assigned** with **Windows 365**
(AppId `0af06dc6-e4b5-4f28-818e-e78e62d137a5`) as an owner. Assign Claims as Required and link
the group under **Configuration > Device grouping and preparation**. App installation can
complete after checkout; independently establish app readiness before transfers and accept
that a run can otherwise fail. The runtime screen/setup checks do not prove installation.
The guided installer deliberately requires the recommended preparation path's confirmation.

These Cloud PCs use the Windows 365 for Agents pool model **Cloud PC for Agents** (`cloudPcAgentPool`).

Microsoft sources for **support and scenario recommendation**:
[Device grouping and preparation](https://learn.microsoft.com/en-us/windows-365/agents/device-grouping-preparation)
and [Create a provisioning policy (agents)](https://learn.microsoft.com/en-us/windows-365/agents/create-provisioning-policy-agents).
The latter distinguishes partner-managed pools such as **Copilot Studio computer use**.
This Foundry procedure does not change or establish support for changing MCS pool preparation;
keep the MCS steps above unchanged.

## 2.7 Optional: skip ESP account setup for Foundry-type agent pools

Use this only with owner approval. It changes the Windows first-sign-in experience for the selected Windows 365 for Agents pool.
**This is not Device Preparation and is not an app-readiness fix.** Do not use an ESP account
setup skip instead of section 2.6, or disable preparation's installation failure/time-out
connection block. Keep successful provisioning-time Claims installation as the readiness
requirement; an ESP skip and an available session do not establish it.

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
