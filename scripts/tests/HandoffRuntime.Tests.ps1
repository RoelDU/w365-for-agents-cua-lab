# Handoff Function app runtime (docs QA D1).
#
# Microsoft lists Node.js 22 as the last Node.js version supported for Linux Consumption plan
# apps. New installs must use it; an existing app's runtime is reported and never changed.
# 'az' and Invoke-Native are stubs here: nothing signs in and no request reaches Azure.
#
# Run with: Invoke-Pester -Path .\scripts\tests\HandoffRuntime.Tests.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here '..\DemoCommon.ps1')

function Use-AzStub([string]$ExistingRuntime, [switch]$Missing, [switch]$RuntimeUnreadable) {
    $global:zNative = New-Object System.Collections.Generic.List[string]
    $global:zRuntime = $ExistingRuntime
    $global:zMissing = [bool]$Missing
    $global:zRuntimeUnreadable = [bool]$RuntimeUnreadable
}

Describe 'Get-HandoffFunctionAppCreateArguments' {
    It 'creates a Linux Consumption app on Node.js 22, Functions v4, with a managed identity' {
        $a = Get-HandoffFunctionAppCreateArguments -Name 'fn' -ResourceGroup 'rg' -StorageAccount 'sa' -Location 'australiaeast'
        $joined = $a -join ' '
        $joined | Should Match '--consumption-plan-location australiaeast'
        $joined | Should Match '--os-type Linux'
        $joined | Should Match '--runtime node --runtime-version 22 '
        $joined | Should Match '--functions-version 4'
        $joined | Should Match '--assign-identity \[system\]'
        $joined | Should Not Match '--runtime-version 24'
    }
}

Describe 'Confirm-HandoffFunctionApp' {
    function az {
        $global:LASTEXITCODE = 0
        $line = $args -join ' '
        if ($line -like 'functionapp show*') {
            if ($global:zMissing) { $global:LASTEXITCODE = 3; return $null }
            return '/subscriptions/x/resourceGroups/rg/providers/Microsoft.Web/sites/fn'
        }
        if ($line -like 'functionapp config show*') {
            if ($global:zRuntimeUnreadable) { $global:LASTEXITCODE = 1; return $null }
            return $global:zRuntime
        }
        throw "unexpected az call: $line"
    }
    function Invoke-Native { param($File, $Arguments, $Action, [switch]$AllowNonZero) $global:zNative.Add(($Arguments -join ' ')) }

    It 'creates a missing app on Node.js 22' {
        Use-AzStub -Missing
        $r = Confirm-HandoffFunctionApp -Name 'fn' -ResourceGroup 'rg' -StorageAccount 'sa' -Location 'australiaeast' 6>$null
        $r.Status | Should Be 'Created'
        $global:zNative.Count | Should Be 1
        $global:zNative[0] | Should Match '^functionapp create .*--runtime-version 22 '
    }

    It 'changes nothing for a missing app in a -WhatIf preview' {
        Use-AzStub -Missing
        $r = Confirm-HandoffFunctionApp -Name 'fn' -ResourceGroup 'rg' -StorageAccount 'sa' -Location 'australiaeast' -WhatIf 6>$null
        $r.Status | Should Be 'Planned'
        $global:zNative.Count | Should Be 0
    }

    It 'keeps an existing app on node|24 and names the explicit next action' {
        Use-AzStub -ExistingRuntime 'NODE|24'
        $r = Confirm-HandoffFunctionApp -Name 'fn' -ResourceGroup 'rg' -StorageAccount 'sa' -Location 'australiaeast' -WarningVariable w -WarningAction SilentlyContinue 6>$null
        $r.Status | Should Be 'Mismatch'
        @($global:zNative | Where-Object { $_ -match 'config set|linux-fx-version|functionapp create' }).Count | Should Be 0
        @($global:zNative | Where-Object { $_ -like 'functionapp identity assign*' }).Count | Should Be 1
        ($w -join ' ') | Should Match "reports runtime 'NODE\|24'"
        ($w -join ' ') | Should Match 'did not change this app'
        ($w -join ' ') | Should Match "az functionapp config set --name 'fn' --resource-group 'rg' --linux-fx-version `"node\|22`""
    }

    It 'keeps an existing app on node|20 unchanged too' {
        Use-AzStub -ExistingRuntime 'Node|20'
        $r = Confirm-HandoffFunctionApp -Name 'fn' -ResourceGroup 'rg' -StorageAccount 'sa' -Location 'australiaeast' -WarningAction SilentlyContinue 6>$null
        $r.Status | Should Be 'Mismatch'
        @($global:zNative | Where-Object { $_ -match 'config set|linux-fx-version' }).Count | Should Be 0
    }

    It 'accepts an existing app on Node 22 in any letter case, without a warning' {
        Use-AzStub -ExistingRuntime 'Node|22'
        $r = Confirm-HandoffFunctionApp -Name 'fn' -ResourceGroup 'rg' -StorageAccount 'sa' -Location 'australiaeast' -WarningVariable w 6>$null
        $r.Status | Should Be 'Match'
        @($w).Count | Should Be 0
    }

    It 'reports an unreadable runtime without changing the app' {
        Use-AzStub -RuntimeUnreadable
        $r = Confirm-HandoffFunctionApp -Name 'fn' -ResourceGroup 'rg' -StorageAccount 'sa' -Location 'australiaeast' -WarningVariable w -WarningAction SilentlyContinue 6>$null
        $r.Status | Should Be 'Unknown'
        ($w -join ' ') | Should Match 'did not change it'
        @($global:zNative | Where-Object { $_ -match 'config set|linux-fx-version' }).Count | Should Be 0
    }

    It 'only reads an existing app in a -WhatIf preview' {
        Use-AzStub -ExistingRuntime 'node|24'
        $r = Confirm-HandoffFunctionApp -Name 'fn' -ResourceGroup 'rg' -StorageAccount 'sa' -Location 'australiaeast' -WhatIf -WarningAction SilentlyContinue 6>$null
        $r.Status | Should Be 'Mismatch'
        $global:zNative.Count | Should Be 0
    }
}

Describe 'New-DemoHandoffOrchestrator -WhatIf (outer preview reaches the Function app step)' {
    # Stubs stop the run at the Key Vault step, right after the Function app step.
    function Register-DemoProvider { }
    function Invoke-Native { param($File, $Arguments, $Action, [switch]$AllowNonZero) $global:zNative.Add(($Arguments -join ' ')) }
    function az {
        $global:LASTEXITCODE = 0
        $line = $args -join ' '
        if ($line -like 'group exists*') { return 'true' }
        if ($line -like 'storage account show*') { return 'sa-id' }
        if ($line -like 'functionapp show*') {
            if ($global:zMissing) { $global:LASTEXITCODE = 3; return $null }
            return 'fn-id'
        }
        if ($line -like 'functionapp config show*') { return $global:zRuntime }
        if ($line -like 'keyvault*') { throw 'STOP-AFTER-FUNCTION-APP' }
        throw "unexpected az call: $line"
    }
    $cfg = [pscustomobject]@{
        azure = [pscustomobject]@{ location = 'australiaeast' }
        handoffOrchestrator = [pscustomobject]@{ resourceGroup = 'rg'; functionAppName = 'fn'; storageAccountName = 'sa'; keyVaultName = 'kv' }
    }
    $repoRoot = (Resolve-Path (Join-Path $here '..\..')).Path

    foreach ($case in @(@{ Missing = $true; Runtime = '' }, @{ Missing = $false; Runtime = 'node|24' })) {
        It "makes no change (missing app: $($case.Missing))" {
            Use-AzStub -ExistingRuntime $case.Runtime -Missing:$case.Missing
            $err = $null
            try { New-DemoHandoffOrchestrator -Config $cfg -RepoRoot $repoRoot -WhatIf -WarningAction SilentlyContinue 6>$null | Out-Null }
            catch { $err = $_.Exception.Message }
            $err | Should Match 'STOP-AFTER-FUNCTION-APP'
            $global:zNative.Count | Should Be 0
        }
    }
}

Describe 'New-DemoHandoffOrchestrator source' {
    It 'never sets an existing app''s Linux runtime' {
        $src = Get-Content -Raw (Join-Path $here '..\DemoCommon.ps1')
        ($src -match "'--linux-fx-version'") | Should Be $false
        ($src -match "'--runtime-version', '24'") | Should Be $false
        ($src -match 'Confirm-HandoffFunctionApp -Name \$fn') | Should Be $true
    }
}
