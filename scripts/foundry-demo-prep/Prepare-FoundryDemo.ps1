<#
.SYNOPSIS
    Pre-demo readiness check for the Zava -> Foundry hosted Claims demo. Safe to rerun.

.DESCRIPTION
    Part of the standalone "Zava Foundry demo preparation" package. Run it from the folder
    you extracted the package into; it needs no repository, Git, Node or Python.
    See START-HERE.txt in the same folder.

      About 30 minutes before:  .\Prepare-FoundryDemo.ps1 -WaitForCloudPcMinutes 20
      2-5 minutes before:       .\Prepare-FoundryDemo.ps1

    What it does, and nothing else:
      - Wakes the relay (Azure Functions, pay-per-use plan) with its anonymous
        availability check. An idle app may be scaled to zero after a few minutes,
        so this only helps when run minutes before presenting.
      - Reads the Zava page, the deployed Foundry agent version and the Windows 365
        agent pool. Read-only.

    What it never does: start a transfer, file a claim, acquire or hold a Cloud PC,
    invoke the Foundry agent, or change any setting. It does not remove every start-up
    delay: each transfer still gets its own Foundry sandbox and its own Cloud PC hand-over.

    It cannot check the presenter's browser sign-in (that lives only in the browser).
    It prints the short browser check to do by hand.

    Exit codes: 0 = ready, 1 = still preparing (for example the Cloud PC is resetting),
    2 = action needed (the message says which).

.PARAMETER ConfigPath
    Configuration file. Default: foundry-demo.config.json next to this script, or the
    path in the FOUNDRY_DEMO_CONFIG environment variable. Copy
    foundry-demo.config.template.json to start one.

.PARAMETER WaitForCloudPcMinutes
    If the pool has no available Cloud PC and none is in use (it is resetting after a
    run), check again every minute up to this many minutes. 0 = check once.

.PARAMETER ExpectedFoundryVersion
    Optional. Report "action needed" if the active Foundry agent version differs.
    Overrides expectedFoundryVersion in the configuration.

.PARAMETER SkipAzureChecks
    Check only the Zava page and wake the relay. Needs no Azure CLI or sign-in; the
    Foundry agent and the Cloud PC pool are not checked.
#>
[CmdletBinding()]
param(
    [string]$ConfigPath = '',
    [ValidateRange(0, 60)][int]$WaitForCloudPcMinutes = 0,
    [string]$ExpectedFoundryVersion = '',
    [switch]$SkipAzureChecks
)

$PackageVersion = '1.0.0'
$ErrorActionPreference = 'Stop'
$results = New-Object System.Collections.Generic.List[object]

# Windows PowerShell 5.1 may not offer TLS 1.2 by default; PowerShell 7 ignores this.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

function Add-Result([string]$Name, [ValidateSet('READY', 'PREPARING', 'ACTION', 'SKIPPED')][string]$State, [string]$Detail) {
    $results.Add([pscustomobject]@{ Check = $Name; State = $State; Detail = $Detail })
    $color = @{ READY = 'Green'; PREPARING = 'Yellow'; ACTION = 'Red'; SKIPPED = 'Gray' }[$State]
    $label = @{ READY = 'READY'; PREPARING = 'STILL PREPARING'; ACTION = 'ACTION NEEDED'; SKIPPED = 'NOT CHECKED' }[$State]
    Write-Host ("[{0}] {1}: {2}" -f $label, $Name, $Detail) -ForegroundColor $color
}

function Resolve-ProfileDir([string]$Dir) {
    if (-not $Dir) { return '' }
    $expanded = [Environment]::ExpandEnvironmentVariables($Dir)
    if (-not [IO.Path]::IsPathRooted($expanded)) { $expanded = Join-Path $script:configFolder $expanded }
    return [IO.Path]::GetFullPath($expanded)
}

function Get-ProfileLabel([string]$Dir) {
    if ($Dir) { return "Azure CLI profile folder '$Dir'" } else { return 'the default Azure CLI profile' }
}

function Get-SignInCommand([string]$Dir, [string]$LoginArgs) {
    $tenant = if ($script:cfg.tenantId) { $script:cfg.tenantId } else { '<tenant-id>' }
    $set = if ($Dir) { "`$env:AZURE_CONFIG_DIR = '$Dir'" } else { 'Remove-Item Env:AZURE_CONFIG_DIR -ErrorAction SilentlyContinue' }
    return "$set; az login $LoginArgs --tenant $tenant"
}

function Get-AzToken([string]$Resource, [string]$ConfigDir) {
    # Bounded: an Azure CLI call that hangs must not hold up the demo.
    $job = Start-Job -ScriptBlock {
        param($r, $d)
        if ($d) { $env:AZURE_CONFIG_DIR = $d } else { Remove-Item Env:AZURE_CONFIG_DIR -ErrorAction SilentlyContinue }
        az account get-access-token --resource $r --query accessToken -o tsv 2>$null
    } -ArgumentList $Resource, $ConfigDir
    try {
        if (-not (Wait-Job $job -Timeout 60)) { return $null }
        $token = (Receive-Job $job -ErrorAction SilentlyContinue) | Select-Object -Last 1
        if ($token -and $token.Length -gt 100) { return $token } else { return $null }
    } finally {
        Remove-Job $job -Force -ErrorAction SilentlyContinue
    }
}

function Get-HttpStatus($ErrorRecord) {
    try { return [int]$ErrorRecord.Exception.Response.StatusCode } catch { return 0 }
}

function Invoke-Timed([scriptblock]$Call) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $value = & $Call
    return @{ Value = $value; Seconds = [math]::Round($watch.Elapsed.TotalSeconds, 1) }
}

# --- Configuration -------------------------------------------------------------------
if (-not $ConfigPath) {
    $ConfigPath = if ($env:FOUNDRY_DEMO_CONFIG) { $env:FOUNDRY_DEMO_CONFIG } else { Join-Path $PSScriptRoot 'foundry-demo.config.json' }
}
Write-Host ("Zava Foundry demo preparation {0} - PowerShell {1}" -f $PackageVersion, $PSVersionTable.PSVersion)
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    Write-Host "ACTION NEEDED: no configuration file at '$ConfigPath'." -ForegroundColor Red
    Write-Host "Copy foundry-demo.config.template.json (in $PSScriptRoot) to foundry-demo.config.json in the same folder and fill it in," -ForegroundColor Red
    Write-Host "or pass -ConfigPath <file>. Your environment administrator can supply a filled-in file." -ForegroundColor Red
    exit 2
}
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$script:configFolder = Split-Path -Parent $ConfigPath
try {
    $script:cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
} catch {
    Write-Host "ACTION NEEDED: the configuration file '$ConfigPath' is not valid JSON: $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}
$cfg = $script:cfg
$required = @('zavaUrl', 'relayUrl')
if (-not $SkipAzureChecks) { $required += 'foundryAgentUrl', 'cloudPcPoolId' }
foreach ($key in $required) {
    $value = [string]$cfg.$key
    if (-not $value -or $value -match '<[^>]+>') {
        Write-Host "ACTION NEEDED: configuration '$ConfigPath' has no real value for '$key' (still empty or a <placeholder>)." -ForegroundColor Red
        Write-Host "Copy foundry-demo.config.template.json to foundry-demo.config.json and fill it with the values supplied by the environment maintainer. See START-HERE.txt in this package." -ForegroundColor Red
        exit 2
    }
}
if (-not $ExpectedFoundryVersion -and $cfg.expectedFoundryVersion) { $ExpectedFoundryVersion = [string]$cfg.expectedFoundryVersion }
$poolDir = Resolve-ProfileDir ([string]$cfg.poolAzureConfigDir)
$foundryDir = Resolve-ProfileDir ([string]$cfg.foundryAzureConfigDir)

$started = Get-Date
Write-Host ("Configuration: {0}" -f $ConfigPath)
Write-Host ("Started {0:HH:mm:ss}. Read-only except waking the relay; no claim, transfer or Cloud PC." -f $started)

# --- 1. Zava page --------------------------------------------------------------------
try {
    $r = Invoke-Timed { Invoke-WebRequest -Uri $cfg.zavaUrl -UseBasicParsing -TimeoutSec 60 }
    Add-Result 'Zava page' 'READY' "opens (HTTP $($r.Value.StatusCode), $($r.Seconds) s)."
} catch {
    Add-Result 'Zava page' 'ACTION' "did not open ($($_.Exception.Message)). Check the zavaUrl setting and the Static Web App before presenting."
}

# --- 2. Relay: wake it and read its availability -------------------------------------
try {
    $r = Invoke-Timed { Invoke-RestMethod -Uri ($cfg.relayUrl.TrimEnd('/') + '/availability') -TimeoutSec 60 }
    $a = $r.Value
    if ($a.configured -and $a.ready) {
        Add-Result 'Relay' 'READY' ("answered in {0} s and is enabled for Foundry transfers. Awake now; it may sleep again after a few idle minutes (then the first check takes about 5 s)." -f $r.Seconds)
    } else {
        Add-Result 'Relay' 'ACTION' "answered but is not ready: '$($a.message)'. Foundry transfers stay disabled in Zava until the environment administrator fixes this."
    }
} catch {
    Add-Result 'Relay' 'ACTION' "did not answer ($($_.Exception.Message)). Check the relayUrl setting; Zava cannot transfer to Foundry while the relay is down."
}

# --- 3 and 4 need the Azure CLI --------------------------------------------------------
$azAvailable = $false
if ($SkipAzureChecks) {
    Add-Result 'Foundry agent' 'SKIPPED' '-SkipAzureChecks was used.'
    Add-Result 'Cloud PC pool' 'SKIPPED' '-SkipAzureChecks was used. Ask the environment administrator whether a Cloud PC is free.'
} elseif (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    $hint = "the Azure CLI is not installed on this computer. Install it (winget install -e --id Microsoft.AzureCLI, then open a new window), or rerun with -SkipAzureChecks to check only the Zava page and relay."
    Add-Result 'Foundry agent' 'ACTION' $hint
    Add-Result 'Cloud PC pool' 'ACTION' $hint
} else {
    $azAvailable = $true
}

# --- 3. Foundry agent version (read-only management read; never invokes the agent) ---
if ($azAvailable) {
    $foundryToken = Get-AzToken 'https://ai.azure.com' $foundryDir
    if (-not $foundryToken) {
        Add-Result 'Foundry agent' 'ACTION' ("no Azure CLI sign-in for Foundry in {0}. Sign in once with an account that has the Foundry User role on the Foundry project: {1}" -f (Get-ProfileLabel $foundryDir), (Get-SignInCommand $foundryDir '--allow-no-subscriptions'))
    } else {
        try {
            $agent = Invoke-RestMethod -Uri $cfg.foundryAgentUrl -Headers @{ Authorization = "Bearer $foundryToken" } -TimeoutSec 60
            $latest = $agent.versions.latest
            $settings = $latest.definition.environment_variables
            $image = [string]$latest.definition.container_configuration.image
            $gates = ($settings.LIVE_EXECUTION_APPROVED -eq 'yes') -and ($settings.CLAIMS_EXECUTION_APPROVED -eq 'yes')
            if ($latest.status -ne 'active') {
                Add-Result 'Foundry agent' 'ACTION' "version $($latest.version) is '$($latest.status)', not active."
            } elseif (-not $gates) {
                Add-Result 'Foundry agent' 'ACTION' "version $($latest.version) is active but its live/Claims execution gates are not both 'yes'."
            } elseif ($ExpectedFoundryVersion -and [string]$latest.version -ne $ExpectedFoundryVersion) {
                Add-Result 'Foundry agent' 'ACTION' "active version is $($latest.version), expected $ExpectedFoundryVersion. If the new version is intended, update expectedFoundryVersion in the configuration."
            } else {
                Add-Result 'Foundry agent' 'READY' ("version {0} active, Claims enabled, image ...{1}. (Configuration only: each transfer starts its own sandbox.)" -f $latest.version, $image.Substring([math]::Max(0, $image.Length - 12)))
            }
        } catch {
            $status = Get-HttpStatus $_
            if ($status -eq 401 -or $status -eq 403) {
                Add-Result 'Foundry agent' 'ACTION' ("{0} is signed in but may not read this agent (HTTP {1}). It needs the Foundry User role on the Foundry project; or point foundryAzureConfigDir at a sign-in that has it." -f (Get-ProfileLabel $foundryDir), $status)
            } elseif ($status -eq 404) {
                Add-Result 'Foundry agent' 'ACTION' 'was not found (HTTP 404). Check foundryAgentUrl (account, project and agent name).'
            } else {
                Add-Result 'Foundry agent' 'ACTION' "could not be read ($($_.Exception.Message))."
            }
        } finally {
            $foundryToken = $null
        }
    }
}

# --- 4. Windows 365 agent pool: is a Cloud PC free now? -------------------------------
if ($azAvailable) {
    $poolUrl = "https://graph.microsoft.com/beta/deviceManagement/virtualEndpoint/cloudPcPools/$($cfg.cloudPcPoolId)"
    $deadline = (Get-Date).AddMinutes($WaitForCloudPcMinutes)
    while ($true) {
        $graphToken = Get-AzToken 'https://graph.microsoft.com' $poolDir
        if (-not $graphToken) {
            Add-Result 'Cloud PC pool' 'ACTION' ("no Azure CLI sign-in for Microsoft Graph in {0}. Reading the pool needs an app (service principal) sign-in with the Graph application permission CloudPC.Read.All; a personal 'az login' cannot read pools. Sign in once, entering the app's certificate or secret yourself (never in the configuration file): {1}" -f (Get-ProfileLabel $poolDir), (Get-SignInCommand $poolDir '--service-principal --username <app-id> --certificate <path-to-pem>'))
            break
        }
        try {
            $pool = Invoke-RestMethod -Uri $poolUrl -Headers @{ Authorization = "Bearer $graphToken" } -TimeoutSec 60
        } catch {
            $status = Get-HttpStatus $_
            if ($status -eq 401 -or $status -eq 403) {
                Add-Result 'Cloud PC pool' 'ACTION' ("{0} is signed in but may not read Cloud PC pools (HTTP {1}). It must be an app sign-in with the Graph application permission CloudPC.Read.All; set poolAzureConfigDir to that sign-in's profile folder." -f (Get-ProfileLabel $poolDir), $status)
            } elseif ($status -eq 404) {
                Add-Result 'Cloud PC pool' 'ACTION' 'was not found (HTTP 404). Check cloudPcPoolId.'
            } else {
                Add-Result 'Cloud PC pool' 'ACTION' "could not be read ($($_.Exception.Message))."
            }
            break
        } finally {
            $graphToken = $null
        }
        $available = [int]$pool.sessionUsage.availableSessionsCount
        $active = [int]$pool.sessionUsage.activeSessionsCount
        $size = $pool.scalingPolicy.maximumCount
        $summary = "pool '$($pool.displayName)' ($($pool.poolStatus)): $available available, $active in use, size $size."
        if ($pool.poolStatus -ne 'running') {
            Add-Result 'Cloud PC pool' 'ACTION' "$summary The pool is not running; the environment administrator should check it in Intune."
            break
        }
        if ($available -ge 1) {
            Add-Result 'Cloud PC pool' 'READY' "$summary Keep it free: any transfer now (including a rehearsal) uses it, and a single-PC pool took about 15-17 minutes to become usable again after a run."
            break
        }
        if ($active -ge 1) {
            Add-Result 'Cloud PC pool' 'ACTION' "$summary A Cloud PC is in use. If no transfer should be running, open that transfer in Zava and use its status/release; an unreleased session is reclaimed only after 30 idle minutes."
            break
        }
        if ((Get-Date) -ge $deadline) {
            Add-Result 'Cloud PC pool' 'PREPARING' "$summary It is resetting after its last use (about 15-17 minutes after release in the reference environment). Rerun shortly; do not start a transfer until it shows available."
            break
        }
        Write-Host ("  {0:HH:mm:ss} {1} Resetting; checking again in 60 s (until {2:HH:mm})." -f (Get-Date), $summary, $deadline)
        Start-Sleep -Seconds 60
    }
}

Write-Host ''
Write-Host 'In the browser you will present from (this tool cannot check it):'
Write-Host "  1. Open $($cfg.zavaUrl.TrimEnd('/'))/workspace, signed in as the presenter."
Write-Host '  2. Simulate Inbound Call -> Answer -> Transfer. "Claims Automation Agent (Foundry)" must be enabled'
Write-Host '     with no message under it (no "Reconnect Microsoft sign-in", "could not be used" or "may still be running").'
Write-Host '     Opening the transfer list also wakes the relay. If Zava asks to reconnect, do it now; the call is kept.'
Write-Host '  3. Close the transfer list without choosing the AI agent (choosing it opens the confirmation,'
Write-Host '     which prepares a Foundry sandbox), then use Reset demo. Do not submit a warm-up claim.'
Write-Host ''

$states = @($results | ForEach-Object { $_.State })
$worst = if ($states -contains 'ACTION') { 'ACTION' } elseif ($states -contains 'PREPARING') { 'PREPARING' } else { 'READY' }
$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds)
$scope = if ($SkipAzureChecks) { ' for the Zava page and relay only' } else { '' }
switch ($worst) {
    'READY' { Write-Host "OVERALL: READY$scope ($elapsed s). Do the browser check; present within a few minutes so the relay stays awake." -ForegroundColor Green; exit 0 }
    'PREPARING' { Write-Host "OVERALL: STILL PREPARING ($elapsed s). Rerun before presenting." -ForegroundColor Yellow; exit 1 }
    default { Write-Host "OVERALL: ACTION NEEDED ($elapsed s). Fix the items above, then rerun." -ForegroundColor Red; exit 2 }
}
