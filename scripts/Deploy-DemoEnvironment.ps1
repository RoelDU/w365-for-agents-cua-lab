<#
.SYNOPSIS
    Deploys the Zava CCaaS demo apps to the agent Cloud PC(s) via Intune, using a
    single device group so onboarding another Cloud PC is just "add it to the group."

.DESCRIPTION
    The Cloud PCs already exist (named however your tenant names them). This script
    does NOT create
    provisioning policies, assign licenses, or provision Cloud PCs. It wires up the
    one thing the demo needs to scale cleanly:

      Phase 1  Groups   An Entra DEVICE security group (assigned membership) for the
                        agent pool, plus the human-workstation USER group. You add each
                        agent Cloud PC's device object to the device group; the pilot
                        Cloud PC(s) in -PilotCloudPcName are added for you.
      Phase 2  Apps     This phase deploys `claims.exe` to the agent Cloud PC pool
                        via Intune as a REQUIRED Win32 app. Copilot Studio Cloud PC
                        pools are Entra-joined and Intune-enrolled, so the pool device
                        group is the correct standing target for app delivery.
      Phase WebLink     The CCaaS desktop as a Microsoft Edge force-installed web app
                        (PWA) assigned to the workstation USER group.

    ONBOARDING ANOTHER CLOUD PC:
        Add its device object to '<DeviceGroupName>' in Entra (portal or
        -PilotCloudPcName). The claims app is delivered by Intune as a required
        Win32 app, so every current/future pool Cloud PC in that device group gets it.

.NOTES
    Auth: interactive least-privilege admin sign-in by default. If the workstation
    has no working browser, add -DeviceCode to sign in from another device. For
    unattended runs (CI / pipelines) pass app-only credentials; a CERTIFICATE
    (-CertificateThumbprint) is preferred over a client secret.

    Idempotent: re-running detects and reuses existing objects/assignments.
    Supports -WhatIf. Run a subset with -Phase.

    Prerequisite: the Cloud PCs must be Intune-enrolled (Windows 365 Enterprise Cloud
    PCs are, automatically). This script only deploys apps; it never provisions.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$TenantId,

    # --- Authentication (interactive by default) ---
    [string]$ClientId,
    [string]$CertificateThumbprint,
    [string]$ClientSecret,

    # Browser-free interactive sign-in: prints a URL + code to authenticate from
    # any other device (phone/laptop). Use when the local browser cannot launch.
    [switch]$DeviceCode,

    # --- Agent POOL: the W365A Cloud PC pool's device group (legacy claims app target) -
    # The pool's Cloud PCs are Entra DEVICE objects; the legacy claims app is assigned
    # to this device group so every current/future pool Cloud PC gets it automatically.
    [string]$DeviceGroupName = "Zava-Demo-Agent-CPCs",
    [string]$ScopeTagName = "Zava-Demo",

    # --- Existing Cloud PC(s) to add to the group now (by Cloud PC / device name) ---
    # The Entra device object's displayName equals the Cloud PC name. Add more here,
    # or just add devices to the group in the portal later - both work identically.
    [string[]]$PilotCloudPcName = @(),

    # --- Agent WORKSTATION: the human agent's user group (CCaaS web link target) ------
    # The CCaaS web link is USER-centric: add the human agent's user account to this
    # group (portal or -AgentUserName) and the link follows them onto whichever Cloud
    # PC they sign into. The legacy claims app is NEVER assigned here. Provisioning /
    # licensing of the Cloud PCs is NOT done here - you create them; this script only
    # does app targeting.
    [string]$UserGroupName = "Zava-Demo-Agent-Users",
    [string[]]$AgentUserName = @(),

    # --- Intune packaging ---
    [string]$PackageRoot = (Join-Path $PSScriptRoot "..\out\intune\packages"),
    [switch]$BuildPackages,

    # --- Legacy claims app delivery (standing demo path: Intune Win32) -------------
    # `claims.exe` is deployed to the agent pool via Intune as a REQUIRED Win32 app.
    # Copilot Studio Cloud PC pools are Entra-joined and Intune-enrolled, so the pool
    # device group is the correct standing target. `-AssignClaimsWin32` is kept only
    # for backward compatibility; it is now redundant and only emits a deprecation note.
    [switch]$AssignClaimsWin32,

    [ValidateSet("All", "Groups", "Apps", "WebLink")]
    [string]$Phase = "All",

    # --- CCaaS desktop (the centrally-hosted SWA app) ----------------------------
    # The CCaaS desktop is not a Win32 app: it is served by the Azure Static Web App
    # and delivered to the Cloud PC as a Microsoft Edge force-installed web app (PWA)
    # via an Intune Settings Catalog policy, which gives a real desktop icon. (A plain
    # Intune managed web link cannot install on Windows and was removed - see issue
    # #60.) Build-DemoFromScratch.ps1 passes the live SWA URL here automatically; both
    # are optional so the Groups/Apps phases still run alone. The -Name/-Url parameters
    # keep the 'WebLink' names for config/back-compat.
    [string]$CcaasWebLinkName = "Zava Contact Center",
    [string]$CcaasWebLinkUrl,

    # Internal: set automatically when the script re-launches itself under
    # PowerShell 7. Prevents an infinite relaunch loop. Not for manual use.
    [switch]$SkipPwshRelaunch
)

$ErrorActionPreference = "Stop"

# --- Auto-relaunch under PowerShell 7 -----------------------------------------
# Microsoft.Graph 2.x throws "EventSourceException: Error occurred when writing
# to a listener" during interactive/device-code auth on Windows PowerShell 5.1.
# The documented fix is to run under PowerShell 7 (pwsh). App-only (cert/secret)
# runs are unaffected and stay on the current host.
$isAppOnly = $ClientId -and ($ClientSecret -or $CertificateThumbprint)
if (-not $SkipPwshRelaunch -and $PSVersionTable.PSVersion.Major -lt 6 -and -not $isAppOnly) {
    $pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($pwshCmd) {
        Write-Host "Relaunching under PowerShell 7 (avoids the Windows PowerShell 5.1 Microsoft.Graph telemetry listener bug)..."
        $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-SkipPwshRelaunch')
        foreach ($kv in $PSBoundParameters.GetEnumerator()) {
            $n = $kv.Key; $v = $kv.Value
            if ($v -is [System.Management.Automation.SwitchParameter]) {
                if ($v.IsPresent) { $fwd += "-$n" }
            }
            elseif ($v -is [System.Collections.IEnumerable] -and $v -isnot [string]) {
                $fwd += "-$n"; $fwd += (($v | ForEach-Object { "$_" }) -join ',')
            }
            else {
                $fwd += "-$n"; $fwd += "$v"
            }
        }
        & $pwshCmd.Source @fwd
        exit $LASTEXITCODE
    }
    Write-Warning "PowerShell 7 (pwsh) not found. Continuing under Windows PowerShell 5.1; interactive/device-code auth may fail with an EventSource listener error. Install PowerShell 7 (winget install Microsoft.PowerShell) and retry if so."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$graphBeta = "https://graph.microsoft.com/beta"

# --- App catalogue (display names MUST match the docs/detection scripts) -------
# The CCaaS desktop is hosted centrally on Azure Static Web Apps and delivered as a
# Microsoft Edge force-installed web app (see Invoke-EdgePwaPhase), so the ONLY Win32
# install is the legacy claims workstation that the Computer-Use agent drives on screen.
$apps = @(
    [pscustomobject]@{
        DisplayName  = "Zava Claims Workstation"
        Description  = "Legacy Win32 claims app driven by the Computer Use agent."
        Publisher    = "Zava (demo)"
        Package      = Join-Path $PackageRoot "ZavaClaims.intunewin"
        DetectScript = Join-Path $repoRoot "apps\legacy-claims-workstation\installer\Detect.ps1"
        Install      = 'claims.exe --install'
        Uninstall    = '"%ProgramFiles%\Business Applications\Zava Claims Workstation\claims.exe" --uninstall'
    }
)

# --- Module bootstrap ----------------------------------------------------------
function Confirm-Module {
    param([Parameter(Mandatory)][string]$Name, [string]$MinimumVersion)
    $have = Get-Module -ListAvailable -Name $Name |
        Sort-Object Version -Descending | Select-Object -First 1
    if (-not $have -or ($MinimumVersion -and $have.Version -lt [version]$MinimumVersion)) {
        # Installing a local PowerShell module is control-PC tooling setup, not an
        # Azure/Graph/Intune mutation, so it must run even under -WhatIf. Without the
        # explicit -WhatIf:$false, a -WhatIf preview only simulates Install-Module and
        # the Import-Module below then fails on a clean machine (the IntuneWin32App
        # 'no valid module file was found' error). The remote Graph/Intune operations
        # stay -WhatIf-protected; only this local prerequisite install is forced.
        Write-Host "Installing module $Name (local prerequisite)..."
        $p = @{ Name = $Name; Scope = "CurrentUser"; Force = $true; AllowClobber = $true; WhatIf = $false; Confirm = $false }
        if ($MinimumVersion) { $p.MinimumVersion = $MinimumVersion }
        try {
            Install-Module @p
        }
        catch {
            $manual = "Install-Module $Name -Scope CurrentUser -Force -AllowClobber"
            if ($MinimumVersion) { $manual += " -MinimumVersion $MinimumVersion" }
            throw "Could not install the required PowerShell module '$Name'. Install it manually and re-run: $manual`nOriginal error: $($_.Exception.Message)"
        }
    }
    Import-Module $Name -ErrorAction Stop
}

# --- Authentication ------------------------------------------------------------
function Connect-DemoGraph {
    param([string[]]$Scopes)
    # Sign-in opens a browser via Start-Process deep inside Microsoft.Graph/MSAL, so it
    # honours -WhatIf and, under a preview, is only simulated -> the run hangs waiting
    # for auth that never opens (issue #2). Crucially, `pwsh -File ... -WhatIf` sets
    # $WhatIfPreference in the GLOBAL scope, which the nested module call resolves to;
    # a local/script-scope shadow does NOT cross the module boundary. Interactive
    # sign-in is local read-context bootstrap (not a resource mutation), so clear the
    # GLOBAL preference for the duration of the auth call only, then restore it. Remote
    # mutations are unaffected: each runs AFTER auth returns (global already restored)
    # and is guarded by $PSCmdlet.ShouldProcess.
    $savedWhatIf = $global:WhatIfPreference
    $global:WhatIfPreference = $false
    try {
        if ($ClientId -and $CertificateThumbprint) {
            Write-Host "Authenticating app-only with certificate ($ClientId)..."
            Connect-MgGraph -TenantId $TenantId -ClientId $ClientId -CertificateThumbprint $CertificateThumbprint -NoWelcome | Out-Null
        }
        elseif ($ClientId -and $ClientSecret) {
            Write-Warning "Using a client secret (dev-only). Prefer -CertificateThumbprint in production."
            $secure = ConvertTo-SecureString $ClientSecret -AsPlainText -Force
            $cred = [System.Management.Automation.PSCredential]::new($ClientId, $secure)
            Connect-MgGraph -TenantId $TenantId -ClientSecretCredential $cred -NoWelcome | Out-Null
        }
        else {
            if ($DeviceCode) {
                Write-Host "Authenticating with device code (open the URL below on any device)..."
                # Device-code prompt is emitted on the output stream; Out-Host keeps it
                # visible (Out-Null/$null= would swallow the code) without returning it.
                Connect-MgGraph -TenantId $TenantId -Scopes $Scopes -UseDeviceAuthentication -NoWelcome | Out-Host
            }
            else {
                Write-Host "Authenticating interactively (sign in as a privileged admin)..."
                Connect-MgGraph -TenantId $TenantId -Scopes $Scopes -NoWelcome | Out-Null
            }
        }
    }
    finally { $global:WhatIfPreference = $savedWhatIf }
}

function Connect-Intune {
    # See Connect-DemoGraph: Connect-MSIntuneGraph's interactive sign-in opens a browser
    # via Start-Process inside MSAL.PS, which honours the GLOBAL $WhatIfPreference set by
    # `pwsh -File ... -WhatIf`. A local shadow does not reach across the module boundary
    # (issue #2), so clear the GLOBAL preference for the auth call only and restore it in
    # finally. Remote Intune mutations run later, after global is restored, and stay
    # -WhatIf-protected via $PSCmdlet.ShouldProcess.
    $savedWhatIf = $global:WhatIfPreference
    $global:WhatIfPreference = $false
    try {
        if ($ClientId -and $CertificateThumbprint) {
            if (-not (Get-Command Connect-MSIntuneGraph).Parameters.ContainsKey('ClientCert')) {
                throw "The installed IntuneWin32App module does not support -ClientCert. Update the module, or use interactive/-ClientSecret auth for the Apps phase."
            }
            Connect-MSIntuneGraph -TenantID $TenantId -ClientID $ClientId -ClientCert (Get-Item "Cert:\CurrentUser\My\$CertificateThumbprint") | Out-Null
        }
        elseif ($ClientId -and $ClientSecret) {
            Connect-MSIntuneGraph -TenantID $TenantId -ClientID $ClientId -ClientSecret $ClientSecret | Out-Null
        }
        else {
            # IntuneWin32App 1.5.0 made -ClientID mandatory (the old built-in default app
            # was retired). Supply the first-party Microsoft Graph Command Line Tools public
            # client so the sign-in doesn't stop for an interactive ClientID prompt.
            $intuneClientId = if ($ClientId) { $ClientId } else { "14d82eec-204b-4c2f-b7e8-296a70dab67e" }
            if ($DeviceCode) {
                if (-not (Get-Command Connect-MSIntuneGraph).Parameters.ContainsKey('DeviceCode')) {
                    throw "The installed IntuneWin32App module does not support -DeviceCode. Update the module (Update-Module IntuneWin32App), then retry."
                }
                # Device-code prompt is emitted on the output stream; Out-Host keeps it
                # visible (Out-Null/$null= would swallow the code) without returning it.
                Connect-MSIntuneGraph -TenantID $TenantId -ClientID $intuneClientId -DeviceCode | Out-Host
            }
            else {
                Connect-MSIntuneGraph -TenantID $TenantId -ClientID $intuneClientId -Interactive | Out-Null
            }
        }
    }
    finally { $global:WhatIfPreference = $savedWhatIf }
}

# --- Small Graph helpers -------------------------------------------------------
# Escape single quotes for OData string literals (names may contain apostrophes).
function ConvertTo-ODataLiteral { param([string]$Value) $Value -replace "'", "''" }

function Get-GroupByName {
    param([string]$Name)
    $lit = ConvertTo-ODataLiteral $Name
    (Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/groups?`$filter=displayName eq '$lit'").value | Select-Object -First 1
}

# Under -WhatIf, an object created inside ShouldProcess is $null; substitute a
# placeholder so dependent code can describe actions without dereferencing $null.
function Resolve-WhatIfPlaceholder {
    param($Object, [string]$Label)
    if ($Object) { return $Object }
    if ($WhatIfPreference) {
        Write-Host "  [WhatIf] '$Label' would be created; skipping dependent live calls."
        return [pscustomobject]@{ id = "whatif-placeholder"; _whatif = $true }
    }
    throw "Expected '$Label' to exist or be created, but it is null."
}
function Test-IsWhatIfPlaceholder { param($Object) [bool]($Object.PSObject.Properties.Name -contains '_whatif') }

# =============================== Phase 1: Groups ===============================
function Invoke-GroupsPhase {
    Write-Host "`n=== Phase 1: Device group (app target) ==="

    # Assigned (static) device security group. You add each agent Cloud PC's device
    # object here; the apps follow automatically.
    $deviceGroup = Get-GroupByName -Name $DeviceGroupName
    if ($deviceGroup) {
        Write-Host "Device group '$DeviceGroupName' exists ($($deviceGroup.id))."
        if ($deviceGroup.groupTypes -contains "DynamicMembership") {
            Write-Host "Group '$DeviceGroupName' uses DYNAMIC membership (e.g. the CPCPool_* group from Enable-W365aPrereqs.ps1). Reusing it as-is; the membership rule populates pool Cloud PCs automatically, so leave agentPool.pilotCloudPcName empty. Any names listed there are ignored for a dynamic group."
        }
    }
    elseif ($PSCmdlet.ShouldProcess($DeviceGroupName, "Create assigned device security group")) {
        $body = @{
            displayName     = $DeviceGroupName
            description     = "Agent Cloud PCs for the Zava CCaaS demo. Add a Cloud PC's device object here to deploy the demo apps to it."
            mailEnabled     = $false
            mailNickname    = ($DeviceGroupName -replace '[^a-zA-Z0-9]', '')
            securityEnabled = $true
        }
        $deviceGroup = Invoke-MgGraphRequest -Method POST -Uri "$graphBeta/groups" -Body ($body | ConvertTo-Json)
        Write-Host "Created device group '$DeviceGroupName' ($($deviceGroup.id))."
    }
    $deviceGroup = Resolve-WhatIfPlaceholder -Object $deviceGroup -Label $DeviceGroupName

    # Add the existing Cloud PC(s) by name (Entra device displayName == Cloud PC name).
    # Skipped for a dynamic group: its membership rule owns the members and Graph rejects
    # manual adds.
    $isDynamic = $deviceGroup -and ($deviceGroup.groupTypes -contains "DynamicMembership")
    if ($isDynamic -and ($PilotCloudPcName | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        Write-Host "  Skipping pilotCloudPcName entries: '$DeviceGroupName' is dynamic and self-populates."
    }
    if ((-not $isDynamic) -and -not (Test-IsWhatIfPlaceholder $deviceGroup)) {
        foreach ($name in $PilotCloudPcName) {
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            $lit = ConvertTo-ODataLiteral $name
            $devices = (Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/devices?`$filter=displayName eq '$lit'").value
            if (-not $devices) {
                Write-Warning "Cloud PC device '$name' not found in Entra. Confirm the name, or add it to '$DeviceGroupName' in the portal once it appears."
                continue
            }
            if ($devices.Count -gt 1) {
                Write-Warning "Multiple Entra devices named '$name'; adding all $($devices.Count). Remove stale device objects if this is unexpected."
            }
            foreach ($dev in $devices) {
                if ($PSCmdlet.ShouldProcess("$name ($($dev.id))", "Add device to $DeviceGroupName")) {
                    $ref = @{ "@odata.id" = "https://graph.microsoft.com/v1.0/directoryObjects/$($dev.id)" }
                    try {
                        Invoke-MgGraphRequest -Method POST -Uri "$graphBeta/groups/$($deviceGroup.id)/members/`$ref" -Body ($ref | ConvertTo-Json) | Out-Null
                        Write-Host "  Added '$name' to $DeviceGroupName."
                    }
                    catch {
                        # Graph returns 400 'added object references already exist' if already a member.
                        # The detail text lives in the response body (ErrorDetails.Message), not always
                        # in Exception.Message, so inspect the whole error record.
                        $errText = "$($_.Exception.Message) $($_.ErrorDetails.Message) $_"
                        if ($errText -match "already exist") { Write-Host "  '$name' already in $DeviceGroupName." }
                        else { throw }
                    }
                }
            }
        }
    }

    return $deviceGroup
}

function Invoke-UserGroupPhase {
    Write-Host "`n=== Phase 1b: User group (W365 Flex / Shared app target) ==="

    # Assigned (static) user security group. You add each agent's USER account here;
    # the apps follow that user onto whichever shared / Flex Cloud PC they sign into.
    $userGroup = Get-GroupByName -Name $UserGroupName
    if ($userGroup) {
        Write-Host "User group '$UserGroupName' exists ($($userGroup.id))."
        if ($userGroup.groupTypes -contains "DynamicMembership") {
            Write-Warning "Group '$UserGroupName' uses DYNAMIC membership; this script expects an ASSIGNED group you add users to. Members added here may be overwritten by the dynamic rule."
        }
    }
    elseif ($PSCmdlet.ShouldProcess($UserGroupName, "Create assigned user security group")) {
        $body = @{
            displayName     = $UserGroupName
            description     = "Agent users for the Zava CCaaS demo (W365 Flex / Shared). Add an agent's user account here to deploy the demo apps to the shared Cloud PC they sign into."
            mailEnabled     = $false
            mailNickname    = ($UserGroupName -replace '[^a-zA-Z0-9]', '')
            securityEnabled = $true
        }
        $userGroup = Invoke-MgGraphRequest -Method POST -Uri "$graphBeta/groups" -Body ($body | ConvertTo-Json)
        Write-Host "Created user group '$UserGroupName' ($($userGroup.id))."
    }
    $userGroup = Resolve-WhatIfPlaceholder -Object $userGroup -Label $UserGroupName

    # Add the agent user(s) by UPN.
    if (-not (Test-IsWhatIfPlaceholder $userGroup)) {
        foreach ($upn in $AgentUserName) {
            if ([string]::IsNullOrWhiteSpace($upn)) { continue }
            $lit = ConvertTo-ODataLiteral $upn
            $users = (Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/users?`$filter=userPrincipalName eq '$lit'").value
            if (-not $users) {
                Write-Warning "User '$upn' not found in Entra. Confirm the UPN, or add them to '$UserGroupName' in the portal."
                continue
            }
            foreach ($u in $users) {
                if ($PSCmdlet.ShouldProcess("$upn ($($u.id))", "Add user to $UserGroupName")) {
                    $ref = @{ "@odata.id" = "https://graph.microsoft.com/v1.0/directoryObjects/$($u.id)" }
                    try {
                        Invoke-MgGraphRequest -Method POST -Uri "$graphBeta/groups/$($userGroup.id)/members/`$ref" -Body ($ref | ConvertTo-Json) | Out-Null
                        Write-Host "  Added '$upn' to $UserGroupName."
                    }
                    catch {
                        $errText = "$($_.Exception.Message) $($_.ErrorDetails.Message) $_"
                        if ($errText -match "already exist") { Write-Host "  '$upn' already in $UserGroupName." }
                        else { throw }
                    }
                }
            }
        }
    }

    return $userGroup
}

# ============================ Phase 2: Apps (Intune) ==========================
function Get-ScopeTagId {
    $lit = ConvertTo-ODataLiteral $ScopeTagName
    $tag = (Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/deviceManagement/roleScopeTags?`$filter=displayName eq '$lit'").value | Select-Object -First 1
    if ($tag) { return $tag.id }
    if ($PSCmdlet.ShouldProcess($ScopeTagName, "Create Intune scope tag")) {
        $body = @{ displayName = $ScopeTagName; description = "Zava CCaaS demo resources." }
        $tag = Invoke-MgGraphRequest -Method POST -Uri "$graphBeta/deviceManagement/roleScopeTags" -Body ($body | ConvertTo-Json)
        Write-Host "Created scope tag '$ScopeTagName' ($($tag.id))."
        return $tag.id
    }
}

function Invoke-AppsPhase {
    param($DeviceGroup)
    Write-Host "`n=== Phase 2: Intune Win32 apps ==="

    # Standing path: package/assign the claims app as an Intune Win32 app to the agent
    # pool device group so it is pre-installed before the Computer Use session starts.
    if ($AssignClaimsWin32) {
        Write-Warning "-AssignClaimsWin32 is now redundant: Intune required-app delivery to the agent-pool device group is the standing demo path, so the script will proceed normally."
    }
    else {
        Write-Host "  Deploying the claims app via Intune required Win32 assignment to the agent-pool device group (standing default)."
    }

    # The legacy claims app belongs ONLY on the W365A agent POOL, whose Cloud PCs are
    # Entra DEVICE objects. So it is always assigned to the device group - never to the
    # human workstation's user group.
    $targets = @()
    if ($DeviceGroup) { $targets += [pscustomobject]@{ Group = $DeviceGroup; Label = $DeviceGroupName; Model = "Agent pool (device context)" } }

    # Under -WhatIf the groups were not actually created, so there is nothing real to
    # assign to yet; narrate intent and stop (mirrors the original behaviour).
    $realTargets = @($targets | Where-Object { $_.Group -and -not (Test-IsWhatIfPlaceholder $_.Group) })
    if ($realTargets.Count -eq 0) {
        Write-Host "  [WhatIf] device group not created yet; would create + assign the claims app to: $(@($targets | ForEach-Object { $_.Label }) -join ', ')."
        return
    }

    # Building the .intunewin packages compiles local artifacts (build.bat, npm) on the
    # control machine via Start-Process. Under -WhatIf the global preference would only
    # preview those local processes, leaving $process null and tripping the exit-code
    # check in Build-IntunePackages.ps1 (issue #3). The packages are only consumed by the
    # ShouldProcess-guarded Add-IntuneWin32App below, which is skipped in a preview, so
    # there is nothing to build for a -WhatIf run: narrate intent and skip the local build.
    if ($BuildPackages -and ($apps | Where-Object { -not (Test-Path $_.Package) })) {
        if ($WhatIfPreference) {
            Write-Host "  [WhatIf] would build local Intune packages for: $(@($apps | Where-Object { -not (Test-Path $_.Package) } | ForEach-Object { $_.DisplayName }) -join ', ') (local build/compile skipped in preview)."
        }
        else {
            Write-Host "Building Intune packages..."
            & (Join-Path $PSScriptRoot "Build-IntunePackages.ps1") -CreateIntuneWin
        }
    }

    $scopeTagId = Get-ScopeTagId

    foreach ($app in $apps) {
        $existing = Get-IntuneWin32App -DisplayName $app.DisplayName -ErrorAction SilentlyContinue |
            Where-Object { $_.displayName -eq $app.DisplayName } | Select-Object -First 1
        if ($existing) {
            Write-Host "App '$($app.DisplayName)' exists ($($existing.id))."
            $obj = $existing
        }
        else {
            if (-not (Test-Path $app.Package)) {
                if ($WhatIfPreference) {
                    Write-Host "  [WhatIf] would build package and create Win32 app '$($app.DisplayName)' (package not built in preview)."
                    continue
                }
                throw "Package not found: $($app.Package). Re-run with -BuildPackages."
            }
            Write-Host "Creating app '$($app.DisplayName)'..."
            # Detection runs 64-bit (-RunAs32Bit $false) so it sees the 64-bit registry
            # view + real Program Files that claims.exe --install writes. Detect.ps1 is
            # also bitness-independent (reads the 64-bit hive explicitly) as a safety net
            # against the "not detected" 0x87D1041C failure (#132).
            $detection = New-IntuneWin32AppDetectionRuleScript -ScriptFile $app.DetectScript -EnforceSignatureCheck $false -RunAs32Bit $false
            $requirement = New-IntuneWin32AppRequirementRule -Architecture "x64" -MinimumSupportedWindowsRelease "W10_1809"
            if ($PSCmdlet.ShouldProcess($app.DisplayName, "Create Win32 app")) {
                $obj = Add-IntuneWin32App -FilePath $app.Package -DisplayName $app.DisplayName `
                    -Description $app.Description -Publisher $app.Publisher `
                    -InstallExperience "system" -RestartBehavior "suppress" `
                    -DetectionRule $detection -RequirementRule $requirement `
                    -InstallCommandLine $app.Install -UninstallCommandLine $app.Uninstall
            }
        }
        if (-not $obj) { continue }

        # Apply the scope tag (merge with any existing tags - don't clobber).
        if ($scopeTagId -and $PSCmdlet.ShouldProcess($app.DisplayName, "Apply scope tag $ScopeTagName")) {
            $current = @((Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/deviceAppManagement/mobileApps/$($obj.id)?`$select=roleScopeTagIds").roleScopeTagIds)
            $merged = @($current + "$scopeTagId" | Where-Object { $_ } | Select-Object -Unique)
            if (-not ($current -contains "$scopeTagId")) {
                Invoke-MgGraphRequest -Method PATCH -Uri "$graphBeta/deviceAppManagement/mobileApps/$($obj.id)" `
                    -Body (@{ "@odata.type" = "#microsoft.graph.win32LobApp"; roleScopeTagIds = $merged } | ConvertTo-Json) | Out-Null
            }
        }

        # Assign 'required' to the agent-pool device group. The app installs in system
        # (machine-wide) context, so the same assignment serves every current and future
        # Cloud PC in the pool's device group.
        foreach ($t in $realTargets) {
            $assigned = Get-IntuneWin32AppAssignment -ID $obj.id -ErrorAction SilentlyContinue |
                Where-Object { $_.GroupID -eq $t.Group.id }
            if ($assigned) {
                Write-Host "  Already assigned to $($t.Label) [$($t.Model)]."
            }
            elseif ($PSCmdlet.ShouldProcess($app.DisplayName, "Assign required to $($t.Label) [$($t.Model)]")) {
                Add-IntuneWin32AppAssignmentGroup -Include -ID $obj.id -GroupID $t.Group.id `
                    -Intent "required" -Notification "hideAll" | Out-Null
                Write-Host "  Assigned '$($app.DisplayName)' as required to $($t.Label) [$($t.Model)]."
            }
        }
    }
}

# ===================== Phase 3: CCaaS desktop (Edge web app) =================
# The centrally-hosted CCaaS desktop (Azure Static Web App) is delivered to the
# human agent's WORKSTATION as a Microsoft Edge force-installed web app (PWA) via
# an Intune Settings Catalog configuration policy (Edge `WebAppInstallForceList`).
#
# Why not an Intune managed web link (#microsoft.graph.webApp)? On Windows a web
# link cannot be installed onto the Cloud PC and produces no desktop icon - its
# installSummary/deviceStatuses return HTTP 400 and isAssigned stays False, so the
# app never reaches the agent. The Edge web-app policy installs a real PWA with a
# desktop + Start icon (app-mode window) while the app stays hosted centrally.
#
# Assignment is USER-centric (the workstation USER group), matching the role-based
# design: the icon follows the human agent onto whichever Cloud PC they sign into.
function Invoke-EdgePwaPhase {
    param($UserGroup)
    Write-Host "`n=== Phase 3: CCaaS desktop (Edge force-installed web app) ==="

    if ([string]::IsNullOrWhiteSpace($CcaasWebLinkUrl)) {
        Write-Host "  No -CcaasWebLinkUrl provided; skipping. (Build-DemoFromScratch.ps1 passes the live Static Web App URL automatically.)"
        return
    }

    # Resolve the workstation user group here (after the URL check) so a blank-URL run
    # never fails on a missing group, and a -Phase WebLink subset run still works.
    if (-not $UserGroup) {
        $UserGroup = Get-GroupByName -Name $UserGroupName
        if (-not $UserGroup) {
            throw "User group '$UserGroupName' not found. Run -Phase Groups first (or create agentWorkstation.userGroupName)."
        }
    }

    $profileName = $CcaasWebLinkName
    # Settings Catalog definition IDs for Edge 'Configure list of force-installed Web Apps'.
    $base = "device_vendor_msft_policy_config_microsoft_edgev80diff~policy~microsoft_edge_webappinstallforcelist"
    $appList = @(@{ url = $CcaasWebLinkUrl; create_desktop_shortcut = $true; default_launch_container = "window" })
    $appListJson = ConvertTo-Json $appList -Compress -Depth 5

    $settings = @(
        @{
            "@odata.type"   = "#microsoft.graph.deviceManagementConfigurationSetting"
            settingInstance = @{
                "@odata.type"        = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
                settingDefinitionId  = $base
                choiceSettingValue   = @{
                    "@odata.type" = "#microsoft.graph.deviceManagementConfigurationChoiceSettingValue"
                    value         = "${base}_1"
                    children      = @(
                        @{
                            "@odata.type"                = "#microsoft.graph.deviceManagementConfigurationSimpleSettingCollectionInstance"
                            settingDefinitionId          = "${base}_webappinstallforcelist"
                            simpleSettingCollectionValue = @(
                                @{
                                    "@odata.type" = "#microsoft.graph.deviceManagementConfigurationStringSettingValue"
                                    value         = $appListJson
                                }
                            )
                        }
                    )
                }
            }
        }
    )

    # Idempotent: if a policy with this name exists, delete it so the URL/settings
    # are always refreshed (Settings Catalog settings cannot be reliably PATCHed).
    $lit = ConvertTo-ODataLiteral $profileName
    $existing = (Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/deviceManagement/configurationPolicies?`$filter=name eq '$lit'").value | Select-Object -First 1
    if ($existing -and $PSCmdlet.ShouldProcess($profileName, "Delete existing Edge web-app policy ($($existing.id)) before recreating")) {
        Invoke-MgGraphRequest -Method DELETE -Uri "$graphBeta/deviceManagement/configurationPolicies/$($existing.id)" | Out-Null
        Write-Host "  Removed existing Edge web-app policy ($($existing.id)) to refresh settings."
    }

    $policy = $null
    if ($PSCmdlet.ShouldProcess($profileName, "Create Edge force-installed web-app policy -> $CcaasWebLinkUrl")) {
        $body = @{
            name         = $profileName
            description  = "Force-installs the centrally-hosted CCaaS agent desktop (Azure Static Web Apps) as a Microsoft Edge web app with a desktop icon. Opens in an Edge app window."
            platforms    = "windows10"
            technologies = "mdm"
            settings     = $settings
        }
        $policy = Invoke-MgGraphRequest -Method POST -Uri "$graphBeta/deviceManagement/configurationPolicies" -Body ($body | ConvertTo-Json -Depth 20)
        Write-Host "  Created Edge web-app policy '$profileName' ($($policy.id)) -> $CcaasWebLinkUrl."
    }
    $policy = Resolve-WhatIfPlaceholder -Object $policy -Label $profileName
    if (Test-IsWhatIfPlaceholder $policy) { return }

    if ($UserGroup -and -not (Test-IsWhatIfPlaceholder $UserGroup) -and $PSCmdlet.ShouldProcess($profileName, "Assign to $UserGroupName")) {
        $assignBody = @{
            assignments = @(
                @{
                    target = @{
                        "@odata.type" = "#microsoft.graph.groupAssignmentTarget"
                        groupId       = $UserGroup.id
                    }
                }
            )
        }
        Invoke-MgGraphRequest -Method POST -Uri "$graphBeta/deviceManagement/configurationPolicies/$($policy.id)/assign" -Body ($assignBody | ConvertTo-Json -Depth 10) | Out-Null
        Write-Host "  Assigned Edge web-app policy to $UserGroupName."
    }
}

# ================================ Orchestrate =================================
Confirm-Module -Name "Microsoft.Graph.Authentication" -MinimumVersion "2.0.0"

$graphScopes = @(
    "Group.ReadWrite.All", "GroupMember.ReadWrite.All", "Device.Read.All",
    "User.Read.All", "DeviceManagementApps.ReadWrite.All", "DeviceManagementRBAC.ReadWrite.All",
    "DeviceManagementConfiguration.ReadWrite.All"
)
Connect-DemoGraph -Scopes $graphScopes

# ================================ Orchestrate =================================
# Two-machine targeting (Option B):
#   - Agent POOL  : legacy claims Win32 app   -> DEVICE group ($DeviceGroupName).
#   - Workstation : CCaaS Edge web-app policy -> USER  group ($UserGroupName).
# The 'Groups' phase (and 'All') creates BOTH groups. Subset phases resolve only the
# group they actually need, so a partial run never fails on the unrelated group.
$deviceGroup = $null
$userGroup   = $null
if ($Phase -in @("All", "Groups")) {
    $deviceGroup = Invoke-GroupsPhase
    $userGroup   = Invoke-UserGroupPhase
}

if ($Phase -in @("All", "Apps")) {
    if (-not $deviceGroup) {
        $deviceGroup = Get-GroupByName -Name $DeviceGroupName
        if (-not $deviceGroup) { throw "Device group '$DeviceGroupName' not found. Run -Phase Groups first (or set agentPool.deviceGroupName)." }
    }
    Confirm-Module -Name "IntuneWin32App" -MinimumVersion "1.4.0"
    Connect-Intune
    Invoke-AppsPhase -DeviceGroup $deviceGroup
}

if ($Phase -in @("All", "WebLink")) {
    # Invoke-EdgePwaPhase resolves the user group itself (after the blank-URL check),
    # so a blank-URL run is a clean no-op and a -Phase WebLink subset run still works.
    Invoke-EdgePwaPhase -UserGroup $userGroup
}

Write-Host "`nDone."
if ($CcaasWebLinkUrl) { Write-Host "CCaaS app    : centrally hosted at $CcaasWebLinkUrl (Edge force-installed web app '$CcaasWebLinkName' -> user group '$UserGroupName')." }
Write-Host "Agent pool   : add a pool Cloud PC's DEVICE object to '$DeviceGroupName' (portal or -PilotCloudPcName). The claims app is delivered via Intune as a required Win32 app, so every enrolled pool Cloud PC in that group gets it automatically (see docs/w365a-pool.md)."
Write-Host "Workstation  : add the human agent's USER account to '$UserGroupName' (portal or -AgentUserName) - the CCaaS desktop icon (Edge web app) follows them onto whichever Cloud PC they sign into."
