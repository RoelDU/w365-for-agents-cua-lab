# Regression tests for the handoff-orchestrator deployment wiring (see issue #39).
#
# The app uses the Azure Functions v4 Node programming model (programmatic
# app.* registration, no function.json). On Linux Consumption that model needs
# the app setting AzureWebJobsFeatureFlags=EnableWorkerIndexing, otherwise
# 'func publish' uploads fine but trigger sync returns BadRequest and every
# route returns HTTP 503. These tests guard that wiring so it cannot silently
# regress.
#
# Run with: Invoke-Pester -Path .\scripts\tests\Orchestrator.Tests.ps1

$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $here)

Describe 'Handoff orchestrator deployment wiring' {
    It 'sets AzureWebJobsFeatureFlags=EnableWorkerIndexing in the Function app settings' {
        $src = Get-Content -Raw (Join-Path $here '..\DemoCommon.ps1')
        ($src -match "AzureWebJobsFeatureFlags\s*=\s*'EnableWorkerIndexing'") | Should Be $true
    }

    It 'surfaces a targeted remediation when func publish fails at trigger sync' {
        $src = Get-Content -Raw (Join-Path $here '..\DemoCommon.ps1')
        ($src -match "sync\\s\*triggers") | Should Be $true
        ($src -match 'EnableWorkerIndexing') | Should Be $true
    }

    It 'still uses the v4 programming model (no function.json files)' {
        $appDir = Join-Path $repoRoot 'apps\handoff-orchestrator'
        $funcJson = Get-ChildItem -Path $appDir -Recurse -Filter 'function.json' -ErrorAction SilentlyContinue
        @($funcJson).Count | Should Be 0
    }
}
