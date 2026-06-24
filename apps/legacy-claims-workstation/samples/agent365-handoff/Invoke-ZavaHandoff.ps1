# Invoke-ZavaHandoff.ps1 - local handoff simulator.
#
# Mimics what Agent365 / a local launcher would do:
#   1. Create handoff in\ and out\ folders.
#   2. Copy a prefill JSON into in\.
#   3. Launch claims.exe with --prefill, --result, --ready-file.
#   4. Wait for ready.json - meaning the app is fully loaded and CUA-ready.
#   5. (Operator or CUA submits the FNOL through the GUI.)
#   6. Wait for result.json or error.json.
#   7. Print the claim ID.
#
# Not a production driver - it's a contract test for the legacy app's
# handoff seam.

[CmdletBinding()]
param(
    [string]$ScenarioFile = (Join-Path $PSScriptRoot 'sample-request.json'),
    [string]$ExePath      = $(
        # Prefer adjacent ..\..\claims.exe (build output), else system install.
        $local = Join-Path (Split-Path $PSScriptRoot -Parent) '..\claims.exe' | Resolve-Path -ErrorAction SilentlyContinue
        if ($local) { $local.Path }
        elseif (Test-Path (Join-Path $env:ProgramFiles 'Business Applications\Zava Claims Workstation\claims.exe')) { Join-Path $env:ProgramFiles 'Business Applications\Zava Claims Workstation\claims.exe' }
        elseif (Test-Path 'C:\ZavaClaims\claims.exe') { 'C:\ZavaClaims\claims.exe' }
        else { throw "claims.exe not found; build the app first or pass -ExePath" }
    ),
    [string]$HandoffDir = (Join-Path $env:TEMP ('ZavaHandoff_' + [Guid]::NewGuid().ToString('N'))),
    [int]   $DemoPin    = 1234,
    [switch]$FastAuth   = $true,
    [int]   $TimeoutSec = 600
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ScenarioFile)) { throw "Scenario file not found: $ScenarioFile" }
$inDir  = Join-Path $HandoffDir 'in'
$outDir = Join-Path $HandoffDir 'out'
New-Item -ItemType Directory -Force -Path $inDir, $outDir | Out-Null
$prefill = Join-Path $inDir 'prefill.json'
Copy-Item -Force $ScenarioFile $prefill
$ready  = Join-Path $outDir 'ready.json'
$result = Join-Path $outDir 'result.json'
$err    = Join-Path $outDir 'error.json'

$argList = @(
    "--prefill=$prefill",
    "--ready-file=$ready",
    "--result=$result",
    "--handoff-dir=$HandoffDir",
    "--no-splash",
    "--stable-host",
    "--idle-timeout=0",
    "--demo-pin=$DemoPin"
)
if ($FastAuth) { $argList += "--fast-auth" }

Write-Host "Launching $ExePath ..."
$proc = Start-Process -FilePath $ExePath -ArgumentList $argList -PassThru

Write-Host "Waiting for ready.json ..."
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline -and -not (Test-Path $ready)) {
    if ($proc.HasExited) { throw "claims.exe exited before ready.json (code $($proc.ExitCode))" }
    Start-Sleep -Milliseconds 300
}
if (-not (Test-Path $ready)) { throw "ready.json never appeared" }
$readyObj = Get-Content $ready | ConvertFrom-Json
Write-Host "READY:"
Write-Host "  request_id: $($readyObj.request_id)"
Write-Host "  matched policy: $($readyObj.matched_policy_number)"
Write-Host "  matched customer: $($readyObj.matched_customer_name)"

Write-Host "Complete the FNOL in the legacy app window (or let CUA drive it)."
Write-Host "Waiting for result.json or error.json ..."
while ((Get-Date) -lt $deadline -and -not (Test-Path $result) -and -not (Test-Path $err)) {
    if ($proc.HasExited) { break }
    Start-Sleep -Milliseconds 300
}

if (Test-Path $err) {
    $errObj = Get-Content $err | ConvertFrom-Json
    Write-Host "ERROR: $($errObj.error_code) - $($errObj.message)"
    exit 2
}
if (Test-Path $result) {
    $r = Get-Content $result | ConvertFrom-Json
    Write-Host "SUBMITTED:"
    Write-Host "  request_id: $($r.request_id)"
    Write-Host "  claim_id:   $($r.claim_id)"
    Write-Host "  policy:     $($r.policy_number)"
    Write-Host "  agent_id:   $($r.agent_id)"
    Write-Host "  reserve:    $($r.reserve_amount)"
    exit 0
}

Write-Host "Timed out waiting for result." -ForegroundColor Yellow
exit 3
