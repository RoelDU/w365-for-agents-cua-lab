<#
.SYNOPSIS
    Tears down the Zava CCaaS / Computer-Use demo environment created by the
    Bootstrap-DemoServicePrincipal.ps1, Deploy-DemoEnvironment.ps1 and
    Deploy-Agent.ps1 scripts. Safe-by-default: previews every change unless you
    pass -Execute, and never deletes anything whose name does not match the
    demo's own resources.

.DESCRIPTION
    This is the inverse of the deploy chain. It finds (by the SAME default names
    the deploy scripts use) and removes:

      Intune / Entra (Microsoft Graph):
        - Apps  "Zava Contact Center" (the CCaaS Edge web-app config policy) and
                "Zava Claims Workstation" (the legacy Win32 claims app)
                (deleting an app/policy removes its assignments automatically)
        - App-targeting groups (whichever exist):
            * Device group "Zava-Demo-Agent-CPCs"  -> Dedicated Cloud PCs
                          (the device OBJECTS / Cloud PCs are NOT deleted)
            * User group   "Zava-Demo-Agent-Users" -> W365 Flex / Shared (multi-user)
                          (the USER accounts are NOT deleted)
        - Scope tag    "Zava-Demo"
        - App registration + service principal "W365-Demo-Automation"
                      (DESTRUCTIVE - requires -Force; this is the automation identity)

      Azure AI Foundry (data plane) + Azure (ARM):
        - Agent (assistant) "Zava Claims Intake (CUA)"
        - Its knowledge vector store(s) "... - knowledge [hash]" + the uploaded files
        - Model deployment "computer-use-preview"
                      (DESTRUCTIVE - requires -Force and the backing account id)

    Nothing the deploy scripts create touches a Windows 365 provisioning policy or
    user license group, so NO Cloud PC is deprovisioned by this teardown. Your
    pilot Cloud PC is licensed manually and is left intact; it is only REMOVED FROM
    the device group (membership), never deleted.

      Azure Static Web Apps (central CCaaS host):
        - The Free Static Web App that serves the CCaaS web app + its /api handoff
          Function (names/subscription read from the same config file the build used).
          Pass -RemoveResourceGroup to also delete the demo resource group.

.NOTES
    Preview vs execute:
        - Default            : preview only (acts like -WhatIf). Nothing is changed.
        - -Execute           : actually delete the non-destructive demo resources.
        - -Execute -Force    : ALSO delete the destructive opt-in resources
                               (app registration / service principal, model deployment).

    Authentication mirrors the deploy scripts:
        - Interactive (default) or -DeviceCode for headless sessions
        - App-only: -ClientId with -CertificateThumbprint (preferred) or -ClientSecret
        - Auto-relaunches under PowerShell 7 for interactive/device-code auth to avoid
          the Microsoft.Graph 2.x EventSource listener bug on Windows PowerShell 5.1.

    Keep this file ASCII-only: Windows PowerShell 5.1 reads a non-BOM UTF-8 .ps1 as
    ANSI, and a stray non-ASCII character (e.g. an em dash) breaks parsing.

.EXAMPLE
    # Preview everything that WOULD be removed (no changes, no Force needed):
    pwsh -File .\scripts\Remove-DemoEnvironment.ps1 -TenantId <tenant> `
        -ProjectEndpoint https://<res>.services.ai.azure.com/api/projects/<project>

.EXAMPLE
    # Remove the non-destructive demo resources for real:
    pwsh -File .\scripts\Remove-DemoEnvironment.ps1 -TenantId <tenant> `
        -ProjectEndpoint https://<res>.services.ai.azure.com/api/projects/<project> -Execute

.EXAMPLE
    # Full teardown including the app registration and the model deployment:
    pwsh -File .\scripts\Remove-DemoEnvironment.ps1 -TenantId <tenant> `
        -ProjectEndpoint https://<res>.services.ai.azure.com/api/projects/<project> `
        -AccountResourceId /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<acct> `
        -Execute -Force
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [string]$TenantId,

    # --- Authentication (interactive by default) ---
    [string]$ClientId,
    [string]$CertificateThumbprint,
    [string]$ClientSecret,
    [switch]$DeviceCode,

    # --- Which parts to remove. "All" = every phase below. ---
    [ValidateSet("All", "IntuneApps", "Group", "ScopeTag", "Foundry", "ModelDeployment", "AppRegistration", "StaticWebApp", "HandoffOrchestrator")]
    [string[]]$Phase = @("All"),

    # --- Resource names (defaults match the deploy scripts) ---
    [string[]]$AppDisplayName  = @("Zava Contact Center", "Zava Claims Workstation"),

    # App-targeting groups. The Dedicated path targets the Cloud PC DEVICE (device
    # group); the W365 Flex / Shared path targets the USER (user group). Whichever
    # of these exist are removed; the Cloud PCs and user accounts themselves are not.
    [string]$DeviceGroupName   = "Zava-Demo-Agent-CPCs",
    [string]$UserGroupName     = "Zava-Demo-Agent-Users",
    [string]$ScopeTagName      = "Zava-Demo",
    [string]$AppRegistrationName = "W365-Demo-Automation",

    # --- Foundry (only needed for the Foundry / ModelDeployment phases) ---
    [string]$ProjectEndpoint,
    [string]$AgentName   = "Zava Claims Intake (CUA)",
    [string]$ApiVersion  = "2025-05-15-preview",

    # --- Model deployment (ARM) - only used by the ModelDeployment phase ---
    [string]$ModelDeploymentName = "computer-use-preview",
    [string]$AccountResourceId,
    [string]$SubscriptionId,
    [string]$ResourceGroup,
    [string]$AccountName,
    [string]$ArmApiVersion = "2024-10-01",

    # --- Static Web App (central CCaaS host) - only used by the StaticWebApp phase -
    # Loaded from the same config file the build script uses, so the subscription,
    # resource group and SWA name match exactly what was deployed.
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'demo-config.local.json'),

    # Also delete the demo resource group after removing the Static Web App. Off by
    # default because the RG may hold other resources you did not create here.
    [switch]$RemoveResourceGroup,

    # For the HandoffOrchestrator phase: also PURGE the soft-deleted Key Vault so its
    # globally-unique name is freed immediately (otherwise it stays reserved).
    [switch]$PurgeKeyVault,

    # Actually perform deletions. Without it, the script only previews.
    [switch]$Execute,

    # Permit the DESTRUCTIVE opt-in removals (app registration / SP, model deployment).
    [switch]$Force,

    # Where to write the run transcript / error log. Defaults under out\logs.
    [string]$LogPath,

    # Internal: set when the script relaunches itself under pwsh 7. Not for manual use.
    [switch]$SkipPwshRelaunch
)

$ErrorActionPreference = "Stop"

# --- Auto-relaunch under PowerShell 7 -----------------------------------------
# Mirrors the deploy scripts: Microsoft.Graph 2.x throws an EventSource listener
# error during interactive/device-code auth on Windows PowerShell 5.1. App-only
# (cert/secret) runs are unaffected and stay on the current host.
$isAppOnly = $ClientId -and ($ClientSecret -or $CertificateThumbprint)
if (-not $SkipPwshRelaunch -and $PSVersionTable.PSVersion.Major -lt 6 -and -not $isAppOnly) {
    $pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($pwshCmd) {
        Write-Host "Relaunching under PowerShell 7 (avoids the Windows PowerShell 5.1 Microsoft.Graph telemetry listener bug)..."
        $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-SkipPwshRelaunch')
        foreach ($kv in $PSBoundParameters.GetEnumerator()) {
            $n = $kv.Key; $v = $kv.Value
            if ($n -eq 'SkipPwshRelaunch') { continue }
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

# Preview by default: unless -Execute is passed, force -WhatIf semantics so a
# careless run can NEVER delete anything.
if (-not $Execute) {
    $WhatIfPreference = $true
    Write-Host ""
    Write-Host "PREVIEW MODE (no -Execute): showing what WOULD be removed. Nothing will be changed." -ForegroundColor Yellow
    Write-Host "Re-run with -Execute to perform the deletions (add -Force for the destructive opt-in items)." -ForegroundColor Yellow
    Write-Host ""
}

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$repoRoot  = Resolve-Path (Join-Path $scriptDir "..")
$graphBeta = "https://graph.microsoft.com/beta"

# Shared helpers (config loader, az sign-in, Static Web App teardown).
. (Join-Path $scriptDir 'DemoCommon.ps1')

# --- Run log -------------------------------------------------------------------
if (-not $LogPath) {
    $logDir = Join-Path $repoRoot "out\logs"
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $LogPath = Join-Path $logDir ("Remove-DemoEnvironment_{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
}
try { Start-Transcript -LiteralPath $LogPath -Append | Out-Null; $script:transcript = $true }
catch { $script:transcript = $false; Write-Warning "Could not start a transcript ($($_.Exception.Message)). Continuing without a log file." }

# Structured record of every action so the end-of-run summary is accurate.
$script:actions = New-Object System.Collections.Generic.List[object]
function Add-Action {
    param([string]$Resource, [string]$Name, [string]$Result, [string]$Detail)
    $script:actions.Add([pscustomobject]@{ Resource = $Resource; Name = $Name; Result = $Result; Detail = $Detail })
}

$wantAll = $Phase -contains "All"
function Test-Phase { param([string]$Name) $wantAll -or ($Phase -contains $Name) }

# --- Module bootstrap (mirrors the deploy scripts) -----------------------------
function Confirm-Module {
    param([Parameter(Mandatory)][string]$Name, [string]$MinimumVersion)
    $have = Get-Module -ListAvailable -Name $Name |
        Where-Object { -not $MinimumVersion -or $_.Version -ge [version]$MinimumVersion } |
        Select-Object -First 1
    if (-not $have) {
        Write-Host "Installing module $Name (CurrentUser scope)..."
        $p = @{ Name = $Name; Scope = "CurrentUser"; Force = $true; AllowClobber = $true }
        if ($MinimumVersion) { $p.MinimumVersion = $MinimumVersion }
        Install-Module @p -ErrorAction Stop
    }
    Import-Module $Name -ErrorAction Stop
}

function ConvertTo-ODataLiteral { param([string]$Value) $Value -replace "'", "''" }

# ======================= Microsoft Graph connectivity ==========================
function Connect-DemoGraph {
    param([string[]]$Scopes)
    Confirm-Module -Name "Microsoft.Graph.Authentication" -MinimumVersion "2.0.0"
    if ($ClientId -and $CertificateThumbprint) {
        Connect-MgGraph -TenantId $TenantId -ClientId $ClientId -CertificateThumbprint $CertificateThumbprint -NoWelcome | Out-Null
        Write-Host "Connected to Graph (app-only, certificate)."
    }
    elseif ($ClientId -and $ClientSecret) {
        $sec = ConvertTo-SecureString $ClientSecret -AsPlainText -Force
        $cred = New-Object System.Management.Automation.PSCredential($ClientId, $sec)
        Connect-MgGraph -TenantId $TenantId -ClientSecretCredential $cred -NoWelcome | Out-Null
        Write-Host "Connected to Graph (app-only, secret)."
    }
    elseif ($DeviceCode) {
        Connect-MgGraph -TenantId $TenantId -Scopes $Scopes -UseDeviceAuthentication -NoWelcome | Out-Host
    }
    else {
        Connect-MgGraph -TenantId $TenantId -Scopes $Scopes -NoWelcome | Out-Null
        Write-Host "Connected to Graph (interactive)."
    }
}

# Invoke Graph and swallow a 404 (already gone) as a non-error.
function Invoke-Graph {
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Uri, $Body)
    $p = @{ Method = $Method; Uri = $Uri }
    if ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Depth 20) }
    Invoke-MgGraphRequest @p
}

function Remove-GraphResource {
    param(
        [Parameter(Mandatory)][string]$Kind,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$DeleteUri
    )
    if ($PSCmdlet.ShouldProcess("$Name ($Id)", "Delete $Kind")) {
        try {
            Invoke-MgGraphRequest -Method DELETE -Uri $DeleteUri | Out-Null
            Write-Host "  Deleted $Kind '$Name'." -ForegroundColor Green
            Add-Action -Resource $Kind -Name $Name -Result "Deleted" -Detail $Id
        }
        catch {
            Write-Warning "  Failed to delete $Kind '$Name': $($_.Exception.Message)"
            Add-Action -Resource $Kind -Name $Name -Result "Error" -Detail $_.Exception.Message
        }
    }
    else {
        Write-Host "  [preview] would delete $Kind '$Name' ($Id)." -ForegroundColor Yellow
        Add-Action -Resource $Kind -Name $Name -Result "WouldDelete" -Detail $Id
    }
}

# =========================== Phase implementations =============================
function Invoke-IntuneAppsPhase {
    Write-Host "`n== Intune apps ==" -ForegroundColor White
    foreach ($name in $AppDisplayName) {
        $lit = ConvertTo-ODataLiteral $name
        $apps = @((Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/deviceAppManagement/mobileApps?`$filter=displayName eq '$lit'").value)
        if (-not $apps -or $apps.Count -eq 0) {
            Write-Host "  Not found: '$name' (nothing to remove)."
            Add-Action -Resource "Intune app" -Name $name -Result "NotFound" -Detail ""
            continue
        }
        foreach ($app in $apps) {
            Remove-GraphResource -Kind "Intune app" -Name $name -Id $app.id `
                -DeleteUri "$graphBeta/deviceAppManagement/mobileApps/$($app.id)"
        }
    }

    # The CCaaS desktop is delivered as a Microsoft Edge force-installed web app
    # (a Settings Catalog configuration policy named after the web-link displayName),
    # not a mobileApp, so remove any matching configurationPolicies too (issue #60).
    foreach ($name in $AppDisplayName) {
        $lit = ConvertTo-ODataLiteral $name
        $policies = @((Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/deviceManagement/configurationPolicies?`$filter=name eq '$lit'").value)
        if (-not $policies -or $policies.Count -eq 0) { continue }
        foreach ($p in $policies) {
            Remove-GraphResource -Kind "Edge web-app policy" -Name $name -Id $p.id `
                -DeleteUri "$graphBeta/deviceManagement/configurationPolicies/$($p.id)"
        }
    }
}

function Invoke-GroupPhase {
    Write-Host "`n== App-targeting groups ==" -ForegroundColor White
    # Dedicated -> device group (device-context app assignment).
    # W365 Flex / Shared -> user group (user-context app assignment).
    $targets = @(
        [pscustomobject]@{ Kind = "Device group (Dedicated)"; Name = $DeviceGroupName; Note = "deleting the group removes its membership only; the Cloud PC device objects are NOT deleted." },
        [pscustomobject]@{ Kind = "User group (Flex/Shared)"; Name = $UserGroupName;   Note = "deleting the group removes its membership only; the user accounts are NOT deleted." }
    )
    foreach ($target in $targets) {
        if (-not $target.Name) { continue }
        $lit = ConvertTo-ODataLiteral $target.Name
        $groups = @((Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/groups?`$filter=displayName eq '$lit'").value)
        if (-not $groups -or $groups.Count -eq 0) {
            Write-Host "  Not found: $($target.Kind) '$($target.Name)' (nothing to remove)."
            Add-Action -Resource $target.Kind -Name $target.Name -Result "NotFound" -Detail ""
            continue
        }
        foreach ($g in $groups) {
            Write-Host "  Note: $($target.Note)"
            Remove-GraphResource -Kind $target.Kind -Name $target.Name -Id $g.id `
                -DeleteUri "$graphBeta/groups/$($g.id)"
        }
    }
}

function Invoke-ScopeTagPhase {
    Write-Host "`n== Scope tag ==" -ForegroundColor White
    $lit = ConvertTo-ODataLiteral $ScopeTagName
    $tags = @((Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/deviceManagement/roleScopeTags?`$filter=displayName eq '$lit'").value)
    if (-not $tags -or $tags.Count -eq 0) {
        Write-Host "  Not found: scope tag '$ScopeTagName' (nothing to remove)."
        Add-Action -Resource "Scope tag" -Name $ScopeTagName -Result "NotFound" -Detail ""
        return
    }
    foreach ($t in $tags) {
        if ("$($t.isBuiltIn)" -eq "True") {
            Write-Host "  Skipping built-in scope tag '$ScopeTagName'."
            Add-Action -Resource "Scope tag" -Name $ScopeTagName -Result "Skipped" -Detail "built-in"
            continue
        }
        Remove-GraphResource -Kind "Scope tag" -Name $ScopeTagName -Id $t.id `
            -DeleteUri "$graphBeta/deviceManagement/roleScopeTags/$($t.id)"
    }
}

function Invoke-AppRegistrationPhase {
    Write-Host "`n== App registration / service principal (DESTRUCTIVE) ==" -ForegroundColor White
    if (-not $Force) {
        Write-Host "  Skipped: removing the automation identity needs -Force (it is the SP the deploy scripts use)." -ForegroundColor Yellow
        Add-Action -Resource "App registration" -Name $AppRegistrationName -Result "SkippedNoForce" -Detail ""
        return
    }
    $lit = ConvertTo-ODataLiteral $AppRegistrationName
    $sps = @((Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/servicePrincipals?`$filter=displayName eq '$lit'").value)
    foreach ($sp in $sps) {
        Remove-GraphResource -Kind "Service principal" -Name $AppRegistrationName -Id $sp.id `
            -DeleteUri "$graphBeta/servicePrincipals/$($sp.id)"
    }
    $apps = @((Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/applications?`$filter=displayName eq '$lit'").value)
    if ((-not $sps -or $sps.Count -eq 0) -and (-not $apps -or $apps.Count -eq 0)) {
        Write-Host "  Not found: app registration '$AppRegistrationName' (nothing to remove)."
        Add-Action -Resource "App registration" -Name $AppRegistrationName -Result "NotFound" -Detail ""
        return
    }
    foreach ($app in $apps) {
        Remove-GraphResource -Kind "App registration" -Name $AppRegistrationName -Id $app.id `
            -DeleteUri "$graphBeta/applications/$($app.id)"
    }
}

# ===================== Azure AI Foundry (data plane) ===========================
function Get-FoundryToken {
    $supportsSecure = (Get-Command Get-AzAccessToken).Parameters.ContainsKey('AsSecureString')
    $lastError = $null
    foreach ($resource in @("https://ai.azure.com", "https://cognitiveservices.azure.com")) {
        try {
            if ($supportsSecure) {
                $t = Get-AzAccessToken -ResourceUrl $resource -AsSecureString -ErrorAction Stop
                $tok = $t.Token
                if ($tok -is [System.Security.SecureString]) {
                    $tok = [System.Net.NetworkCredential]::new("", $tok).Password
                }
            }
            else { $tok = (Get-AzAccessToken -ResourceUrl $resource -ErrorAction Stop).Token }
            if ($tok) { return $tok }
        }
        catch { $lastError = $_ }
    }
    throw "Could not obtain a Foundry data-plane token. $(if ($lastError) { $lastError.Exception.Message })"
}

function Connect-Azure {
    Confirm-Module -Name "Az.Accounts" -MinimumVersion "2.0.0"
    $ctx = Get-AzContext -ErrorAction SilentlyContinue
    if (-not $ctx -or ($TenantId -and $ctx.Tenant.Id -ne $TenantId)) {
        $p = @{}
        if ($TenantId) { $p.TenantId = $TenantId }
        if ($DeviceCode) { Connect-AzAccount @p -UseDeviceAuthentication | Out-Host }
        else { Connect-AzAccount @p | Out-Host }
    }
    $ctx = Get-AzContext -ErrorAction SilentlyContinue
    if (-not $ctx) { throw "Azure sign-in did not establish a context (add -DeviceCode for headless sessions)." }
    Write-Host "Signed in to Azure as $($ctx.Account.Id) (tenant $($ctx.Tenant.Id))."
}

function Invoke-Foundry {
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path)
    $sep = if ($Path -match '\?') { '&' } else { '?' }
    $uri = "$($script:foundryBase)$Path$sep" + "api-version=$ApiVersion"
    Invoke-RestMethod -Method $Method -Uri $uri -Headers @{ Authorization = "Bearer $($script:foundryToken)" }
}

function Get-FoundryList {
    param([Parameter(Mandatory)][string]$Path)
    $all = New-Object System.Collections.Generic.List[object]
    $after = $null
    do {
        $sep = if ($Path -match '\?') { '&' } else { '?' }
        $page = "$Path${sep}order=desc&limit=100"
        if ($after) { $page = "$page&after=$after" }
        $resp = Invoke-Foundry -Method GET -Path $page
        if ($resp.data) { foreach ($item in $resp.data) { $all.Add($item) } }
        $after = if ($resp.has_more) { $resp.last_id } else { $null }
    } while ($after)
    $all
}

function Remove-FoundryResource {
    param([string]$Kind, [string]$Name, [string]$Id, [string]$Path)
    if ($PSCmdlet.ShouldProcess("$Name ($Id)", "Delete $Kind")) {
        try {
            Invoke-Foundry -Method DELETE -Path $Path | Out-Null
            Write-Host "  Deleted $Kind '$Name' ($Id)." -ForegroundColor Green
            Add-Action -Resource $Kind -Name $Name -Result "Deleted" -Detail $Id
        }
        catch {
            Write-Warning "  Failed to delete $Kind '$Name': $($_.Exception.Message)"
            Add-Action -Resource $Kind -Name $Name -Result "Error" -Detail $_.Exception.Message
        }
    }
    else {
        Write-Host "  [preview] would delete $Kind '$Name' ($Id)." -ForegroundColor Yellow
        Add-Action -Resource $Kind -Name $Name -Result "WouldDelete" -Detail $Id
    }
}

function Invoke-FoundryPhase {
    Write-Host "`n== Foundry agent + knowledge ==" -ForegroundColor White
    if (-not $ProjectEndpoint) {
        Write-Host "  Skipped: -ProjectEndpoint not supplied. Pass it to remove the agent + vector store." -ForegroundColor Yellow
        Add-Action -Resource "Foundry" -Name "(all)" -Result "SkippedNoEndpoint" -Detail ""
        return
    }
    $script:foundryBase  = $ProjectEndpoint.TrimEnd('/')
    $script:foundryToken = Get-FoundryToken

    # Agent (assistant) by name.
    $agents = @(Get-FoundryList -Path "/assistants" | Where-Object { $_.name -eq $AgentName })
    if (-not $agents -or $agents.Count -eq 0) {
        Write-Host "  Not found: agent '$AgentName'."
        Add-Action -Resource "Foundry agent" -Name $AgentName -Result "NotFound" -Detail ""
    }
    foreach ($a in $agents) {
        Remove-FoundryResource -Kind "Foundry agent" -Name $AgentName -Id $a.id -Path "/assistants/$($a.id)"
    }

    # Knowledge vector store(s) for this agent + the files they reference.
    $vsBase = "$AgentName - knowledge"
    $stores = @(Get-FoundryList -Path "/vector_stores" | Where-Object { $_.name -like "$vsBase*" })
    if (-not $stores -or $stores.Count -eq 0) {
        Write-Host "  Not found: knowledge vector store for '$AgentName'."
        Add-Action -Resource "Foundry vector store" -Name $vsBase -Result "NotFound" -Detail ""
    }
    foreach ($vs in $stores) {
        # Collect file ids attached to the store BEFORE deleting it, so we can also
        # remove the uploaded knowledge file(s) and not orphan them.
        $fileIds = @()
        try {
            $vsFiles = Invoke-Foundry -Method GET -Path "/vector_stores/$($vs.id)/files"
            if ($vsFiles.data) { $fileIds = @($vsFiles.data | ForEach-Object { $_.id }) }
        }
        catch { Write-Warning "  Could not list files in vector store '$($vs.name)': $($_.Exception.Message)" }

        Remove-FoundryResource -Kind "Foundry vector store" -Name $vs.name -Id $vs.id -Path "/vector_stores/$($vs.id)"

        foreach ($fid in $fileIds) {
            Remove-FoundryResource -Kind "Foundry file" -Name $fid -Id $fid -Path "/files/$fid"
        }
    }
}

# ===================== Model deployment (ARM, destructive) =====================
function Resolve-AccountResourceId {
    if ($AccountResourceId) { return $AccountResourceId.TrimEnd('/') }
    if ($SubscriptionId -and $ResourceGroup -and $AccountName) {
        return "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.CognitiveServices/accounts/$AccountName"
    }
    return $null
}

function Invoke-ModelDeploymentPhase {
    Write-Host "`n== Model deployment (DESTRUCTIVE) ==" -ForegroundColor White
    if (-not $Force) {
        Write-Host "  Skipped: removing the model deployment needs -Force." -ForegroundColor Yellow
        Add-Action -Resource "Model deployment" -Name $ModelDeploymentName -Result "SkippedNoForce" -Detail ""
        return
    }
    $accId = Resolve-AccountResourceId
    if (-not $accId) {
        Write-Host "  Skipped: pass -AccountResourceId (or -SubscriptionId + -ResourceGroup + -AccountName) to remove the deployment." -ForegroundColor Yellow
        Add-Action -Resource "Model deployment" -Name $ModelDeploymentName -Result "SkippedNoAccount" -Detail ""
        return
    }
    $supportsSecure = (Get-Command Get-AzAccessToken).Parameters.ContainsKey('AsSecureString')
    if ($supportsSecure) {
        $t = Get-AzAccessToken -ResourceUrl "https://management.azure.com" -AsSecureString -ErrorAction Stop
        $armToken = $t.Token
        if ($armToken -is [System.Security.SecureString]) { $armToken = [System.Net.NetworkCredential]::new("", $armToken).Password }
    }
    else { $armToken = (Get-AzAccessToken -ResourceUrl "https://management.azure.com" -ErrorAction Stop).Token }
    $headers = @{ Authorization = "Bearer $armToken" }
    $deployUri = "https://management.azure.com$accId/deployments/${ModelDeploymentName}?api-version=$ArmApiVersion"
    try { $existing = Invoke-RestMethod -Method GET -Uri $deployUri -Headers $headers }
    catch { $existing = $null }
    if (-not $existing) {
        Write-Host "  Not found: deployment '$ModelDeploymentName' on the account."
        Add-Action -Resource "Model deployment" -Name $ModelDeploymentName -Result "NotFound" -Detail ""
        return
    }
    if ($PSCmdlet.ShouldProcess("$ModelDeploymentName (on $AccountName$accId)", "Delete model deployment")) {
        try {
            Invoke-RestMethod -Method DELETE -Uri $deployUri -Headers $headers | Out-Null
            Write-Host "  Deleted model deployment '$ModelDeploymentName'." -ForegroundColor Green
            Add-Action -Resource "Model deployment" -Name $ModelDeploymentName -Result "Deleted" -Detail $accId
        }
        catch {
            Write-Warning "  Failed to delete deployment '$ModelDeploymentName': $($_.Exception.Message)"
            Add-Action -Resource "Model deployment" -Name $ModelDeploymentName -Result "Error" -Detail $_.Exception.Message
        }
    }
    else {
        Write-Host "  [preview] would delete model deployment '$ModelDeploymentName'." -ForegroundColor Yellow
        Add-Action -Resource "Model deployment" -Name $ModelDeploymentName -Result "WouldDelete" -Detail $accId
    }
}

# ================================ Orchestration ================================
function Invoke-StaticWebAppPhase {
    Write-Host "`n== Static Web App (central CCaaS host) ==" -ForegroundColor White
    $cfg = $null
    try { $cfg = Get-DemoConfig -Path $ConfigPath }
    catch {
        Write-Warning "  Cannot load config '$ConfigPath' for the Static Web App phase: $($_.Exception.Message)"
        Add-Action -Resource "Static Web App" -Name $ConfigPath -Result "Error" -Detail $_.Exception.Message
        return
    }
    Assert-Prerequisite -Name 'az' -InstallHint 'Install the Azure CLI: winget install Microsoft.AzureCLI'
    Connect-DemoAzureCli -Config $cfg -DeviceCode:$DeviceCode
    $name = $cfg.staticWebApp.name; $rg = $cfg.staticWebApp.resourceGroup
    if ($Execute) {
        Remove-DemoStaticWebApp -Config $cfg -Execute -RemoveResourceGroup:$RemoveResourceGroup
        Add-Action -Resource "Static Web App" -Name $name -Result "Deleted" -Detail "rg=$rg$(if ($RemoveResourceGroup) { ' (+rg)' })"
    }
    else {
        Remove-DemoStaticWebApp -Config $cfg -RemoveResourceGroup:$RemoveResourceGroup
        Add-Action -Resource "Static Web App" -Name $name -Result "WouldDelete" -Detail "rg=$rg"
    }
}

function Invoke-HandoffOrchestratorPhase {
    Write-Host "`n== AI handoff orchestrator (Durable Functions) ==" -ForegroundColor White
    $cfg = $null
    try { $cfg = Get-DemoConfig -Path $ConfigPath }
    catch {
        Write-Warning "  Cannot load config '$ConfigPath' for the handoff orchestrator phase: $($_.Exception.Message)"
        Add-Action -Resource "Handoff Orchestrator" -Name $ConfigPath -Result "Error" -Detail $_.Exception.Message
        return
    }
    if (-not $cfg.handoffOrchestrator) {
        Write-Host "  No handoffOrchestrator block in config - nothing to remove."
        return
    }
    Assert-Prerequisite -Name 'az' -InstallHint 'Install the Azure CLI: winget install Microsoft.AzureCLI'
    Connect-DemoAzureCli -Config $cfg -DeviceCode:$DeviceCode
    $o = $cfg.handoffOrchestrator
    if ($Execute) {
        Remove-DemoHandoffOrchestrator -Config $cfg -Execute -PurgeKeyVault:$PurgeKeyVault
        Add-Action -Resource "Handoff Orchestrator" -Name $o.functionAppName -Result "Deleted" -Detail "rg=$($o.resourceGroup)$(if ($PurgeKeyVault) { ' (+kv purge)' })"
    }
    else {
        Remove-DemoHandoffOrchestrator -Config $cfg
        Add-Action -Resource "Handoff Orchestrator" -Name $o.functionAppName -Result "WouldDelete" -Detail "rg=$($o.resourceGroup)"
    }
}

$needGraph = (Test-Phase "IntuneApps") -or (Test-Phase "Group") -or (Test-Phase "ScopeTag") -or (Test-Phase "AppRegistration")
$needAzure = (Test-Phase "Foundry") -or (Test-Phase "ModelDeployment")
$needSwa   = Test-Phase "StaticWebApp"
$needOrch  = Test-Phase "HandoffOrchestrator"

# Best-effort: align teardown names with the same config the build used, so a custom
# deployment is torn down by the names it was actually created with. Only fills values
# the caller did NOT explicitly pass, so explicit -DeviceGroupName/etc. always win.
if (-not $PSBoundParameters.ContainsKey('AppDisplayName') -or
    -not $PSBoundParameters.ContainsKey('DeviceGroupName') -or
    -not $PSBoundParameters.ContainsKey('UserGroupName') -or
    -not $PSBoundParameters.ContainsKey('ScopeTagName') -or
    -not $PSBoundParameters.ContainsKey('AppRegistrationName')) {
    try {
        $tearCfg = Get-DemoConfig -Path $ConfigPath
        if (-not $PSBoundParameters.ContainsKey('DeviceGroupName') -and $tearCfg.agentPool.deviceGroupName) {
            $DeviceGroupName = [string]$tearCfg.agentPool.deviceGroupName
        }
        if (-not $PSBoundParameters.ContainsKey('UserGroupName') -and $tearCfg.agentWorkstation.userGroupName) {
            $UserGroupName = [string]$tearCfg.agentWorkstation.userGroupName
        }
        if (-not $PSBoundParameters.ContainsKey('ScopeTagName') -and $tearCfg.agentPool.scopeTagName) {
            $ScopeTagName = [string]$tearCfg.agentPool.scopeTagName
        }
        if (-not $PSBoundParameters.ContainsKey('AppRegistrationName') -and $tearCfg.appRegistration.displayName) {
            $AppRegistrationName = [string]$tearCfg.appRegistration.displayName
        }
        if (-not $PSBoundParameters.ContainsKey('AppDisplayName') -and $tearCfg.agentWorkstation.webLink.displayName) {
            # Keep the legacy Win32 app name(s) and also remove the configured CCaaS
            # web-link app, so a renamed web link is still cleaned up.
            $linkName = [string]$tearCfg.agentWorkstation.webLink.displayName
            if ($AppDisplayName -notcontains $linkName) { $AppDisplayName = @($AppDisplayName + $linkName) }
        }
        Write-Host "Config  : aligned teardown names with '$ConfigPath'." -ForegroundColor DarkGray
    }
    catch {
        Write-Host "Config  : '$ConfigPath' not loaded ($($_.Exception.Message)); using parameter defaults." -ForegroundColor DarkGray
    }
}

Write-Host "Zava demo environment teardown" -ForegroundColor White
Write-Host "Tenant  : $TenantId"
Write-Host "Phases  : $($Phase -join ', ')"
Write-Host "Mode    : $(if ($Execute) { 'EXECUTE' } else { 'PREVIEW (no changes)' })$(if ($Force) { ' + Force (destructive opt-ins enabled)' })"
Write-Host ""

try {
    if ($needGraph) {
        $graphScopes = @(
            "Group.ReadWrite.All",
            "DeviceManagementApps.ReadWrite.All",
            "DeviceManagementConfiguration.ReadWrite.All",
            "DeviceManagementRBAC.ReadWrite.All",
            "Application.ReadWrite.All"
        )
        Connect-DemoGraph -Scopes $graphScopes
        if (Test-Phase "IntuneApps")      { Invoke-IntuneAppsPhase }
        if (Test-Phase "Group")           { Invoke-GroupPhase }
        if (Test-Phase "ScopeTag")        { Invoke-ScopeTagPhase }
        if (Test-Phase "AppRegistration") { Invoke-AppRegistrationPhase }
    }

    if ($needAzure) {
        Connect-Azure
        if (Test-Phase "Foundry")         { Invoke-FoundryPhase }
        if (Test-Phase "ModelDeployment") { Invoke-ModelDeploymentPhase }
    }

    if ($needSwa) {
        Invoke-StaticWebAppPhase
    }

    if ($needOrch) {
        Invoke-HandoffOrchestratorPhase
    }
}
finally {
    # --- Summary -----------------------------------------------------------------
    Write-Host "`n================ Teardown summary ================" -ForegroundColor White
    if ($script:actions.Count -eq 0) {
        Write-Host "No matching demo resources were found." -ForegroundColor Yellow
    }
    else {
        $script:actions | Format-Table Resource, Name, Result, Detail -AutoSize | Out-Host
    }
    $errs = @($script:actions | Where-Object { $_.Result -eq "Error" })
    if (-not $Execute) {
        Write-Host "PREVIEW complete. Re-run with -Execute to apply (add -Force for destructive items)." -ForegroundColor Yellow
    }
    elseif ($errs.Count) {
        Write-Host "$($errs.Count) deletion(s) failed - see the warnings above and the log." -ForegroundColor Red
    }
    else {
        Write-Host "Teardown complete." -ForegroundColor Green
    }
    if ($script:transcript) { try { Stop-Transcript | Out-Null; Write-Host "Log: $LogPath" } catch {} }
    if ($needGraph) { try { Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null } catch {} }
}

if (@($script:actions | Where-Object { $_.Result -eq "Error" }).Count) { exit 1 }
