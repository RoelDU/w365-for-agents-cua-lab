# Deploy to Windows 365 with Intune

This guide describes the Intune and Windows 365 targeting portion of the current
Zava CCaaS / Computer-Use demo architecture.

The CCaaS desktop is **not** a Win32 app. It is hosted centrally on Azure Static
Web Apps and delivered to the Cloud PC as a **Microsoft Edge force-installed web
app (PWA)** via an Intune Settings Catalog policy, which produces a real desktop
icon. (A plain Intune managed web link was tried first but **cannot install on
Windows** - it produces no desktop icon and its install status errors out - so it
was removed; see issue #60.)

| Intune catalog item | Type | Purpose |
|---|---|---|
| Zava Contact Center | Edge web app via Settings Catalog policy (`WebAppInstallForceList`) | Force-installs the Static Web App URL as an Edge PWA (desktop + Start icon) for the human contact-center agent. |
| Zava Claims Workstation | Win32 app (`ZavaClaims.intunewin`) | Installs the legacy claims workstation that the **Copilot Studio Computer-Use agent** drives on screen. |

There is no `CCaaSAgentDesktop.intunewin` package and no CCaaS desktop MSI/exe in
the current deployment.

---

## Scope

The scripts do **not** provision or deprovision Cloud PCs, assign Windows 365
licenses, or create Windows 365 provisioning policies. They only create/update
Intune app catalog entries and Entra groups so an existing Cloud PC or user
receives the demo apps.

The demo always targets two machines (both exist in a normal run); each app has a
fixed, app-specific assignment - there is no "choose one" model:

| Machine | App delivered | Targeting model | Membership to add |
|---|---|---|---|
| Agent pool (W365A) | Legacy claims Win32 app | Agent-pool DEVICE group (`agentPool.deviceGroupName`) | Pool Cloud PC device object(s). |
| Human workstation | CCaaS Edge web app (PWA) | Workstation USER group (`agentWorkstation.userGroupName`) | Human agent user account(s). |

All names and memberships come from `scripts\demo-config.local.json` when using
the from-scratch script.

---

## Choosing the agent-pool device group

The legacy claims Win32 app is assigned to one Entra **device** group named by
`agentPool.deviceGroupName`. There are two ways to populate that group; pick one
before doing final Intune config.

| Option | When to use | What to set |
|---|---|---|
| **Dynamic `CPCPool_*` group (recommended for W365A pools)** | The Cloud PCs live in a Windows 365 for Agents pool, so their device names are assigned by the maker portal and aren't known in advance. | Run `scripts\Enable-W365aPrereqs.ps1 -CreateDynamicGroup` (see [`docs/w365a-pool.md`](w365a-pool.md)). Set `agentPool.deviceGroupName` to that group's name (default `Zava W365A Cloud PC Pools`) and leave `agentPool.pilotCloudPcName` **empty**. Membership rule `device.enrollmentProfileName -startsWith "CPCPool_"` captures every pool Cloud PC automatically (5-10 min to populate). |
| **Assigned group with explicit names** | You already know the exact Cloud PC device display names and want a fixed, hand-managed membership. | Keep the default `agentPool.deviceGroupName` (`Zava-Demo-Agent-CPCs`) and list the Cloud PC device display names in `agentPool.pilotCloudPcName`, or add them in the portal later. |

The from-scratch build script handles both: if `agentPool.deviceGroupName` already
exists as a **dynamic** group it reuses it as-is and ignores `pilotCloudPcName`
(the rule owns membership); otherwise it creates an **assigned** group and adds any
`pilotCloudPcName` entries. Dynamic groups require an **Entra ID P1** (or Intune for
Education) license.

> Whichever option you choose, the assignment uses the same top-level
> `agentPool.deviceGroupName` config key. (Earlier drafts referred to a
> `handoffOrchestrator.agentPool.deviceGroupName` path — that key does not exist.)

---

## Recommended path: from-scratch script

Use the central build script unless you are intentionally doing a manual Intune
walkthrough:

```powershell
Copy-Item .\scripts\demo-config.sample.json .\scripts\demo-config.local.json
notepad .\scripts\demo-config.local.json

pwsh -File .\scripts\Build-DemoFromScratch.ps1 -DeviceCode
```

During its Intune phase, the script:

1. Creates the `agentPool` DEVICE group and the `agentWorkstation` USER group.
2. Adds configured seed pool Cloud PC device names (`agentPool.pilotCloudPcName`)
   and human agent UPNs (`agentWorkstation.agentUserName`).
3. Uploads the legacy Win32 app package, `ZavaClaims.intunewin`, and assigns it
   **only** to the agent-pool DEVICE group.
4. Creates or updates the **Zava Contact Center** Edge web-app (PWA) configuration
   policy with the deployed Static Web App URL.
5. Assigns the Edge web-app policy **only** to the workstation USER group (so the
   desktop icon follows the human agent).

The Static Web App URL is produced by the SWA deployment phase and passed through
to the Edge web-app phase automatically. If you front the SWA with a custom domain,
set the override in `agentWorkstation.webLink.url` in the config.

---

## Manual Intune equivalent

### 1. Create the two assignment targets

The demo targets two machines independently:

- **Agent pool (claims app):** the Entra **device** security group named by
  `agentPool.deviceGroupName`. Either use the dynamic `CPCPool_*` group (recommended)
  or an assigned group with explicit Cloud PC device names — see
  [Choosing the agent-pool device group](#choosing-the-agent-pool-device-group)
  above. For an assigned group, each device's display name is its Cloud PC name.
- **Human workstation (CCaaS desktop):** an assigned Entra **user** security group
  (`agentWorkstation.userGroupName`). Add the human agent user accounts who should
  receive the CCaaS Edge web-app (desktop icon) when they sign into their Cloud PC.

### 2. Legacy claims app delivery — Intune Win32 (required)

> [!IMPORTANT]
> **Deliver `claims.exe` to the Copilot Studio agent pool with an Intune Win32 app.**
> Copilot Studio Cloud PC pools are **Entra-joined and Intune-enrolled** per Microsoft GA
> documentation, so Intune **required-app** delivery is the correct standing path.
>
> `claims.exe` is deployed to the pool device group as a **required Win32 app**, which
> means it is already installed before the Computer Use session starts. The agent simply
> launches the pre-installed app — no self-provisioning, SWA binary hosting, or runtime
> download is needed. See [`docs/w365a-pool.md`](w365a-pool.md#getting-claimsexe-onto-the-pool).

> [!WARNING]
> **Do NOT let this app gate the Enrollment Status Page (ESP) on the agent pool.**
> These pool Cloud PCs are ephemeral and auto-scaled; a freshly provisioned device may not
> be in the `CPCPool_*` dynamic device group yet (membership lags 5–10 min, up to 24h), and
> IME may not finish a Win32 install during the OOBE "Account setup" window. If the default
> ESP ("All users and all devices", `showInstallationProgress=true`) blocks on this required
> app, OOBE hangs/errors at "Account setup" and the device reaches the desktop without the
> app (see #82 / #132). Configure a **targeted ESP for the `CPCPool_*` group that does not
> block on app install** (or omit this app from the blocking set), so the app installs in the
> background post-provision, and use **always-available (warm) Cloud PCs** so it installs once
> and persists across runs. The binary delivery stays Intune Win32 (D20) — only the ESP gating
> changes.

<details>
<summary>Win32 packaging settings (standing demo path)</summary>

Create **Apps > Windows > Add > Windows app (Win32)** for the legacy app:

| Setting | Value |
|---|---|
| App package file | `ZavaClaims.intunewin` (setup file: `claims.exe`) |
| Name | Zava Claims Workstation |
| Publisher | Zava Mutual (Demo) |
| Install command | `claims.exe --install` |
| Uninstall command | `"%ProgramFiles%\Business Applications\Zava Claims Workstation\claims.exe" --uninstall` |
| Install behavior | System |
| Run script as 32-bit process on 64-bit clients | No |
| Device restart behavior | No specific action |
| Detection rule | Custom script: `Detect.ps1` (registry `…\Uninstall\ZavaClaimsWorkstation` + binary) |

> **Why a compiled `claims.exe --install` and not a PowerShell script?** On the
> locked-down agent Cloud PCs, an Intune install command of
> `powershell.exe -File Install.ps1` failed with `0x80070001` (the proven-working
> "WVD Production Line Monitor" app on Flex pools uses a compiled `Setup.exe /S`
> installer, not PowerShell). `claims.exe` now self-installs natively (copies to
> `%ProgramFiles%\Business Applications\Zava Claims Workstation\`, registers
> Add/Remove Programs, creates all-users shortcuts) with no PowerShell at install
> time. The `Install.ps1` script is retained only for manual/dev use.

Verify the target Cloud PCs are in the agent-pool device group and are enrolled in Intune.
A required assignment to that device group is the intended standing demo configuration.

</details>

### 3. Create the CCaaS desktop as an Edge force-installed web app (PWA)

The CCaaS desktop is delivered with a Microsoft Edge **Settings Catalog** policy,
not a managed web link. A managed web link (`#microsoft.graph.webApp`) **cannot be
installed on Windows** - it only appears as a Company Portal tile, never creates a
desktop icon, and its install status errors/stays 0 regardless of Available vs
Required - so it is not used (see issue #60). The Edge web-app policy force-installs
the centrally-hosted SWA as a PWA with a real **desktop + Start icon**, with no
Win32 packaging.

Create a configuration profile: **Devices > Configuration > New policy > Windows 10
and later > Settings catalog**, then add the setting **Microsoft Edge > Configure
list of force-installed Web Apps** (`WebAppInstallForceList`), set it to **Enabled**,
and provide this value (one entry):

```json
[
  {
    "url": "https://<your-static-web-app-host>",
    "create_desktop_shortcut": true,
    "default_launch_container": "window"
  }
]
```

Assign the profile to the workstation **user** group
(`agentWorkstation.userGroupName`) so the desktop icon follows the human agent onto
whichever Cloud PC they sign into. Edge force-installs the SWA URL as a web app,
pins it to Start, and (with `create_desktop_shortcut`) drops a **desktop icon** -
while the application stays hosted centrally on Azure Static Web Apps.

`Deploy-DemoEnvironment.ps1` (`-Phase WebLink` / `All`) creates and assigns this
policy automatically via Graph (`deviceManagement/configurationPolicies`); the
Settings Catalog definition IDs it uses are
`...microsoft_edge_webappinstallforcelist` (parent, Enabled) and its
`..._webappinstallforcelist` string-list child. Do not reintroduce a
`CCaaSAgentDesktop.intunewin` package for this scenario.

---

## Verification

On an onboarded Cloud PC or Flex/Shared user session:

1. Confirm `claims.exe` is **installed via Intune** on the agent Cloud PC at
   `%ProgramFiles%\Business Applications\Zava Claims Workstation\claims.exe` (registered in
   Add/Remove Programs), and that the Computer Use agent simply launches
   the pre-installed app when the session starts. This is the standing demo path for the
   pool. See
   [`docs/w365a-pool.md`](w365a-pool.md#getting-claimsexe-onto-the-pool).
2. Confirm the **Zava Contact Center** desktop icon is present on the Cloud PC and
   opens the Static Web App URL in an Edge app window. (Edge installs it shortly
   after the user signs in and the policy applies; check the Edge profile's status
   in Intune if it is missing.)
3. Start a call in the CCaaS desktop and transfer to the AI agent.
4. Confirm the status card moves through the run lifecycle
   (handoff -> running -> done).

The CCaaS -> agent handoff is sent to the configured agent backend (the Copilot
Studio Direct Line bot, or the Foundry local-orchestrator's `POST /handoff`); it
does **not** use a Static Web App `/api` endpoint. The agent -> legacy-app handoff
is driven by on-screen Computer Use against `claims.exe` on the Cloud PC.
