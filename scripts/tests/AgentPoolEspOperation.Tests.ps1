# Tests for the Plan / Apply / Remove paths of Set-AgentPoolEspSkip.ps1 against
# an in-memory fake of the Graph calls. Synthetic IDs only; nothing connects to
# Graph and nothing is written to a tenant.
#
# Run with: Invoke-Pester -Path .\scripts\tests\AgentPoolEspOperation.Tests.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here '..\AgentPoolEsp.ps1')

$Pool = 'Example-Agents-Pool'
$Tenant = '00000000-0000-0000-0000-000000000001'
$Base = 'https://graph.microsoft.com/beta/deviceManagement'

function global:New-FakeObject($Value) { $Value | ConvertTo-Json -Depth 8 | ConvertFrom-Json }

function global:Reset-FakeGraph {
    $names = Get-AgentPoolEspNames -PoolName 'Example-Agents-Pool'
    $global:FakeGraph = @{
        Names       = $names
        Pools       = @(New-FakeObject @{ '@odata.type' = '#microsoft.graph.cloudPcAgentPool'; id = 'pool-1'; displayName = 'Example-Agents-Pool' })
        Filters     = [ordered]@{}
        Esps        = [ordered]@{}
        Assignments = @{}
        Next        = 0
        Calls       = New-Object System.Collections.ArrayList
        FailOn      = $null
        TamperRule  = $false
        Preview     = New-FakeObject @{
            TotalRowCount = 1
            Columns       = @(@{ Name = 'deviceName' }, @{ Name = 'enrollmentProfileName' }, @{ Name = 'model' })
            Values        = @(, @('CPCA-0001', 'Example-Agents-Pool', 'Cloud PC for Agents'))
        }
    }
}

function global:Invoke-FakeGraph([string]$Method, [string]$Uri, $Body, [switch]$AllowNotFound) {
    $f = $global:FakeGraph
    $path = $Uri.Replace('https://graph.microsoft.com/beta/deviceManagement/', '').Split('?')[0]
    [void]$f.Calls.Add("$Method $path")
    if ($f.FailOn -eq "$Method $path") { throw "synthetic Graph failure: $Method $path" }
    $parts = $path.Split('/')
    $missing = { if ($AllowNotFound) { return $null }; throw "synthetic 404: $path" }
    switch -Regex ("$Method $path") {
        '^GET virtualEndpoint/cloudPcPools$' { return New-FakeObject @{ value = $f.Pools } }
        '^POST evaluateAssignmentFilter$' { return $f.Preview }
        '^GET assignmentFilters$' { return New-FakeObject @{ value = @($f.Filters.Values) } }
        '^GET deviceEnrollmentConfigurations$' { return New-FakeObject @{ value = @($f.Esps.Values) } }
        '^POST assignmentFilters$' {
            $f.Next++; $id = "filter-$($f.Next)"
            $obj = New-FakeObject $Body; $obj | Add-Member id $id
            if ($f.TamperRule) { $obj.rule = '(device.model -contains "Cloud PC")' }
            $f.Filters[$id] = $obj; return $obj
        }
        '^POST deviceEnrollmentConfigurations$' {
            # Live 3 Oct 2026: Graph returns a bare 400 when a custom ESP is created already hidden.
            if ($Body.showInstallationProgress -eq $false) { throw 'synthetic 400: ESP created with progress hidden' }
            $f.Next++; $id = "esp-$($f.Next)"
            $obj = New-FakeObject $Body; $obj | Add-Member id $id
            $f.Esps[$id] = $obj; $f.Assignments[$id] = @(); return $obj
        }
        '^POST deviceEnrollmentConfigurations/[^/]+/assign$' {
            $f.Assignments[$parts[1]] = @((New-FakeObject $Body).enrollmentConfigurationAssignments); return $null
        }
        '^GET deviceEnrollmentConfigurations/[^/]+/assignments$' {
            if (-not $f.Esps.Contains($parts[1])) { return & $missing }
            return New-FakeObject @{ value = @($f.Assignments[$parts[1]]) }
        }
        '^PATCH deviceEnrollmentConfigurations/[^/]+$' {
            if (-not $f.Esps.Contains($parts[1])) { return & $missing }
            foreach ($p in (New-FakeObject $Body).PSObject.Properties) { if ($p.Name -ne '@odata.type') { $f.Esps[$parts[1]].($p.Name) = $p.Value } }
            return $null
        }
        '^GET assignmentFilters/[^/]+$' { if ($f.Filters.Contains($parts[1])) { return $f.Filters[$parts[1]] }; return & $missing }
        '^GET deviceEnrollmentConfigurations/[^/]+$' { if ($f.Esps.Contains($parts[1])) { return $f.Esps[$parts[1]] }; return & $missing }
        '^DELETE assignmentFilters/[^/]+$' { $f.Filters.Remove($parts[1]); return $null }
        '^DELETE deviceEnrollmentConfigurations/[^/]+$' { $f.Esps.Remove($parts[1]); return $null }
    }
    throw "unexpected fake call: $Method $path"
}

function global:Add-FakeFilter($Id, $DisplayName, $Rule) {
    $global:FakeGraph.Filters[$Id] = New-FakeObject @{ id = $Id; displayName = $DisplayName; platform = 'windows10AndLater'; rule = $Rule }
}

function global:Add-FakeEsp($Id, $DisplayName) {
    $global:FakeGraph.Esps[$Id] = New-FakeObject @{
        '@odata.type' = '#microsoft.graph.windows10EnrollmentCompletionPageConfiguration'
        id = $Id; displayName = $DisplayName; showInstallationProgress = $true
    }
    $global:FakeGraph.Assignments[$Id] = @(New-FakeObject @{ target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = 'group-x' } })
}

function Get-Writes { @($global:FakeGraph.Calls | Where-Object { $_ -match '^(POST|PATCH|DELETE) ' -and $_ -ne 'POST evaluateAssignmentFilter' }) }

Describe 'Apply' {
    Mock Invoke-AgentPoolGraph { Invoke-FakeGraph -Method $Method -Uri $Uri -Body $Body -AllowNotFound:$AllowNotFound }

    It 'creates the filter and ESP, verifies them, assigns once and records the IDs' {
        Reset-FakeGraph
        $receiptPath = Join-Path $TestDrive 'apply.local.json'
        Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath | Out-Null

        $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
        $receipt.tenantId | Should Be $Tenant
        $receipt.poolName | Should Be $Pool
        $receipt.poolId | Should Be 'pool-1'
        $receipt.state | Should Be 'applied'
        $global:FakeGraph.Filters[$receipt.filterId].rule | Should Be '(device.enrollmentProfileName -eq "Example-Agents-Pool")'
        $global:FakeGraph.Esps[$receipt.espId].showInstallationProgress | Should Be $false
        $global:FakeGraph.Assignments[$receipt.espId].Count | Should Be 1
        $calls = @($global:FakeGraph.Calls)
        $calls.IndexOf("GET assignmentFilters/$($receipt.filterId)") | Should BeLessThan $calls.IndexOf("POST deviceEnrollmentConfigurations/$($receipt.espId)/assign")
        (Get-Writes) -join ',' | Should Be "POST assignmentFilters,POST deviceEnrollmentConfigurations,PATCH deviceEnrollmentConfigurations/$($receipt.espId),POST deviceEnrollmentConfigurations/$($receipt.espId)/assign"
    }

    It 'refuses a same-named broader filter it did not create and writes nothing' {
        Reset-FakeGraph
        Add-FakeFilter 'other-filter' $global:FakeGraph.Names.Filter '(device.model -contains "Cloud PC")'
        $receiptPath = Join-Path $TestDrive 'broad.local.json'
        $threw = $false
        try { Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath } catch { $threw = $true }
        $threw | Should Be $true 'not created by this script'
        @(Get-Writes).Count | Should Be 0
        Test-Path $receiptPath | Should Be $false
    }

    It 'refuses an unrelated same-named ESP and leaves its assignments alone' {
        Reset-FakeGraph
        Add-FakeEsp 'other-esp' $global:FakeGraph.Names.Esp
        { Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath (Join-Path $TestDrive 'esp.local.json') } | Should Throw 'not created by this script'
        @(Get-Writes).Count | Should Be 0
        $global:FakeGraph.Assignments['other-esp'][0].target.groupId | Should Be 'group-x'
    }

    It 'refuses to run again while a receipt from an earlier Apply exists' {
        Reset-FakeGraph
        $receiptPath = Join-Path $TestDrive 'again.local.json'
        Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath | Out-Null
        $global:FakeGraph.Calls.Clear()
        $threw = $false
        try { Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath } catch { $threw = $true }
        $threw | Should Be $true 'receipt'
        @(Get-Writes).Count | Should Be 0
    }

    It 'refuses when the filter preview reaches a device outside the pool' {
        Reset-FakeGraph
        $global:FakeGraph.Preview = New-FakeObject @{
            TotalRowCount = 1
            Columns       = @(@{ Name = 'deviceName' }, @{ Name = 'enrollmentProfileName' }, @{ Name = 'model' })
            Values        = @(, @('HOSTED-01', 'Example-Agents-Pool', 'Copilot Studio Hosted Agent Machine'))
        }
        { Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath (Join-Path $TestDrive 'outside.local.json') } | Should Throw 'outside the pool'
        @(Get-Writes).Count | Should Be 0
    }

    It 'stops before assigning when the created filter does not read back as expected' {
        Reset-FakeGraph
        $global:FakeGraph.TamperRule = $true
        $receiptPath = Join-Path $TestDrive 'drift.local.json'
        $threw = $false
        try { Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath } catch { $threw = $true }
        $threw | Should Be $true 'filter'
        @($global:FakeGraph.Calls | Where-Object { $_ -match '/assign$' }).Count | Should Be 0
        (Get-Content $receiptPath -Raw | ConvertFrom-Json).filterId | Should Not BeNullOrEmpty
    }

    It 'records a partial create so Remove deletes only what was created' {
        Reset-FakeGraph
        Add-FakeFilter 'unrelated' 'Someone else' '(device.model -contains "Cloud PC")'
        $global:FakeGraph.FailOn = 'POST deviceEnrollmentConfigurations'
        $receiptPath = Join-Path $TestDrive 'partial.local.json'
        $threw = $false
        try { Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath } catch { $threw = $true }
        $threw | Should Be $true 'synthetic Graph failure'
        $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
        $receipt.state | Should Be 'creating'
        $receipt.espId | Should BeNullOrEmpty

        $global:FakeGraph.FailOn = $null
        $global:FakeGraph.Calls.Clear()
        Invoke-AgentPoolEspRemove -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath | Out-Null
        (Get-Writes) -join ',' | Should Be "DELETE assignmentFilters/$($receipt.filterId)"
        $global:FakeGraph.Filters.Contains('unrelated') | Should Be $true
        Test-Path $receiptPath | Should Be $false
    }
}

Describe 'Remove' {
    Mock Invoke-AgentPoolGraph { Invoke-FakeGraph -Method $Method -Uri $Uri -Body $Body -AllowNotFound:$AllowNotFound }

    It 'deletes exactly the recorded ESP, then the recorded filter, then the receipt' {
        Reset-FakeGraph
        $receiptPath = Join-Path $TestDrive 'remove.local.json'
        Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath | Out-Null
        $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
        $global:FakeGraph.Calls.Clear()
        Invoke-AgentPoolEspRemove -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath | Out-Null
        (Get-Writes) -join ',' | Should Be "DELETE deviceEnrollmentConfigurations/$($receipt.espId),DELETE assignmentFilters/$($receipt.filterId)"
        Test-Path $receiptPath | Should Be $false
    }

    It 'refuses to delete by name when there is no receipt' {
        Reset-FakeGraph
        Add-FakeFilter 'other-filter' $global:FakeGraph.Names.Filter '(device.enrollmentProfileName -eq "Example-Agents-Pool")'
        Add-FakeEsp 'other-esp' $global:FakeGraph.Names.Esp
        { Invoke-AgentPoolEspRemove -PoolName $Pool -TenantId $Tenant -ReceiptPath (Join-Path $TestDrive 'none.local.json') } | Should Throw 'No receipt'
        @(Get-Writes).Count | Should Be 0
    }

    It 'refuses a receipt recorded for another tenant or pool' {
        Reset-FakeGraph
        $receiptPath = Join-Path $TestDrive 'other.local.json'
        Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath | Out-Null
        $global:FakeGraph.Calls.Clear()
        { Invoke-AgentPoolEspRemove -PoolName $Pool -TenantId '00000000-0000-0000-0000-000000000002' -ReceiptPath $receiptPath } | Should Throw 'another tenant or pool'
        { Invoke-AgentPoolEspRemove -PoolName 'Other-Pool' -TenantId $Tenant -ReceiptPath $receiptPath } | Should Throw 'another tenant or pool'
        @(Get-Writes).Count | Should Be 0
    }

    It 'refuses when the recorded ESP was reassigned after Apply' {
        Reset-FakeGraph
        $receiptPath = Join-Path $TestDrive 'reassigned.local.json'
        Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath | Out-Null
        $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
        $global:FakeGraph.Assignments[$receipt.espId] += New-FakeObject @{ target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = 'group-x' } }
        $global:FakeGraph.Calls.Clear()
        { Invoke-AgentPoolEspRemove -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath } | Should Throw 'changed since Apply'
        @(Get-Writes).Count | Should Be 0
        Test-Path $receiptPath | Should Be $true
    }
}

Describe 'Plan' {
    Mock Invoke-AgentPoolGraph { Invoke-FakeGraph -Method $Method -Uri $Uri -Body $Body -AllowNotFound:$AllowNotFound }

    It 'only reads, and reports a same-named object it did not create' {
        Reset-FakeGraph
        Add-FakeFilter 'other-filter' $global:FakeGraph.Names.Filter '(device.model -contains "Cloud PC")'
        $receiptPath = Join-Path $TestDrive 'plan.local.json'
        $plan = Invoke-AgentPoolEspPlan -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath
        $plan.ReadyToApply | Should Be $false
        ($plan.Conflicts -join ' ') | Should Match 'other-filter'
        @(Get-Writes).Count | Should Be 0
        Test-Path $receiptPath | Should Be $false
    }

    It 'is ready on a clean tenant whose preview reaches only the pool' {
        Reset-FakeGraph
        $plan = Invoke-AgentPoolEspPlan -PoolName $Pool -TenantId $Tenant -ReceiptPath (Join-Path $TestDrive 'clean.local.json')
        $plan.ReadyToApply | Should Be $true
        $plan.Devices | Should Be 'CPCA-0001'
        @(Get-Writes).Count | Should Be 0
    }
}

# Real Graph seam: Microsoft.Graph.Authentication 2.37 refuses evaluateAssignmentFilter's
# JSON body because the service labels it application/octet-stream, unless the caller
# asks for a file (-OutputFilePath). Only Invoke-MgGraphRequest is faked here.
Describe 'Filter preview through Invoke-MgGraphRequest' {
    It 'reads the octet-stream labelled JSON preview and finds the pool device' {
        function global:Invoke-MgGraphRequest {
            param($Method, $Uri, $Body, $ContentType, $OutputType, $OutputFilePath)
            if (-not $OutputFilePath) {
                throw "Request returned Non-Json response of OctetStream with Content-Disposition , Please specify '-OutputFilePath' or '-InferOutputFileName'"
            }
            $json = @{
                TotalRowCount = 1
                Columns       = @(@{ Name = 'deviceName' }, @{ Name = 'model' }, @{ Name = 'enrollmentProfileName' })
                Values        = @(, @('CPCA-0001', 'Cloud PC for Agents', 'Example-Agents-Pool'))
            } | ConvertTo-Json -Depth 5
            [IO.File]::WriteAllText($OutputFilePath, $json)
        }
        try {
            $result = Get-AgentPoolFilterPreview -PoolName $Pool
            $result.Ok | Should Be $true
            $result.Devices | Should Be 'CPCA-0001'
        }
        finally { Remove-Item function:\global:Invoke-MgGraphRequest -ErrorAction SilentlyContinue }
    }
}

Describe 'Apply ESP priority' {
    Mock Invoke-AgentPoolGraph { Invoke-FakeGraph -Method $Method -Uri $Uri -Body $Body -AllowNotFound:$AllowNotFound }

    It 'uses 1 when only the default ESP (priority 0) exists' {
        Reset-FakeGraph
        $global:FakeGraph.Esps['default'] = New-FakeObject @{ '@odata.type' = '#microsoft.graph.windows10EnrollmentCompletionPageConfiguration'; id = 'default'; displayName = 'All users and all devices'; priority = 0 }
        $receiptPath = Join-Path $TestDrive 'prio1.local.json'
        Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath | Out-Null
        $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
        $global:FakeGraph.Esps[$receipt.espId].priority | Should Be 1
    }

    It 'goes one above the highest existing ESP and ignores other enrollment configuration types' {
        Reset-FakeGraph
        $global:FakeGraph.Esps['u'] = New-FakeObject @{ '@odata.type' = '#microsoft.graph.windows10EnrollmentCompletionPageConfiguration'; id = 'u'; displayName = 'User ESP'; priority = 1 }
        $global:FakeGraph.Esps['s'] = New-FakeObject @{ '@odata.type' = '#microsoft.graph.windows10EnrollmentCompletionPageConfiguration'; id = 's'; displayName = 'Self ESP'; priority = 2 }
        $global:FakeGraph.Esps['lim'] = New-FakeObject @{ '@odata.type' = '#microsoft.graph.deviceEnrollmentLimitConfiguration'; id = 'lim'; displayName = 'Limit'; priority = 9 }
        $receiptPath = Join-Path $TestDrive 'prio3.local.json'
        Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath | Out-Null
        $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
        $global:FakeGraph.Esps[$receipt.espId].priority | Should Be 3
    }
}

Describe 'Apply interrupted between create and hide' {
    Mock Invoke-AgentPoolGraph { Invoke-FakeGraph -Method $Method -Uri $Uri -Body $Body -AllowNotFound:$AllowNotFound }

    It 'never assigns a shown ESP, and Remove deletes the unassigned shown ESP and the filter' {
        Reset-FakeGraph
        $global:FakeGraph.FailOn = 'PATCH deviceEnrollmentConfigurations/esp-2'
        $receiptPath = Join-Path $TestDrive 'hide-fail.local.json'
        $threw = $false
        try { Invoke-AgentPoolEspApply -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath } catch { $threw = $true }
        $threw | Should Be $true
        $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
        $receipt.espId | Should Be 'esp-2'
        $global:FakeGraph.Assignments['esp-2'].Count | Should Be 0
        $global:FakeGraph.FailOn = $null
        Invoke-AgentPoolEspRemove -PoolName $Pool -TenantId $Tenant -ReceiptPath $receiptPath | Out-Null
        $global:FakeGraph.Esps.Contains('esp-2') | Should Be $false
        $global:FakeGraph.Filters.Count | Should Be 0
        Test-Path $receiptPath | Should Be $false
    }
}
