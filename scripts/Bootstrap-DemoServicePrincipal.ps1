# Creates (idempotently) the Microsoft Entra app registration / service principal
# that the demo's unattended automation principal uses to configure the Windows 365
# demo tenant: Entra groups, Intune Win32 app assignment, and the Cloud PC
# provisioning policy.
#
# RUN THIS ONCE, INTERACTIVELY, AS A GLOBAL ADMINISTRATOR of the test tenant.
# This is the one-time admin-consent step; it cannot be done app-only. If the
# tenant's Conditional Access requires a compliant device, run it from the
# Admin Cloud PC.
#
#   .\scripts\Bootstrap-DemoServicePrincipal.ps1 -TenantId <your-tenant-id>
#
# Output: TenantId / ClientId / Secret. The secret is shown ONCE - store it in a
# password manager or Key Vault. Do NOT commit it and do NOT share it. This script
# contains no secret; the secret is generated at run time.
#
# Prefer a certificate over a client secret for anything longer-lived than a
# throwaway demo (-UseCertificate is left as a future enhancement).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TenantId,

    [string]$DisplayName = "W365-Demo-Automation",

    [int]$SecretMonths = 6
)

$ErrorActionPreference = "Stop"

# App-only Microsoft Graph permissions, least-privilege for the demo tasks.
$RequiredPermissions = @(
    "Group.ReadWrite.All",                          # create groups + manage membership
    "DeviceManagementApps.ReadWrite.All",           # create / assign Intune Win32 apps
    "DeviceManagementConfiguration.ReadWrite.All",  # config profiles
    "DeviceManagementServiceConfig.ReadWrite.All",  # enrollment / service config
    "CloudPC.ReadWrite.All",                         # Windows 365 provisioning policy
    "Device.Read.All"                               # resolve Cloud PC device objects
)

$GraphAppId = "00000003-0000-0000-c000-000000000000"

foreach ($module in @("Microsoft.Graph.Applications", "Microsoft.Graph.Authentication")) {
    if (-not (Get-Module -ListAvailable -Name $module)) {
        Write-Host "Installing $module ..."
        Install-Module $module -Scope CurrentUser -Force -AllowClobber
    }
}

Write-Host "Connecting to tenant $TenantId as Global Administrator (interactive) ..."
Connect-MgGraph -TenantId $TenantId `
    -Scopes "Application.ReadWrite.All", "AppRoleAssignment.ReadWrite.All" | Out-Null

# 1) App registration (idempotent on DisplayName)
$app = Get-MgApplication -Filter "displayName eq '$DisplayName'" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $app) {
    Write-Host "Creating app registration '$DisplayName' ..."
    $app = New-MgApplication -DisplayName $DisplayName -SignInAudience "AzureADMyOrg"
} else {
    Write-Host "Reusing existing app registration '$DisplayName' (AppId $($app.AppId))."
}

# 2) Service principal (idempotent on AppId)
$sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $sp) {
    $sp = New-MgServicePrincipal -AppId $app.AppId
}

# 3) Grant app-only Graph permissions (recording admin consent), skipping any
#    that are already assigned so re-runs are safe.
$graph = Get-MgServicePrincipal -Filter "appId eq '$GraphAppId'"
$existing = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -ErrorAction SilentlyContinue

foreach ($perm in $RequiredPermissions) {
    $role = $graph.AppRoles | Where-Object { $_.Value -eq $perm -and $_.AllowedMemberTypes -contains "Application" }
    if (-not $role) { Write-Warning "Permission not found on Microsoft Graph: $perm"; continue }

    if ($existing | Where-Object { $_.AppRoleId -eq $role.Id -and $_.ResourceId -eq $graph.Id }) {
        Write-Host "Already granted: $perm"
        continue
    }
    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id `
        -PrincipalId $sp.Id -ResourceId $graph.Id -AppRoleId $role.Id | Out-Null
    Write-Host "Granted: $perm"
}

# 4) Client secret (generated at run time; never stored in this file)
Write-Host "Creating a client secret valid for $SecretMonths month(s) ..."
$cred = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
    displayName = "w365-demo-automation-secret"
    endDateTime = (Get-Date).AddMonths($SecretMonths)
}

# 5) Emit the three values the automation principal needs.
Write-Host ""
Write-Host "==================== COPY THESE NOW (secret shown once) ====================" -ForegroundColor Yellow
[pscustomobject]@{
    TenantId = $TenantId
    ClientId = $app.AppId
    Secret   = $cred.SecretText
} | Format-List
Write-Host "============================================================================" -ForegroundColor Yellow
Write-Host "Store the secret in a password manager / Key Vault. Do NOT commit it." -ForegroundColor Yellow

Disconnect-MgGraph | Out-Null
