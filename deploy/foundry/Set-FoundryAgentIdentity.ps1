<#
.SYNOPSIS
    Create the Foundry Claims agent's agent user and consent the Windows 365 Computer Use
    scopes on its agent identity blueprint. Plan (default) only reads; -Apply writes.

.DESCRIPTION
    Run after the first hosted agent version exists (deploy\foundry\Deploy-FoundryAgent.ps1
    -DeployVersion with both execution gates "no"). That deployment creates the hosted agent's
    native agent identity and its blueprint; its receipt records the agent identity ID.

    This script then:
      1. Reads the agent identity and its blueprint.
      2. Finds or creates one agent user linked to that agent identity (identityParentId).
         Graph: POST /users/microsoft.graph.agentUser
         https://learn.microsoft.com/graph/api/agentuser-post
      3. Makes sure the three resource service principals exist in the tenant (registers
         W365Agents-Production if missing).
      4. Declares exactly these delegated scopes on the blueprint (requiredResourceAccess),
         marks them inheritable by its agent identities, and grants tenant-wide consent:
           Agent 365 Tools (ea9ffc3e-8a23-4a7d-836d-234d7c7565c1)   McpServersMetadata.Read.All
           Windows 365 Computer Use MCP (da81128c-e5b5-4f9e-8d89-50d906f107c5)  Tools.ListInvoke.All
           W365Agents-Production (90ecec28-f5a6-42b3-9bde-dae1ca98f8b5)  Computer.See
         Computer.Control is deliberately not granted (the viewer is view-only).
      5. Prints the four CLAIMS_*_ID values for deploy\foundry\foundry-agent.local.json.

    The reference environment was configured with these same Graph calls on 1 October 2026.
    This script itself has been run in plan mode against that environment only.

.PARAMETER AgentIdentityId
    Object ID of the hosted agent's agent identity (the instance identity client ID in the
    first deployment's receipt; for agent identities the object ID and app ID are the same).

.PARAMETER AgentUserPrincipalName
    UPN for the agent user, on a verified domain, e.g. claims-agent@contoso.com.

.NOTES
    Requires the Azure CLI signed in to the tenant (az login --tenant <id>) as an administrator
    who holds Agent ID Administrator (agent user) and Cloud Application Administrator or higher
    plus Privileged Role Administrator / Global Administrator (tenant-wide consent).
    Keep this file ASCII-only.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TenantId,
    [Parameter(Mandatory = $true)][string]$AgentIdentityId,
    [Parameter(Mandatory = $true)][string]$AgentUserPrincipalName,
    [string]$AgentUserDisplayName = 'Zava Claims Foundry agent',
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$Graph = 'https://graph.microsoft.com/v1.0'
$Resources = @(
    @{ AppId = 'ea9ffc3e-8a23-4a7d-836d-234d7c7565c1'; Name = 'Agent 365 Tools'; Scope = 'McpServersMetadata.Read.All' },
    @{ AppId = 'da81128c-e5b5-4f9e-8d89-50d906f107c5'; Name = 'Windows 365 Computer Use MCP'; Scope = 'Tools.ListInvoke.All' },
    @{ AppId = '90ecec28-f5a6-42b3-9bde-dae1ca98f8b5'; Name = 'W365Agents-Production'; Scope = 'Computer.See' }
)
foreach ($id in $TenantId, $AgentIdentityId) {
    if ($id -notmatch '^[0-9a-fA-F-]{36}$') { throw "Not a GUID: $id" }
}
if ($AgentUserPrincipalName -notmatch '^[A-Za-z0-9''.\-_!#^~]+@[A-Za-z0-9.\-]+$') { throw 'AgentUserPrincipalName is not a valid UPN.' }

function Invoke-Graph([string]$Method, [string]$Path, $Body) {
    $azArgs = @('rest', '--method', $Method, '--url', "$Graph$Path", '--headers', 'Content-Type=application/json', '-o', 'json')
    $file = $null
    if ($null -ne $Body) {
        $file = [IO.Path]::GetTempFileName()
        $Body | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $file -Encoding utf8
        $azArgs += @('--body', "@$file")
    }
    try {
        $out = & az @azArgs 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Graph $Method $Path failed: $out" }
        if ($out) { return ($out | Out-String | ConvertFrom-Json) }
    }
    finally { if ($file) { Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue } }
}

$account = az account show --query tenantId -o tsv 2>$null
if ($account -ne $TenantId) { throw "The Azure CLI is not signed in to tenant $TenantId. Run: az login --tenant $TenantId" }

$plan = [System.Collections.Generic.List[string]]::new()
Write-Host ("Mode: " + $(if ($Apply) { 'APPLY (writes)' } else { 'PLAN (read-only)' }))

# 1. Agent identity and blueprint.
$agent = Invoke-Graph GET "/servicePrincipals/$AgentIdentityId/microsoft.graph.agentIdentity?`$select=id,appId,displayName,agentIdentityBlueprintId"
$blueprintAppId = $agent.agentIdentityBlueprintId
if (-not $blueprintAppId) { throw 'The agent identity has no blueprint. Deploy the hosted agent first.' }
$blueprint = (Invoke-Graph GET "/applications/microsoft.graph.agentIdentityBlueprint?`$filter=appId eq '$blueprintAppId'&`$select=id,appId,displayName,requiredResourceAccess").value | Select-Object -First 1
if (-not $blueprint) { throw "Blueprint $blueprintAppId was not found." }
$blueprintSp = (Invoke-Graph GET "/servicePrincipals?`$filter=appId eq '$blueprintAppId'&`$select=id,appId").value | Select-Object -First 1
if (-not $blueprintSp) { throw "The blueprint $blueprintAppId has no service principal in this tenant." }
Write-Host "Agent identity : $($agent.displayName) ($($agent.appId))"
Write-Host "Blueprint      : $($blueprint.displayName) ($blueprintAppId)"

# 2. Agent user.
$user = (Invoke-Graph GET "/users?`$filter=userPrincipalName eq '$AgentUserPrincipalName'&`$select=id,userPrincipalName,accountEnabled,identityParentId").value | Select-Object -First 1
if ($user) {
    if ($user.identityParentId -ne $AgentIdentityId) { throw "$AgentUserPrincipalName exists but is not linked to agent identity $AgentIdentityId." }
    Write-Host "Agent user     : exists ($($user.id))"
}
else {
    $plan.Add("Create agent user $AgentUserPrincipalName linked to $AgentIdentityId")
    if ($Apply) {
        $alias = $AgentUserPrincipalName.Split('@')[0]
        $user = Invoke-Graph POST '/users/microsoft.graph.agentUser' @{
            accountEnabled = $true; displayName = $AgentUserDisplayName; mailNickname = $alias
            userPrincipalName = $AgentUserPrincipalName; identityParentId = $AgentIdentityId
        }
        Write-Host "Agent user     : created ($($user.id))"
    }
}

# 3-4. Resources, declaration, inheritance, consent.
$inherit = (Invoke-Graph GET "/applications/microsoft.graph.agentIdentityBlueprint/$($blueprint.id)/inheritablePermissions").value
$grants = (Invoke-Graph GET "/oauth2PermissionGrants?`$filter=clientId eq '$($blueprintSp.id)'").value
$required = @($blueprint.requiredResourceAccess)
$requiredChanged = $false
foreach ($r in $Resources) {
    $sp = (Invoke-Graph GET "/servicePrincipals?`$filter=appId eq '$($r.AppId)'&`$select=id,appId,oauth2PermissionScopes").value | Select-Object -First 1
    if (-not $sp) {
        $plan.Add("Register service principal for $($r.Name) ($($r.AppId))")
        if (-not $Apply) { continue }
        $sp = Invoke-Graph POST '/servicePrincipals' @{ appId = $r.AppId }
    }
    $scope = @($sp.oauth2PermissionScopes) | Where-Object { $_.value -eq $r.Scope } | Select-Object -First 1
    if (-not $scope) { throw "$($r.Name) does not publish the scope $($r.Scope)." }

    $entry = $required | Where-Object { $_.resourceAppId -eq $r.AppId } | Select-Object -First 1
    if (-not ($entry -and (@($entry.resourceAccess) | Where-Object { $_.id -eq $scope.id }))) {
        $plan.Add("Declare $($r.Scope) on the blueprint")
        $required = @($required | Where-Object { $_.resourceAppId -ne $r.AppId }) + @(@{ resourceAppId = $r.AppId; resourceAccess = @(@{ id = $scope.id; type = 'Scope' }) })
        $requiredChanged = $true
    }
    if (-not (@($inherit) | Where-Object { $_.resourceAppId -eq $r.AppId })) {
        $plan.Add("Make $($r.Name) scopes inheritable by the blueprint's agent identities")
        if ($Apply) {
            Invoke-Graph POST "/applications/microsoft.graph.agentIdentityBlueprint/$($blueprint.id)/inheritablePermissions" @{
                resourceAppId = $r.AppId; inheritableScopes = @{ '@odata.type' = '#microsoft.graph.allAllowedScopes'; kind = 'allAllowed' }
            } | Out-Null
        }
    }
    $grant = @($grants) | Where-Object { $_.resourceId -eq $sp.id -and $_.consentType -eq 'AllPrincipals' } | Select-Object -First 1
    if (-not ($grant -and (" $($grant.scope) " -like "* $($r.Scope) *"))) {
        $plan.Add("Grant tenant-wide consent for $($r.Scope)")
        if ($Apply) {
            Invoke-Graph POST '/oauth2PermissionGrants' @{ clientId = $blueprintSp.id; consentType = 'AllPrincipals'; resourceId = $sp.id; scope = $r.Scope } | Out-Null
        }
    }
}
if ($requiredChanged -and $Apply) {
    Invoke-Graph PATCH "/applications/$($blueprint.id)/microsoft.graph.agentIdentityBlueprint" @{ requiredResourceAccess = $required } | Out-Null
}

Write-Host ''
if ($plan.Count -eq 0) { Write-Host 'Nothing to change: agent user, scopes, inheritance and consent are already in place.' }
else {
    Write-Host ($(if ($Apply) { 'Applied:' } else { 'Apply would:' }))
    $plan | ForEach-Object { Write-Host "  - $_" }
}
Write-Host ''
Write-Host 'Put these in deploy\foundry\foundry-agent.local.json (hostedAgent.environmentVariables):'
Write-Host "  CLAIMS_TENANT_ID     = $TenantId"
Write-Host "  CLAIMS_BLUEPRINT_ID  = $blueprintAppId"
Write-Host "  CLAIMS_AGENT_ID      = $($agent.appId)"
Write-Host ("  CLAIMS_AGENT_USER_ID = " + $(if ($user) { $user.id } else { '(created by -Apply)' }))
