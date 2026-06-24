# Configures the ONE-TIME, tenant-wide Microsoft Entra prerequisites that a
# Windows 365 for Agents (W365A) Cloud PC pool needs before it can run the
# Copilot Studio Computer Use tool. This automates the two genuinely scriptable
# prerequisites so the demo does not fail later with
# 'MSEntraRemoteDesktopAppConsentRequired':
#
#   1) Enables Microsoft Entra authentication for RDP on the Microsoft Remote
#      Desktop service principal (AppId a4a365df-50f1-4397-bc59-1a1564b8bb9c) by
#      setting isRemoteDesktopProtocolEnabled = true.
#   2) (Optional, -CreateDynamicGroup) Creates the dynamic Entra device group that
#      captures the pool's Cloud PCs (membership rule
#      device.enrollmentProfileName -startsWith "CPCPool_") AND hides the RDP
#      consent prompt for it by adding it as a target device group on the
#      Microsoft Remote Desktop service principal (so runs don't fail with
#      'MSEntraRemoteDesktopAppConsentRequired'). The build's Intune Win32
#      assignment can also target this same group to install claims.exe.
#
# RUN THIS ONCE, INTERACTIVELY, AS A GLOBAL / INTUNE ADMINISTRATOR of the test
# tenant. It is the one-time admin-consent step and cannot be done app-only.
#
#   .\scripts\Enable-W365aPrereqs.ps1 -TenantId <your-tenant-id>
#   .\scripts\Enable-W365aPrereqs.ps1 -TenantId <id> -CreateDynamicGroup -WhatIf
#
# What this script intentionally does NOT do (manual gates, by design):
#   - Create the Cloud PC pool itself. For the Copilot Studio path you create it
#     in the maker portal: your agent -> Computer Use tool -> Machines ->
#     Cloud PC pool -> Add new. There is no supported public API for creating
#     that Copilot Studio pool object, and it is a once-per-tenant gesture.
#     See https://learn.microsoft.com/microsoft-copilot-studio/use-cloud-pc-pool
#   - Set up billing: pay-as-you-go to your Azure subscription ($0.40/hr runtime,
#     plus $5/Cloud PC/mo if always-available). No reliable free tier - the meter
#     is live; the demo uses always-available to avoid cold start.
#   - Set the Intune device-type enrollment restriction (Allow Windows (MDM) for
#     corporate enrollment) - that is a portal toggle.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a non-BOM UTF-8 .ps1 as
# ANSI, and a stray non-ASCII character breaks parsing.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$TenantId,

    # Use device-code sign-in (for a headless admin box / Conditional Access).
    [switch]$DeviceCode,

    # Also create the dynamic device group that captures the pool's Cloud PCs.
    [switch]$CreateDynamicGroup,

    [string]$DynamicGroupName = "Zava W365A Cloud PC Pools",

    # Enrollment-profile prefix used by the dynamic membership rule. Cloud PCs for
    # Agents enroll with profile names beginning 'CPCPool_'.
    [string]$EnrollmentProfilePrefix = "CPCPool_"
)

$ErrorActionPreference = "Stop"

# Well-known first-party app: 'Microsoft Remote Desktop'. The Cloud PC pool runs
# by creating a local RDP session using a Microsoft Entra ID account, so this SP
# must have RDP enabled.
$MicrosoftRemoteDesktopAppId = "a4a365df-50f1-4397-bc59-1a1564b8bb9c"

# Modules needed: Authentication (Connect-MgGraph), Applications (service
# principal + remote-desktop config), Groups (only when -CreateDynamicGroup).
$requiredModules = @("Microsoft.Graph.Authentication", "Microsoft.Graph.Applications")
if ($CreateDynamicGroup) { $requiredModules += "Microsoft.Graph.Groups" }

foreach ($module in $requiredModules) {
    if (-not (Get-Module -ListAvailable -Name $module)) {
        Write-Host "Installing $module ..."
        Install-Module $module -Scope CurrentUser -Force -AllowClobber
    }
}

# Least-privilege scopes for exactly the mutations below.
$scopes = @("Application.Read.All", "Application-RemoteDesktopConfig.ReadWrite.All")
if ($CreateDynamicGroup) { $scopes += "Group.ReadWrite.All" }

Write-Host "Connecting to tenant $TenantId as administrator (interactive) ..."
$connect = @{ TenantId = $TenantId; Scopes = $scopes }
if ($DeviceCode) { $connect["UseDeviceCode"] = $true }
Connect-MgGraph @connect | Out-Null

try {
    # ----------------------------------------------------------------------
    # 1) Enable Microsoft Entra authentication for RDP on Microsoft Remote Desktop
    # ----------------------------------------------------------------------
    $sp = Get-MgServicePrincipal -Filter "appId eq '$MicrosoftRemoteDesktopAppId'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $sp) {
        throw "Microsoft Remote Desktop service principal ($MicrosoftRemoteDesktopAppId) was not found in tenant $TenantId. Ensure Windows 365 / the relevant first-party apps are provisioned, then re-run."
    }

    $current = $null
    try {
        $current = Get-MgServicePrincipalRemoteDesktopSecurityConfiguration -ServicePrincipalId $sp.Id -ErrorAction Stop
    } catch {
        $current = $null   # not configured yet
    }

    if ($current -and $current.IsRemoteDesktopProtocolEnabled) {
        Write-Host "RDP already enabled on Microsoft Remote Desktop SP ($($sp.Id)) - nothing to do."
    } elseif ($PSCmdlet.ShouldProcess("Microsoft Remote Desktop service principal ($($sp.Id))", "Set isRemoteDesktopProtocolEnabled = true")) {
        Update-MgServicePrincipalRemoteDesktopSecurityConfiguration -ServicePrincipalId $sp.Id -IsRemoteDesktopProtocolEnabled | Out-Null
        $check = Get-MgServicePrincipalRemoteDesktopSecurityConfiguration -ServicePrincipalId $sp.Id
        if ($check.IsRemoteDesktopProtocolEnabled) {
            Write-Host "Enabled RDP (isRemoteDesktopProtocolEnabled = true) on Microsoft Remote Desktop SP."
        } else {
            Write-Warning "Update ran but isRemoteDesktopProtocolEnabled is still not true - re-check permissions / tenant state."
        }
    }

    # ----------------------------------------------------------------------
    # 2) (Optional) Dynamic device group capturing the pool's Cloud PCs
    # ----------------------------------------------------------------------
    if ($CreateDynamicGroup) {
        $rule = "(device.enrollmentProfileName -startsWith ""$EnrollmentProfilePrefix"")"
        $groupId = $null
        $existing = Get-MgGroup -Filter "displayName eq '$DynamicGroupName'" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($existing) {
            Write-Host "Dynamic group '$DynamicGroupName' already exists (Id $($existing.Id)) - leaving as-is."
            Write-Host "  Membership rule should be: $rule"
            $groupId = $existing.Id
        } elseif ($PSCmdlet.ShouldProcess("Entra dynamic device group '$DynamicGroupName'", "Create with rule $rule")) {
            $mailNick = (($DynamicGroupName -replace '[^a-zA-Z0-9]', '')).ToLower()
            if (-not $mailNick) { $mailNick = "zavaw365apool" }
            $group = New-MgGroup -DisplayName $DynamicGroupName `
                -Description "Captures Windows 365 for Agents Cloud PCs (enrollment profile '$EnrollmentProfilePrefix*') for the Zava demo: hide-consent + Intune claims.exe assignment." `
                -MailEnabled:$false `
                -MailNickname $mailNick `
                -SecurityEnabled:$true `
                -GroupTypes @("DynamicMembership") `
                -MembershipRule $rule `
                -MembershipRuleProcessingState "On"
            Write-Host "Created dynamic group '$DynamicGroupName' (Id $($group.Id))."
            Write-Host "  Dynamic groups require an Entra ID P1 (or Intune for Education) license."
            Write-Host "  Membership may take 5-10 min (occasionally up to 24h) to populate."
            Write-Host "  Set agentPool.deviceGroupName (in demo-config.local.json) to '$DynamicGroupName' and leave agentPool.pilotCloudPcName empty so Intune auto-installs claims.exe on every pool Cloud PC."
            $groupId = $group.Id
        }

        # 3) Hide the RDP consent prompt for the pool's Cloud PCs by adding the
        #    dynamic group as a target device group on the Microsoft Remote Desktop
        #    SP. Without this, computer use runs fail with
        #    MSEntraRemoteDesktopAppConsentRequired. (Requires the SP's RDP config
        #    from step 1, which is why this runs after it.)
        if ($groupId) {
            $alreadyTargeted = $false
            try {
                $targets = Get-MgServicePrincipalRemoteDesktopSecurityConfigurationTargetDeviceGroup -ServicePrincipalId $sp.Id -ErrorAction Stop
                if ($targets | Where-Object { $_.Id -eq $groupId }) { $alreadyTargeted = $true }
            } catch {
                $alreadyTargeted = $false
            }

            if ($alreadyTargeted) {
                Write-Host "Consent prompt already hidden for group $groupId (target device group present) - nothing to do."
            } elseif ($PSCmdlet.ShouldProcess("Microsoft Remote Desktop SP ($($sp.Id))", "Add target device group $groupId to hide the consent prompt")) {
                New-MgServicePrincipalRemoteDesktopSecurityConfigurationTargetDeviceGroup -ServicePrincipalId $sp.Id `
                    -BodyParameter @{ id = $groupId; displayName = $DynamicGroupName } | Out-Null
                Write-Host "Hid the consent prompt: added target device group $groupId to the Microsoft Remote Desktop SP."
            }
        }
    }

    Write-Host ""
    Write-Host "==================== W365A prerequisites configured ====================" -ForegroundColor Green
    Write-Host "Done (automatable parts). Remaining MANUAL gates for the Copilot Studio path:" -ForegroundColor Yellow
    Write-Host "  - Create the Cloud PC pool: agent -> Computer Use tool -> Machines -> Cloud PC pool -> Add new." -ForegroundColor Yellow
    Write-Host "      Name it 'Zava Claims Agent Pool'. The backing object will appear with a platform-generated" -ForegroundColor Yellow
    Write-Host "      name 'CPCPool_<environmentId>_<groupId>' - that is EXPECTED and not editable." -ForegroundColor Yellow
    Write-Host "      Verify in Intune -> Devices -> All Cloud PCs (enrollment profile starts 'CPCPool_'), NOT under" -ForegroundColor Yellow
    Write-Host "      'Provisioning policies (Agents)' (that list is correctly EMPTY for the Copilot Studio pool)." -ForegroundColor Yellow
    Write-Host "      Region follows the Power Platform environment geography (a US environment => US Central is normal);" -ForegroundColor Yellow
    Write-Host "      the first GUID in the CPCPool_ name is that environment's id. See docs/w365a-pool.md." -ForegroundColor Yellow
    Write-Host "  - Confirm billing: pay-as-you-go to your Azure subscription (`$0.40/hr; `$5/Cloud PC/mo if always-available). No reliable free tier - use always-available to avoid cold start." -ForegroundColor Yellow
    Write-Host "  - Intune: device-type enrollment restriction = Allow Windows (MDM) for corporate enrollment." -ForegroundColor Yellow
    if (-not $CreateDynamicGroup) {
        Write-Host "  - Hide the consent prompt: re-run with -CreateDynamicGroup (automates it), or do it manually." -ForegroundColor Yellow
    }
    Write-Host "  - Power Platform admin center: ensure Cloud PC is enabled for the environment (Copilot -> Settings -> Computer Use)." -ForegroundColor Yellow
    Write-Host "  - If the Computer Use 'Machines' drop-down has NO 'Cloud PC pool' option (only" -ForegroundColor Yellow
    Write-Host "    'Hosted browser' / 'Bring-your-own machine'): turn ON the per-environment toggle" -ForegroundColor Yellow
    Write-Host "    Settings -> Features -> 'Enable cross-geo support for Windows 365-based features'" -ForegroundColor Yellow
    Write-Host "    (needed outside the tenant home geo, e.g. Australia), and confirm the Windows 365 /" -ForegroundColor Yellow
    Write-Host "    Azure Virtual Desktop first-party service principals exist (az ad sp create --id ...)." -ForegroundColor Yellow
    Write-Host "    Do NOT switch to 'Bring-your-own machine' - see docs/w365a-pool.md troubleshooting." -ForegroundColor Yellow
    Write-Host "  - Same-account rule: the signed-in Entra user must own the Computer Use connection." -ForegroundColor Yellow
    Write-Host "  Docs: https://learn.microsoft.com/microsoft-copilot-studio/use-cloud-pc-pool" -ForegroundColor Yellow
    Write-Host "========================================================================" -ForegroundColor Green
}
finally {
    Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null
}
