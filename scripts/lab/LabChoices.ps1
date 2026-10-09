<#
.SYNOPSIS
    Sign-in, the one-time choices, and the generators that turn saved choices into the
    repository's existing config formats. Dot-sourced by scripts\Install-Lab.ps1.
    Keep this file ASCII-only.
#>

$script:LabDefaults = @{
    resourceGroup      = 'zava-lab-rg'
    signInAppName      = 'Zava Contact Center'
    foundryProject     = 'zava-claims'
    agentName          = 'claims-w365'
    modelDeployment    = 'gpt-4.1-mini'
    modelCapacity      = '250'
    mcsAgentName       = 'Zava Claims Intake (CUA)'
    mcsDeviceGroup     = 'Zava W365A Cloud PC Pools'
    foundryDeviceGroup = 'Zava W365A Foundry Claims Devices'
    presenterGroup     = 'Zava-Demo-Agent-Users'
    publisherPrefix    = 'crcce'
}

function Test-LabUseMcs([hashtable]$State) { $State.choices.backends -in @('both', 'mcs') }
function Test-LabUseFoundry([hashtable]$State) { $State.choices.backends -in @('both', 'foundry') }

function Get-LabSignedInAccount {
    $acct = Get-LabAzJson @('account', 'show') -Lenient
    if ($acct -and $acct.tenantId) { return $acct }
    return $null
}

function Connect-LabAzure {
    # Reuses an existing Azure CLI sign-in for the tenant; otherwise starts the normal Microsoft
    # sign-in (browser, or a device code with -DeviceCode). Conditional Access still applies.
    param([Parameter(Mandatory)][string]$Tenant, [string]$SubscriptionId, [switch]$DeviceCode)
    $acct = Get-LabSignedInAccount
    if (-not $acct -or ($acct.tenantId -ne $Tenant -and $acct.tenantDefaultDomain -ne $Tenant)) {
        Write-LabInfo "Signing in to Microsoft Entra tenant $Tenant with your own administrator account..."
        $a = @('login', '--tenant', $Tenant, '--only-show-errors', '-o', 'none')
        if ($DeviceCode) { $a += '--use-device-code' }
        Invoke-LabAz -Arguments $a | Out-Null
        $acct = Get-LabSignedInAccount
        if (-not $acct) { throw 'The Azure CLI sign-in did not complete.' }
    }
    if ($SubscriptionId -and $acct.id -ne $SubscriptionId) {
        Invoke-LabAz -Arguments @('account', 'set', '--subscription', $SubscriptionId, '--only-show-errors') | Out-Null
        $acct = Get-LabSignedInAccount
    }
    return $acct
}

function Get-LabPowerPlatformEnvironments {
    # Dataverse-backed environments the signed-in account can see (read-only).
    $r = Invoke-LabRest -Url 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments?api-version=2020-10-01&$expand=properties' -Resource 'https://service.powerapps.com/'
    if (-not $r.Ok) { throw "Could not list Power Platform environments: $($r.Message)" }
    @($r.Json.value | Where-Object { $_.properties.databaseType -eq 'CommonDataService' -and $_.properties.linkedEnvironmentMetadata.instanceUrl } | ForEach-Object {
            [pscustomobject]@{
                Id     = [string]$_.name
                Name   = [string]$_.properties.displayName
                OrgUrl = ([string]$_.properties.linkedEnvironmentMetadata.instanceUrl).TrimEnd('/')
                Geo    = [string]$_.location
            }
        })
}

function Select-LabPowerPlatformEnvironment([hashtable]$State) {
    $envs = @(Get-LabPowerPlatformEnvironments)
    if ($envs.Count -eq 0) {
        Write-LabWarn 'No Power Platform environment with Dataverse is visible to this account yet. Setup will show you how to create one when it reaches that stage.'
        $State.choices.ppEnvironmentId = ''
        return
    }
    Write-LabInfo 'Copilot Studio path: which Power Platform environment should hold the agent and its trigger table?'
    Write-LabInfo 'Its geography decides where the Copilot Studio Cloud PCs run.'
    $i = Read-LabNumber -Prompt 'Environment number' -Options ($envs | ForEach-Object { "$($_.Name)  ($($_.Geo), $($_.OrgUrl))" })
    $State.choices.ppEnvironmentId = $envs[$i].Id
    $State.choices.ppEnvironmentName = $envs[$i].Name
    $State.choices.dataverseUrl = $envs[$i].OrgUrl
}

function Test-LabChoicesComplete([hashtable]$State) {
    $c = $State.choices
    $need = @('tenantId', 'subscriptionId', 'location', 'backends', 'resourceGroup', 'functionApp', 'storageAccount', 'keyVault', 'staticWebApp', 'signInAppName', 'presenterGroup')
    if (Test-LabUseFoundry $State) { $need += @('foundryMode', 'foundryAccount', 'foundryAccountGroup', 'foundryProject', 'registry', 'agentName', 'modelDeployment', 'modelCapacity', 'agentUserUpn', 'foundryDeviceGroup') }
    if (Test-LabUseMcs $State) { $need += @('mcsAgentName', 'mcsDeviceGroup', 'publisherPrefix') }
    foreach ($k in $need) { if (-not $c.ContainsKey($k) -or [string]::IsNullOrWhiteSpace([string]$c[$k])) { return $false } }
    if ((Test-LabUseMcs $State) -and -not $c.ContainsKey('ppEnvironmentId')) { return $false }
    return $true
}

function Select-LabChoices {
    # Asks each question once and saves the answers. Later runs reuse them without asking.
    param([Parameter(Mandatory)][hashtable]$State, [string]$Backends, [switch]$DeviceCode)
    $c = $State.choices
    $prev = @{} + $c
    $enteredNow = @()
    Write-LabTitle 'Your choices (asked once; saved privately on this computer)'

    # Tenant: an existing sign-in is offered, never assumed.
    $acct = Get-LabSignedInAccount
    $tenantDefault = if ($c.tenantId) { $c.tenantId } elseif ($acct) { $acct.tenantId } else { '' }
    if ($acct) { Write-LabInfo "The Azure CLI is signed in as $($acct.user.name) to tenant $($acct.tenantId)." }
    $tenant = Read-LabText -Prompt 'Microsoft Entra tenant ID or domain to install into' -Default $tenantDefault
    $acct = Connect-LabAzure -Tenant $tenant -DeviceCode:$DeviceCode
    $c.tenantId = $acct.tenantId

    # Subscription: always an explicit choice, even when only one is visible.
    $subs = @(Get-LabAzJson @('account', 'list', '--all') | Where-Object { $_.tenantId -eq $c.tenantId -and $_.state -eq 'Enabled' })
    if ($subs.Count -eq 0) { throw "The signed-in account sees no enabled Azure subscription in tenant $($c.tenantId)." }
    Write-LabInfo 'Which Azure subscription pays for the lab resources?'
    $i = Read-LabNumber -Prompt 'Subscription number' -Options ($subs | ForEach-Object { "$($_.name)  ($($_.id))" })
    $c.subscriptionId = $subs[$i].id
    $c.subscriptionName = $subs[$i].name
    Connect-LabAzure -Tenant $c.tenantId -SubscriptionId $c.subscriptionId | Out-Null

    if (-not $Backends) {
        Write-LabInfo 'Which agent paths do you want?'
        $b = Read-LabNumber -Prompt 'Path number' -Options @('Both: Copilot Studio and Foundry (recommended)', 'Copilot Studio only', 'Foundry only')
        $Backends = @('both', 'mcs', 'foundry')[$b]
    }
    $c.backends = $Backends

    $locDefault = if ($c.location) { $c.location } else { '' }
    $known = @(Get-LabAzJson @('account', 'list-locations') -Lenient | ForEach-Object { $_.name })
    $c.location = Read-LabText -Prompt 'Azure region for the lab resources (for example australiaeast or eastus2)' -Default $locDefault -Validate {
        param($a) if ($known.Count -and ($known -notcontains $a.ToLowerInvariant())) { "'$a' is not an Azure region name this subscription offers." }
    }.GetNewClosure()
    $c.location = $c.location.ToLowerInvariant()

    $c.resourceGroup = Read-LabText -Prompt 'Resource group for the lab (created if it does not exist)' -Default $(if ($c.resourceGroup) { $c.resourceGroup } else { $script:LabDefaults.resourceGroup })
    $rgExists = (Invoke-LabAz -Arguments @('group', 'exists', '--name', $c.resourceGroup) -AllowFailure).Text.Trim() -eq 'true'
    if ($rgExists) {
        $count = @(Get-LabAzJson @('resource', 'list', '--resource-group', $c.resourceGroup)).Count
        Write-LabWarn "Resource group '$($c.resourceGroup)' already exists with $count resource(s). Setup reuses resources with the names below and does not delete anything."
        if (-not (Confirm-Lab "Use this existing resource group?")) { throw 'Stopped: choose another resource group name by running setup again.' }
    }

    # Names: unique per subscription, the same rule the existing helpers use.
    $sfx = Get-DemoNameSuffix -Seed "$($c.subscriptionId)|$($c.tenantId)"
    $names = [ordered]@{
        functionApp    = "zava-handoff-$sfx"
        storageAccount = "zavahandoff$sfx"
        keyVault       = "zava-handoff-kv-$sfx"
        staticWebApp   = "zava-ccaas-$sfx"
        signInAppName  = $script:LabDefaults.signInAppName
        presenterGroup = $script:LabDefaults.presenterGroup
        presenterPolicyName = "Zava Contact Center - zava-ccaas-$sfx"
    }
    if (Test-LabUseMcs $State) {
        $names.mcsAgentName = $script:LabDefaults.mcsAgentName
        $names.mcsDeviceGroup = $script:LabDefaults.mcsDeviceGroup
        $names.publisherPrefix = $script:LabDefaults.publisherPrefix
    }
    if (Test-LabUseFoundry $State) {
        $domains = Invoke-LabRest -Url 'https://graph.microsoft.com/v1.0/domains?$select=id,isVerified,isInitial'
        $initial = @($domains.Json.value | Where-Object { $_.isInitial }) | Select-Object -First 1
        $names.foundryAccount = "zava-lab-$sfx"
        $names.foundryAccountGroup = $c.resourceGroup
        $names.foundryProject = $script:LabDefaults.foundryProject
        $names.registry = "zavalab$sfx"
        $names.agentName = $script:LabDefaults.agentName
        $names.modelDeployment = $script:LabDefaults.modelDeployment
        $names.modelCapacity = $script:LabDefaults.modelCapacity
        $names.agentUserUpn = if ($initial) { "zava-claims-agent@$($initial.id)" } else { '' }
        $names.foundryDeviceGroup = $script:LabDefaults.foundryDeviceGroup

        Write-LabInfo 'Foundry: setup creates a new Foundry resource and project for this lab, unless you name an existing one that is meant for it.'
        Write-LabInfo 'It never picks a project just because your account can see it.'
        $mode = Read-LabNumber -Prompt 'Foundry project' -Options @('Create a new Foundry resource and project for this lab (recommended)', 'Use an existing Foundry resource and project that I name')
        $c.foundryMode = @('new', 'existing')[$mode]
        $enteredNow += 'foundryAccountGroup'
        if ($c.foundryMode -eq 'existing') {
            $names.foundryAccount = Read-LabText -Prompt 'Existing Foundry resource (account) name'
            $names.foundryAccountGroup = Read-LabText -Prompt 'Its resource group' -Default $c.resourceGroup
            $names.foundryProject = Read-LabText -Prompt 'Existing project name'
            $enteredNow += @('foundryAccount', 'foundryProject')
            $acc = Get-LabAzJson @('cognitiveservices', 'account', 'show', '--name', $names.foundryAccount, '--resource-group', $names.foundryAccountGroup)
            if (-not $acc) { throw "Foundry resource '$($names.foundryAccount)' was not found in resource group '$($names.foundryAccountGroup)' of the chosen subscription." }
        }
    }

    # Earlier answers are offered again only for the same tenant and subscription, and never
    # replace an answer typed just now.
    if ($prev.tenantId -eq $c.tenantId -and $prev.subscriptionId -eq $c.subscriptionId) {
        foreach ($k in @($names.Keys)) { if ($k -notin $enteredNow -and $prev[$k]) { $names[$k] = $prev[$k] } }
    }
    Write-LabInfo 'Proposed names:'
    foreach ($k in $names.Keys) { Write-Host ("    {0,-20} {1}" -f $k, $names[$k]) }
    $editable = @($names.Keys | Where-Object { $_ -ne 'foundryAccountGroup' })
    if (-not (Confirm-Lab 'Use these names?')) {
        foreach ($k in $editable) { $names[$k] = Read-LabText -Prompt $k -Default $names[$k] }
    }
    foreach ($k in $names.Keys) { $c[$k] = [string]$names[$k] }
    if ((Test-LabUseFoundry $State) -and -not $c.agentUserUpn) { $c.agentUserUpn = Read-LabText -Prompt 'Sign-in name for the Foundry agent user, on a verified domain (for example zava-claims-agent@contoso.com)' }

    if (Test-LabUseMcs $State) { Select-LabPowerPlatformEnvironment -State $State }
}

function Get-LabDestinationKey([hashtable]$State) {
    # Everything that decides where setup works. Findings from another destination are not reused.
    $c = $State.choices
    (@('tenantId', 'subscriptionId', 'resourceGroup', 'functionApp', 'staticWebApp', 'signInAppName', 'ppEnvironmentId', 'mcsAgentName',
            'foundryAccount', 'foundryAccountGroup', 'foundryProject', 'registry', 'agentName', 'agentUserUpn') | ForEach-Object { [string]$c[$_] }) -join '|'
}

function Show-LabDestination([hashtable]$State) {
    $c = $State.choices
    Write-LabTitle 'Destination (nothing outside this list is changed)'
    $rows = [ordered]@{
        'Tenant'           = $c.tenantId
        'Subscription'     = "$($c.subscriptionName) ($($c.subscriptionId))"
        'Region'           = $c.location
        'Resource group'   = $c.resourceGroup
        'Agent paths'      = @{ both = 'Copilot Studio and Foundry'; mcs = 'Copilot Studio only'; foundry = 'Foundry only' }[$c.backends]
        'Handoff service'  = "$($c.functionApp) (+ storage $($c.storageAccount), key vault $($c.keyVault))"
        'Zava web site'    = $c.staticWebApp
        'Zava sign-in app' = $c.signInAppName
        'Presenter policy' = "$(Get-LabPresenterPolicyName $State) (Intune, for group $($c.presenterGroup))"
    }
    if (Test-LabUseMcs $State) {
        $rows['Power Platform'] = $(if ($c.ppEnvironmentName) { "$($c.ppEnvironmentName) ($($c.dataverseUrl))" } else { 'not chosen yet' })
        $rows['Copilot Studio agent'] = $c.mcsAgentName
    }
    if (Test-LabUseFoundry $State) {
        $rows['Foundry project'] = "$($c.foundryProject) in $($c.foundryAccount) ($($c.foundryMode))"
        $rows['Model deployment'] = "$($c.modelDeployment), capacity $($c.modelCapacity) thousand tokens per minute"
        $rows['Container registry'] = $c.registry
        $rows['Foundry agent'] = "$($c.agentName), agent user $($c.agentUserUpn)"
    }
    foreach ($k in $rows.Keys) { Write-Host ("  {0,-22} {1}" -f $k, $rows[$k]) }
}

# ---------------------------------------------------------------- existing config formats
function Get-LabFoundryEndpoint([hashtable]$State) {
    if ($State.found.foundryEndpoint) { return $State.found.foundryEndpoint }
    return "https://$($State.choices.foundryAccount).services.ai.azure.com/api/projects/$($State.choices.foundryProject)"
}

function Write-LabDemoConfig([hashtable]$State, [string]$Path) {
    # scripts\demo-config.sample.json format, for New-DemoHandoffOrchestrator / New-DemoStaticWebApp.
    $c = $State.choices
    $cfg = Get-Content -Raw -LiteralPath (Join-Path $script:LabRepoRoot 'scripts\demo-config.sample.json') | ConvertFrom-Json
    $cfg._README = 'Generated by scripts\Install-Lab.ps1 from scripts\lab-setup.local.json. Change choices by running Install-Lab.ps1 -ChooseAgain, not here.'
    $cfg.agentBackend = $c.backends
    $cfg.azure.subscriptionId = $c.subscriptionId
    $cfg.azure.tenantId = $c.tenantId
    $cfg.azure.globalAdminUpn = ''
    $cfg.azure.location = $c.location
    $o = $cfg.handoffOrchestrator
    $o.resourceGroup = $c.resourceGroup
    $o.functionAppName = $c.functionApp
    $o.storageAccountName = $c.storageAccount
    $o.keyVaultName = $c.keyVault
    $o.location = $c.location
    $o.dataverse.orgUrl = [string]$c.dataverseUrl
    $o.dataverse.cuaAgentBotId = [string]$State.found.mcsBotId
    $o.foundryRelay.invocationsUrl = [string]$State.found.invocationsUrl
    $o.foundryRelay.tenantId = $c.tenantId
    $o.foundryRelay.clientId = [string]$State.found.zavaClientId
    $o.foundryRelay.cloudPcPoolId = [string]$State.found.foundryPoolId
    $cfg.staticWebApp.name = $c.staticWebApp
    $cfg.staticWebApp.resourceGroup = $c.resourceGroup
    $cfg.appRegistration.displayName = $c.signInAppName
    $cfg.appRegistration.clientId = [string]$State.found.zavaClientId
    $cfg.agentPool.deviceGroupName = $(if ($c.mcsDeviceGroup) { $c.mcsDeviceGroup } else { $script:LabDefaults.mcsDeviceGroup })
    $cfg.agentWorkstation.userGroupName = $c.presenterGroup
    $cfg.agentWorkstation.webLink.url = [string]$State.found.zavaUrl
    if (Test-LabUseFoundry $State) {
        $cfg.foundry.endpoint = Get-LabFoundryEndpoint $State
        $cfg.foundry.agentName = $c.agentName
        $cfg.foundry.modelDeployment = $c.modelDeployment
    }
    ($cfg | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $Path -Encoding utf8
    return $Path
}

function Write-LabFoundryConfig {
    # deploy\foundry\foundry-agent.sample.json format, for Deploy-FoundryAgent.ps1.
    # Enabled = $false: first deployment, both execution gates off and the identity IDs empty.
    # Enabled = $true: gates on, with the four IDs read from the tenant.
    param([hashtable]$State, [string]$Path, [string]$SamplePath, [switch]$Enabled, [string]$ReceiptPath)
    $c = $State.choices; $f = $State.found
    $cfg = Get-Content -Raw -LiteralPath $SamplePath | ConvertFrom-Json
    $cfg._README = 'Generated by scripts\Install-Lab.ps1 from scripts\lab-setup.local.json. Change choices by running Install-Lab.ps1 -ChooseAgain, not here.'
    $cfg.tenantId = $c.tenantId
    $cfg.subscriptionId = $c.subscriptionId
    $cfg.resourceGroup = $c.resourceGroup
    $cfg.containerRegistryName = $c.registry
    $cfg.imageRepository = $c.agentName
    $cfg.imageTag = 'lab'
    $cfg.imageDigest = [string]$f.imageDigest
    $cfg.foundryProjectEndpoint = Get-LabFoundryEndpoint $State
    $cfg.agentName = $c.agentName
    $cfg.outputReceiptPath = $ReceiptPath
    $vars = $cfg.hostedAgent.environmentVariables
    $vars.AZURE_AI_MODEL_DEPLOYMENT_NAME = $c.modelDeployment
    if ($Enabled) {
        foreach ($k in 'agentIdentityId', 'blueprintId', 'agentUserId') { if (-not $f[$k]) { throw "Cannot turn the agent on: $k is not known yet." } }
        $vars.LIVE_EXECUTION_APPROVED = 'yes'
        $vars.CLAIMS_EXECUTION_APPROVED = 'yes'
        $vars.CLAIMS_TENANT_ID = $c.tenantId
        $vars.CLAIMS_BLUEPRINT_ID = $f.blueprintId
        $vars.CLAIMS_AGENT_ID = $f.agentIdentityId
        $vars.CLAIMS_AGENT_USER_ID = $f.agentUserId
        $cfg.expectedInstanceIdentityClientId = $f.agentIdentityId
    }
    else {
        $vars.LIVE_EXECUTION_APPROVED = 'no'
        $vars.CLAIMS_EXECUTION_APPROVED = 'no'
        foreach ($k in 'CLAIMS_TENANT_ID', 'CLAIMS_BLUEPRINT_ID', 'CLAIMS_AGENT_ID', 'CLAIMS_AGENT_USER_ID') { $vars.$k = '' }
        $cfg.expectedInstanceIdentityClientId = [string]$f.agentIdentityId
    }
    ($cfg | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $Path -Encoding utf8
    return $Path
}
