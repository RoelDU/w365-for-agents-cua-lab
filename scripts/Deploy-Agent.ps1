<#
.SYNOPSIS
    Creates (or updates) the Zava CCaaS -> CUA claims-intake agent in an Azure AI
    Foundry project from the in-repo agent assets - the automatable half of
    "Step 5 - Create the AI Agent". Preview features are used by design.

.DESCRIPTION
    This is the code-first counterpart to Confirm-AgentAssets.ps1 (which only lints
    the assets and prints the portal mapping). Using the Foundry Agent Service
    data-plane API (assistants-compatible), it does everything that HAS a public
    API, idempotently:

      1. Knowledge   Uploads KNOWLEDGE.md and builds a vector store so the agent can
                     retrieve it on demand (file_search).
      2. Instructions Combines AGENT-INSTRUCTIONS.md (behaviour) and
                     CUA-TOOL-INSTRUCTIONS.md (UI navigation) into the agent's
                     instructions, headers stripped.
      3. Tools       Registers the function tools in tools\*.json, attaches the
                     file_search (knowledge) tool, and adds the Computer Use
                     (computer_use_preview) tool. Web search is intentionally NOT
                     added (the demo must stay self-contained).
      4. Agent       Creates the agent with the chosen model deployment, or updates
                     it in place if one with the same name already exists.
      5. Model       (Optional, -CreateModelDeployment) Creates the model deployment
         deployment  on the backing Azure AI Services account via ARM, so the agent
                     has a deployment to target. Access approval is still a human
                     gate, but the deployment itself IS scriptable.

    THE ONE MANUAL STEP (everything else here is scripted or automatic):
      - Approving access to the 'computer-use-preview' model (human gate:
        https://aka.ms/oai/cuaaccess). The DEPLOYMENT after approval is automated by
        -CreateModelDeployment.
    Automatic / one-click (not script work):
      - The agent's Entra Agent ID is auto-provisioned when the agent is published
        to Agent 365 (no manual registration).
      - Pointing Computer Use at the Cloud PC is a single click in the agent's
        Settings -> Connections (refresh before each demo).
    Optional enterprise scale-out (documented, not baked in - see
    docs\agent-cua-setup.md): governed Entra Agent ID blueprints and a Windows 365
    for Agents pool (session API). Not needed for the demo.

.NOTES
    Auth: interactive Azure sign-in (Connect-AzAccount) by default; add -DeviceCode
    to sign in from another device. Run under PowerShell 7 (pwsh) - multipart file
    upload uses Invoke-RestMethod -Form (PS 7+).

    Idempotent: re-running detects and reuses the agent, vector store, and knowledge
    file by name. Supports -WhatIf.

.EXAMPLE
    pwsh -File .\scripts\Deploy-Agent.ps1 `
        -ProjectEndpoint https://my-foundry.services.ai.azure.com/api/projects/zava-demo `
        -ModelDeploymentName computer-use-preview -DeviceCode -WhatIf

.EXAMPLE
    # Also create the computer-use-preview deployment (after access is approved):
    pwsh -File .\scripts\Deploy-Agent.ps1 `
        -ProjectEndpoint https://my-foundry.services.ai.azure.com/api/projects/zava-demo `
        -CreateModelDeployment -SubscriptionId <sub> -ResourceGroup <rg> -AccountName <aiservices-account>
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Foundry project endpoint, e.g.
    #   https://<resource>.services.ai.azure.com/api/projects/<project>
    # (older form: https://<resource>.ai.azure.com/api/projects/<project>)
    [Parameter(Mandatory = $true)]
    [string]$ProjectEndpoint,

    # The model deployment the agent uses. Computer Use needs the access-gated
    # 'computer-use-preview' deployment (see docs\agent-cua-setup.md).
    [string]$ModelDeploymentName = "computer-use-preview",

    [string]$AgentName = "Zava Claims Intake (CUA)",

    # Folder holding the agent assets. Defaults to the in-repo sample set.
    [string]$AssetRoot,

    # Data-plane API version. Parameterised so it is trivial to pin/bump as the
    # Foundry Agent Service preview evolves.
    [string]$ApiVersion = "2025-05-15-preview",

    # Browser-free interactive sign-in (prints a URL + code to use on any device).
    [switch]$DeviceCode,

    # Skip adding the Computer Use tool (e.g. before model access is approved) so
    # the rest of the agent can still be provisioned.
    [switch]$SkipComputerUseTool,

    # Optional: a Tenant to sign into.
    [string]$TenantId,

    # Optional: also create the model deployment on the backing Azure AI Services
    # account (control-plane / ARM) so the agent has a deployment to target. Access
    # to 'computer-use-preview' must already be approved for the subscription.
    [switch]$CreateModelDeployment,

    # ARM resource id of the Azure AI Services / Cognitive Services account that
    # backs the Foundry project, e.g.
    #   /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>
    # Either supply this, or -SubscriptionId + -ResourceGroup + -AccountName.
    [string]$AccountResourceId,
    [string]$SubscriptionId,
    [string]$ResourceGroup,
    [string]$AccountName,

    # Model to deploy (deployment name = -ModelDeploymentName). Version is optional;
    # when omitted the script picks the newest version offered for the account.
    [string]$ModelName = "computer-use-preview",
    [string]$ModelVersion,
    [string]$DeploymentSku = "GlobalStandard",
    [ValidateRange(1, 100000)]
    [int]$DeploymentCapacity = 1,

    # Allow updating an existing model deployment whose settings differ from the
    # requested ones. Without this, a mismatch stops with guidance (no surprise edits).
    [switch]$ForceUpdateModelDeployment,

    # Allow reusing/updating an agent or vector store that already exists under the
    # same name but was NOT created by this script (lacks our managedBy metadata).
    [switch]$AdoptExisting,

    # ARM api-version for Microsoft.CognitiveServices deployments.
    [string]$ArmApiVersion = "2024-10-01",

    # Optional: write the created/updated agent id to this file (one line, ASCII).
    # Build-DemoFromScratch.ps1 uses this to auto-wire FOUNDRY_AGENT_ID into the SWA.
    [string]$AgentIdOutFile
)

$ErrorActionPreference = "Stop"

# Top-level handler: turn any terminating error into a clean, actionable block
# instead of a raw PowerShell stack trace, and exit non-zero for CI/automation.
trap {
    Write-Host ""
    Write-Host "============================ DEPLOYMENT FAILED ============================" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "==========================================================================" -ForegroundColor Red
    Write-Host "The script is idempotent - fix the issue above and re-run; completed steps are reused." -ForegroundColor Yellow
    Write-Host "Full reference: docs\agent-cua-setup.md (Troubleshooting)." -ForegroundColor Yellow
    exit 1
}

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw @"

ERROR: this script needs PowerShell 7 (pwsh), but you're on $($PSVersionTable.PSVersion).
What to do  :
  - Install it:  winget install --id Microsoft.PowerShell
  - Then re-run with pwsh, e.g.:  pwsh -File .\scripts\Deploy-Agent.ps1 -ProjectEndpoint <url>
  (Multipart knowledge upload uses Invoke-RestMethod -Form, which is PS 7+ only.)
"@
}

# Validate the project endpoint shape early so a typo fails here, not mid-deploy.
if ($ProjectEndpoint -notmatch '^https://[^/]+/api/projects/[^/]+') {
    throw @"

ERROR: -ProjectEndpoint doesn't look like a Foundry project endpoint.
Got         : $ProjectEndpoint
Expected    : https://<resource>.services.ai.azure.com/api/projects/<project>
              (older form: https://<resource>.ai.azure.com/api/projects/<project>)
What to do  :
  - Copy it from the Foundry portal: your project > Overview > 'Project endpoint' / 'Endpoint'.
"@
}

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $AssetRoot) {
    $AssetRoot = Join-Path $scriptDir "..\apps\legacy-claims-workstation\samples\foundry-agent"
}
if (-not (Test-Path -LiteralPath $AssetRoot)) {
    throw @"

ERROR: agent asset folder not found.
Path        : $AssetRoot
What to do  :
  - Run the script from the repo (it defaults to apps\legacy-claims-workstation\samples\foundry-agent), or
  - Pass -AssetRoot pointing at a folder containing AGENT-INSTRUCTIONS.md, CUA-TOOL-INSTRUCTIONS.md and KNOWLEDGE.md.
"@
}
$AssetRoot = (Resolve-Path -LiteralPath $AssetRoot).Path
$base = $ProjectEndpoint.TrimEnd('/')

# --- Module bootstrap ----------------------------------------------------------
function Confirm-Module {
    param([Parameter(Mandatory)][string]$Name, [string]$MinimumVersion)
    $have = Get-Module -ListAvailable -Name $Name |
        Where-Object { -not $MinimumVersion -or $_.Version -ge [version]$MinimumVersion } |
        Select-Object -First 1
    if (-not $have) {
        Write-Host "Installing module $Name (CurrentUser scope)..."
        $p = @{ Name = $Name; Scope = "CurrentUser"; Force = $true; AllowClobber = $true }
        if ($MinimumVersion) { $p.MinimumVersion = $MinimumVersion }
        try {
            Install-Module @p -ErrorAction Stop
        }
        catch {
            throw @"

ERROR: could not install the '$Name' PowerShell module.
Detail      : $($_.Exception.Message)
What to do  :
  - Make sure the PowerShell Gallery is reachable, then retry:
        Install-Module $Name -Scope CurrentUser -Force
  - First-time setup may need:
        Register-PSRepository -Default
        Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
        Install-PackageProvider -Name NuGet -Force
  - Behind a proxy:  set HTTP_PROXY / HTTPS_PROXY, or install the module offline.
"@
        }
    }
    try {
        Import-Module $Name -ErrorAction Stop
    }
    catch {
        throw @"

ERROR: could not load the '$Name' PowerShell module.
Detail      : $($_.Exception.Message)
What to do  :
  - Install it manually:  Install-Module $Name -Scope CurrentUser -Force
  - If that fails, register the gallery first:
        Register-PSRepository -Default
        Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
  - Behind a proxy/offline machine, copy the module onto a `$env:PSModulePath folder.
"@
    }
}

# --- HTTP error formatting -----------------------------------------------------
# Extracts the status code and the service's own error message from a failed
# Invoke-RestMethod call (PS 7 puts the response body in ErrorDetails.Message).
function Get-HttpErrorDetail {
    param([Parameter(Mandatory)][System.Management.Automation.ErrorRecord]$ErrorRecord)
    $status = $null
    try {
        if ($ErrorRecord.Exception.PSObject.Properties['Response'] -and $ErrorRecord.Exception.Response) {
            $status = [int]$ErrorRecord.Exception.Response.StatusCode
        }
    }
    catch { }
    $body = $null
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        $body = $ErrorRecord.ErrorDetails.Message.Trim()
    }
    $apiMsg = $null
    if ($body) {
        try {
            $j = $body | ConvertFrom-Json -ErrorAction Stop
            if ($j.error.message)    { $apiMsg = $j.error.message }
            elseif ($j.error.code)   { $apiMsg = $j.error.code }
            elseif ($j.message)      { $apiMsg = $j.message }
        }
        catch { }
    }
    [pscustomobject]@{
        Status     = $status
        Body       = $body
        ApiMessage = $apiMsg
        Message    = $ErrorRecord.Exception.Message
    }
}

# Throws a single, well-formatted, actionable error block.
function Stop-WithGuidance {
    param(
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][System.Management.Automation.ErrorRecord]$ErrorRecord,
        [string[]]$Guidance
    )
    $d = Get-HttpErrorDetail -ErrorRecord $ErrorRecord
    $detail = if ($d.ApiMessage) { $d.ApiMessage } else { $d.Message }
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("")
    $lines.Add("ERROR during: $Operation")
    if ($d.Status) { $lines.Add("HTTP status : $($d.Status)") }
    $lines.Add("Detail      : $detail")
    if ($Guidance -and $Guidance.Count) {
        $lines.Add("What to do  :")
        foreach ($g in $Guidance) { $lines.Add("  - $g") }
    }
    if ($d.Body -and $d.Body -ne $d.ApiMessage) {
        $lines.Add("Raw response: $($d.Body)")
    }
    throw ($lines -join [Environment]::NewLine)
}

# --- Authentication ------------------------------------------------------------
# Foundry data-plane tokens are issued for the Azure AI audience. Az PowerShell is
# used purely to obtain that bearer token for the signed-in admin.
function Connect-Foundry {
    Confirm-Module -Name "Az.Accounts" -MinimumVersion "2.0.0"
    $ctx = Get-AzContext -ErrorAction SilentlyContinue
    # Force a fresh sign-in when there is no context, the existing context is for a
    # different tenant, OR -DeviceCode was explicitly requested. The last case matters:
    # a stale Az context for the WRONG account in the SAME tenant would otherwise be
    # silently reused even though the caller asked for a device-code sign-in to select
    # the intended account, then Foundry data-plane auth fails for that wrong identity
    # (issue #19). -DeviceCode therefore always refreshes the context.
    $needSignIn = (-not $ctx) -or ($TenantId -and $ctx.Tenant.Id -ne $TenantId) -or $DeviceCode
    if ($needSignIn) {
        if ($DeviceCode -and $ctx) {
            Write-Host "  -DeviceCode requested: ignoring the existing Az context for $($ctx.Account.Id) and forcing a fresh device-code sign-in."
        }
        $p = @{}
        if ($TenantId) { $p.TenantId = $TenantId }
        try {
            if ($DeviceCode) {
                Write-Host "Authenticating with device code (open the URL below on any device)..."
                Connect-AzAccount @p -UseDeviceAuthentication | Out-Host
            }
            else {
                Write-Host "Authenticating interactively (sign in as the agent owner)..."
                Connect-AzAccount @p | Out-Host
            }
        }
        catch {
            throw @"

ERROR: Azure sign-in failed.
Detail      : $($_.Exception.Message)
What to do  :
  - Re-run the script and complete the sign-in prompt as the agent owner.
  - If the browser pop-up didn't appear (RDP/SSH/headless session), re-run with -DeviceCode.
  - If you got 'tenant not found' or signed into the wrong tenant, pass
    -TenantId $(if ($TenantId) { $TenantId } else { '<your-tenant-id>' }).
  - If sign-in is blocked by Conditional Access, use an account/location that is allowed.
"@
        }
    }
    $ctx = Get-AzContext -ErrorAction SilentlyContinue
    if (-not $ctx) {
        throw "Azure sign-in did not establish a context. Re-run and complete the sign-in (add -DeviceCode for headless sessions)."
    }
    Write-Host "Signed in as $($ctx.Account.Id) (tenant $($ctx.Tenant.Id))."
}

function Get-FoundryToken {
    # The Azure AI Foundry data plane accepts tokens for the cognitive-services /
    # ai.azure.com audience. Try the AI audience first, fall back to ARM-less CS.
    $supportsSecure = (Get-Command Get-AzAccessToken).Parameters.ContainsKey('AsSecureString')
    $lastError = $null
    foreach ($resource in @("https://ai.azure.com", "https://cognitiveservices.azure.com")) {
        try {
            if ($supportsSecure) {
                # Az.Accounts 5.x returns a SecureString by default; request it
                # explicitly to silence the deprecation warning, then unwrap.
                $t = Get-AzAccessToken -ResourceUrl $resource -AsSecureString -ErrorAction Stop
                $tok = $t.Token
                if ($tok -is [System.Security.SecureString]) {
                    $tok = [System.Net.NetworkCredential]::new("", $tok).Password
                }
            }
            else {
                $t = Get-AzAccessToken -ResourceUrl $resource -ErrorAction Stop
                $tok = $t.Token
            }
            if ($tok) { return $tok }
        }
        catch { $lastError = $_ }
    }
    throw @"

ERROR: could not obtain a Foundry data-plane access token for the signed-in identity.
Detail      : $(if ($lastError) { $lastError.Exception.Message } else { 'no token returned for either audience.' })
What to do  :
  - Confirm you are signed in: run 'Get-AzContext'. If empty, re-run this script (add -DeviceCode if headless).
  - Ensure you signed into the tenant that owns the Foundry project (pass -TenantId $(if ($TenantId) { $TenantId } else { '<your-tenant-id>' })).
  - Update Az.Accounts:  Update-Module Az.Accounts -Scope CurrentUser
  - If your org blocks the 'https://ai.azure.com' audience, the cognitiveservices audience is tried automatically;
    a failure of both usually means a tenant/Conditional-Access restriction - try a different account.
"@
}

# Obtain an ARM (management.azure.com) token for control-plane calls, hardened for
# Az.Accounts 5.x SecureString return.
function Get-ArmToken {
    $supportsSecure = (Get-Command Get-AzAccessToken).Parameters.ContainsKey('AsSecureString')
    if ($supportsSecure) {
        $t = Get-AzAccessToken -ResourceUrl "https://management.azure.com" -AsSecureString -ErrorAction Stop
        $tok = $t.Token
        if ($tok -is [System.Security.SecureString]) {
            $tok = [System.Net.NetworkCredential]::new("", $tok).Password
        }
        return $tok
    }
    (Get-AzAccessToken -ResourceUrl "https://management.azure.com" -ErrorAction Stop).Token
}

# Resolve + validate the backing account's ARM resource id. Throws a clear,
# actionable error when the required parameters are missing or malformed. Safe to
# call in preflight (no network) so a forgotten id fails before the sign-in.
function Get-AccountResourceId {
    if ($AccountResourceId) {
        if ($AccountResourceId -notmatch '^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.CognitiveServices/accounts/[^/]+/?$') {
            throw @"

ERROR: -AccountResourceId is not a valid Azure AI Services account resource id.
Got         : $AccountResourceId
Expected    : /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>
"@
        }
        return $AccountResourceId.TrimEnd('/')
    }
    if (-not ($SubscriptionId -and $ResourceGroup -and $AccountName)) {
        throw @"

ERROR: -CreateModelDeployment needs the backing Azure AI Services account.
What to do  :
  - Pass -AccountResourceId /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>
  - OR pass all three: -SubscriptionId <sub> -ResourceGroup <rg> -AccountName <account>
  (This is checked up front so you don't sign in and then discover it's missing.)
"@
    }
    "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.CognitiveServices/accounts/$AccountName"
}

# Poll an ARM model deployment until it reaches a terminal provisioning state.
function Wait-DeploymentReady {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][hashtable]$Headers,
        [int]$TimeoutSec = 300
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $d = Invoke-RestMethod -Method GET -Uri $Uri -Headers $Headers
        $state = "$($d.properties.provisioningState)"
        switch ($state) {
            "Succeeded" { return $d }
            "Failed"    { throw "Model deployment '$ModelDeploymentName' provisioning FAILED. Check the deployment in the Azure portal." }
            "Canceled"  { throw "Model deployment '$ModelDeploymentName' provisioning was Canceled. Re-run to retry." }
            default     { Write-Host "  ...deployment state: $state (waiting)"; Start-Sleep -Seconds 5 }
        }
    }
    Write-Warning "Deployment '$ModelDeploymentName' still provisioning after $TimeoutSec s; continuing - it may finish shortly."
    return $null
}

# Create (or update) the model deployment on the backing Azure AI Services account
# via ARM. Access to the model must already be approved for the subscription; the
# deployment itself is a standard, scriptable control-plane PUT. Idempotent: reuses
# an existing deployment that already matches, and refuses to silently change a
# differing one unless -ForceUpdateModelDeployment is set.
function New-ModelDeployment {
    $accountId = Get-AccountResourceId
    # -AccountName is blank when the caller passed -AccountResourceId instead, so derive
    # a display name from the resolved id (its last segment) for error messages (#27).
    $accountDisplay = if ($AccountName) { $AccountName } else { ($accountId -split '/')[-1] }
    $armToken = Get-ArmToken
    $armHeaders = @{ Authorization = "Bearer $armToken" }

    # Resolve the model version if not supplied: list the account's offered models
    # and pick the newest version for the requested model name.
    $version = $ModelVersion
    if (-not $version) {
        $modelsUri = "https://management.azure.com$accountId/models?api-version=$ArmApiVersion"
        try {
            $models = (Invoke-RestMethod -Method GET -Uri $modelsUri -Headers $armHeaders).value |
                Where-Object { $_.model.name -eq $ModelName }
            $version = ($models.model.version | Sort-Object -Descending | Select-Object -First 1)
        }
        catch {
            $d = Get-HttpErrorDetail -ErrorRecord $_
            $g = switch ($d.Status) {
                403 { @("The signed-in identity can't read models on this account.",
                        "Grant it 'Cognitive Services Contributor' (or Contributor) on $accountId.") }
                404 { @("The account wasn't found. Check -SubscriptionId/-ResourceGroup/-AccountName (or -AccountResourceId).",
                        "Current target: $accountId") }
                default { @("Pass an explicit -ModelVersion to skip this lookup.") }
            }
            Stop-WithGuidance -Operation "list models on $accountDisplay (ARM)" -ErrorRecord $_ -Guidance $g
        }
        if (-not $version) {
            throw @"

ERROR: model '$ModelName' is not available on account '$accountDisplay'.
What to do  :
  - This almost always means access to '$ModelName' has NOT been approved yet for the subscription.
    Request it at https://aka.ms/oai/cuaaccess (a human approval - no API), then re-run with -CreateModelDeployment.
  - If access IS approved but the model is region-limited, deploy in a supported region, or pass -ModelVersion explicitly.
"@
        }
        Write-Host "Resolved '$ModelName' version: $version"
    }

    $deployUri = "https://management.azure.com$accountId/deployments/${ModelDeploymentName}?api-version=$ArmApiVersion"

    # Idempotency: if a deployment with this name already exists, compare settings
    # before touching it (no destructive surprises on re-run).
    $existing = $null
    try {
        $existing = Invoke-RestMethod -Method GET -Uri $deployUri -Headers $armHeaders
    }
    catch {
        $d = Get-HttpErrorDetail -ErrorRecord $_
        if ($d.Status -ne 404) {
            Stop-WithGuidance -Operation "read model deployment '$ModelDeploymentName' (ARM)" -ErrorRecord $_ `
                -Guidance @("Confirm 'Cognitive Services Contributor' on $accountId and that the account exists.")
        }
    }
    if ($existing) {
        $em = $existing.properties.model
        $same = ("$($em.name)" -eq $ModelName) -and ("$($em.version)" -eq "$version") -and `
                ("$($existing.sku.name)" -eq $DeploymentSku) -and ([int]$existing.sku.capacity -eq $DeploymentCapacity)
        if ($same) {
            Write-Host "Model deployment '$ModelDeploymentName' already matches requested settings - reusing." -ForegroundColor Green
            return (Wait-DeploymentReady -Uri $deployUri -Headers $armHeaders)
        }
        if (-not $ForceUpdateModelDeployment) {
            throw @"

ERROR: a model deployment named '$ModelDeploymentName' already exists with DIFFERENT settings.
Existing    : model=$($em.name) v$($em.version), sku=$($existing.sku.name), capacity=$($existing.sku.capacity)
Requested   : model=$ModelName v$version, sku=$DeploymentSku, capacity=$DeploymentCapacity
What to do  :
  - If the existing one is fine, omit -CreateModelDeployment (just point the agent at it), OR
  - Pass -ForceUpdateModelDeployment to overwrite it with the requested settings, OR
  - Delete it in the Azure portal and re-run.
"@
        }
        Write-Host "Updating existing deployment '$ModelDeploymentName' (-ForceUpdateModelDeployment)..." -ForegroundColor Yellow
    }

    $deployBody = [ordered]@{
        sku        = [ordered]@{ name = $DeploymentSku; capacity = $DeploymentCapacity }
        properties = [ordered]@{
            model = [ordered]@{ format = "OpenAI"; name = $ModelName; version = $version }
        }
    }
    if ($PSCmdlet.ShouldProcess($ModelDeploymentName, "Create/Update model deployment '$ModelName' v$version on $accountId")) {
        try {
            $r = Invoke-RestMethod -Method PUT -Uri $deployUri -Headers $armHeaders `
                -Body ($deployBody | ConvertTo-Json -Depth 10) -ContentType "application/json"
        }
        catch {
            $d = Get-HttpErrorDetail -ErrorRecord $_
            $g = switch ($d.Status) {
                401 { @("Your ARM token expired. Re-run the script to sign in again.") }
                403 { @("Either you lack permission, or access to '$ModelName' isn't approved.",
                        "Grant 'Cognitive Services Contributor' on $accountId, AND confirm model access at https://aka.ms/oai/cuaaccess.") }
                404 { @("The account wasn't found. Verify -SubscriptionId/-ResourceGroup/-AccountName (or -AccountResourceId).",
                        "Current target: $accountId") }
                409 { @("A deployment named '$ModelDeploymentName' conflicts. Pass -ForceUpdateModelDeployment, or delete it in the portal.") }
                429 { @("Quota or rate limit hit. Lower -DeploymentCapacity (current: $DeploymentCapacity), or request more quota.") }
                default {
                    if ($d.Status -ge 500) { @("Azure returned a server error - usually transient. Retry shortly.") }
                    else { @("Check the SKU ('$DeploymentSku'), capacity ($DeploymentCapacity), and that '$ModelName' v$version is offered in this region.") }
                }
            }
            Stop-WithGuidance -Operation "create model deployment '$ModelDeploymentName' (ARM)" -ErrorRecord $_ -Guidance $g
        }
        Write-Host "Model deployment '$ModelDeploymentName' ($ModelName v$version) submitted; waiting for it to be ready..." -ForegroundColor Green
        $ready = Wait-DeploymentReady -Uri $deployUri -Headers $armHeaders
        if ($ready) {
            Write-Host "Model deployment '$ModelDeploymentName' is ready." -ForegroundColor Green
        }
        return $ready
    }
}

# Resolve the backing account id WITHOUT throwing - returns $null when the caller
# didn't supply enough to locate the account. Used by the read-only deployment
# preflight so a standalone run with no account args degrades to a warning rather
# than a hard error.
function Resolve-AccountResourceIdSoft {
    if ($AccountResourceId) { return $AccountResourceId.TrimEnd('/') }
    if ($SubscriptionId -and $ResourceGroup -and $AccountName) {
        return "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.CognitiveServices/accounts/$AccountName"
    }
    return $null
}

# Read-only preflight: confirm the model deployment the agent will reference
# (-ModelDeploymentName) actually exists and is Succeeded on the backing account.
# Without this, -WhatIf reported the Foundry phase as green even though the real
# agent create would fail because computer-use-preview was never deployed (issue
# #22). Skipped when -CreateModelDeployment is set (this run creates it).
function Test-ModelDeploymentReady {
    if ($CreateModelDeployment) { return }
    $accountId = Resolve-AccountResourceIdSoft
    if (-not $accountId) {
        Write-Warning ("Could not verify the '$ModelDeploymentName' model deployment: no backing account was provided " +
            "(pass -AccountResourceId, or -SubscriptionId/-ResourceGroup/-AccountName). The agent references this " +
            "deployment, so if it does not exist the real (non-WhatIf) run will fail at agent creation.")
        return
    }
    $armHeaders = @{ Authorization = "Bearer $(Get-ArmToken)" }
    # Brace-wrap ${ModelDeploymentName}: in PowerShell 7 "$var?..." is parsed as the
    # null-conditional operator, which swallows the name and the '?', producing a URI
    # with NO ?api-version= query string -> ARM 400 MissingApiVersionParameter (#25).
    $deployUri = "https://management.azure.com$accountId/deployments/${ModelDeploymentName}?api-version=$ArmApiVersion"
    try {
        $dep = Invoke-RestMethod -Method GET -Uri $deployUri -Headers $armHeaders
    }
    catch {
        $d = Get-HttpErrorDetail -ErrorRecord $_
        if ($d.Status -eq 404) {
            throw @"

ERROR: the Foundry model deployment '$ModelDeploymentName' does not exist on account
  $accountId
The agent uses this deployment (model = '$ModelDeploymentName'), so creating the agent would fail.
What to do  :
  - Request '$ModelName' access at https://aka.ms/oai/cuaaccess (a human approval - no API), then
  - create the deployment: re-run with -CreateModelDeployment (needs -AccountResourceId or
    -SubscriptionId/-ResourceGroup/-AccountName), or create it in the Azure portal, OR
  - if you mean to use a different, already-deployed model, pass -ModelDeploymentName <existing-deployment>.
"@
        }
        $g = switch ($d.Status) {
            403 { @("The signed-in identity can't read deployments on this account.",
                    "Grant it 'Cognitive Services Contributor' (or Contributor) on $accountId, then re-run.") }
            default { @("Confirm the account exists and that you can read its deployments: $accountId") }
        }
        Stop-WithGuidance -Operation "verify model deployment '$ModelDeploymentName' (ARM)" -ErrorRecord $_ -Guidance $g
    }
    $state = "$($dep.properties.provisioningState)"
    if ($state -eq "Succeeded") {
        Write-Host "  [ok] model deployment '$ModelDeploymentName' is deployed (Succeeded)."
    }
    else {
        Write-Warning "Model deployment '$ModelDeploymentName' exists but its provisioning state is '$state' (not Succeeded yet). The agent may fail until it finishes."
    }
}

# --- REST helper ---------------------------------------------------------------
function Invoke-Foundry {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Path,   # begins with '/'
        $Body,
        [hashtable]$Form
    )
    $sep = if ($Path -match '\?') { '&' } else { '?' }
    $uri = "$base$Path$sep" + "api-version=$ApiVersion"
    $headers = @{ Authorization = "Bearer $script:token" }
    $p = @{ Method = $Method; Uri = $uri; Headers = $headers }
    if ($Form) {
        $p.Form = $Form
    }
    elseif ($null -ne $Body) {
        $p.Body = ($Body | ConvertTo-Json -Depth 30)
        $p.ContentType = "application/json"
    }
    try {
        Invoke-RestMethod @p
    }
    catch {
        $d = Get-HttpErrorDetail -ErrorRecord $_
        $bodyText = "$($d.ApiMessage) $($d.Body)"
        # A missing Foundry/AIServices *data action* surfaces as HTTP 401/403 with a
        # PermissionDenied body. That is an RBAC gap, NOT a bad/expired token, so the
        # generic "re-sign-in" guidance below would send the user down the wrong path
        # (issue #21). Detect it from the response body and give role-grant guidance.
        $missingAction = $null
        if ($bodyText -match "data action ``?([A-Za-z0-9.\/_-]+)``?") { $missingAction = $Matches[1] }
        $isPermissionDenied = ($bodyText -match 'PermissionDenied') -or
                              ($bodyText -match 'lacks the required data action') -or $missingAction
        if ($isPermissionDenied) {
            $actionLine = if ($missingAction) { "The signed-in principal is missing the Foundry data action '$missingAction'." }
                          else { "The signed-in principal is missing a required Foundry data action (PermissionDenied)." }
            $pg = @($actionLine,
                "This is an RBAC gap on the Foundry project/account, NOT a token or tenant problem - do NOT re-authenticate.",
                "Grant the signing-in identity a role that includes the AIServices agent data actions on the Foundry account/project scope,",
                "  e.g. 'Azure AI User' (read), or 'Azure AI Developer'/'Cognitive Services Contributor' for read+write, or 'Owner'.",
                "Then wait for role propagation (can take a few minutes) and re-run.")
            Stop-WithGuidance -Operation "$Method $Path (Foundry data-plane)" -ErrorRecord $_ -Guidance $pg
        }
        $g = switch ($d.Status) {
            400 { @("The request was rejected by Foundry. See the raw response below for the exact field.",
                    "If it names the model/deployment, confirm -ModelDeploymentName '$ModelDeploymentName' exists",
                    "(create it with -CreateModelDeployment once '$ModelName' access is approved).") }
            401 { @("Your token was rejected or expired. Re-run the script to sign in again.",
                    "Make sure you're in the tenant that owns the project (pass -TenantId $(if ($TenantId) { $TenantId } else { '<your-tenant-id>' })).") }
            403 { @("The signed-in identity lacks access to this Foundry project.",
                    "Grant it the 'Azure AI Developer' (or Contributor) role on the Foundry project/resource.") }
            404 { @("Endpoint, path, or API version not found.",
                    "Check -ProjectEndpoint: $base",
                    "  (expected form: https://<resource>.services.ai.azure.com/api/projects/<project>)",
                    "If the Foundry preview API moved, try a different -ApiVersion (current: $ApiVersion).") }
            413 { @("The knowledge file is too large for upload. Trim KNOWLEDGE.md or split it.") }
            429 { @("Foundry is throttling requests. Wait a minute and re-run (the script is idempotent).") }
            default {
                if ($d.Status -ge 500) { @("Foundry returned a server error - usually transient. Retry shortly.") }
                else { @("Unexpected error. See the raw response below; verify -ProjectEndpoint and -ApiVersion.") }
            }
        }
        Stop-WithGuidance -Operation "$Method $Path (Foundry data-plane)" -ErrorRecord $_ -Guidance $g
    }
}

# Page through a Foundry list endpoint (assistants / vector_stores use cursor
# pagination via has_more + last_id) and return ALL items, so find-by-name does not
# miss a match on page 2+.
function Get-FoundryList {
    param([Parameter(Mandatory)][string]$Path)   # e.g. "/assistants" or "/vector_stores"
    $all = New-Object System.Collections.Generic.List[object]
    $after = $null
    do {
        $sep = if ($Path -match '\?') { '&' } else { '?' }
        $page = "$Path${sep}order=desc&limit=100"
        if ($after) { $page = "$page&after=$after" }
        $resp = Invoke-Foundry -Method GET -Path $page
        if ($resp.data) { foreach ($item in $resp.data) { $all.Add($item) } }
        if ($resp.has_more -and -not $resp.last_id) {
            throw "Foundry list '$Path' reported more pages (has_more=true) but returned no pagination cursor (last_id). Cannot safely page; aborting to avoid a partial result. This usually means the API pagination shape differs from the expected OpenAI-compatible cursor - verify the -ApiVersion."
        }
        $after = if ($resp.has_more) { $resp.last_id } else { $null }
    } while ($after)
    $all
}

# Load + validate the tool JSON files. Used in preflight (validate only) and in the
# main run (build tools), so schema problems surface BEFORE the interactive sign-in.
function Get-ToolDefinitions {
    param([Parameter(Mandatory)][string]$ToolsDir)
    $defs = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path -LiteralPath $ToolsDir)) { return $defs }
    $seen = @{}
    foreach ($tf in (Get-ChildItem -LiteralPath $ToolsDir -Filter *.json -File | Sort-Object Name)) {
        try {
            $json = Get-Content -LiteralPath $tf.FullName -Raw | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            throw @"

ERROR: a tool definition file is not valid JSON.
File        : $($tf.FullName)
Detail      : $($_.Exception.Message)
What to do  :
  - Fix the JSON syntax (try: Get-Content '$($tf.FullName)' -Raw | ConvertFrom-Json), or
  - Move/rename the file out of the tools\ folder if it isn't a Foundry function tool.
"@
        }
        if (-not $json.name) {
            throw "Tool file '$($tf.Name)' is missing a 'name' field (required for a Foundry function tool)."
        }
        if ($json.name -notmatch '^[a-zA-Z0-9_-]{1,64}$') {
            throw "Tool '$($json.name)' in '$($tf.Name)' has an invalid name. Use 1-64 chars: letters, digits, '_' or '-'."
        }
        if ($seen.ContainsKey($json.name)) {
            throw "Duplicate tool name '$($json.name)' (in '$($tf.Name)' and '$($seen[$json.name])'). Tool names must be unique."
        }
        $seen[$json.name] = $tf.Name
        if ($json.parameters -and "$($json.parameters.type)" -and $json.parameters.type -ne 'object') {
            throw "Tool '$($json.name)' has parameters.type '$($json.parameters.type)'; Foundry function tools require 'object'."
        }
        $defs.Add($json)
    }
    $defs
}

# --- Asset helpers -------------------------------------------------------------
# Strip the leading "# Title" line and the "Paste this verbatim..." preamble so the
# instruction body matches what a human would paste (header skipped).
function Get-InstructionBody {
    param([Parameter(Mandatory)][string]$Path)
    $lines = @(Get-Content -LiteralPath $Path)
    $i = 0
    # Drop the leading "# Title" line(s) and any blank lines.
    while ($i -lt $lines.Count -and ($lines[$i] -match '^\s*#\s' -or [string]::IsNullOrWhiteSpace($lines[$i]))) { $i++ }
    # Drop a "Paste this verbatim ..." preamble paragraph in full (it can wrap
    # across several lines), then any blank lines that follow it.
    if ($i -lt $lines.Count -and $lines[$i] -match '^\s*Paste this verbatim') {
        while ($i -lt $lines.Count -and -not [string]::IsNullOrWhiteSpace($lines[$i])) { $i++ }
        while ($i -lt $lines.Count -and [string]::IsNullOrWhiteSpace($lines[$i])) { $i++ }
    }
    if ($i -ge $lines.Count) { return "" }
    ($lines[$i..($lines.Count - 1)] -join "`n").Trim()
}

# Convert a repo tool JSON (type shell/file/function) into a Foundry function tool.
# The command/args in shell tools are runtime concerns for the on-CPC executor; the
# agent only needs the name/description/parameters declaration.
function ConvertTo-FunctionTool {
    param([Parameter(Mandatory)]$Json)
    $params = if ($Json.parameters) { $Json.parameters } else { @{ type = "object"; properties = @{} } }
    $desc = "$($Json.description)"
    if ($Json.type -eq 'shell' -and $Json.command) {
        $desc = "$desc (runtime: launches '$($Json.command)' on the Cloud PC)."
    }
    [ordered]@{
        type     = "function"
        function = [ordered]@{
            name        = $Json.name
            description  = $desc
            parameters  = $params
        }
    }
}

# Guard: refuse to silently take over a same-named resource that this script didn't
# create, unless the user opts in with -AdoptExisting.
function Assert-Adoptable {
    param([Parameter(Mandatory)]$Resource, [Parameter(Mandatory)][string]$Kind, [Parameter(Mandatory)][string]$Name)
    $managed = "$($Resource.metadata.managedBy)" -eq "Deploy-Agent.ps1"
    if (-not $managed -and -not $AdoptExisting) {
        throw @"

ERROR: a $Kind named '$Name' already exists but was not created by this script.
Id          : $($Resource.id)
What to do  :
  - If it is safe to reuse/overwrite it, re-run with -AdoptExisting.
  - Otherwise delete/rename it in the Foundry portal, or pass a different name.
"@
    }
}

# ============================ Phase 0: PREFLIGHT =============================
# Everything checkable WITHOUT signing in happens here, so a forgotten prerequisite
# fails in seconds - not after you've signed in and walked away.
Write-Host "Zava agent deployment (Foundry Agent Service, preview)" -ForegroundColor White
Write-Host "Project : $base"
Write-Host "Model   : $ModelDeploymentName"
Write-Host "Assets  : $AssetRoot"
Write-Host ""
Write-Host "Running preflight checks..." -ForegroundColor White

# Assets present?
$agentInstr = Join-Path $AssetRoot "AGENT-INSTRUCTIONS.md"
$cuaInstr   = Join-Path $AssetRoot "CUA-TOOL-INSTRUCTIONS.md"
$knowledge  = Join-Path $AssetRoot "KNOWLEDGE.md"
$toolsDir   = Join-Path $AssetRoot "tools"
foreach ($f in @($agentInstr, $cuaInstr, $knowledge)) {
    if (-not (Test-Path -LiteralPath $f)) {
        throw @"

ERROR: required agent asset is missing.
Missing     : $f
Asset folder: $AssetRoot
What to do  :
  - Make sure the folder has all three files: AGENT-INSTRUCTIONS.md, CUA-TOOL-INSTRUCTIONS.md, KNOWLEDGE.md.
  - If your assets live elsewhere, pass -AssetRoot <path-to-that-folder>.
"@
    }
}
Write-Host "  [ok] agent assets found"

# Tool JSON valid (parse + schema)?
$toolDefs = Get-ToolDefinitions -ToolsDir $toolsDir
Write-Host "  [ok] $($toolDefs.Count) tool definition(s) valid"

# ARM parameters present + well-formed if we're asked to create the deployment?
if ($CreateModelDeployment) {
    $null = Get-AccountResourceId   # throws actionable guidance if missing/malformed
    Write-Host "  [ok] model-deployment parameters present"
}

# Az.Accounts available (or installable)?
$haveAz = Get-Module -ListAvailable -Name Az.Accounts | Select-Object -First 1
if ($haveAz) { Write-Host "  [ok] Az.Accounts $($haveAz.Version) present" }
else { Write-Host "  [info] Az.Accounts not found - it will be installed (CurrentUser scope) during sign-in." -ForegroundColor Yellow }

# Summary so the user knows what will happen and what must already be true.
Write-Host ""
Write-Host "This run will:" -ForegroundColor White
Write-Host "  - sign you in (interactive Azure sign-in$(if ($DeviceCode) { ', device code' }))"
if ($CreateModelDeployment) { Write-Host "  - create/verify the '$ModelName' model deployment '$ModelDeploymentName' (ARM)" }
Write-Host "  - upload knowledge + create/reuse the vector store"
Write-Host "  - create/update the agent '$AgentName'"
Write-Host "  - attach: $($toolDefs.Count) function tool(s), file_search$(if (-not $SkipComputerUseTool) { ', computer_use_preview' })"
Write-Host "You must already have:" -ForegroundColor White
Write-Host "  - the agent-owner role on the Foundry project (Azure AI Developer / Contributor)"
if (-not $SkipComputerUseTool -or $CreateModelDeployment) {
    Write-Host "  - '$ModelName' access APPROVED for the subscription (https://aka.ms/oai/cuaaccess)"
}
if ($WhatIfPreference) { Write-Host "  (-WhatIf: will authenticate and READ remote state, but make no changes.)" -ForegroundColor Yellow }
Write-Host ""

# ============================ Phase 1: SIGN IN ==============================
Connect-Foundry
$script:token = Get-FoundryToken

# Cheap post-auth connectivity/permission check before any long work, so a wrong
# tenant / missing role fails now rather than after the model deployment.
Write-Host "Verifying access to the Foundry project..."
$null = Invoke-Foundry -Method GET -Path "/assistants?limit=1"
Write-Host "  [ok] project reachable and authorized"

# Confirm the model deployment the agent references actually exists, so -WhatIf can't
# report a green Foundry phase when computer-use-preview was never deployed (issue #22).
Write-Host "Verifying the model deployment exists..."
Test-ModelDeploymentReady

# ============================ Phase 2: DEPLOY ===============================
if ($CreateModelDeployment) {
    Write-Host "Creating/verifying model deployment (control-plane / ARM)..." -ForegroundColor White
    New-ModelDeployment | Out-Null
}

# --- Build the instruction body ------------------------------------------------
$instructions = @"
$(Get-InstructionBody -Path $agentInstr)

## Computer Use (CUA) Tool Instructions

$(Get-InstructionBody -Path $cuaInstr)
"@

# --- Build the tool list -------------------------------------------------------
$tools = New-Object System.Collections.Generic.List[object]
foreach ($json in $toolDefs) {
    $tools.Add((ConvertTo-FunctionTool -Json $json))
    Write-Host "  + function tool '$($json.name)'"
}
$tools.Add(@{ type = "file_search" })
Write-Host "  + file_search (knowledge)"
if (-not $SkipComputerUseTool) {
    # Computer Use tool. The W365A connection itself is bound out-of-band (manual).
    $tools.Add([ordered]@{
        type        = "computer_use_preview"
        environment = "windows"
    })
    Write-Host "  + computer_use_preview (Windows)"
}
else {
    Write-Warning "Skipping Computer Use tool (-SkipComputerUseTool). Add it later once model access is approved."
}

# --- Knowledge: upload file + vector store (idempotent, content-aware) ----------
# The vector store name embeds a short hash of KNOWLEDGE.md so that if the content
# changes, a NEW store is created and the agent is repointed - i.e. re-runs converge
# on the current knowledge instead of silently reusing stale content.
$knowledgeHash  = (Get-FileHash -LiteralPath $knowledge -Algorithm SHA256).Hash.Substring(0, 8).ToLower()
$vectorStoreBase = "$AgentName - knowledge"
$vectorStoreName = "$vectorStoreBase [$knowledgeHash]"
$vectorStoreId = $null

$allStores = Get-FoundryList -Path "/vector_stores"
$existingVs = @($allStores | Where-Object { $_.name -eq $vectorStoreName })
if ($existingVs.Count -gt 1) {
    throw "Found $($existingVs.Count) vector stores named '$vectorStoreName' (ids: $(($existingVs.id) -join ', ')). Delete the extras and re-run."
}
$existingVs = $existingVs | Select-Object -First 1
if ($existingVs) {
    Assert-Adoptable -Resource $existingVs -Kind "vector store" -Name $vectorStoreName
    $vectorStoreId = $existingVs.id
    Write-Host "Knowledge vector store is current ($vectorStoreId)."
}
elseif ($PSCmdlet.ShouldProcess($vectorStoreName, "Upload KNOWLEDGE.md and create vector store")) {
    # Note any older managed stores for this agent (previous knowledge versions).
    $stale = @($allStores | Where-Object { $_.name -like "$vectorStoreBase ``[*``]" -and "$($_.metadata.managedBy)" -eq "Deploy-Agent.ps1" })
    if ($stale.Count) {
        Write-Host "KNOWLEDGE.md changed - creating a new vector store; $($stale.Count) older one(s) left in place (delete manually if desired)." -ForegroundColor Yellow
    }
    $uploaded = Invoke-Foundry -Method POST -Path "/files" -Form @{
        purpose = "assistants"
        file    = Get-Item -LiteralPath $knowledge
    }
    Write-Host "Uploaded knowledge file ($($uploaded.id))."
    $vs = Invoke-Foundry -Method POST -Path "/vector_stores" -Body @{
        name     = $vectorStoreName
        file_ids = @($uploaded.id)
        metadata = @{ managedBy = "Deploy-Agent.ps1"; knowledgeHash = $knowledgeHash }
    }
    $vectorStoreId = $vs.id
    Write-Host "Created vector store ($vectorStoreId)."
}

$toolResources = @{}
if ($vectorStoreId) {
    $toolResources.file_search = @{ vector_store_ids = @($vectorStoreId) }
}

# --- Create or update the agent (idempotent by name) ---------------------------
$payload = [ordered]@{
    name          = $AgentName
    model         = $ModelDeploymentName
    instructions  = $instructions
    tools         = $tools.ToArray()
    tool_resources = $toolResources
    temperature   = 0.2
    metadata      = @{ demo = "zava-ccaas-cua"; managedBy = "Deploy-Agent.ps1" }
}

$existingAgents = @(Get-FoundryList -Path "/assistants" | Where-Object { $_.name -eq $AgentName })
if ($existingAgents.Count -gt 1) {
    throw @"

ERROR: $($existingAgents.Count) agents already exist with the name '$AgentName'.
Ids         : $(($existingAgents.id) -join ', ')
What to do  :
  - Delete the duplicates in the Foundry portal so exactly one (or none) remains, then re-run.
"@
}
$existingAgent = $existingAgents | Select-Object -First 1

if ($existingAgent) {
    Assert-Adoptable -Resource $existingAgent -Kind "agent" -Name $AgentName
    if ($PSCmdlet.ShouldProcess($AgentName, "Update existing agent ($($existingAgent.id))")) {
        $agent = Invoke-Foundry -Method POST -Path "/assistants/$($existingAgent.id)" -Body $payload
        Write-Host "Updated agent '$AgentName' ($($agent.id))." -ForegroundColor Green
    }
    else { $agent = $existingAgent }
}
elseif ($PSCmdlet.ShouldProcess($AgentName, "Create agent")) {
    $agent = Invoke-Foundry -Method POST -Path "/assistants" -Body $payload
    Write-Host "Created agent '$AgentName' ($($agent.id))." -ForegroundColor Green
}

# Emit the agent id for callers (e.g. Build-DemoFromScratch.ps1 -> FOUNDRY_AGENT_ID).
if ($AgentIdOutFile -and $agent -and $agent.id -and -not $WhatIfPreference) {
    Set-Content -LiteralPath $AgentIdOutFile -Value ([string]$agent.id) -Encoding ascii
    Write-Host "Wrote agent id to '$AgentIdOutFile'."
}

# --- Follow-up checklist -------------------------------------------------------
Write-Host ""
if ($WhatIfPreference) {
    Write-Host "-WhatIf: preflight passed and the project is reachable. No changes were made." -ForegroundColor Yellow
    Write-Host "Re-run without -WhatIf to create/update the agent." -ForegroundColor Yellow
    return
}
Write-Host "Agent provisioned. To finish (see docs\agent-cua-setup.md):" -ForegroundColor White
Write-Host "  THE ONE MANUAL STEP:"
Write-Host "    - Approve '$ModelName' access (human gate: https://aka.ms/oai/cuaaccess), then re-run"
Write-Host "      with -CreateModelDeployment if you haven't deployed the model yet."
Write-Host "  AUTOMATIC / ONE CLICK:"
Write-Host "    - Publish the agent to Agent 365 -> its Entra Agent ID is auto-provisioned (no registration)."
Write-Host "    - Point Computer Use at the target Cloud PC in Settings -> Connections; refresh before demos."
Write-Host "  OPTIONAL:"
Write-Host "    - Import the evaluation CSVs (evaluations\*.csv) for the built-in eval runs."
Write-Host "    - Enterprise scale-out (Agent ID blueprints, W365-for-Agents pool) - see the docs; not needed for the demo."
Write-Host ""
Write-Host "Done." -ForegroundColor Green
