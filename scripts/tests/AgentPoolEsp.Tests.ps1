# Tests for the helpers behind Set-AgentPoolEspSkip.ps1: the custom Enrollment
# Status Page that hides Windows account setup on ONE Windows 365 for Agents pool.
# Synthetic values only; no Graph calls.
#
# Run with: Invoke-Pester -Path .\scripts\tests\AgentPoolEsp.Tests.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here '..\AgentPoolEsp.ps1')

function New-PreviewReply {
    param([object[]]$Rows)
    $columns = @('deviceName', 'enrollmentProfileName', 'model', 'osVersion') |
        ForEach-Object { [pscustomobject]@{ Name = $_; Type = 'String' } }
    [pscustomobject]@{
        TotalRowCount = @($Rows).Count
        Columns       = $columns
        Values        = @($Rows | ForEach-Object { , @($_) })
    }
}

Describe 'New-AgentPoolFilterRule' {
    It 'matches the exact pool enrollment profile name only' {
        New-AgentPoolFilterRule -PoolName 'Example-Agents-Pool' |
            Should Be '(device.enrollmentProfileName -eq "Example-Agents-Pool")'
    }

    It 'rejects names that could break or widen the rule' {
        foreach ($badName in @('', ' Pool', 'Pool") -or (device.model -ne "x', 'Pool\x')) {
            $threw = $false
            try { New-AgentPoolFilterRule -PoolName $badName | Out-Null }
            catch { $threw = $true }
            $threw | Should Be $true
        }
    }
}

Describe 'New-AgentPoolEspBody' {
    It 'hides the setup screen without blocking on apps' {
        $body = New-AgentPoolEspBody -PoolName 'Example-Agents-Pool'
        $body['@odata.type'] | Should Be '#microsoft.graph.windows10EnrollmentCompletionPageConfiguration'
        $body.showInstallationProgress | Should Be $false
        $body.displayName | Should Be (Get-AgentPoolEspNames -PoolName 'Example-Agents-Pool').Esp
    }

    # Graph returned a bare 400 for a custom ESP created without a priority (live, 3 Oct 2026).
    It 'carries the requested priority' {
        (New-AgentPoolEspBody -PoolName 'Example-Agents-Pool' -Priority 3).priority | Should Be 3
    }

    # Live 3 Oct 2026: a sparse body got a bare 400; a full clone of an existing tenant ESP
    # was accepted. Every setting is now explicit, matching the tenant default ESP except
    # showInstallationProgress.
    It 'states every ESP setting explicitly' {
        $body = New-AgentPoolEspBody -PoolName 'Example-Agents-Pool' -Priority 3
        foreach ($key in 'blockDeviceSetupRetryByUser', 'allowDeviceResetOnInstallFailure',
            'allowLogCollectionOnInstallFailure', 'customErrorMessage', 'installProgressTimeoutInMinutes',
            'allowDeviceUseOnInstallFailure', 'selectedMobileAppIds', 'allowNonBlockingAppInstallation',
            'installQualityUpdates', 'trackInstallProgressForAutopilotOnly',
            'disableUserStatusTrackingAfterFirstUser', 'roleScopeTagIds') {
            $body.Contains($key) | Should Be $true
        }
        $body.allowDeviceUseOnInstallFailure | Should Be $true
        $body.installProgressTimeoutInMinutes | Should Be 60
        @($body.selectedMobileAppIds).Count | Should Be 0
    }
}

Describe 'New-AgentPoolEspAssignBody' {
    It 'targets All devices through the include filter only' {
        $target = (New-AgentPoolEspAssignBody -FilterId 'filter-1').enrollmentConfigurationAssignments[0].target
        $target['@odata.type'] | Should Be '#microsoft.graph.allDevicesAssignmentTarget'
        $target.deviceAndAppManagementAssignmentFilterId | Should Be 'filter-1'
        $target.deviceAndAppManagementAssignmentFilterType | Should Be 'include'
    }
}

Describe 'Test-AgentPoolFilterMatch' {
    It 'accepts a preview that lists only agent Cloud PCs of the pool' {
        $reply = New-PreviewReply @(, @('CPCA-0001', 'Example-Agents-Pool', 'Cloud PC for Agents', '10.0'))
        $result = Test-AgentPoolFilterMatch -Preview $reply -PoolName 'Example-Agents-Pool'
        $result.Ok | Should Be $true
        $result.Devices | Should Be 'CPCA-0001'
    }

    It 'refuses when no pool device is enrolled yet, because the match is unproven' {
        $result = Test-AgentPoolFilterMatch -Preview (New-PreviewReply @()) -PoolName 'Example-Agents-Pool'
        $result.Ok | Should Be $false
        $result.Reason | Should Match 'no device'
    }

    It 'refuses when the rule would also reach a device outside the pool' {
        $reply = New-PreviewReply @(
            @('CPCA-0001', 'Example-Agents-Pool', 'Cloud PC for Agents', '10.0'),
            @('HOSTED-01', 'Example-Agents-Pool', 'Copilot Studio Hosted Agent Machine', '10.0')
        )
        $result = Test-AgentPoolFilterMatch -Preview $reply -PoolName 'Example-Agents-Pool'
        $result.Ok | Should Be $false
        $result.Reason | Should Match 'HOSTED-01'
    }

    It 'refuses a paged preview it cannot fully see' {
        $reply = New-PreviewReply @(, @('CPCA-0001', 'Example-Agents-Pool', 'Cloud PC for Agents', '10.0'))
        $reply.TotalRowCount = 60
        (Test-AgentPoolFilterMatch -Preview $reply -PoolName 'Example-Agents-Pool').Ok | Should Be $false
    }
}
