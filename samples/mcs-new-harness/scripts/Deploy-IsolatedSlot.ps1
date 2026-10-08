[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$ParentAppName,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$SlotName,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$')][string]$HostId,
    [Parameter(Mandatory)][uri]$PublicOrigin,
    [Parameter(Mandatory)][guid]$ApiAudience,
    [Parameter(Mandatory)][guid]$McpClientId,
    [Parameter(Mandatory)][string]$UseScope,
    [Parameter(Mandatory)][string]$ExpectedProductionRuntime,
    [string]$PackagePath = (Join-Path $PSScriptRoot '..\.build\auth-only.zip'),
    [string]$AzureCli = 'az',
    [switch]$ReuseParentStorage,
    [switch]$Deploy
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$template = Join-Path $root 'deploy\slot-auth.arm.json'
if ($PublicOrigin.Scheme -ne 'https' -or $PublicOrigin.AbsolutePath -ne '/' -or
    $PublicOrigin.Query -or $PublicOrigin.Fragment -or $PublicOrigin.UserInfo) {
    throw 'PublicOrigin must be the exact approved HTTPS origin, without a path or credentials.'
}
if ($SlotName -eq 'production') { throw 'An isolated non-production slot name is required.' }
$plan = [ordered]@{
    target = "$ResourceGroup/$ParentAppName/slots/$SlotName"
    template = $template
    package = $PackagePath
    gateway = $false
    registration = $false
    delay = $false
    storage = 'Only server-side AzureWebJobsStorage reference; explicit same-app trust required.'
}
if (-not $Deploy) {
    $plan | ConvertTo-Json
    Write-Output 'Plan only. No Azure requests. Use -Deploy only after resource/identity/storage review.'
    return
}
if (-not $ReuseParentStorage) { throw 'Explicit -ReuseParentStorage review is required.' }
if (-not (Test-Path -LiteralPath $PackagePath)) { throw 'Build the auth-only package first.' }
if (-not $PSCmdlet.ShouldProcess($plan.target, 'Create one isolated auth-only slot and deploy package')) { return }

function Invoke-AzJson {
    param([string[]]$Arguments)
    $text = & $AzureCli @Arguments --only-show-errors -o json
    if ($LASTEXITCODE -ne 0) { throw 'Azure command failed; inspect resource state before retry.' }
    return ($text | ConvertFrom-Json)
}

$common = @('--subscription', "$SubscriptionId", '-g', $ResourceGroup, '-n', $ParentAppName)
$account = Invoke-AzJson -Arguments @(
    'account', 'show', '--subscription', "$SubscriptionId", '--query', '{tenant:tenantId,subscription:id}'
)
if ($account.tenant -ne "$TenantId" -or $account.subscription -ne "$SubscriptionId") {
    throw 'Authenticated Azure tenant/subscription does not match the reviewed inputs.'
}
$projection = '{id:id,runtime:siteConfig.linuxFxVersion,scale:siteConfig.functionAppScaleLimit,plan:appServicePlanId || serverFarmId,location:location,kind:kind}'
$before = Invoke-AzJson -Arguments (@('functionapp', 'show') + $common + @('--query', $projection))
if ($before.runtime -ne $ExpectedProductionRuntime -or $before.kind -notlike '*linux*' -or -not $before.plan) {
    throw 'Expected existing Linux production app not confirmed.'
}
$slots = Invoke-AzJson -Arguments (@('functionapp', 'deployment', 'slot', 'list') + $common + @('--query', '[].name'))
if (@($slots | Where-Object { $_ }).Count -ne 0) {
    throw 'A slot already exists. Inspect ownership/capacity; this create-only script never overwrites a slot.'
}
$storageShape = Invoke-AzJson -Arguments @(
    'rest', '--method', 'post',
    '--url', "https://management.azure.com$($before.id)/config/appsettings/list?api-version=2024-04-01",
    '--query', '{storageType:type(properties.AzureWebJobsStorage),hostId:properties.AzureFunctionsWebHost__hostid}'
)
if ($storageShape.storageType -ne 'string') {
    throw 'Parent does not expose the reviewed connection-string setting. Identity-based storage needs a separate plan.'
}
if ($HostId -eq $storageShape.hostId -or $HostId -eq $ParentAppName.Substring(0, [Math]::Min(32, $ParentAppName.Length))) {
    throw 'Slot host ID must be distinct from the parent host ID.'
}
$values = @{
    parentAppName = $ParentAppName; slotName = $SlotName; location = $before.location
    serverFarmId = $before.plan; hostId = $HostId; publicOrigin = $PublicOrigin.GetLeftPart('Authority')
    tenantId = "$TenantId"; apiAudience = "$ApiAudience"; mcpClientId = "$McpClientId"; useScope = $UseScope
}
$parameters = @{}
foreach ($name in $values.Keys) { $parameters[$name] = @{value = $values[$name]} }
$work = Join-Path $root ('.build\deploy-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$parameterFile = Join-Path $work 'parameters.local.json'
@{parameters = $parameters} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $parameterFile
$receipt = @{startedUtc = [DateTime]::UtcNow.ToString('o'); productionBefore = $before; target = $plan.target}
$receiptPath = Join-Path $work 'receipt.local.json'
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath
$deploymentName = 'nh-auth-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$arm = @('--subscription', "$SubscriptionId", '-g', $ResourceGroup, '--name', $deploymentName,
    '--template-file', $template, '--parameters', "@$parameterFile", '--query', '{state:properties.provisioningState}')
Invoke-AzJson -Arguments (@('deployment', 'group', 'validate') + $arm) | Out-Null
Invoke-AzJson -Arguments (@('deployment', 'group', 'create') + $arm) | Out-Null
$receipt.deployment = Invoke-AzJson -Arguments (
    @('functionapp', 'deployment', 'source', 'config-zip') + $common +
    @('--slot', $SlotName, '--src', (Resolve-Path $PackagePath).Path, '--build-remote', 'true',
      '--timeout', '600', '--query', '{id:id,status:status,complete:complete}')
)
$after = Invoke-AzJson -Arguments (@('functionapp', 'show') + $common + @('--query', $projection))
$receipt.productionAfter = $after
$receipt.productionRuntimeAndScaleUnchanged = $before.runtime -eq $after.runtime -and $before.scale -eq $after.scale
$receipt.finishedUtc = [DateTime]::UtcNow.ToString('o')
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath
if (-not $receipt.productionRuntimeAndScaleUnchanged) { throw 'Production changed; coordinate immediately.' }
Write-Output "Deployment receipt: $receiptPath"
Write-Output 'Deployment is not runtime proof. Verify HTTPS metadata/401 and all disabled gates before native configuration.'
