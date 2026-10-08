<#
.SYNOPSIS
    Hide Windows account setup ("Setting up for work or school") on ONE
    Windows 365 for Agents pool with a scoped custom Enrollment Status Page.

.DESCRIPTION
    Written for a pool where each agent session was observed to get a newly
    provisioned Cloud PC, so the agent user's sign-in was always a first sign-in
    and the tenant's default ESP showed the Account setup phase in front of the
    desktop. This script plans, creates or removes:

      1. An Intune assignment filter: device.enrollmentProfileName -eq "<pool name>".
      2. A custom ESP with "Show app and profile configuration progress" = No.
      3. One assignment of that ESP: All devices + the include filter.

    That is the targeting Windows 365 documents for custom ESP profiles
    (https://learn.microsoft.com/windows-365/enterprise/enrollment-status-page).
    The default ESP, other profiles, compliance, Defender, watermark and
    Conditional Access policies are not changed.

    CAVEAT: this changes ESP gating for that pool, not only what is shown.
    Without the setup screen, the desktop is handed over while user policies and
    apps may still be applying in the background; they are not proven ready.
    A Cloud PC enrolled before -Apply can keep its earlier ESP; only one enrolled
    afterwards shows the effect.

    Plan (default) only reads, and reports whether Apply would be allowed: Intune's
    filter preview must reach at least one Cloud PC of this pool and nothing else,
    and no filter or ESP may already carry this script's names. The preview checks
    the pool name at that moment; it does not stop a later device reusing the name.

    -Apply only creates new objects, never adopts existing ones by name. It records
    the created IDs, bound to tenant and pool, in a git-ignored local receipt
    (written before and after each create, so a partial run is recorded), reads
    both objects back before assigning, and reads the assignment back.

    -Remove deletes only the IDs in that receipt, after reading them back and
    refusing if their settings, rule or assignments changed since Apply.

.PARAMETER PoolName
    Exact display name of the Windows 365 for Agents pool.

.PARAMETER ReceiptPath
    Local receipt of created IDs. Default: scripts\agent-pool-esp.local.json
    (ignored by git through **/*.local.json). Keep it until -Remove.

.EXAMPLE
    .\scripts\Set-AgentPoolEspSkip.ps1 -TenantId <tenant-id> -PoolName "<pool display name>"
    # Plan only. Scopes: CloudPC.Read.All, DeviceManagementConfiguration.Read.All,
    # DeviceManagementServiceConfig.Read.All

.EXAMPLE
    .\scripts\Set-AgentPoolEspSkip.ps1 -TenantId <tenant-id> -PoolName "<pool display name>" -Apply
    .\scripts\Set-AgentPoolEspSkip.ps1 -TenantId <tenant-id> -PoolName "<pool display name>" -Remove
    # Apply adds DeviceManagementConfiguration.ReadWrite.All (filter) and
    # DeviceManagementServiceConfig.ReadWrite.All (ESP); Remove needs only those two.

.NOTES
    Requires Microsoft.Graph.Authentication. Run as an Intune administrator.
    Keep this file ASCII-only.
#>
[CmdletBinding(DefaultParameterSetName = 'Plan')]
param(
    [Parameter(Mandatory = $true)]
    [string]$PoolName,

    [string]$TenantId,

    [Parameter(ParameterSetName = 'Apply')]
    [switch]$Apply,

    [Parameter(ParameterSetName = 'Remove')]
    [switch]$Remove,

    [string]$ReceiptPath = (Join-Path $PSScriptRoot 'agent-pool-esp.local.json'),

    [switch]$UseDeviceCode
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'AgentPoolEsp.ps1')
Assert-AgentPoolName -PoolName $PoolName

if (-not $TenantId) {
    $configPath = Join-Path $PSScriptRoot 'demo-config.local.json'
    if (Test-Path $configPath) {
        $TenantId = (Get-Content $configPath -Raw | ConvertFrom-Json).azure.tenantId
    }
    if (-not $TenantId) {
        throw "TenantId required. Pass -TenantId or create scripts/demo-config.local.json with azure.tenantId."
    }
}

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
    throw "Microsoft.Graph.Authentication module not found. Run: Install-Module Microsoft.Graph.Authentication -Scope CurrentUser"
}
Import-Module Microsoft.Graph.Authentication

if ($Remove) {
    $scopes = @('DeviceManagementConfiguration.ReadWrite.All', 'DeviceManagementServiceConfig.ReadWrite.All')
}
elseif ($Apply) {
    $scopes = @('CloudPC.Read.All', 'DeviceManagementConfiguration.ReadWrite.All', 'DeviceManagementServiceConfig.ReadWrite.All')
}
else {
    $scopes = @('CloudPC.Read.All', 'DeviceManagementConfiguration.Read.All', 'DeviceManagementServiceConfig.Read.All')
}
$connect = @{ TenantId = $TenantId; Scopes = $scopes; NoWelcome = $true }
if ($UseDeviceCode) { $connect['UseDeviceAuthentication'] = $true }
Connect-MgGraph @connect | Out-Null

$caveat = 'Caveat: this changes ESP gating for the pool. The desktop is handed over while user policies and apps may still apply in the background. A Cloud PC enrolled before Apply may keep its earlier ESP.'
try {
    if ($Remove) {
        Invoke-AgentPoolEspRemove -PoolName $PoolName -TenantId $TenantId -ReceiptPath $ReceiptPath
    }
    elseif ($Apply) {
        Write-Host $caveat
        $result = Invoke-AgentPoolEspApply -PoolName $PoolName -TenantId $TenantId -ReceiptPath $ReceiptPath
        Write-Host "Applied. Filter $($result.filterId), ESP $($result.espId). Receipt: $ReceiptPath (keep it for -Remove)."
    }
    else {
        $plan = Invoke-AgentPoolEspPlan -PoolName $PoolName -TenantId $TenantId -ReceiptPath $ReceiptPath
        $plan | Format-List
        Write-Host $caveat
        if ($plan.ReadyToApply) { Write-Host 'Plan only. -Apply would create the filter, the ESP and its All devices + filter assignment.' }
        else { Write-Host 'Apply would refuse; see PreviewNote, Conflicts and Receipt above.' }
    }
}
finally {
    Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null
}
