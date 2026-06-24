<#
.SYNOPSIS
    Verify that the Zava Claims Workstation Win32 app is assigned as Required
    to the agent-pool Cloud PC device group in Intune.

.DESCRIPTION
    Uses Microsoft Graph PowerShell SDK (not Azure CLI - Azure CLI's first-party
    app cannot access Intune deviceAppManagement scopes). Run interactively as
    an Intune admin, or with the repo service principal
    (see Bootstrap-DemoServicePrincipal.ps1).

.PARAMETER TenantId
    The demo tenant ID. Defaults to the value in demo-config.local.json.

.EXAMPLE
    .\Verify-IntuneClaimsAssignment.ps1
    # Interactive browser sign-in with DeviceManagementApps.Read.All

.EXAMPLE
    .\Verify-IntuneClaimsAssignment.ps1 -UseDeviceCode
    # Device-code auth (for headless/SSH sessions)

.NOTES
    Requires: Microsoft.Graph.Authentication module (Install-Module Microsoft.Graph.Authentication)
    Azure CLI CANNOT be used for this - see issue #128.
#>
[CmdletBinding()]
param(
    [string]$TenantId,
    [switch]$UseDeviceCode
)

$ErrorActionPreference = 'Stop'

# Resolve tenant from config if not provided
if (-not $TenantId) {
    $configPath = Join-Path $PSScriptRoot 'demo-config.local.json'
    if (Test-Path $configPath) {
        $TenantId = (Get-Content $configPath -Raw | ConvertFrom-Json).azure.tenantId
    }
    if (-not $TenantId) {
        Write-Error "TenantId required. Pass -TenantId or create scripts/demo-config.local.json with azure.tenantId."
        return
    }
}

# Ensure Graph module
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
    Write-Error "Microsoft.Graph.Authentication module not found. Run: Install-Module Microsoft.Graph.Authentication -Scope CurrentUser"
    return
}
Import-Module Microsoft.Graph.Authentication

# Connect with Intune read scope
$scopes = @("DeviceManagementApps.Read.All", "Group.Read.All")
$connectParams = @{ TenantId = $TenantId; Scopes = $scopes; NoWelcome = $true }
if ($UseDeviceCode) { $connectParams['UseDeviceAuthentication'] = $true }

Write-Host "Connecting to Microsoft Graph (tenant: $TenantId)..."
Connect-MgGraph @connectParams | Out-Null
Write-Host "  Connected as: $((Get-MgContext).Account)" -ForegroundColor Green

# Find the Claims app
$graphBeta = "https://graph.microsoft.com/beta"
$appName = "Zava Claims Workstation"
$filter = [Uri]::EscapeDataString("displayName eq '$appName'")
$apps = (Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/deviceAppManagement/mobileApps?`$filter=$filter").value

if (-not $apps -or $apps.Count -eq 0) {
    Write-Warning "? No Intune app named '$appName' found. Create it first via Deploy-DemoEnvironment.ps1."
    Disconnect-MgGraph | Out-Null
    return
}

$app = $apps[0]
Write-Host "`n?? App: $($app.displayName) (id: $($app.id))" -ForegroundColor Cyan

# Get assignments
$assignments = (Invoke-MgGraphRequest -Method GET -Uri "$graphBeta/deviceAppManagement/mobileApps/$($app.id)/assignments").value

if (-not $assignments -or $assignments.Count -eq 0) {
    Write-Warning "? No assignments found for '$appName'. Assign it as Required to the pool device group."
    Disconnect-MgGraph | Out-Null
    return
}

Write-Host "`n?? Assignments:" -ForegroundColor Cyan
$hasRequired = $false
foreach ($a in $assignments) {
    $intent = $a.intent
    $targetType = $a.target.'@odata.type'
    $groupId = $a.target.groupId

    $groupName = "unknown"
    if ($groupId) {
        try {
            $groupName = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/groups/$groupId?`$select=displayName").displayName
        } catch { $groupName = $groupId }
    }

    $status = if ($intent -eq 'required') { "?" } else { "??" }
    Write-Host "  $status Intent=$intent | Target=$groupName ($targetType)"

    if ($intent -eq 'required') { $hasRequired = $true }
}

if ($hasRequired) {
    Write-Host "`n? PASS: '$appName' has a Required assignment." -ForegroundColor Green
} else {
    Write-Warning "`n? FAIL: '$appName' exists but has no Required assignment. Fix in Intune or via Deploy-DemoEnvironment.ps1."
}

# Check dynamic group exists
Write-Host "`n?? Checking CPCPool_ dynamic group..." -ForegroundColor Cyan
$groups = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/groups?`$filter=startswith(displayName,'Zava')&`$select=id,displayName,membershipRule").value
$poolGroup = $groups | Where-Object { $_.membershipRule -and $_.membershipRule -match 'CPCPool_' }
if ($poolGroup) {
    Write-Host "  ? Dynamic group: $($poolGroup.displayName) (rule: $($poolGroup.membershipRule))" -ForegroundColor Green
} else {
    Write-Warning "  ? No dynamic group with CPCPool_ membership rule found."
}

Disconnect-MgGraph | Out-Null
Write-Host "`nDone." -ForegroundColor Gray
