<#
.SYNOPSIS
    Build the ENTIRE Zava CCaaS / Computer-Use demo environment from scratch, in order,
    from a single config file. One script, all inputs up front, prerequisites checked,
    every step recorded, idempotent, and -WhatIf-safe.

.DESCRIPTION
    A brand-new user (any tenant, any subscription, any region) does exactly this:

      1. Copy scripts\demo-config.sample.json to scripts\demo-config.local.json and fill it in.
      2. Run Bootstrap-DemoServicePrincipal.ps1 ONCE as Global Admin (creates the app
         registration; this is the one step that needs interactive admin consent).
      3. Run THIS script. (The default Microsoft Copilot Studio (MCS) path needs no Azure
         OpenAI model access. The Foundry + Windows 365 for Agents path, selected with
         -AgentBackend foundry|both, additionally requires requesting 'computer-use-preview'
         model access once via the human gate https://aka.ms/oai/cuaaccess.)

    Choose the AI backend up front with -AgentBackend (like tenant/subscription, this is
    a primary decision; it also reads config 'agentBackend'):
      mcs     - Microsoft Copilot Studio over Direct Line (DEFAULT; phase C orchestrator).
      foundry - Azure AI Foundry Computer-Use agent driving a Windows 365 for Agents Cloud
                PC via samples/foundry-w365a-runner (phase D agent; orchestrator skipped).
      both    - Configure both and bake both endpoints into the SPA so the desktop's
                backend toggle can switch between them live for A/B demos.

    It then, in order:
      A. Validates the config and checks every prerequisite tool (fails fast with fixes).
      B. Signs the Azure CLI into the configured tenant + subscription.
      C. (MCS) Deploys the standalone Durable Functions handoff orchestrator (apps/handoff-
         orchestrator) that drives the published Microsoft Copilot Studio agent over
         Bot Framework Direct Line - resource group, Storage, Function app (managed
         identity), Key Vault (Direct Line secret + callback key), app settings,
         publish. ON when the backend includes MCS.
      D. (Foundry) Creates/updates the Foundry Computer-Use agent. ON when the backend
         includes Foundry. The Foundry + W365A runtime itself is samples/foundry-w365a-
         runner, run on/near the Cloud PC (watches the handoff, drives claims.exe).
      E. Creates the Free Static Web App and builds + deploys the CCaaS app, baking the
         orchestrator URL(s) into the SPA so the desktop points at it with no manual config.
      F. Allows the CCaaS app origin to call the orchestrator (CORS).
      G. Creates the Entra group(s), onboards the seed Cloud PC(s)/user(s), deploys the
         legacy Win32 claims app, and publishes the CCaaS Edge web app (PWA).
      H. Prints a summary and the remaining manual gates.

    Two ways to drive Computer Use on the Windows 365 for Agents Cloud PC pool:
      - MCS: the pool is bound in the Copilot Studio agent's Machine field.
      - Foundry: samples/foundry-w365a-runner checks out a W365A session and runs the
        Foundry responses Computer Use loop directly against the Cloud PC.

    What it intentionally does NOT do (out of scope, by design):
      - Provision or deprovision Cloud PCs / licenses (you create those; this only adds
        a device/user to a group so it becomes a CCaaS agent workstation).
      - Publish the Copilot Studio agent or mint its Direct Line secret (human gate).
      - The one-time admin-consent bootstrap and the one-time model access approval.

    Keep this file ASCII-only (Windows PowerShell 5.1 reads non-BOM UTF-8 as ANSI).

.EXAMPLE
    # Preview everything, change nothing:
    pwsh -File .\scripts\Build-DemoFromScratch.ps1 -WhatIf

.EXAMPLE
    # Build it for real (headless admin box -> device-code sign-in):
    pwsh -File .\scripts\Build-DemoFromScratch.ps1 -DeviceCode

.EXAMPLE
    # Foundry + Windows 365 for Agents backend (skips the MCS orchestrator):
    pwsh -File .\scripts\Build-DemoFromScratch.ps1 -AgentBackend foundry

.EXAMPLE
    # Configure BOTH backends so the desktop toggle can switch live for A/B demos:
    pwsh -File .\scripts\Build-DemoFromScratch.ps1 -AgentBackend both
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # The one file a new user edits. Defaults next to this script.
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'demo-config.local.json'),

    # Browser-free interactive sign-in for az + Graph (headless admin workstation).
    [switch]$DeviceCode,

    # Choose the AI agent backend up front (like tenant/subscription, this is a
    # primary decision):
    #   mcs     - Microsoft Copilot Studio over Direct Line (the default; phase C
    #             orchestrator). Keeps the original path fully intact.
    #   foundry - Azure AI Foundry Computer-Use agent driving a Windows 365 for Agents
    #             Cloud PC (phase D agent + the samples\foundry-w365a-runner). Skips the
    #             Direct Line orchestrator (Foundry does not use it).
    #   both    - Configure BOTH and bake both endpoints into the SPA so the desktop's
    #             backend toggle can switch between them live (demo A/B).
    # When omitted, falls back to config 'agentBackend', then to the legacy
    # -IncludeFoundryAgent switch, then to 'mcs'.
    [ValidateSet('mcs', 'foundry', 'both')]
    [string]$AgentBackend,

    # Skip individual stages (e.g. re-run just the SWA deploy after a code change).
    # NOTE: you normally do NOT need -SkipOrchestrator. If the Direct Line secret is
    # blank in your config, the build auto-skips the orchestrator and tells you to
    # re-run after you paste the secret in. This flag is only an explicit override.
    [switch]$SkipOrchestrator,
    [switch]$SkipStaticWebApp,
    [switch]$SkipIntune,

    # DEPRECATED alias. Foundry is now a first-class backend selected with
    # -AgentBackend foundry|both (which builds the agent and uses
    # samples/foundry-w365a-runner behind the handoff_id contract). This switch is kept
    # only for back-compat: it (a) defaults the backend to 'foundry' when -AgentBackend
    # and config.agentBackend are both absent, and (b) opts in the DEPRECATED SWA-managed
    # /api (thread_id/run_id) on the Static Web App. Prefer -AgentBackend.
    [switch]$IncludeFoundryAgent,

    # Deprecated alias: previously skipped the (then-default) Foundry agent. With the
    # backend selector, this just skips phase D (the Foundry agent) even when the chosen
    # backend includes Foundry. Kept only for back-compat.
    [switch]$SkipAgent,

    # Also create the access-gated 'computer-use-preview' model deployment (ARM) as part
    # of the legacy Foundry agent stage. Requires model access to be approved.
    [switch]$CreateModelDeployment,

    # Record failures and keep going instead of stopping at the first error.
    [switch]$ContinueOnError,

    # Internal: set when the script relaunches itself under PowerShell 7. Prevents
    # an infinite relaunch loop. Not for manual use.
    [switch]$SkipPwshRelaunch
)

$ErrorActionPreference = 'Stop'

# --- Auto-relaunch under PowerShell 7 -----------------------------------------
# The child scripts (Deploy-Agent.ps1 / Deploy-DemoEnvironment.ps1) require PS7
# for reliable interactive Graph auth and hard-fail below it. So the single
# from-scratch entry point must run under PS7 too: relaunch here once.
if (-not $SkipPwshRelaunch -and $PSVersionTable.PSVersion.Major -lt 6) {
    $pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $pwshCmd) {
        throw "PowerShell 7 (pwsh) is required but was not found. Install it (winget install Microsoft.PowerShell) and re-run. It is needed for the Foundry agent and Intune stages."
    }
    Write-Host "Relaunching under PowerShell 7 (required for the agent + Intune stages)..."
    $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-SkipPwshRelaunch')
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        $n = $kv.Key; $v = $kv.Value
        if ($n -eq 'SkipPwshRelaunch') { continue }
        if ($v -is [System.Management.Automation.SwitchParameter]) { if ($v.IsPresent) { $fwd += "-$n" } }
        elseif ($v -is [System.Collections.IEnumerable] -and $v -isnot [string]) { $fwd += "-$n"; $fwd += (($v | ForEach-Object { "$_" }) -join ',') }
        else { $fwd += "-$n"; $fwd += "$v" }
    }
    & $pwshCmd.Source @fwd
    exit $LASTEXITCODE
}

. (Join-Path $PSScriptRoot 'DemoCommon.ps1')

if ($WhatIfPreference) {
    Write-Host ""
    Write-Host "PREVIEW MODE (-WhatIf): no resources will be created, modified, or deleted." -ForegroundColor Yellow
    Write-Host "Note: preview still SIGNS IN (az/Graph), READS live state, and may install required" -ForegroundColor Yellow
    Write-Host "PowerShell modules so it can show an accurate plan. It makes no remote changes." -ForegroundColor Yellow
    Write-Host ""
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$results = New-Object System.Collections.Generic.List[object]

function Invoke-Step {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Action)
    Write-Host "`n========== $Name ==========" -ForegroundColor Cyan
    $start = Get-Date
    try {
        & $Action
        $results.Add([pscustomobject]@{ Step = $Name; Status = 'OK'; Detail = '' })
    }
    catch {
        $msg = $_.Exception.Message
        $results.Add([pscustomobject]@{ Step = $Name; Status = 'FAILED'; Detail = $msg })
        Write-Host "  [FAILED] $msg" -ForegroundColor Red
        if (-not $ContinueOnError) { throw }
    }
    finally {
        Write-Host ("  ({0:n1}s)" -f ((Get-Date) - $start).TotalSeconds)
    }
}

# ----------------------------------------------------------------------------- A
$config = $null
$swaResult = $null
$orchResult = $null
$agentId = $null
$orchDeferredForSecret = $false
$script:resolvedBackend = 'mcs'
$script:useMcs = $true
$script:useFoundry = $false

# Resolve the chosen AI backend up front: -AgentBackend param > config 'agentBackend'
# > legacy -IncludeFoundryAgent > 'mcs'. Peeks at the config JSON without full
# validation so the choice is known before we decide what to validate/require.
function Resolve-AgentBackend {
    param([string]$Param, [string]$ConfigPathLocal)
    if ($Param) { return $Param.ToLowerInvariant() }
    try {
        if (Test-Path -LiteralPath $ConfigPathLocal) {
            $raw = Get-Content -Raw -LiteralPath $ConfigPathLocal | ConvertFrom-Json
            $b = [string]$raw.agentBackend
            if (-not [string]::IsNullOrWhiteSpace($b)) { return $b.ToLowerInvariant() }
        }
    }
    catch { }
    if ($IncludeFoundryAgent) { return 'foundry' }
    return 'mcs'
}

# Orchestrator is the Copilot Studio (MCS) path. ON unless the backend excludes MCS,
# -SkipOrchestrator is set, or handoffOrchestrator.enabled=false / no Direct Line secret.
function Test-OrchestratorEnabled {
    param($Cfg)
    if (-not $script:useMcs) { return $false }
    if ($SkipOrchestrator) { return $false }
    if (-not $Cfg.handoffOrchestrator) { return $false }
    if (($Cfg.handoffOrchestrator.PSObject.Properties.Name -contains 'enabled') -and (-not [bool]$Cfg.handoffOrchestrator.enabled)) { return $false }
    # Auto-skip when there is neither a Direct Line secret NOR a token endpoint yet.
    # The orchestrator cannot talk to the Copilot Studio agent without one, so
    # deploying it now would be half-built. We defer this phase until you publish the
    # agent and paste its secret OR token endpoint into the config, and re-run. This
    # means you NEVER have to decide whether to pass -SkipOrchestrator.
    $hasSecret = -not [string]::IsNullOrWhiteSpace([string]$Cfg.handoffOrchestrator.directLineSecret)
    $hasToken  = -not [string]::IsNullOrWhiteSpace([string]$Cfg.handoffOrchestrator.directLineTokenEndpoint)
    if (-not $hasSecret -and -not $hasToken) { return $false }
    return $true
}

# Why the orchestrator phase will be skipped (for clear, single-source-of-truth messaging).
function Get-OrchestratorSkipReason {
    param($Cfg)
    if (-not $script:useMcs) { return 'backend' }
    if ($SkipOrchestrator) { return 'flag' }
    if (-not $Cfg.handoffOrchestrator) { return 'noblock' }
    if (($Cfg.handoffOrchestrator.PSObject.Properties.Name -contains 'enabled') -and (-not [bool]$Cfg.handoffOrchestrator.enabled)) { return 'disabled' }
    $hasSecret = -not [string]::IsNullOrWhiteSpace([string]$Cfg.handoffOrchestrator.directLineSecret)
    $hasToken  = -not [string]::IsNullOrWhiteSpace([string]$Cfg.handoffOrchestrator.directLineTokenEndpoint)
    if (-not $hasSecret -and -not $hasToken) { return 'nosecret' }
    return $null
}

Invoke-Step 'A. Validate config + prerequisites' {
    $script:resolvedBackend = Resolve-AgentBackend -Param $AgentBackend -ConfigPathLocal $ConfigPath
    $script:useMcs = $script:resolvedBackend -in @('mcs', 'both')
    $script:useFoundry = $script:resolvedBackend -in @('foundry', 'both')
    $reqOrch = $script:useMcs -and (-not $SkipOrchestrator)
    $script:config = Get-DemoConfig -Path $ConfigPath -RequireOrchestrator:$reqOrch -RequireFoundry:$script:useFoundry -RequireLegacyFoundryApi:$IncludeFoundryAgent
    Write-Host "  [ok]   config '$ConfigPath' valid"
    Write-Host "  backend      : $($script:resolvedBackend)  (MCS=$($script:useMcs), Foundry+W365A=$($script:useFoundry))"
    Write-Host "  subscription : $($script:config.azure.subscriptionId)"
    Write-Host "  tenant       : $($script:config.azure.tenantId)"
    Write-Host "  SWA region   : $($script:config.staticWebApp.location) (workload region: $($script:config.azure.location))"
    $aiPath = @()
    if (Test-OrchestratorEnabled $script:config) { $aiPath += 'Copilot Studio orchestrator' } elseif ($script:useMcs) { $aiPath += 'orchestrator SKIPPED' }
    if ($script:useFoundry) { $aiPath += 'Foundry + W365A runner (samples/foundry-w365a-runner)' }
    Write-Host "  AI path      : $($aiPath -join ' + ')"

    # Make the skip decision explicit so the user never has to guess about -SkipOrchestrator.
    if (-not (Test-OrchestratorEnabled $script:config)) {
        switch (Get-OrchestratorSkipReason $script:config) {
            'backend'  { Write-Host "  Orchestrator : SKIPPED because the chosen backend ('$($script:resolvedBackend)') does not use the Copilot Studio (MCS) path." }
            'flag'     { Write-Host "  Orchestrator : SKIPPED because you passed -SkipOrchestrator." }
            'disabled' { Write-Host "  Orchestrator : SKIPPED because handoffOrchestrator.enabled = false in your config." }
            'noblock'  { Write-Host "  Orchestrator : SKIPPED because there is no handoffOrchestrator block in your config." }
            'nosecret' {
                $script:orchDeferredForSecret = $true
                Write-Host ""
                Write-Host "  Orchestrator : SKIPPED for now - no Direct Line secret or token endpoint in your config yet." -ForegroundColor Yellow
                Write-Host "                 This is NORMAL on a first run, before the Copilot Studio agent exists." -ForegroundColor Yellow
                Write-Host "                 The website + infrastructure still get built now. You do NOT need" -ForegroundColor Yellow
                Write-Host "                 to pass -SkipOrchestrator - the script handles this for you." -ForegroundColor Yellow
                Write-Host "                 Later: publish your agent, then paste EITHER its Direct Line secret into" -ForegroundColor Yellow
                Write-Host "                 handoffOrchestrator.directLineSecret, OR (if the channel exposes no" -ForegroundColor Yellow
                Write-Host "                 classic secret, e.g. the 60-day premium trial) its Direct Line token" -ForegroundColor Yellow
                Write-Host "                 endpoint into handoffOrchestrator.directLineTokenEndpoint, then re-run" -ForegroundColor Yellow
                Write-Host "                 this script to deploy the orchestrator." -ForegroundColor Yellow
                Write-Host "                 If publishing shows a '60-day trial' prompt, the agent's" -ForegroundColor Yellow
                Write-Host "                 environment lacks Copilot Studio entitlement - see" -ForegroundColor Yellow
                Write-Host "                 docs/licensing-and-entitlement.md (pay-as-you-go, cents per run)." -ForegroundColor Yellow
                Write-Host ""
            }
        }
    }

    Write-Host "  Checking prerequisite tools..."
    Assert-Prerequisite -Name 'az'   -InstallHint 'Install the Azure CLI: winget install Microsoft.AzureCLI  (https://aka.ms/installazurecli)'
    Assert-Prerequisite -Name 'node' -InstallHint 'Install Node.js 20+: winget install OpenJS.NodeJS.LTS'
    Assert-Prerequisite -Name 'npm'  -InstallHint 'npm ships with Node.js 20+: winget install OpenJS.NodeJS.LTS'
    Assert-Prerequisite -Name 'pwsh' -InstallHint 'Install PowerShell 7: winget install Microsoft.PowerShell'
    if (Test-OrchestratorEnabled $script:config) {
        Assert-Prerequisite -Name 'func' -VersionPattern '^\d+\.\d+' -InstallHint 'Install Azure Functions Core Tools v4: npm i -g azure-functions-core-tools@4  (or winget install Microsoft.Azure.FunctionsCoreTools)'
    }
    Write-Host "  [ok]   running under PowerShell $($PSVersionTable.PSVersion)"
}

# ----------------------------------------------------------------------------- B
Invoke-Step 'B. Azure CLI sign-in' {
    Connect-DemoAzureCli -Config $script:config -DeviceCode:$DeviceCode
}

# Read-only preflight (advisory): warn now if Copilot Studio has no Dataverse-backed
# environment, so Step 3 does not later dead-end at the loading donut.
Invoke-Step 'B2. Copilot Studio environment preflight (Dataverse)' {
    Test-CopilotStudioReady -WorkloadRegion ([string]$script:config.azure.location)
}

# ----------------------------------------------------------------------------- C
Invoke-Step 'C. AI handoff backend (Durable Functions orchestrator)' {
    if (-not (Test-OrchestratorEnabled $script:config)) {
        if ($script:orchDeferredForSecret) {
            Write-Host "  Skipping - no Direct Line secret yet (see step A). Re-run after pasting it in to deploy the orchestrator."
        } else {
            Write-Host "  Orchestrator not enabled (see the reason in step A). Skipping."
        }
        return
    }
    $script:orchResult = New-DemoHandoffOrchestrator -Config $script:config -RepoRoot $repoRoot
    if ($script:orchResult) { Write-Host "  [ok]   orchestrator base URL: $($script:orchResult.BaseUrl)" }
}

# ----------------------------------------------------------------------------- D
Invoke-Step 'D. Foundry Computer-Use agent (Foundry + W365A backend)' {
    if (-not $script:useFoundry -or $SkipAgent) {
        $why = if ($SkipAgent) { '-SkipAgent passed' } else { "backend '$($script:resolvedBackend)' does not use Foundry" }
        Write-Host "  Foundry agent not built ($why). Using foundry.agentId from config if present ('$($script:config.foundry.agentId)')."
        Write-Host "  The Foundry + W365A runtime lives in samples/foundry-w365a-runner (run it on/near the Cloud PC; it watches the orchestrator handoff and drives claims.exe via Computer Use)."
        $script:agentId = [string]$script:config.foundry.agentId
        return
    }

    $idFile = Join-Path ([System.IO.Path]::GetTempPath()) ("zava-agent-id-{0}.txt" -f ([guid]::NewGuid().ToString('N')))
    $agentArgs = @{
        ProjectEndpoint     = $script:config.foundry.endpoint
        AgentName           = $script:config.foundry.agentName
        ModelDeploymentName = $script:config.foundry.modelDeployment
        ApiVersion          = $script:config.foundry.apiVersion
        TenantId            = $script:config.azure.tenantId
        AgentIdOutFile      = $idFile
    }
    if ($DeviceCode) { $agentArgs['DeviceCode'] = $true }
    # Pass the backing account id whenever it's configured (not only for
    # -CreateModelDeployment) so Deploy-Agent can verify the computer-use-preview
    # deployment exists during preflight/-WhatIf instead of falsely passing (issue #22).
    $acctId = [string]$script:config.foundry.accountResourceId
    if (-not [string]::IsNullOrWhiteSpace($acctId)) {
        $agentArgs['AccountResourceId'] = $acctId
        $agentArgs['SubscriptionId'] = $script:config.azure.subscriptionId
    }
    if ($CreateModelDeployment) {
        $agentArgs['CreateModelDeployment'] = $true
        $agentArgs['SubscriptionId'] = $script:config.azure.subscriptionId
        $acct = [string]$script:config.foundry.accountResourceId
        if ([string]::IsNullOrWhiteSpace($acct)) {
            throw "-CreateModelDeployment needs the backing account. Set foundry.accountResourceId in $ConfigPath (the ARM id of the Azure AI Services account that backs the Foundry project), or omit -CreateModelDeployment and create the computer-use-preview deployment in the portal."
        }
        $agentArgs['AccountResourceId'] = $acct
    }
    if ($WhatIfPreference) { $agentArgs['WhatIf'] = $true }

    # Reset so a stale exit code can't cause a false pass/fail, then treat any non-zero
    # exit from the child as a phase failure: Deploy-Agent.ps1 signals fatal errors with
    # `exit 1`, which sets $LASTEXITCODE but does NOT throw in the parent. Without this
    # check the build would mask a failed Foundry deployment and continue into later phases.
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot 'Deploy-Agent.ps1') @agentArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Deploy-Agent.ps1 failed (exit $LASTEXITCODE). The Foundry Computer-Use agent was not deployed - see the error above. Resolve it and re-run, or pass -SkipAgent to skip this phase."
    }

    if ((-not $WhatIfPreference) -and (Test-Path -LiteralPath $idFile)) {
        $script:agentId = (Get-Content -LiteralPath $idFile -Raw).Trim()
        Remove-Item -LiteralPath $idFile -ErrorAction SilentlyContinue
        Write-Host "  [ok]   captured agent id: $($script:agentId)"
    }
    elseif (-not $WhatIfPreference) {
        Write-Warning "  Agent id file not produced; FOUNDRY_AGENT_ID will fall back to config ('$($script:config.foundry.agentId)')."
        $script:agentId = [string]$script:config.foundry.agentId
    }
}

# ----------------------------------------------------------------------------- E
Invoke-Step 'E. Central CCaaS host (Azure Static Web Apps)' {
    if ($SkipStaticWebApp) { Write-Host "  -SkipStaticWebApp: skipping."; return }

    $orchUrl = if ($script:orchResult -and $script:orchResult.BaseUrl) { $script:orchResult.BaseUrl }
               elseif (Test-OrchestratorEnabled $script:config) { "https://$($script:config.handoffOrchestrator.functionAppName).azurewebsites.net/api" }
               else { '' }

    # The Foundry backend's desktop endpoint is the local-orchestrator paired with the
    # samples/foundry-w365a-runner (the orchestrator serves the desktop's HTTP /handoff; the
    # runner watches its file-drop). Both run on/near the Cloud PC, so there is no
    # fixed cloud URL). Baked as VITE_FOUNDRY_ORCHESTRATOR_URL so the SPA's backend
    # toggle can switch to it; when backend is foundry-only it becomes the default.
    $foundryUrl = if ($script:useFoundry) { [string]$script:config.foundry.orchestratorUrl } else { '' }
    # Default the SPA to a backend whose endpoint was actually baked. For 'both' this prefers
    # MCS when its orchestrator URL exists, else falls back to Foundry - never defaulting to a
    # dead '/api' when the MCS half was skipped (e.g. no Direct Line secret yet).
    $defaultBackend = if (-not [string]::IsNullOrWhiteSpace($orchUrl)) { 'mcs' }
                      elseif (-not [string]::IsNullOrWhiteSpace($foundryUrl)) { 'foundry' }
                      else { 'mcs' }

    # The new Foundry backend drives the Cloud PC via samples/foundry-w365a-runner behind
    # the SAME handoff_id contract (its endpoint is foundry.orchestratorUrl, baked above) -
    # it does NOT use the deprecated SWA-managed /api (thread_id/run_id). So -IncludeFoundry
    # (which deploys that legacy /api + FOUNDRY_* app settings) stays decoupled from the new
    # backend selector and is driven only by the explicit legacy -IncludeFoundryAgent switch.
    $script:swaResult = New-DemoStaticWebApp -Config $script:config -RepoRoot $repoRoot -FoundryAgentId $script:agentId -OrchestratorUrl $orchUrl -FoundryOrchestratorUrl $foundryUrl -DefaultBackend $defaultBackend -IncludeFoundry:$IncludeFoundryAgent
}

# ----------------------------------------------------------------------------- F
Invoke-Step 'F. Orchestrator CORS (allow the CCaaS app origin)' {
    if (-not $script:orchResult) { Write-Host "  No orchestrator deployed; skipping CORS."; return }
    if (-not ($script:swaResult -and $script:swaResult.Url)) { Write-Host "  No CCaaS app URL; skipping CORS."; return }
    Set-DemoHandoffOrchestratorCors -FunctionAppName $script:orchResult.FunctionAppName -ResourceGroup $script:orchResult.ResourceGroup -AllowedOrigin $script:swaResult.Url
}

# ----------------------------------------------------------------------------- G
Invoke-Step 'G. Intune groups, legacy app + CCaaS Edge web app' {
    if ($SkipIntune) { Write-Host "  -SkipIntune: skipping."; return }

    $url = if ($script:swaResult -and $script:swaResult.Url) { $script:swaResult.Url } elseif ($script:config.agentWorkstation.webLink.url) { [string]$script:config.agentWorkstation.webLink.url } else { '' }

    $envArgs = @{
        TenantId         = $script:config.azure.tenantId
        DeviceGroupName  = $script:config.agentPool.deviceGroupName
        UserGroupName    = $script:config.agentWorkstation.userGroupName
        ScopeTagName     = $script:config.agentPool.scopeTagName
        CcaasWebLinkName = $script:config.agentWorkstation.webLink.displayName
        BuildPackages    = $true
    }
    if ($url) { $envArgs['CcaasWebLinkUrl'] = $url }
    if ($script:config.agentPool.pilotCloudPcName)     { $envArgs['PilotCloudPcName'] = @($script:config.agentPool.pilotCloudPcName) }
    if ($script:config.agentWorkstation.agentUserName) { $envArgs['AgentUserName']    = @($script:config.agentWorkstation.agentUserName) }
    if ($DeviceCode) { $envArgs['DeviceCode'] = $true }
    if ($WhatIfPreference) { $envArgs['WhatIf'] = $true }

    & (Join-Path $PSScriptRoot 'Deploy-DemoEnvironment.ps1') @envArgs
}

# ----------------------------------------------------------------------------- H
Write-Host "`n================ Build summary ================" -ForegroundColor White
$results | Format-Table Step, Status, Detail -AutoSize -Wrap | Out-Host

if ($swaResult -and $swaResult.Url) {
    Write-Host "CCaaS web app : $($swaResult.Url)" -ForegroundColor Green
}
if ($swaResult) {
    Write-Host "Claims app    : Intune required Win32 app -> agent-pool device group (pre-installed; the agent just launches it)" -ForegroundColor Green
}
Write-Host "AI backend    : $($script:resolvedBackend)  (MCS=$($script:useMcs), Foundry+W365A=$($script:useFoundry))" -ForegroundColor Green
if ($orchResult) {
    Write-Host "Orchestrator  : $($orchResult.BaseUrl)" -ForegroundColor Green
    Write-Host "  Result callback URL : $($orchResult.BaseUrl)/handoff/{handoff_id}/result   (header: x-handoff-key)"
    Write-Host "  Callback key        : $($orchResult.CallbackKey)"
    Write-Host ""
    Write-Host "  Validate the chain YOURSELF (no agent, no second person needed):" -ForegroundColor Green
    Write-Host "    pwsh -File .\scripts\Test-Handoff.ps1 -SimulateResult -BaseUrl $($orchResult.BaseUrl) -CallbackKey $($orchResult.CallbackKey)" -ForegroundColor Green
    Write-Host "    It starts a real handoff and proves queued -> ready -> submitted by injecting the"
    Write-Host "    result callback the agent's flow would send. Drop -SimulateResult to watch a REAL"
    Write-Host "    run (it sits at 'ready' until the #69 agent wiring below is done)."
}
if ($script:useFoundry) {
    Write-Host "Foundry runner: samples/foundry-w365a-runner" -ForegroundColor Green
    Write-Host "  Run it on/near the Windows 365 for Agents Cloud PC. It watches the orchestrator"
    Write-Host "  handoff (in/prefill.json), checks out a W365A session, drives claims.exe via the"
    Write-Host "  Foundry Computer Use loop, and writes back ready/result. Desktop endpoint:"
    Write-Host "    $([string]$script:config.foundry.orchestratorUrl)"
}
Write-Host "`nRemaining MANUAL gates (one-time, cannot be scripted):" -ForegroundColor White
if ($orchDeferredForSecret) {
    Write-Host "  - NEXT STEP (the orchestrator was NOT deployed yet): publish your Microsoft Copilot" -ForegroundColor Yellow
    Write-Host "    Studio agent, copy its Direct Line secret into handoffOrchestrator.directLineSecret" -ForegroundColor Yellow
    Write-Host "    in demo-config.local.json, then run this SAME script again. It will skip everything" -ForegroundColor Yellow
    Write-Host "    already built and deploy the orchestrator this time." -ForegroundColor Yellow
}
if (Test-OrchestratorEnabled $config) {
    $triggerText = if ([string]::IsNullOrWhiteSpace([string]$config.handoffOrchestrator.triggerText)) { 'A customer phone call has been handed off to you for automated processing. Using the caller phone, policy number, intent, and summary from the handoff context, open the Zava Mutual Claims Workstation and file a new First Notice of Loss, then return the resulting claim ID.' } else { [string]$config.handoffOrchestrator.triggerText }
    $callbackUrl = if ($orchResult) { "$($orchResult.BaseUrl)/handoff/{handoff_id}/result" } else { '{orchestratorBaseUrl}/api/handoff/{handoff_id}/result' }
    $callbackKey = if ($orchResult) { [string]$orchResult.CallbackKey } else { '<HANDOFF_CALLBACK_KEY>' }
    Write-Host "  - Publish your Microsoft Copilot Studio agent and copy its Direct Line secret into handoffOrchestrator.directLineSecret (demo-config.local.json), then re-run."
    Write-Host ""
    Write-Host "  *** FINISH THE AGENT - handoff wiring (issue #69) ***" -ForegroundColor Yellow
    Write-Host "  The build CANNOT auto-provision the agent's topics, Global variables, or result" -ForegroundColor Yellow
    Write-Host "  flow: Copilot Studio exposes no supported creation API for the Computer Use tool" -ForegroundColor Yellow
    Write-Host "  binding (see docs/build-the-agent.md 'Does any of this script?'). Wire these by hand" -ForegroundColor Yellow
    Write-Host "  or the handoff stalls at 'ready' and never drives claims.exe:" -ForegroundColor Yellow
    Write-Host "    a) Require authentication via 'Authenticate manually' (Settings -> Security ->" -ForegroundColor Yellow
    Write-Host "       Authentication -> 'Authenticate manually', a custom Entra app reg). NOT 'No" -ForegroundColor Yellow
    Write-Host "       authentication' (disables Computer Use - Test pane: 'CUA is disabled for" -ForegroundColor Yellow
    Write-Host "       unauthenticated agents', pool shows 0 runs ever), and NOT 'Authenticate with" -ForegroundColor Yellow
    Write-Host "       Microsoft' (disconnects the Direct Line channel the orchestrator uses). App-reg" -ForegroundColor Yellow
    Write-Host "       steps in docs/build-the-agent.md step 2. Save + Publish, re-copy Direct Line secret." -ForegroundColor Yellow
    Write-Host "    b) Inbound context (handoff-runbook.md 2a): create Global variables callerName," -ForegroundColor Yellow
    Write-Host "       callerPhone, policyNumber, intent, correlationId, handoff_id, agentDisplayName" -ForegroundColor Yellow
    Write-Host "       and enable 'External sources can set values' on each (filled from pvaSetContext)." -ForegroundColor Yellow
    Write-Host "    c) Trigger topic (handoff-runbook.md 2b): add a topic whose trigger phrase is" -ForegroundColor Yellow
    Write-Host "       EXACTLY '$triggerText' and that INVOKES the Computer Use tool. Disable web search /" -ForegroundColor Yellow
    Write-Host "       other knowledge so the trigger is not answered by search instead of Computer Use." -ForegroundColor Yellow
    Write-Host "    d) Result callback (handoff-runbook.md 2c): a typed Power Automate flow that POSTs the" -ForegroundColor Yellow
    Write-Host "       claim result to $callbackUrl" -ForegroundColor Yellow
    Write-Host "       with header x-handoff-key = $callbackKey" -ForegroundColor Yellow
    Write-Host "  - Bind/refresh the Computer Use -> Windows 365 for Agents connection in Copilot Studio before each demo."
}
if ($script:useFoundry) {
    Write-Host "  - (Foundry) 'computer-use-preview' model access approval (https://aka.ms/oai/cuaaccess)."
    Write-Host "  - Provision a Windows 365 for Agents pool, set foundry.* + w365a.* in the runner's .env, and run samples/foundry-w365a-runner on/near the Cloud PC."
}
Write-Host "  - Onboard a pool Cloud PC by adding its DEVICE object to the agent-pool group (or set agentPool.pilotCloudPcName); onboard the human agent by adding their USER account to the workstation group (or set agentWorkstation.agentUserName)."
Write-Host ""
Write-Host "  *** ATTACH A W365A POOL BILLING POLICY - manual billing step (issue #77) ***" -ForegroundColor Yellow
Write-Host "  This script CANNOT attach billing (it commits Azure spend). Separate from Copilot" -ForegroundColor Yellow
Write-Host "  Studio entitlement and NOT covered by M365/Copilot licensing: the Computer Use Cloud" -ForegroundColor Yellow
Write-Host "  PC pool needs its OWN Windows 365 for Agents pay-as-you-go billing policy on the" -ForegroundColor Yellow
Write-Host "  environment. Without it the pool is a TRIAL (0 machines), Computer Use never launches" -ForegroundColor Yellow
Write-Host "  a session, and the handoff hangs at 'ready'. Power Platform admin center -> Licensing" -ForegroundColor Yellow
Write-Host "  -> Pay-as-you-go plans -> include the Windows 365 / Hosted RPA product -> bind the" -ForegroundColor Yellow
Write-Host "  agent's environment. Then set ALWAYS-AVAILABLE in the Windows 365 provisioning policy" -ForegroundColor Yellow
Write-Host "  in INTUNE (NOT Copilot Studio): Intune admin center -> Devices -> Provision Cloud PCs ->" -ForegroundColor Yellow
Write-Host "  Provisioning policies (Agents) -> Create policy -> General -> pick the Billing plan and" -ForegroundColor Yellow
Write-Host "  set 'Always available Cloud PCs' = 1 (~`$5/mo) to avoid cold start. Provisioning takes" -ForegroundColor Yellow
Write-Host "  ~20-30 min. See docs/licensing-and-entitlement.md (pool billing policy) and docs/w365a-pool.md." -ForegroundColor Yellow
if ($swaResult) {
    Write-Host ""
    Write-Host "  *** claims.exe on the W365A pool - delivered by Intune as a required Win32 app ***" -ForegroundColor Yellow
    Write-Host "  Copilot Studio Cloud PC pools are Entra-joined and Intune-enrolled, so claims.exe" -ForegroundColor Yellow
    Write-Host "  is installed ahead of time via Intune. The agent's first on-screen action just" -ForegroundColor Yellow
    Write-Host "  launches the pre-installed app, then drives it by sight:" -ForegroundColor Yellow
    Write-Host "    powershell -NoProfile -Command `"& (Join-Path `$env:LOCALAPPDATA 'ZavaClaims\claims.exe') --no-splash --fast-auth --stable-host --idle-timeout=0 --demo-pin=1234`"" -ForegroundColor Yellow
    Write-Host "  This is baked into the agent's launch instructions (CUA-TOOL-INSTRUCTIONS.md / launch-claims-app.json)." -ForegroundColor Yellow
    Write-Host "  Keep it BRACE-FREE: Copilot Studio parses { } in agent instructions as Power Fx, so an if(){} block" -ForegroundColor Yellow
    Write-Host "  throws ContentValidationError before the agent runs (issue #69)." -ForegroundColor Yellow
    Write-Host "  Use an ALWAYS-AVAILABLE (warm) Cloud PC so the pre-installed app is ready before each" -ForegroundColor Yellow
    Write-Host "  live run and you avoid cold-start delays." -ForegroundColor Yellow
}

$failed = @($results | Where-Object { $_.Status -eq 'FAILED' })
if ($failed.Count -gt 0) {
    Write-Host "`n$($failed.Count) step(s) FAILED - see the table above." -ForegroundColor Red
    exit 1
}
Write-Host "`nAll steps completed." -ForegroundColor Green
