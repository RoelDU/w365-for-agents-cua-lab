# Intune and Windows 365 notes

The ordered install guide covers the normal path: [`install\03-tenant-and-cloud-pcs.md`](install/03-tenant-and-cloud-pcs.md).

## What Intune delivers

| Target | Delivery method | Purpose |
| --- | --- | --- |
| MCS Cloud PC pool devices | Required Win32 app | Installs `ZavaClaims.intunewin` so Copilot Studio Computer Use can launch the Claims app. |
| MCS Cloud PC pool devices | Required Win32 app | `ZavaClaimsAgentShortcut.intunewin` (app "Zava Claims Agent Launch Shortcut") adds the "Zava Claims Agent Launch" Public Desktop icon with the agent launch options. Installed with `cmd.exe /c copy`, removed with `cmd.exe /c del`; deploy with `scripts\Deploy-McsAgentShortcut.ps1`. |
| Foundry Cloud PC pool devices | Required Win32 app | Installs the same Claims app for the hosted Foundry agent. |
| Human presenter users | Edge force-installed web app policy | Gives the presenter a Zava Contact Center desktop/start-menu app that opens the Static Web App. |

The Claims package is committed at `deploy\intune-packages\ZavaClaims.intunewin`. Rebuild it only when the Win32 source changes:

```powershell
pwsh -File .\scripts\Build-IntunePackages.ps1
```

## Device groups

Use a device group for each Cloud PC pool that should receive the Claims app. For Copilot Studio hosted pools, a dynamic rule matching `device.enrollmentProfileName -startsWith "CPCPool_"` can capture pool Cloud PCs after they enrol.

## Enrollment Status Page warning

Do not let the Claims app block account setup for agent pools. Windows 365 supports ESP for Cloud PCs, but custom ESP targeting must use the `enrollmentProfileName` filter. Use `scripts\Set-AgentPoolEspSkip.ps1` only after an owner-approved plan proves it targets the intended pool.

Microsoft references:

- Intune Win32 apps: <https://learn.microsoft.com/en-us/mem/intune/apps/apps-win32-app-management>
- Windows 365 ESP: <https://learn.microsoft.com/en-us/windows-365/enterprise/enrollment-status-page>
- Windows 365 for Agents pools: <https://learn.microsoft.com/en-us/windows-365/agents/cloud-pc-agent-pools>
