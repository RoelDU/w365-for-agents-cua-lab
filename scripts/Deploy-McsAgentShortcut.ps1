<#
.SYNOPSIS
    Delivers the "Zava Claims Agent Launch" desktop shortcut to the Copilot Studio (MCS)
    Cloud PCs only, as its own small Intune Win32 app.

.DESCRIPTION
    The shortcut starts the installed Claims app with the agent launch options, so MCS
    Computer Use can double-click it instead of typing the command into Run (eight model
    steps in run MCS-9). See docs\mcs-computer-use-instructions.md.

    What it changes, and what it does not:
      - Creates one Intune Win32 app (default name "Zava Claims Agent Launch Shortcut") and
        assigns it as required to the MCS pool device group only (default
        "Zava W365A Cloud PC Pools"). Nothing is assigned to the Foundry group.
      - Makes that app depend on the Claims Intune app (default "Zava Claims Workstation",
        created by Deploy-DemoEnvironment.ps1), so Intune installs Claims first. The script
        stops if that Claims app does not exist yet. Its detection also requires claims.exe,
        so the shortcut never reports installed before Claims is.
      - On the Cloud PC: copies one file to C:\Users\Public\Desktop with cmd.exe. Uninstall
        deletes only that file. The Claims app, its Intune app and its normal shortcuts are
        not touched.
      - If the app already exists, it is left as it is (no content or detection update), as in
        Deploy-DemoEnvironment.ps1; its Claims dependency and assignment are still checked.

    -Build stages the package from source and runs Microsoft's IntuneWinAppUtil (downloaded
    to out\tools if absent), writing out\intune\packages\ZavaClaimsAgentShortcut.intunewin.
    Without -Build the committed deploy\intune-packages\ZavaClaimsAgentShortcut.intunewin
    is used.

    Sign-in: either run Connect-MSIntuneGraph first, or pass -UseAzureCliToken to reuse
    the current Azure CLI sign-in (it needs DeviceManagementApps.ReadWrite.All and
    Group.Read.All). Use -WhatIf to preview every tenant change.

.EXAMPLE
    pwsh -File .\scripts\Deploy-McsAgentShortcut.ps1 -Build -UseAzureCliToken -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Build,
    [string]$PackagePath,
    [string]$AppDisplayName = 'Zava Claims Agent Launch Shortcut',
    [string]$GroupName = 'Zava W365A Cloud PC Pools',
    [string]$ClaimsAppDisplayName = 'Zava Claims Workstation',
    [switch]$UseAzureCliToken,
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$pkgSrc = Join-Path $repoRoot 'apps\legacy-claims-workstation\installer\agent-shortcut'
. (Join-Path $pkgSrc 'AgentShortcut.Settings.ps1')
$detectScript = Join-Path $pkgSrc 'Detect-AgentShortcut.ps1'
$graph = 'https://graph.microsoft.com/beta'

if ($Build -or $BuildOnly) {
    # Local packaging is not a tenant change, so it runs even under -WhatIf.
    $tenantWhatIf = $WhatIfPreference
    $WhatIfPreference = $false
    $stage = Join-Path $repoRoot 'out\intune\source\ZavaClaimsAgentShortcut'
    $outDir = Join-Path $repoRoot 'out\intune\packages'
    if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
    New-Item -ItemType Directory -Force -Path $stage, $outDir | Out-Null
    $lnk = Join-Path $stage $AgentShortcutFileName
    & (Join-Path $pkgSrc 'New-AgentLaunchShortcut.ps1') -OutputPath $lnk

    $tool = Join-Path $repoRoot 'out\tools\IntuneWinAppUtil.exe'
    if (-not (Test-Path $tool)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $tool) | Out-Null
        Write-Host 'Downloading IntuneWinAppUtil.exe (Microsoft Win32 Content Prep Tool)...'
        Invoke-WebRequest -Uri 'https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool/raw/master/IntuneWinAppUtil.exe' -OutFile $tool
    }
    $default = Join-Path $outDir ([IO.Path]::GetFileNameWithoutExtension($AgentShortcutFileName) + '.intunewin')
    $named = Join-Path $outDir 'ZavaClaimsAgentShortcut.intunewin'
    Remove-Item -Force $default, $named -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath $tool -ArgumentList "-c `"$stage`" -s `"$AgentShortcutFileName`" -o `"$outDir`" -q" -Wait -PassThru -NoNewWindow
    if ($p.ExitCode -ne 0 -or -not (Test-Path $default)) { throw "IntuneWinAppUtil failed (exit $($p.ExitCode))." }
    Move-Item -Force $default $named
    Write-Host "Package: $named"
    if (-not $PackagePath) { $PackagePath = $named }
    $WhatIfPreference = $tenantWhatIf
}
if ($BuildOnly) { return }
if (-not $PackagePath) { $PackagePath = Join-Path $repoRoot 'deploy\intune-packages\ZavaClaimsAgentShortcut.intunewin' }
if (-not (Test-Path $PackagePath)) { throw "Package not found: $PackagePath (use -Build)." }

Import-Module IntuneWin32App -MinimumVersion 1.4.0
if ($UseAzureCliToken) {
    $tok = az account get-access-token --resource-type ms-graph -o json | ConvertFrom-Json
    if (-not $tok.accessToken) { throw 'Azure CLI returned no Microsoft Graph token. Sign in with az login first.' }
    $expires = [DateTimeOffset]::FromUnixTimeSeconds([int64]$tok.expires_on)
    $Global:AccessToken = [pscustomobject]@{ AccessToken = $tok.accessToken; ExpiresOn = $expires }
    $Global:AccessTokenTenantID = $tok.tenant
    $Global:AuthenticationHeader = @{
        'Content-Type'  = 'application/json'
        'Authorization' = "Bearer $($tok.accessToken)"
        'ExpiresOn'     = $expires.UtcDateTime
    }
}
if (-not $Global:AuthenticationHeader) { throw 'Not signed in: run Connect-MSIntuneGraph first, or pass -UseAzureCliToken.' }
$auth = @{ Authorization = $Global:AuthenticationHeader['Authorization'] }

$groups = @((Invoke-RestMethod -Headers $auth -Uri "$graph/groups?`$filter=displayName eq '$($GroupName -replace "'", "''")'&`$select=id,displayName,membershipRule").value)
if ($groups.Count -ne 1) { throw "Expected exactly one group named '$GroupName', found $($groups.Count)." }
$group = $groups[0]
Write-Host "Target group: $($group.displayName) ($($group.id)) rule: $($group.membershipRule)"

$claimsApps = @((Invoke-RestMethod -Headers $auth -Uri "$graph/deviceAppManagement/mobileApps?`$filter=displayName eq '$($ClaimsAppDisplayName -replace "'", "''")'").value)
if ($claimsApps.Count -ne 1) {
    throw "Expected exactly one Intune app named '$ClaimsAppDisplayName' (the Claims app this shortcut opens), found $($claimsApps.Count). Deploy the Claims app first (install guide page 2)."
}
$claimsAppId = $claimsApps[0].id
Write-Host "Claims app: $ClaimsAppDisplayName ($claimsAppId)"

$existing = @((Invoke-RestMethod -Headers $auth -Uri "$graph/deviceAppManagement/mobileApps?`$filter=displayName eq '$($AppDisplayName -replace "'", "''")'").value)
if ($existing.Count -gt 1) { throw "More than one app named '$AppDisplayName'; resolve that in Intune first." }
$appId = $null
if ($existing.Count -eq 1) {
    $appId = $existing[0].id
    Write-Host "App '$AppDisplayName' exists ($appId); content left as it is."
}
elseif ($PSCmdlet.ShouldProcess($AppDisplayName, 'Create Intune Win32 app (MCS agent launch shortcut)')) {
    $detection = New-IntuneWin32AppDetectionRuleScript -ScriptFile $detectScript -EnforceSignatureCheck $false -RunAs32Bit $false
    $requirement = New-IntuneWin32AppRequirementRule -Architecture 'x64' -MinimumSupportedWindowsRelease 'W10_1809'
    $app = Add-IntuneWin32App -FilePath $PackagePath -DisplayName $AppDisplayName `
        -Description 'Adds the "Zava Claims Agent Launch" Public Desktop shortcut that the Copilot Studio Computer Use agent double-clicks. MCS Cloud PCs only; the Claims app and its normal shortcuts are unchanged.' `
        -Publisher 'Zava (demo)' -InstallExperience 'system' -RestartBehavior 'suppress' `
        -DetectionRule $detection -RequirementRule $requirement `
        -InstallCommandLine $AgentShortcutInstallCommand -UninstallCommandLine $AgentShortcutUninstallCommand
    $appId = $app.id
    Write-Host "Created '$AppDisplayName' ($appId)."
}
else {
    Write-Host "  [WhatIf] install:   $AgentShortcutInstallCommand"
    Write-Host "  [WhatIf] uninstall: $AgentShortcutUninstallCommand"
}

if ($appId) {
    $dependsOnClaims = {
        @((Invoke-RestMethod -Headers $auth -Uri "$graph/deviceAppManagement/mobileApps/$appId/relationships").value |
            Where-Object { $_.'@odata.type' -eq '#microsoft.graph.mobileAppDependency' -and $_.targetId -eq $claimsAppId }).Count -gt 0
    }
    if (& $dependsOnClaims) { Write-Host "Already depends on '$ClaimsAppDisplayName'." }
    elseif ($PSCmdlet.ShouldProcess($AppDisplayName, "Add dependency on '$ClaimsAppDisplayName' (install it first)")) {
        $dependency = New-IntuneWin32AppDependency -ID $claimsAppId -DependencyType 'AutoInstall'
        Add-IntuneWin32AppDependency -ID $appId -Dependency $dependency | Out-Null
        # The module reports a failed update only as a warning, so read it back.
        if (-not (& $dependsOnClaims)) { throw "The dependency on '$ClaimsAppDisplayName' was not saved; add it in Intune (app > Dependencies) before assigning." }
        Write-Host "Depends on '$ClaimsAppDisplayName' (installed first)."
    }

    $assigned = @((Invoke-RestMethod -Headers $auth -Uri "$graph/deviceAppManagement/mobileApps/$appId/assignments").value |
        Where-Object { $_.target.groupId -eq $group.id })
    if ($assigned) { Write-Host "Already assigned to '$($group.displayName)'." }
    elseif ($PSCmdlet.ShouldProcess($AppDisplayName, "Assign required to '$($group.displayName)'")) {
        Add-IntuneWin32AppAssignmentGroup -Include -ID $appId -GroupID $group.id -Intent 'required' -Notification 'hideAll' | Out-Null
        Write-Host "Assigned as required to '$($group.displayName)'."
    }
}
elseif ($WhatIfPreference) {
    Write-Host "  [WhatIf] would add a dependency on '$ClaimsAppDisplayName' (install it first)."
    Write-Host "  [WhatIf] would assign required to '$($group.displayName)'."
}
