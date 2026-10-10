<#
.SYNOPSIS
    Install-Lab stages for the Foundry hosted agent path. The order is the one the platform
    requires: first hosted version with both execution gates off (this creates the agent's
    native identity), then the agent user and consent, the Cloud PC pool, and only then a
    version with the gates on, after an explicit yes.
    Keep this file ASCII-only.
#>

$script:LabModelName = 'gpt-4.1-mini'
$script:LabModelVersion = '2025-04-14'
$script:LabUserRoles = @('Foundry User', 'Azure AI User')

function Get-LabFoundryAgent([hashtable]$State) {
    $url = "$(Get-LabFoundryEndpoint $State)/agents/$($State.choices.agentName)?api-version=v1"
    Invoke-LabRest -Url $url -Resource 'https://ai.azure.com'
}

function Get-LabRoleNames([string]$Assignee, [string]$Scope) {
    @(Get-LabAzJson @('role', 'assignment', 'list', '--assignee', $Assignee, '--scope', $Scope, '--include-inherited') | ForEach-Object { [string]$_.roleDefinitionName })
}

function Resolve-LabRoleName([string[]]$Names) {
    foreach ($n in $Names) { if (@(Get-LabAzJson @('role', 'definition', 'list', '--name', $n)).Count) { return $n } }
    throw "None of these Azure roles exists in this subscription: $($Names -join ', ')."
}

function Get-LabFoundryProjectState([hashtable]$State) {
    $c = $State.choices
    $o = [ordered]@{ Missing = @(); Account = $null; Project = $null; Registry = $null; Me = $null }
    $o.Account = Get-LabAzJson @('cognitiveservices', 'account', 'show', '--name', $c.foundryAccount, '--resource-group', $c.foundryAccountGroup)
    if (-not $o.Account) { $o.Missing += "Foundry resource $($c.foundryAccount)"; return [pscustomobject]$o }
    $sub = [string]$o.Account.properties.customSubDomainName
    if ($sub) { Set-LabFound $State 'foundryEndpoint' "https://$sub.services.ai.azure.com/api/projects/$($c.foundryProject)" }
    $o.Project = Get-LabAzJson @('cognitiveservices', 'account', 'project', 'show', '--name', $c.foundryAccount, '--resource-group', $c.foundryAccountGroup, '--project-name', $c.foundryProject)
    if (-not $o.Project) { $o.Missing += "Foundry project $($c.foundryProject)" }
    if (-not (Get-LabAzJson @('cognitiveservices', 'account', 'deployment', 'show', '--name', $c.foundryAccount, '--resource-group', $c.foundryAccountGroup, '--deployment-name', $c.modelDeployment))) { $o.Missing += "model deployment $($c.modelDeployment)" }
    $o.Registry = Get-LabAzJson @('acr', 'show', '--name', $c.registry)
    if (-not $o.Registry) { $o.Missing += "container registry $($c.registry)" }
    if ($o.Project -and $o.Registry) {
        $mi = [string]$o.Project.identity.principalId
        if (-not (Get-LabRoleNames $mi $o.Registry.id | Where-Object { $_ -in @('AcrPull', 'Container Registry Repository Reader') })) { $o.Missing += 'project identity may pull from the registry (AcrPull)' }
    }
    if ($o.Project) {
        if ($State.found.handoffPrincipalId -and -not (Get-LabRoleNames $State.found.handoffPrincipalId $o.Project.id | Where-Object { $_ -in @('Foundry Agent Consumer', 'Foundry User', 'Azure AI User') })) { $o.Missing += 'handoff service may call the agent (Foundry Agent Consumer)' }
        $me = Get-LabAzJson @('ad', 'signed-in-user', 'show')
        $o.Me = $me
        if ($me -and -not (Get-LabRoleNames $me.id $o.Project.id | Where-Object { $_ -in $script:LabUserRoles })) { $o.Missing += "you may deploy agent versions ($($script:LabUserRoles -join ' or '))" }
    }
    return [pscustomobject]$o
}

function Install-LabFoundryProject([hashtable]$State) {
    $c = $State.choices
    $s = Get-LabFoundryProjectState $State
    if (-not $s.Account) {
        if ($c.foundryMode -ne 'new') { throw "The Foundry resource '$($c.foundryAccount)' you named does not exist." }
        Invoke-LabAzVisible -Arguments @('cognitiveservices', 'account', 'create', '--name', $c.foundryAccount, '--resource-group', $c.foundryAccountGroup, '--kind', 'AIServices', '--sku', 'S0', '--location', $c.location, '--custom-domain', $c.foundryAccount, '--assign-identity', '--allow-project-management', 'true', '-o', 'none', '--only-show-errors')
        $s = Get-LabFoundryProjectState $State
    }
    if (-not $s.Project) {
        if ($c.foundryMode -ne 'new') { throw "The Foundry project '$($c.foundryProject)' you named does not exist." }
        Invoke-LabAz -Arguments @('cognitiveservices', 'account', 'project', 'create', '--name', $c.foundryAccount, '--resource-group', $c.foundryAccountGroup, '--project-name', $c.foundryProject, '--location', $c.location, '-o', 'none', '--only-show-errors') | Out-Null
    }
    if ($s.Missing -like 'model deployment*') {
        Invoke-LabAz -Arguments @('cognitiveservices', 'account', 'deployment', 'create', '--name', $c.foundryAccount, '--resource-group', $c.foundryAccountGroup, '--deployment-name', $c.modelDeployment, '--model-name', $script:LabModelName, '--model-version', $script:LabModelVersion, '--model-format', 'OpenAI', '--sku-name', 'GlobalStandard', '--sku-capacity', $c.modelCapacity, '-o', 'none', '--only-show-errors') | Out-Null
    }
    if (-not $s.Registry) {
        Invoke-LabAz -Arguments @('acr', 'create', '--name', $c.registry, '--resource-group', $c.resourceGroup, '--sku', 'Basic', '--location', $c.location, '-o', 'none', '--only-show-errors') | Out-Null
    }
    $s = Get-LabFoundryProjectState $State
    if (-not ($s.Project -and $s.Registry)) { throw "Still missing: $($s.Missing -join '; ')" }
    $mi = [string]$s.Project.identity.principalId
    if ($s.Missing -like 'project identity*') {
        Invoke-LabAz -Arguments @('role', 'assignment', 'create', '--assignee-object-id', $mi, '--assignee-principal-type', 'ServicePrincipal', '--role', 'AcrPull', '--scope', $s.Registry.id, '-o', 'none', '--only-show-errors') | Out-Null
    }
    if ($s.Missing -like 'handoff service*') {
        Invoke-LabAz -Arguments @('role', 'assignment', 'create', '--assignee-object-id', $State.found.handoffPrincipalId, '--assignee-principal-type', 'ServicePrincipal', '--role', 'Foundry Agent Consumer', '--scope', $s.Project.id, '-o', 'none', '--only-show-errors') | Out-Null
    }
    if ($s.Missing -like 'you may deploy*') {
        $role = Resolve-LabRoleName $script:LabUserRoles
        Invoke-LabAz -Arguments @('role', 'assignment', 'create', '--assignee-object-id', $s.Me.id, '--assignee-principal-type', 'User', '--role', $role, '--scope', $s.Project.id, '-o', 'none', '--only-show-errors') | Out-Null
    }
}

function Invoke-LabFoundryDeploy([hashtable]$Ctx, [switch]$Enabled, [switch]$DeployVersion, [switch]$ConfigureEndpoint, [switch]$BuildImage) {
    Write-LabFoundryConfig -State $Ctx.State -Path $Ctx.Paths.FoundryConfig -SamplePath $Ctx.Paths.FoundrySample -Enabled:$Enabled -ReceiptPath $Ctx.Paths.FoundryReceipt | Out-Null
    $a = @{ ConfigPath = $Ctx.Paths.FoundryConfig; Python = $Ctx.Paths.VenvPython }
    if ($BuildImage) { $a.BuildImage = $true }
    if ($DeployVersion) { $a.DeployVersion = $true }
    if ($ConfigureEndpoint) { $a.ConfigureEndpoint = $true }
    Invoke-LabScript 'deploy\foundry\Deploy-FoundryAgent.ps1' $a | Out-Null
}

function Get-LabIdentityPlan([hashtable]$Ctx, [switch]$Apply) {
    $c = $Ctx.State.choices
    $a = @{ TenantId = $c.tenantId; AgentIdentityId = $Ctx.State.found.agentIdentityId; AgentUserPrincipalName = $c.agentUserUpn; PassThru = $true }
    if ($Apply) { $a.Apply = $true }
    $out = Invoke-LabScript 'deploy\foundry\Set-FoundryAgentIdentity.ps1' $a
    $o = @($out) | Where-Object { $_ -and $_.PSObject.Properties['BlueprintId'] } | Select-Object -Last 1
    if (-not $o) { throw 'Set-FoundryAgentIdentity.ps1 did not report its result.' }
    Set-LabFound $Ctx.State 'blueprintId' $o.BlueprintId
    Set-LabFound $Ctx.State 'agentUserId' $o.AgentUserId
    return $o
}

function Invoke-LabGraphPs {
    # Reads that the Azure CLI token cannot do (Cloud PC pools, Intune policies) use the Microsoft
    # Graph PowerShell sign-in, with read-only scopes.
    param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$TenantId, [string[]]$Scopes = @('CloudPC.Read.All'), [switch]$DeviceCode)
    Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
    $ctx = Get-MgContext
    if (-not $ctx -or $ctx.TenantId -ne $TenantId -or @($Scopes | Where-Object { @($ctx.Scopes) -notcontains $_ }).Count) {
        if ($DeviceCode) { Connect-MgGraph -TenantId $TenantId -Scopes $Scopes -UseDeviceAuthentication -NoWelcome | Out-Null }
        else { Connect-MgGraph -TenantId $TenantId -Scopes $Scopes -NoWelcome | Out-Null }
    }
    Invoke-MgGraphRequest -Method GET -Uri $Uri -OutputType PSObject
}

function Get-LabFoundryStages {
    $stages = New-Object System.Collections.Generic.List[hashtable]

    $stages.Add(@{
            Id = 'foundry-project'; When = 'foundry'; Kind = 'auto'
            Title = 'Create the Foundry project, model and registry'
            Purpose = 'The hosted agent runs in this Foundry project, calls this model deployment, and is built into your own container registry.'
            Who = 'You (Owner, or Contributor plus User Access Administrator, on the resource group)'
            Plan = {
                param($Ctx)
                $c = $Ctx.State.choices
                $verb = if ($c.foundryMode -eq 'new') { 'Create or reuse' } else { 'Use your existing' }
                "$verb Foundry resource $($c.foundryAccount) and project $($c.foundryProject); model deployment $($c.modelDeployment) ($script:LabModelName $script:LabModelVersion, Global Standard, capacity $($c.modelCapacity), billed per token); Basic container registry $($c.registry) (small monthly charge). Roles: project identity AcrPull on the registry; handoff service Foundry Agent Consumer on the project; you Foundry User on the project."
            }
            Check = {
                param($Ctx)
                $s = Get-LabFoundryProjectState $Ctx.State
                if ($s.Missing.Count) { return (New-LabResult $false ("Missing: " + ($s.Missing -join '; '))) }
                New-LabResult $true (Get-LabFoundryEndpoint $Ctx.State)
            }
            Apply = { param($Ctx) Install-LabFoundryProject $Ctx.State }
            NextAction = 'Hosted agents and the model are offered in some regions only, and the model needs quota. Run setup with -ChooseAgain to pick another region or a smaller capacity, or ask for quota.'
        })

    $stages.Add(@{
            Id = 'foundry-image'; When = 'foundry'; Kind = 'auto'
            Title = 'Build the agent image in your registry'
            Purpose = 'Builds the Foundry agent from this download into your own registry and records the exact image (its digest).'
            Who = 'You (Contributor on the registry)'
            Plan = { param($Ctx) "Run deploy\foundry\Deploy-FoundryAgent.ps1 -BuildImage: a billable registry build in $($Ctx.State.choices.registry) of only the files the Dockerfile uses." }
            Check = {
                param($Ctx)
                $d = $Ctx.State.found.imageDigest
                if (-not $d) { return (New-LabResult $false 'No image built yet.') }
                if (-not (Get-LabAzJson @('acr', 'repository', 'show', '--name', $Ctx.State.choices.registry, '--image', "$($Ctx.State.choices.agentName)@$d"))) { return (New-LabResult $false "Image $d is not in the registry.") }
                New-LabResult $true "$($Ctx.State.choices.registry).azurecr.io/$($Ctx.State.choices.agentName)@$d"
            }
            Apply = {
                param($Ctx)
                Invoke-LabFoundryDeploy -Ctx $Ctx -BuildImage
                $digest = [string](Get-Content -Raw -LiteralPath $Ctx.Paths.FoundryConfig | ConvertFrom-Json).imageDigest
                if (-not $digest) { throw 'The build finished but no image digest was recorded.' }
                Set-LabFound $Ctx.State 'imageDigest' $digest
            }
            NextAction = 'Read the build output above. A registry build needs outbound access to Docker Hub and PyPI from Azure.'
        })

    $stages.Add(@{
            Id = 'foundry-agent'; When = 'foundry'; Kind = 'auto'; Settle = 300
            Title = 'Create the Foundry agent (switched off)'
            Purpose = 'The first hosted version makes Foundry create the agent''s own identity. Both execution gates are off, so it cannot touch a Cloud PC yet.'
            Who = 'You (Foundry User on the project)'
            Plan = { param($Ctx) "Run Deploy-FoundryAgent.ps1 -DeployVersion -ConfigureEndpoint for agent $($Ctx.State.choices.agentName) with LIVE_EXECUTION_APPROVED=no and CLAIMS_EXECUTION_APPROVED=no; endpoint = Invocations with Microsoft Entra authorization. An existing agent is not redeployed here." }
            Check = {
                param($Ctx)
                $r = Get-LabFoundryAgent $Ctx.State
                if ($r.NotFound) { return (New-LabResult $false "Agent $($Ctx.State.choices.agentName) does not exist yet.") }
                if (-not $r.Ok) { throw "Could not read the Foundry agent: $($r.Message)" }
                $a = $r.Json
                $status = [string]$a.versions.latest.status
                if ($status -ne 'active') { return (New-LabResult $false "The latest version is '$status', not active yet.") }
                $id = [string]$a.instance_identity.client_id
                if (-not $id) { return (New-LabResult $false 'The agent has no identity yet.') }
                Set-LabFound $Ctx.State 'agentIdentityId' $id
                Set-LabFound $Ctx.State 'invocationsUrl' "$(Get-LabFoundryEndpoint $Ctx.State)/agents/$($Ctx.State.choices.agentName)/endpoint/protocols/invocations?api-version=v1"
                $ep = ($a.agent_endpoint | ConvertTo-Json -Depth 10)
                if (-not ($ep -match '(?i)invocations' -and $ep -match '(?i)entra')) { return (New-LabResult $false 'The agent endpoint is not set to Invocations with Microsoft Entra authorization yet.') }
                New-LabResult $true "version $($a.versions.latest.version) active; identity $id"
            }
            Apply = {
                param($Ctx)
                $r = Get-LabFoundryAgent $Ctx.State
                if ($r.NotFound) { Invoke-LabFoundryDeploy -Ctx $Ctx -DeployVersion -ConfigureEndpoint; return }
                if (-not $r.Ok) { throw "Could not read the Foundry agent: $($r.Message)" }
                Invoke-LabFoundryDeploy -Ctx $Ctx -ConfigureEndpoint
            }
            NextAction = 'Check that you have Foundry User on the project (a new role assignment can take a few minutes to apply), then run setup again.'
        })

    $stages.Add(@{
            Id = 'foundry-identity'; When = 'foundry'; Kind = 'admin'
            Title = 'Create the agent user and consent its Computer Use permissions'
            Purpose = 'The agent signs in to Windows 365 as its own agent user. That needs exactly three delegated permissions, consented for the tenant.'
            Who = 'Agent ID Administrator, plus Privileged Role Administrator or Global Administrator (tenant-wide consent)'
            Plan = { param($Ctx) "Run deploy\foundry\Set-FoundryAgentIdentity.ps1 -Apply: agent user $($Ctx.State.choices.agentUserUpn); tenant-wide consent for McpServersMetadata.Read.All (Agent 365 Tools), Tools.ListInvoke.All (Windows 365 Computer Use MCP) and Computer.See (W365Agents-Production). Computer.Control is not granted. Asks for your explicit yes." }
            Check = {
                param($Ctx)
                if (-not $Ctx.State.found.agentIdentityId) { return (New-LabResult $false 'Waiting for the agent identity.') }
                $o = Get-LabIdentityPlan $Ctx
                if (@($o.Changes).Count) { return (New-LabResult $false ("To do: " + (@($o.Changes) -join '; '))) }
                New-LabResult $true "Agent user $($o.AgentUserId); scopes consented"
            }
            Apply = {
                param($Ctx)
                $o = Get-LabIdentityPlan $Ctx
                Write-LabWarn 'This makes these changes in Microsoft Entra ID:'
                foreach ($line in @($o.Changes)) { Write-LabWarn "  - $line" }
                Write-LabWarn 'Tenant-wide consent means the agent identity may use those three delegated permissions for its own agent user. It does not grant Computer.Control.'
                if (-not (Confirm-Lab 'Do you approve these identity changes and the tenant-wide consent?')) { throw 'You did not approve the identity changes.' }
                Get-LabIdentityPlan $Ctx -Apply | Out-Null
            }
            NextAction = 'This needs Agent ID Administrator plus Privileged Role Administrator or Global Administrator. Ask someone with those roles to sign in on this computer (az login --tenant <tenant>) and run setup again.'
        })

    $stages.Add(@{
            Id = 'foundry-claims-app'; When = 'foundry'; Kind = 'admin'
            Title = 'Deliver the Claims app to the Foundry pool''s devices'
            Purpose = 'A Windows 365 for Agents pool puts its Cloud PCs in an assigned group you choose. Setup creates that group and assigns the Claims app to it.'
            Who = 'Intune Administrator (signs in when asked)'
            Plan = { param($Ctx) "Run scripts\Deploy-DemoEnvironment.ps1 for device group '$($Ctx.State.choices.foundryDeviceGroup)' (empty until the pool fills it)." }
            Check = { param($Ctx) Get-LabIntuneStageResult $Ctx 'foundry-claims-app' 'Zava Claims Workstation' $Ctx.State.choices.foundryDeviceGroup }
            Apply = {
                param($Ctx)
                $c = $Ctx.State.choices
                $a = @{ TenantId = $c.tenantId; DeviceGroupName = $c.foundryDeviceGroup; UserGroupName = $c.presenterGroup }
                if ($Ctx.DeviceCode) { $a.DeviceCode = $true }
                Invoke-LabScript 'scripts\Deploy-DemoEnvironment.ps1' $a | Out-Null
                Add-LabRun $Ctx.State 'foundry-claims-app' $c.foundryDeviceGroup
            }
            NextAction = 'This needs an Intune Administrator. Ask one to run setup again on this computer and sign in when the Intune sign-in window opens.'
        })

    $stages.Add(@{
            Id = 'foundry-pool'; When = 'foundry'; Kind = 'portal'; Interactive = $true
            Title = 'Create the Foundry agent''s Cloud PC pool'
            Purpose = 'Billing plan, pool size and image are your decisions, so the pool is created in the Intune admin center. You add the agent to it there.'
            Who = 'Intune Administrator with access to the Windows 365 for Agents billing policy'
            Plan = { param($Ctx) "Portal: provisioning policy (agents) with agent $($Ctx.State.choices.agentName) and device group '$($Ctx.State.choices.foundryDeviceGroup)'. Setup then finds the pool with a Microsoft Graph sign-in (CloudPC.Read.All)." }
            Check = {
                param($Ctx)
                $f = $Ctx.State.found
                if (-not $f.agentUserId) { return (New-LabResult $false 'Waiting for the agent user.') }
                if ($Ctx.Preview) { return [pscustomobject]@{ Done = $false; Deferred = $true; Detail = 'Checked when setup runs (needs a Microsoft Graph sign-in).' } }
                $Ctx.State.found.Remove('poolReadError')
                try {
                    $pools = Invoke-LabGraphPs -Uri 'https://graph.microsoft.com/beta/deviceManagement/virtualEndpoint/cloudPcPools' -TenantId $Ctx.State.choices.tenantId -DeviceCode:$Ctx.DeviceCode
                    foreach ($p in @($pools.value)) {
                        $as = Invoke-LabGraphPs -Uri "https://graph.microsoft.com/beta/deviceManagement/virtualEndpoint/cloudPcPools/$($p.id)/assignments" -TenantId $Ctx.State.choices.tenantId -DeviceCode:$Ctx.DeviceCode
                        if (($as | ConvertTo-Json -Depth 10) -like "*$($f.agentUserId)*") {
                            Set-LabFound $Ctx.State 'foundryPoolId' $p.id
                            Set-LabFound $Ctx.State 'foundryPoolName' $p.displayName
                            if ($Ctx.RanThisRun) { $Ctx.RanThisRun['foundry-pool'] = $true }
                            return (New-LabResult $true "Pool '$($p.displayName)' ($($p.id)) includes the agent")
                        }
                    }
                }
                catch {
                    # Only when the live read is impossible does a person's confirmation count.
                    $Ctx.State.found.poolReadError = Get-LabShortText $_.Exception.Message 300
                    if ($Ctx.RanThisRun -and $Ctx.RanThisRun['foundry-pool-confirmed']) { return (New-LabEarlierResult 'Confirmed by you in the Intune admin center during this run; setup could not read Cloud PC pools with your sign-in.') }
                    if ($f.foundryPoolConfirmedAt) { return (New-LabEarlierResult "Confirmed by you in the Intune admin center on $($f.foundryPoolConfirmedAt); setup could not read Cloud PC pools with your sign-in.") }
                    return (New-LabResult $false "Setup could not read Cloud PC pools: $($Ctx.State.found.poolReadError)")
                }
                New-LabResult $false "No Cloud PC pool includes agent user $($Ctx.State.choices.agentUserUpn) yet."
            }
            Guide = {
                param($Ctx)
                $c = $Ctx.State.choices
                @(
                    'Before you start: a billing policy with Windows 365 for Agents turned on must exist (Microsoft 365 admin center > Copilot > Cost management > classic Billing & usage > Billing policies; prerequisites page, section 0.1).',
                    '1. Open https://intune.microsoft.com > Devices > Provision Cloud PCs > Provisioning policies (Agents) > Create policy.',
                    '2. Choose that billing policy, the number of Cloud PCs (1 is enough for the lab) and the geography.',
                    "3. On the Agents page select Add Agents and choose the Foundry agent '$($c.agentName)' (agent user $($c.agentUserUpn)).",
                    '4. Choose the image.',
                    "5. Under Device grouping and preparation select the group '$($c.foundryDeviceGroup)'. Setup already assigned the Claims app to it.",
                    '6. Create the policy. Cloud PCs take a while to provision; the agent can work once one is ready.',
                    'Expected result: the policy''s Agents page lists the agent.'
                )
            }
            Confirm = {
                param($Ctx)
                if (-not $Ctx.State.found.poolReadError) { return }
                Write-LabWarn "Setup could not read the pool itself ($($Ctx.State.found.poolReadError))."
                Write-LabWarn "Check in the Intune admin center instead: Devices > Provision Cloud PCs > Provisioning policies (Agents) > your policy > Agents must list '$($Ctx.State.choices.agentName)'."
                if (Confirm-Lab 'Does the policy list the agent?') {
                    $Ctx.State.found.foundryPoolConfirmedAt = (Get-Date).ToUniversalTime().ToString('o')
                    if ($Ctx.RanThisRun) { $Ctx.RanThisRun['foundry-pool-confirmed'] = $true }
                    $id = [string](Read-Host '  Pool ID, only if you have it (used for the optional availability check; press Enter to skip)')
                    if ($id.Trim() -match '^[0-9a-fA-F-]{36}$') { Set-LabFound $Ctx.State 'foundryPoolId' $id.Trim() }
                }
            }
        })

    $stages.Add(@{
            Id = 'foundry-enable'; When = 'foundry'; Kind = 'auto'; Settle = 300
            Title = 'Turn the Foundry agent on'
            Purpose = 'Deploys a new version with the four identity IDs read from the tenant and both execution gates on. Asks for your explicit yes.'
            Who = 'You, as the environment owner (Foundry User on the project)'
            Plan = { param($Ctx) 'Run Deploy-FoundryAgent.ps1 -DeployVersion with LIVE_EXECUTION_APPROVED=yes, CLAIMS_EXECUTION_APPROVED=yes, CLAIMS_TENANT_ID, CLAIMS_BLUEPRINT_ID, CLAIMS_AGENT_ID and CLAIMS_AGENT_USER_ID, pinned to the built image.' }
            Check = {
                param($Ctx)
                $f = $Ctx.State.found; $Ctx.State.found.foundryEnabled = $false
                $r = Get-LabFoundryAgent $Ctx.State
                if (-not $r.Ok) { return (New-LabResult $false 'The agent cannot be read yet.') }
                $v = $r.Json.versions.latest; $ev = $v.definition.environment_variables
                $why = @()
                if ($ev.LIVE_EXECUTION_APPROVED -ne 'yes' -or $ev.CLAIMS_EXECUTION_APPROVED -ne 'yes') { $why += 'execution gates are off' }
                if ($ev.CLAIMS_TENANT_ID -ne $Ctx.State.choices.tenantId -or $ev.CLAIMS_BLUEPRINT_ID -ne $f.blueprintId -or $ev.CLAIMS_AGENT_ID -ne $f.agentIdentityId -or $ev.CLAIMS_AGENT_USER_ID -ne $f.agentUserId) { $why += 'identity IDs differ from the tenant' }
                if (-not ([string]$v.definition.container_configuration.image).EndsWith("@$($f.imageDigest)")) { $why += 'it runs a different image' }
                if ([string]$v.status -ne 'active') { $why += "latest version is '$($v.status)'" }
                if ($why.Count) { return (New-LabResult $false ("Not on yet: " + ($why -join '; '))) }
                $Ctx.State.found.foundryEnabled = $true
                New-LabResult $true "version $($v.version) active with execution on"
            }
            Apply = {
                param($Ctx)
                if (-not ($Ctx.RanThisRun -and ($Ctx.RanThisRun['foundry-pool'] -or $Ctx.RanThisRun['foundry-pool-confirmed']))) {
                    # Turning the agent on needs the pool confirmed now, not only on an earlier run.
                    Write-LabWarn "Setup could not read the Cloud PC pool during this run. In the Intune admin center check Devices > Provision Cloud PCs > Provisioning policies (Agents) > your policy > Agents: it must list '$($Ctx.State.choices.agentName)'."
                    if (-not (Confirm-Lab 'Does the policy list the agent now?')) { throw 'The Cloud PC pool was not confirmed during this run, so the agent stays off.' }
                    $Ctx.RanThisRun['foundry-pool-confirmed'] = $true
                }
                Write-LabWarn 'Turning the agent on lets it take a Cloud PC from its pool and file synthetic claims in the Claims app when a presenter transfers a call in Zava.'
                Write-LabWarn 'The next stage then sets FOUNDRY_CLAIMS_READY=1 so Zava offers Foundry transfers. To stop it later without a redeploy, set FOUNDRY_CLAIMS_READY=0 (docs\install\07-handoff-and-zava.md step 6.2).'
                if (-not (Confirm-Lab 'Turn the Foundry agent on?')) { throw 'You chose to keep the Foundry agent off. Run setup again when you want to turn it on.' }
                Invoke-LabFoundryDeploy -Ctx $Ctx -Enabled -DeployVersion
            }
            NextAction = 'Read the message above, then run setup again.'
        })
    return $stages
}
