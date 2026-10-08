# Installer preview and tenant safety (release QA R2, R3).
#
# The scripts run with stub commands defined here, so nothing is installed, no one signs in and
# no request reaches Microsoft. PSModulePath points at an empty folder, as on a clean machine.
#
# Run with: Invoke-Pester -Path .\scripts\tests\InstallerPreview.Tests.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..')
$intended = '11111111-1111-1111-1111-111111111111'
$other = '22222222-2222-2222-2222-222222222222'

function Use-CleanModulePath {
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('nomodules-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $script:savedModulePath = $env:PSModulePath
    $env:PSModulePath = $dir
}
function Restore-ModulePath { $env:PSModulePath = $script:savedModulePath }

Describe 'Enable-W365aPrereqs.ps1 -WhatIf on a machine without the Graph modules (R2)' {
    It 'installs the local modules, then previews without changing the tenant' {
        $global:zCalls = New-Object System.Collections.Generic.List[string]
        function Install-Module { [CmdletBinding(SupportsShouldProcess = $true)] param($Name, $Scope, [switch]$Force, [switch]$AllowClobber)
            $global:zCalls.Add("install $Name pref=$WhatIfPreference") }
        function Connect-MgGraph { $global:zCalls.Add('connect') }
        function Disconnect-MgGraph { }
        function Get-MgServicePrincipal { [pscustomobject]@{ Id = 'sp-1' } }
        function Get-MgServicePrincipalRemoteDesktopSecurityConfiguration { [pscustomobject]@{ IsRemoteDesktopProtocolEnabled = $false } }
        function Update-MgServicePrincipalRemoteDesktopSecurityConfiguration { $global:zCalls.Add('TENANT CHANGE rdp') }
        function Get-MgGroup { }
        function New-MgGroup { $global:zCalls.Add('TENANT CHANGE group') }
        function Get-MgServicePrincipalRemoteDesktopSecurityConfigurationTargetDeviceGroup { }
        function New-MgServicePrincipalRemoteDesktopSecurityConfigurationTargetDeviceGroup { $global:zCalls.Add('TENANT CHANGE target') }
        Use-CleanModulePath
        try { & (Join-Path $repo 'scripts\Enable-W365aPrereqs.ps1') -TenantId $intended -CreateDynamicGroup -WhatIf 6>$null | Out-Null }
        finally { Restore-ModulePath }

        $installs = @($global:zCalls | Where-Object { $_ -like 'install *' })
        $installs.Count | Should Be 3
        @($installs | Where-Object { $_ -notlike '*pref=False' }).Count | Should Be 0
        $global:zCalls -contains 'connect' | Should Be $true
        @($global:zCalls | Where-Object { $_ -like 'TENANT CHANGE*' }).Count | Should Be 0
    }
}

Describe 'Deploy-McsAgentShortcut.ps1 tenant check (R3)' {
    function Invoke-Shortcut([string]$TokenTenant, [hashtable]$Arguments) {
        $global:zGraphCalls = 0
        function Import-Module { }
        function Invoke-RestMethod { $global:zGraphCalls++; [pscustomobject]@{ value = @() } }
        $global:zTokenTenant = $TokenTenant
        function az { '{"accessToken":"t","expires_on":"' + ([DateTimeOffset]::UtcNow.AddHours(1).ToUnixTimeSeconds()) + '","tenant":"' + $global:zTokenTenant + '"}' }
        $global:AuthenticationHeader = $null
        $err = $null
        try { & (Join-Path $repo 'scripts\Deploy-McsAgentShortcut.ps1') @Arguments 6>$null | Out-Null }
        catch { $err = $_.Exception.Message }
        $global:AuthenticationHeader = $null
        return $err
    }

    It 'stops before any Graph call when the Azure CLI is signed in to another tenant' {
        $err = Invoke-Shortcut $other @{ TenantId = $intended; UseAzureCliToken = $true; WhatIf = $true }
        $err | Should Match 'tenant'
        $global:zGraphCalls | Should Be 0
    }

    It 'requires the intended tenant to be named' {
        $err = Invoke-Shortcut $intended @{ UseAzureCliToken = $true; WhatIf = $true }
        $err | Should Match 'TenantId'
        $global:zGraphCalls | Should Be 0
    }

    It 'continues to the Intune reads when the tenant matches' {
        $err = Invoke-Shortcut $intended @{ TenantId = $intended; UseAzureCliToken = $true; WhatIf = $true }
        $global:zGraphCalls | Should BeGreaterThan 0
        $err | Should Match 'Expected exactly one group'
    }
}
