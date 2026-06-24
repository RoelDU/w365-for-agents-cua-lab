<#
.SYNOPSIS
  Self-service end-to-end smoke test for the Zava CCaaS handoff orchestrator.

.DESCRIPTION
  Drives a real handoff against a deployed orchestrator and watches it advance
  queued -> ready -> submitted, so you can validate the chain yourself without any
  other tooling or a second person.

  Two modes:

    (default)         Start a handoff and poll status. A REAL run advances to
                      'ready' and then waits for the Copilot Studio agent to file
                      the claim and POST the result callback. If your agent's
                      handoff wiring (issue #69: the start_fnol_handoff trigger
                      topic that invokes Computer Use + the result flow) is not in
                      place yet, the run will sit at 'ready' - that is the expected
                      diagnosis, not a script failure.

    -SimulateResult   After the handoff reaches 'ready', POST the structured result
                      callback yourself (exactly what the agent's Power Automate
                      result flow would send). This proves the orchestrator +
                      callback chain end-to-end (queued -> ready -> submitted)
                      WITHOUT a live agent or Cloud PC. Requires -CallbackKey.

.PARAMETER BaseUrl
  Orchestrator base URL ending in /api, e.g.
  https://zava-handoff-xxxx.azurewebsites.net/api
  (the build prints this as "Orchestrator : ..."). If omitted, the script reads
  handoffOrchestrator.baseUrl from scripts/demo-config.local.json.

.PARAMETER CallbackKey
  The HANDOFF_CALLBACK_KEY (the build prints it as "Callback key : ..."). Required
  only for -SimulateResult. If omitted, read from demo-config.local.json.

.PARAMETER SimulateResult
  Inject the result callback once the handoff is 'ready' (no live agent needed).

.PARAMETER ClaimId
  The claim id to report in the simulated result (default: a generated CLM id).

.PARAMETER TimeoutSeconds
  How long to poll before giving up (default 180).

.PARAMETER PollSeconds
  Seconds between status polls (default 5).

.EXAMPLE
  # Validate the full chain yourself, no agent required:
  pwsh -File .\scripts\Test-Handoff.ps1 -SimulateResult

.EXAMPLE
  # Watch a REAL run (shows how far the live agent gets):
  pwsh -File .\scripts\Test-Handoff.ps1 -BaseUrl https://zava-handoff-xxxx.azurewebsites.net/api
#>
[CmdletBinding()]
param(
    [string]$BaseUrl,
    [string]$CallbackKey,
    [switch]$SimulateResult,
    [string]$ClaimId,
    [int]$TimeoutSeconds = 180,
    [int]$PollSeconds = 5
)

$ErrorActionPreference = "Stop"

function Read-LocalConfig {
    $cfgPath = Join-Path $PSScriptRoot "demo-config.local.json"
    if (-not (Test-Path -LiteralPath $cfgPath)) { return $null }
    try { return Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json } catch { return $null }
}

if ([string]::IsNullOrWhiteSpace($BaseUrl) -or ($SimulateResult -and [string]::IsNullOrWhiteSpace($CallbackKey))) {
    $cfg = Read-LocalConfig
    if ($cfg -and $cfg.handoffOrchestrator) {
        if ([string]::IsNullOrWhiteSpace($BaseUrl))     { $BaseUrl     = [string]$cfg.handoffOrchestrator.baseUrl }
        if ([string]::IsNullOrWhiteSpace($CallbackKey)) { $CallbackKey = [string]$cfg.handoffOrchestrator.callbackKey }
    }
}

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    throw "No orchestrator BaseUrl. Pass -BaseUrl https://<func>.azurewebsites.net/api (the build prints it as 'Orchestrator : ...'), or set handoffOrchestrator.baseUrl in scripts/demo-config.local.json."
}
$BaseUrl = $BaseUrl.TrimEnd("/")
if ($SimulateResult -and [string]::IsNullOrWhiteSpace($CallbackKey)) {
    throw "-SimulateResult needs -CallbackKey (the build prints it as 'Callback key : ...')."
}

function Write-Stamp([string]$Message, [string]$Color = "Gray") {
    Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Message) -ForegroundColor $Color
}

# 1) Health -------------------------------------------------------------------
Write-Stamp "Checking orchestrator health: $BaseUrl/health"
try {
    $health = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health" -TimeoutSec 30
    if ($health.status -ne "ok") { throw "health did not return ok (got: $($health | ConvertTo-Json -Compress))." }
    Write-Stamp "Health OK." "Green"
}
catch {
    throw "Health check failed against $BaseUrl/health. Confirm the orchestrator is deployed and the URL ends in /api. Underlying error: $($_.Exception.Message)"
}

# 2) Start a handoff (valid CallContext - see contract.js validateCallContext) -
$requestId = "REQ-SMOKE-{0:yyyyMMdd-HHmmss}-{1}" -f (Get-Date), (Get-Random -Maximum 9999)
if ([string]::IsNullOrWhiteSpace($ClaimId)) {
    $ClaimId = "CLM-{0:yyyy}-{1:D6}" -f (Get-Date), (Get-Random -Maximum 999999)
}
$callContext = [ordered]@{
    request_id    = $requestId
    caller_phone  = "(555) 123-4567"
    policy_number = "POL-2024-008341"
    intent        = "auto_collision"
    summary       = "Smoke test: rear-ended at 5th and Main, no injuries."
    timestamp     = (Get-Date).ToUniversalTime().ToString("o")
    requested_by  = [ordered]@{
        agent_id     = "ccaas-demo:csr-acarter"
        display_name = "A. Carter"
        email        = "acarter@zava.example"
    }
}
Write-Stamp "Starting handoff (request_id=$requestId) ..."
$start = Invoke-RestMethod -Method Post -Uri "$BaseUrl/handoff" -ContentType "application/json" -Body ($callContext | ConvertTo-Json -Depth 5)
$handoffId = $start.handoff_id
if ([string]::IsNullOrWhiteSpace($handoffId)) { throw "Start did not return a handoff_id. Response: $($start | ConvertTo-Json -Compress)" }
Write-Stamp "Handoff started: handoff_id=$handoffId status=$($start.status) ($($start.disposition))." "Cyan"

# 3) Poll status, printing each transition ------------------------------------
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$lastStatus = $null
$resultPosted = $false
$terminal = @("submitted", "error")

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $PollSeconds
    try {
        $s = Invoke-RestMethod -Method Get -Uri "$BaseUrl/handoff/$handoffId/status" -TimeoutSec 30
    }
    catch {
        Write-Stamp "Status read error (will retry): $($_.Exception.Message)" "Yellow"
        continue
    }
    if ($s.status -ne $lastStatus) {
        $detail = if ($s.claim_id) { " claim_id=$($s.claim_id)" } elseif ($s.error_code) { " error_code=$($s.error_code)" } else { "" }
        $color = switch ($s.status) { "submitted" { "Green" } "error" { "Red" } "ready" { "Cyan" } default { "Gray" } }
        Write-Stamp "status -> $($s.status)$detail" $color
        $lastStatus = $s.status
    }

    # Inject the result callback once we're 'ready' (simulating the agent's flow).
    if ($SimulateResult -and -not $resultPosted -and $s.status -eq "ready") {
        Write-Stamp "Injecting structured result callback (simulating the agent's Power Automate flow) ..." "Magenta"
        $resultBody = [ordered]@{
            correlation_id = $requestId
            status         = "succeeded"
            claim_id       = $ClaimId
            confidence     = 0.97
            error          = $null
        }
        try {
            $r = Invoke-RestMethod -Method Post -Uri "$BaseUrl/handoff/$handoffId/result" `
                -Headers @{ "x-handoff-key" = $CallbackKey } -ContentType "application/json" `
                -Body ($resultBody | ConvertTo-Json -Depth 5)
            Write-Stamp "Result callback accepted: $($r.note)" "Magenta"
        }
        catch {
            throw "Result callback POST failed (check -CallbackKey matches HANDOFF_CALLBACK_KEY): $($_.Exception.Message)"
        }
        $resultPosted = $true
    }

    if ($terminal -contains $s.status) {
        if ($s.status -eq "submitted") {
            Write-Stamp "END-TO-END OK: queued -> ready -> submitted. claim_id=$($s.claim_id)" "Green"
            exit 0
        }
        else {
            Write-Stamp "Handoff ended in ERROR: error_code=$($s.error_code) message=$($s.message)" "Red"
            exit 1
        }
    }
}

# Timed out --------------------------------------------------------------------
if ($lastStatus -eq "ready" -and $SimulateResult -and $resultPosted) {
    Write-Stamp "Timed out at 'ready' AFTER the result callback was accepted (202)." "Red"
    Write-Stamp "Meaning: raiseEvent succeeded but the orchestration never consumed 'handoffResult'." "Red"
    Write-Stamp "This is event DELIVERY, not orchestrator logic - the completion generator is proven" "Red"
    Write-Stamp "correct by apps/handoff-orchestrator/test/orchestrator.replay.test.js (real-SDK replay)." "Red"
    Write-Stamp "Check, in order:" "Yellow"
    Write-Stamp "  1) The deployed Function App is running the LATEST code (redeploy the orchestrator)." "Yellow"
    Write-Stamp "  2) The result function and the orchestrator share the SAME durable backend:" "Yellow"
    Write-Stamp "     identical AzureWebJobsStorage and host.json durableTask.hubName ('ZavaHandoffHub')." "Yellow"
    Write-Stamp "  3) App Insights for this handoff_id: after the EventRaised there must be a fresh" "Yellow"
    Write-Stamp "     OrchestratorStarted (a replay). If none appears, the event never reached the" "Yellow"
    Write-Stamp "     instance control queue - a storage/task-hub/deployment problem, not the code." "Yellow"
    Write-Stamp "     handoff_id=$handoffId" "Yellow"
}
elseif ($lastStatus -eq "ready" -and -not $SimulateResult) {
    Write-Stamp "Timed out at 'ready'. The handoff opened the conversation but no result arrived." "Yellow"
    Write-Stamp "This is the expected symptom when the agent handoff wiring is not yet done (issue #69):" "Yellow"
    Write-Stamp "  the start_fnol_handoff trigger topic must INVOKE Computer Use, and the result flow must POST back." "Yellow"
    Write-Stamp "  To prove the orchestrator+callback chain without an agent, re-run with -SimulateResult -CallbackKey <key>." "Yellow"
}
else {
    Write-Stamp "Timed out after ${TimeoutSeconds}s at status '$lastStatus' (handoff_id=$handoffId)." "Yellow"
}
exit 2
