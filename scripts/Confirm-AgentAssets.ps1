# Validates the Foundry / Copilot Studio agent assets and reports agentic-platform
# readiness for the CCaaS -> CUA -> legacy-claims demo.
#
# WHY THIS EXISTS (and why it is NOT an SDK "create-agent" script):
#   The agent assets in apps\legacy-claims-workstation\samples\foundry-agent are
#   authored for the *portal agent builder* (paste Instructions, upload Knowledge,
#   add tool definitions, enable Computer Use). The Computer Use model
#   (computer-use-preview) is access-gated public preview and the agent's Entra
#   Agent ID is provisioned in Agent 365 -- neither can be stood up by a script.
#   So this is the honest, runnable piece: a pre-demo readiness GATE that lints the
#   assets, prints the exact portal mapping, and (optionally) smoke-checks the
#   Foundry project endpoint + signed-in Azure identity. It complements the
#   tenant-readiness CUA checker (W365/AVD/Intune side) referenced in
#   docs\demo-environment-setup.md (Part B.0).
#
# Exit codes: 0 = all asset checks passed; 1 = one or more asset checks failed.

[CmdletBinding()]
param(
    # Folder holding the agent assets. Defaults to the in-repo sample set.
    [string]$AssetRoot,

    # Optional: Foundry project endpoint, e.g.
    #   https://<resource>.ai.azure.com/api/projects/<project>
    # When supplied, the script does a best-effort reachability + identity preflight.
    [string]$ProjectEndpoint,

    # The Computer Use model deployment the agent must use (access-gated preview).
    [string]$ModelDeploymentName = "computer-use-preview"
)

$ErrorActionPreference = "Stop"

# Robustly resolve the script directory ($PSScriptRoot can be empty depending on
# how the script is invoked), then default the asset root from it.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $AssetRoot) {
    $AssetRoot = Join-Path $scriptDir "..\apps\legacy-claims-workstation\samples\foundry-agent"
}

$script:failures = 0
$script:warnings = 0

function Write-Pass { param([string]$Message) Write-Host "  [PASS] $Message" -ForegroundColor Green }
function Write-Fail { param([string]$Message) Write-Host "  [FAIL] $Message" -ForegroundColor Red; $script:failures++ }
function Write-Warn { param([string]$Message) Write-Host "  [WARN] $Message" -ForegroundColor Yellow; $script:warnings++ }
function Write-Section { param([string]$Title) Write-Host ""; Write-Host "== $Title ==" -ForegroundColor Cyan }

# A required prose asset (Instructions / Knowledge) must exist and be non-trivial.
function Confirm-ProseAsset {
    param([string]$Path, [string]$Label, [int]$MinChars = 200)

    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Fail "$Label missing: $Path"
        return
    }
    $text = Get-Content -LiteralPath $Path -Raw
    $len = ($text -replace '\s', '').Length
    if ($len -lt $MinChars) {
        Write-Fail "$Label looks empty/stub ($len non-whitespace chars, expected >= $MinChars): $Path"
    }
    else {
        Write-Pass "$Label present ($len non-whitespace chars)."
    }
}

# A tool definition must be valid JSON and expose a 'name' and 'type'.
function Confirm-ToolAsset {
    param([string]$Path)

    $name = Split-Path $Path -Leaf
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Fail "Tool definition missing: $Path"
        return
    }
    try {
        $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Write-Fail "Tool '$name' is not valid JSON: $($_.Exception.Message)"
        return
    }
    if (-not $json.name) { Write-Fail "Tool '$name' has no 'name' property." ; return }
    if (-not $json.type) { Write-Fail "Tool '$name' has no 'type' property." ; return }
    Write-Pass "Tool '$name' valid (name='$($json.name)', type='$($json.type)')."
}

Write-Host "Agent-asset readiness check" -ForegroundColor White
Write-Host "Asset root: $AssetRoot"

if (-not (Test-Path -LiteralPath $AssetRoot)) {
    Write-Fail "Asset root not found: $AssetRoot"
    Write-Host ""
    Write-Host "RESULT: FAIL (asset root missing)" -ForegroundColor Red
    exit 1
}

# ---- 1. Always-in-context guidance + on-demand knowledge -------------------
Write-Section "Agent guidance assets"
Confirm-ProseAsset -Path (Join-Path $AssetRoot "AGENT-INSTRUCTIONS.md")    -Label "Agent Instructions"
Confirm-ProseAsset -Path (Join-Path $AssetRoot "CUA-TOOL-INSTRUCTIONS.md") -Label "CUA Tool Instructions"
Confirm-ProseAsset -Path (Join-Path $AssetRoot "KNOWLEDGE.md")             -Label "Knowledge file"

# ---- 2. Tool definitions ---------------------------------------------------
Write-Section "Tool definitions (tools\*.json)"
$toolsDir = Join-Path $AssetRoot "tools"
if (-not (Test-Path -LiteralPath $toolsDir)) {
    Write-Fail "tools\ folder missing: $toolsDir"
}
else {
    $toolFiles = Get-ChildItem -LiteralPath $toolsDir -Filter *.json -File
    if ($toolFiles.Count -eq 0) {
        Write-Fail "No tool definitions found in $toolsDir"
    }
    foreach ($t in $toolFiles) { Confirm-ToolAsset -Path $t.FullName }
}

# ---- 3. Evaluations (optional but expected) --------------------------------
Write-Section "Evaluation sets (evaluations\*.csv)"
$evalDir = Join-Path $AssetRoot "evaluations"
if (Test-Path -LiteralPath $evalDir) {
    $evals = Get-ChildItem -LiteralPath $evalDir -Filter *.csv -File
    if ($evals.Count -eq 0) { Write-Warn "No evaluation CSVs found in $evalDir" }
    else { Write-Pass "$($evals.Count) evaluation CSV(s) present." }
}
else {
    Write-Warn "evaluations\ folder not found (optional): $evalDir"
}

# ---- 4. Portal mapping (what goes where) -----------------------------------
Write-Section "Portal mapping - paste/upload into Foundry or Copilot Studio"
$mapping = @(
    [pscustomobject]@{ Asset = "AGENT-INSTRUCTIONS.md";    Target = "Agent Instructions (paste, skip header)" }
    [pscustomobject]@{ Asset = "CUA-TOOL-INSTRUCTIONS.md"; Target = "CUA Tool Instructions (paste, skip header)" }
    [pscustomobject]@{ Asset = "KNOWLEDGE.md";             Target = "Knowledge (upload as file)" }
    [pscustomobject]@{ Asset = "tools\*.json";             Target = "Tools (add each definition in the agent builder)" }
    [pscustomobject]@{ Asset = "evaluations\*.csv";        Target = "Evaluation (import in order; reset data before batches 3 and 4)" }
)
$mapping | Format-Table -AutoSize | Out-String | Write-Host

# ---- 5. Foundry project preflight (optional, best-effort) ------------------
Write-Section "Foundry platform preflight (Part B.0)"
if ($ProjectEndpoint) {
    if ($ProjectEndpoint -notmatch '^https://[^/]+\.ai\.azure\.com/api/projects/.+') {
        Write-Warn "ProjectEndpoint does not match the expected shape https://<resource>.ai.azure.com/api/projects/<project>"
    }
    else {
        Write-Pass "ProjectEndpoint is well-formed."
    }

    # Identity preflight: confirm a signed-in Azure identity (the principal that
    # will run the agent). Best-effort across Az PowerShell or the az CLI.
    $identity = $null
    if (Get-Command Get-AzContext -ErrorAction SilentlyContinue) {
        $ctx = Get-AzContext -ErrorAction SilentlyContinue
        if ($ctx) { $identity = $ctx.Account.Id }
    }
    if (-not $identity -and (Get-Command az -ErrorAction SilentlyContinue)) {
        try {
            $acct = az account show 2>$null | ConvertFrom-Json
            if ($acct) { $identity = $acct.user.name }
        }
        catch { }
    }
    if ($identity) { Write-Pass "Signed-in Azure identity: $identity" }
    else { Write-Warn "No signed-in Azure identity found (run Connect-AzAccount or az login as the principal that will own the agent)." }

    # Reachability smoke test (no data-plane schema assumptions).
    try {
        $projHost = ([Uri]$ProjectEndpoint).Host
        if ([System.Net.Dns]::GetHostAddresses($projHost)) {
            Write-Pass "Project host resolves: $projHost"
        }
    }
    catch {
        Write-Warn "Could not resolve project host: $($_.Exception.Message)"
    }
}
else {
    Write-Warn "No -ProjectEndpoint supplied; skipping Foundry reachability/identity preflight."
}

Write-Host ""
Write-Host "Manual confirmations still required in the demo tenant (cannot be scripted):" -ForegroundColor White
Write-Host "  - Access to '$ModelDeploymentName' approved (https://aka.ms/oai/cuaaccess) and a deployment created in the project."
Write-Host "  - Agent registered in Agent 365 with its own Entra Agent ID + least-privilege permissions."
Write-Host "  - Computer Use enabled on the agent and pointed at the agent's Cloud PC."
Write-Host "  - Windows 365 / CUA connection refreshed before each demo (token expires on session disconnect)."
Write-Host "  See docs\demo-environment-setup.md -> Part B.0 for the full enterprise setup order."

# ---- Result ----------------------------------------------------------------
Write-Host ""
if ($script:failures -gt 0) {
    Write-Host "RESULT: FAIL ($($script:failures) asset error(s), $($script:warnings) warning(s))" -ForegroundColor Red
    exit 1
}
Write-Host "RESULT: PASS (asset checks OK, $($script:warnings) warning(s) - clear manual items above before the demo)" -ForegroundColor Green
exit 0
