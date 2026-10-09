<#
.SYNOPSIS
    Install-Lab stages for the Copilot Studio (MCS) path. Checks read the live tenant and
    Dataverse; applies reuse the existing helper scripts. Portal-only work is a guided stop.
    Keep this file ASCII-only.
#>

function Invoke-LabDataverse {
    param([Parameter(Mandatory)][hashtable]$State, [string]$Method = 'GET', [Parameter(Mandatory)][string]$Path, $Body, [string[]]$Headers = @())
    $org = $State.choices.dataverseUrl
    if (-not $org) { throw 'The Power Platform environment is not chosen yet.' }
    Invoke-LabRest -Method $Method -Url "$org/api/data/v9.2/$Path" -Resource $org -Body $Body -Headers (@('OData-Version=4.0') + $Headers)
}

function Get-LabGroupId([string]$Name) {
    $g = @(Get-LabAzJson @('ad', 'group', 'list', '--filter', "displayName eq '$Name'"))
    if ($g.Count -eq 1) { return [string]$g[0].id }
    return $null
}

function Test-LabIntuneAssignment {
    # $true / $false from Intune, or $null when this sign-in may not read Intune apps.
    param([Parameter(Mandatory)][string]$AppName, [Parameter(Mandatory)][string]$GroupId)
    $r = Invoke-LabRest -Url "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps?`$filter=displayName eq '$AppName'&`$expand=assignments"
    if (-not $r.Ok) { return $null }
    foreach ($app in @($r.Json.value)) {
        if (@($app.assignments) | Where-Object { $_.target.groupId -eq $GroupId }) { return $true }
    }
    return $false
}

function Get-LabIntuneStageResult([hashtable]$Ctx, [string]$StageId, [string]$AppName, [string]$GroupName) {
    $gid = Get-LabGroupId $GroupName
    if (-not $gid) { return (New-LabResult $false "Group $GroupName does not exist yet.") }
    $assigned = Test-LabIntuneAssignment -AppName $AppName -GroupId $gid
    if ($assigned -eq $true) { return (New-LabResult $true "$AppName is assigned to $GroupName") }
    if ($assigned -eq $false) { return (New-LabResult $false "$AppName is not assigned to $GroupName yet.") }
    # This sign-in may not read Intune apps.
    if ($Ctx.RanThisRun -and $Ctx.RanThisRun[$StageId]) { return (New-LabResult $true "Group $GroupName exists; the Intune helper confirmed the assignment during this run.") }
    if ($Ctx.State.runs[$StageId]) { return (New-LabEarlierResult "Group $GroupName exists; the Intune assignment cannot be read with this sign-in. The Intune helper confirmed it on $($Ctx.State.runs[$StageId].atUtc).") }
    New-LabResult $false "Group $GroupName exists; the Claims app assignment is not confirmed yet."
}

$script:RdpAppId = 'a4a365df-50f1-4397-bc59-1a1564b8bb9c'

function Get-LabRdpState([string]$GroupId) {
    # $true / $false when the remote desktop settings can be read; $null when this sign-in may not.
    $base = "https://graph.microsoft.com/v1.0/servicePrincipals(appId='$script:RdpAppId')/remoteDesktopSecurityConfiguration"
    $cfg = Invoke-LabRest -Url $base
    if ($cfg.NotFound) { return $false }
    if (-not $cfg.Ok) { return $null }
    if (-not $cfg.Json.isRemoteDesktopProtocolEnabled) { return $false }
    $targets = Invoke-LabRest -Url "$base/targetDeviceGroups"
    if (-not $targets.Ok) { return $null }
    return [bool](@($targets.Json.value) | Where-Object { $_.id -eq $GroupId })
}

$script:LabPrivileges = @(
    @{ Table = 'TRIGGER'; Types = @('Create', 'Read', 'Write') },
    @{ Table = 'flowsession'; Types = @('Read') },
    @{ Table = 'flowlog'; Types = @('Read') },
    @{ Table = 'flowsessionbinary'; Types = @('Read') },
    @{ Table = 'conversationtranscript'; Types = @('Read') }
)
$script:LabRoleName = 'Zava Handoff Service'

function Get-LabRootBusinessUnit([hashtable]$State) {
    $r = Invoke-LabDataverse -State $State -Path 'businessunits?$select=businessunitid&$filter=_parentbusinessunitid_value eq null'
    if (-not $r.Ok -or -not @($r.Json.value).Count) { throw "Could not read the environment's root business unit: $($r.Message)" }
    return [string]@($r.Json.value)[0].businessunitid
}

function Get-LabAppUser([hashtable]$State) {
    $appId = $State.found.handoffClientId
    $r = Invoke-LabDataverse -State $State -Path "systemusers?`$select=systemuserid,applicationid&`$filter=applicationid eq $appId&`$expand=systemuserroles_association(`$select=roleid,name)"
    if (-not $r.Ok) { throw "Could not read application users in Dataverse: $($r.Message)" }
    return @($r.Json.value) | Select-Object -First 1
}

function Get-LabRequiredPrivileges([hashtable]$State, [string]$BusinessUnitId) {
    # The exact privileges the handoff service needs, read from each table's own metadata.
    $privs = @()
    foreach ($p in $script:LabPrivileges) {
        $table = if ($p.Table -eq 'TRIGGER') { "$($State.choices.publisherPrefix)_claimrequest" } else { $p.Table }
        $meta = Invoke-LabDataverse -State $State -Path "EntityDefinitions(LogicalName='$table')?`$select=LogicalName,Privileges"
        if (-not $meta.Ok) { throw "Could not read the privileges of table $table`: $($meta.Message)" }
        foreach ($t in $p.Types) {
            $pv = @($meta.Json.Privileges) | Where-Object { [string]$_.PrivilegeType -eq $t } | Select-Object -First 1
            if (-not $pv) { throw "Table $table has no $t privilege to grant." }
            $privs += @{ Depth = 'Global'; PrivilegeId = $pv.PrivilegeId; BusinessUnitId = $BusinessUnitId; PrivilegeName = $pv.Name; Label = "$t $table" }
        }
    }
    return $privs
}

function Get-LabRolePrivilegeDiff([hashtable]$State, [string]$RoleId, [object[]]$Required) {
    $r = Invoke-LabDataverse -State $State -Path "roles($RoleId)/Microsoft.Dynamics.CRM.RetrieveRolePrivilegesRole()"
    if (-not $r.Ok) { throw "Could not read the security role's privileges: $($r.Message)" }
    $all = @($r.Json.RolePrivileges)
    $global = @($all | Where-Object { [string]$_.Depth -eq 'Global' } | ForEach-Object { [string]$_.PrivilegeId })
    $wanted = @($Required | ForEach-Object { [string]$_.PrivilegeId })
    [pscustomobject]@{
        Missing = @($Required | Where-Object { $global -notcontains [string]$_.PrivilegeId } | ForEach-Object { $_.Label })
        Extra   = @($all | Where-Object { $wanted -notcontains [string]$_.PrivilegeId } | ForEach-Object { if ($_.PrivilegeName) { [string]$_.PrivilegeName } else { [string]$_.PrivilegeId } })
    }
}

function Get-LabExtraAccessMessage([hashtable]$State, $User, $Diff) {
    $others = @($User.systemuserroles_association | Where-Object { $_.name -ne $script:LabRoleName } | ForEach-Object { $_.name })
    $why = @()
    if ($others.Count) { $why += "the handoff service's application user also has the role(s) $($others -join ', ')" }
    if ($Diff -and $Diff.Extra.Count) { $why += "the role '$($script:LabRoleName)' also grants $($Diff.Extra -join ', ')" }
    if (-not $why.Count) { return $null }
    "More access than the handoff service needs: $($why -join '; and '). Setup does not remove access. Review it in the Power Platform admin center > environment $($State.choices.ppEnvironmentName) > Settings > Users + permissions (Application users, Security roles), remove what is not needed, then run setup again."
}

function Install-LabAppUser([hashtable]$State) {
    # Least-privilege role: create/read/write the trigger table, read the Computer Use run logs.
    $bu = Get-LabRootBusinessUnit $State
    $required = @(Get-LabRequiredPrivileges $State $bu)
    $role = @((Invoke-LabDataverse -State $State -Path "roles?`$select=roleid,name&`$filter=name eq '$($script:LabRoleName)' and _businessunitid_value eq $bu").Json.value) | Select-Object -First 1
    $user = Get-LabAppUser $State
    if ($role -or $user) {
        $diff = if ($role) { Get-LabRolePrivilegeDiff $State $role.roleid $required } else { $null }
        $extra = Get-LabExtraAccessMessage $State $user $diff
        if ($extra) { throw $extra }
    }
    if (-not $role) {
        $r = Invoke-LabDataverse -State $State -Method POST -Path 'roles' -Body @{ name = $script:LabRoleName; 'businessunitid@odata.bind' = "/businessunits($bu)" } -Headers @('Prefer=return=representation')
        if (-not $r.Ok) { throw "Could not create the security role: $($r.Message)" }
        $role = $r.Json
        Write-LabGood "Created security role '$($script:LabRoleName)'."
    }
    $privs = @($required | ForEach-Object { @{ Depth = $_.Depth; PrivilegeId = $_.PrivilegeId; BusinessUnitId = $_.BusinessUnitId; PrivilegeName = $_.PrivilegeName } })
    $r = Invoke-LabDataverse -State $State -Method POST -Path "roles($($role.roleid))/Microsoft.Dynamics.CRM.AddPrivilegesRole" -Body @{ Privileges = $privs }
    if (-not $r.Ok) { throw "Could not add privileges to the security role: $($r.Message)" }

    $user = Get-LabAppUser $State
    if (-not $user) {
        $r = Invoke-LabDataverse -State $State -Method POST -Path 'systemusers' -Body @{ applicationid = $State.found.handoffClientId; 'businessunitid@odata.bind' = "/businessunits($bu)" } -Headers @('Prefer=return=representation')
        if (-not $r.Ok) { throw "Could not create the Dataverse application user: $($r.Message)" }
        $user = $r.Json
        Write-LabGood 'Created the Dataverse application user for the handoff service.'
    }
    if (-not (@($user.systemuserroles_association) | Where-Object { $_.roleid -eq $role.roleid })) {
        $r = Invoke-LabDataverse -State $State -Method POST -Path "systemusers($($user.systemuserid))/systemuserroles_association/`$ref" -Body @{ '@odata.id' = "$($State.choices.dataverseUrl)/api/data/v9.2/roles($($role.roleid))" }
        if (-not $r.Ok) { throw "Could not give the application user its role: $($r.Message)" }
    }
}

function Find-LabMcsAgent([hashtable]$State) {
    $name = $State.choices.mcsAgentName.Replace("'", "''")
    $r = Invoke-LabDataverse -State $State -Path "bots?`$select=botid,name,schemaname,publishedon&`$filter=name eq '$name'"
    if (-not $r.Ok) { throw "Could not read Copilot Studio agents: $($r.Message)" }
    return @($r.Json.value)
}

function Get-LabMcsFlowCheck([hashtable]$State) {
    $table = "$($State.choices.publisherPrefix)_claimrequest"
    $r = Invoke-LabDataverse -State $State -Path 'workflows?$select=workflowid,name,statecode,clientdata&$filter=category eq 5'
    if (-not $r.Ok) { throw "Could not read cloud flows: $($r.Message)" }
    $match = @($r.Json.value | Where-Object {
            $d = [string]$_.clientdata
            $d -like "*$table*" -and $d -like '*ExecuteCopilot*' -and $d -like '*handoffreceipt*' -and ($d -like "*$($State.found.mcsBotSchema)*" -or $d -like "*$($State.found.mcsBotId)*")
        })
    if (-not $match.Count) { return (New-LabResult $false 'No trigger flow for this agent and table was found yet.') }
    $on = @($match | Where-Object { [int]$_.statecode -eq 1 })
    if (-not $on.Count) { return (New-LabResult $false "The flow '$($match[0].name)' exists but is turned off.") }
    New-LabResult $true "Flow '$($on[0].name)' is on"
}

function Get-LabMcsStages {
    $stages = New-Object System.Collections.Generic.List[hashtable]

    $stages.Add(@{
            Id = 'tenant-prep'; When = 'mcs'; Kind = 'admin'
            Title = 'Prepare the tenant for Copilot Studio Cloud PCs'
            Purpose = 'Turns on Microsoft Entra authentication for remote desktop and creates the dynamic device group that hides the consent prompt and receives the Claims app.'
            Who = 'Global Administrator (signs in when asked)'
            Plan = { param($Ctx) "Run scripts\Enable-W365aPrereqs.ps1 -CreateDynamicGroup (group '$($Ctx.State.choices.mcsDeviceGroup)'). It reads first and changes only what is missing. Needs Microsoft Entra ID P1." }
            Check = {
                param($Ctx)
                $gid = Get-LabGroupId $Ctx.State.choices.mcsDeviceGroup
                if (-not $gid) { return (New-LabResult $false "Dynamic group $($Ctx.State.choices.mcsDeviceGroup) does not exist yet.") }
                $rdp = Get-LabRdpState $gid
                if ($rdp -eq $true) { return (New-LabResult $true 'Remote desktop sign-in is on and the group hides the consent prompt') }
                if ($rdp -eq $false) { return (New-LabResult $false 'Remote desktop sign-in or the group''s consent setting is not in place yet.') }
                if ($Ctx.RanThisRun -and $Ctx.RanThisRun['tenant-prep']) { return (New-LabResult $true 'Group exists; the tenant script confirmed the remote desktop settings during this run.') }
                if ($Ctx.State.runs['tenant-prep']) { return (New-LabEarlierResult "Group exists; the remote desktop settings need a Global Administrator to read. The tenant script confirmed them on $($Ctx.State.runs['tenant-prep'].atUtc).") }
                New-LabResult $false 'The group exists; the remote desktop settings have not been confirmed yet.'
            }
            Apply = {
                param($Ctx)
                $a = @{ TenantId = $Ctx.State.choices.tenantId; CreateDynamicGroup = $true; DynamicGroupName = $Ctx.State.choices.mcsDeviceGroup }
                if ($Ctx.DeviceCode) { $a.DeviceCode = $true }
                Invoke-LabScript 'scripts\Enable-W365aPrereqs.ps1' $a | Out-Null
                Add-LabRun $Ctx.State 'tenant-prep' 'Enable-W365aPrereqs.ps1 -CreateDynamicGroup'
            }
            NextAction = 'This needs a Global Administrator. Ask one to run setup again on this computer and sign in when the Microsoft Graph window opens.'
        })

    $stages.Add(@{
            Id = 'mcs-claims-app'; When = 'mcs'; Kind = 'admin'
            Title = 'Deliver the Claims app to Copilot Studio Cloud PCs'
            Purpose = 'Uploads the committed Claims app package to Intune and assigns it as Required to the Copilot Studio device group. Also creates the presenter group.'
            Who = 'Intune Administrator (signs in when asked)'
            Plan = { param($Ctx) "Run scripts\Deploy-DemoEnvironment.ps1 for device group '$($Ctx.State.choices.mcsDeviceGroup)' and presenter group '$($Ctx.State.choices.presenterGroup)'." }
            Check = { param($Ctx) Get-LabIntuneStageResult $Ctx 'mcs-claims-app' 'Zava Claims Workstation' $Ctx.State.choices.mcsDeviceGroup }
            Apply = {
                param($Ctx)
                $c = $Ctx.State.choices
                $a = @{ TenantId = $c.tenantId; DeviceGroupName = $c.mcsDeviceGroup; UserGroupName = $c.presenterGroup }
                if ($Ctx.DeviceCode) { $a.DeviceCode = $true }
                Invoke-LabScript 'scripts\Deploy-DemoEnvironment.ps1' $a | Out-Null
                Add-LabRun $Ctx.State 'mcs-claims-app' $c.mcsDeviceGroup
            }
            NextAction = 'This needs an Intune Administrator. Ask one to run setup again on this computer and sign in when the Intune sign-in window opens.'
        })

    $stages.Add(@{
            Id = 'mcs-shortcut'; When = 'mcs'; Kind = 'admin'
            Title = 'Add the agent launch icon to Copilot Studio Cloud PCs'
            Purpose = 'A small separate Intune app puts the "Zava Claims Agent Launch" icon on the Cloud PC desktop; the agent double-clicks it to start Claims.'
            Who = 'Intune Administrator (uses the Azure CLI sign-in)'
            Plan = { param($Ctx) "Run scripts\Deploy-McsAgentShortcut.ps1 -UseAzureCliToken for group '$($Ctx.State.choices.mcsDeviceGroup)'. It depends on the Claims app above." }
            Check = { param($Ctx) Get-LabIntuneStageResult $Ctx 'mcs-shortcut' 'Zava Claims Agent Launch Shortcut' $Ctx.State.choices.mcsDeviceGroup }
            Apply = {
                param($Ctx)
                $c = $Ctx.State.choices
                Invoke-LabScript 'scripts\Deploy-McsAgentShortcut.ps1' @{ TenantId = $c.tenantId; UseAzureCliToken = $true; GroupName = $c.mcsDeviceGroup } | Out-Null
                Add-LabRun $Ctx.State 'mcs-shortcut' $c.mcsDeviceGroup
            }
            NextAction = 'This needs an Intune Administrator signed in to the Azure CLI on this computer (az login --tenant <tenant>). Then run setup again.'
        })

    $stages.Add(@{
            Id = 'mcs-environment'; When = 'mcs'; Kind = 'portal'
            Title = 'Power Platform environment with Dataverse'
            Purpose = 'Holds the Copilot Studio agent, its trigger table and the Computer Use run log.'
            Who = 'Power Platform Administrator'
            Plan = { param($Ctx) $(if ($Ctx.State.choices.ppEnvironmentId) { "Use environment $($Ctx.State.choices.ppEnvironmentName)." } else { 'Create an environment with Dataverse in the Power Platform admin center, then choose it.' }) }
            Check = {
                param($Ctx)
                $id = $Ctx.State.choices.ppEnvironmentId
                if (-not $id) { return (New-LabResult $false 'No environment chosen yet.') }
                $e = @(Get-LabPowerPlatformEnvironments | Where-Object { $_.Id -eq $id })
                if (-not $e.Count) { return (New-LabResult $false "Environment $($Ctx.State.choices.ppEnvironmentName) is not visible to this account, or has no Dataverse.") }
                $Ctx.State.choices.dataverseUrl = $e[0].OrgUrl
                New-LabResult $true "$($e[0].Name) ($($e[0].OrgUrl))"
            }
            Guide = {
                param($Ctx)
                @(
                    '1. Open the Power Platform admin center: https://admin.powerplatform.microsoft.com > Manage > Environments > New.',
                    '2. Give it a name, choose the region where the Copilot Studio Cloud PCs should run, and turn on "Add a Dataverse data store".',
                    '3. Save and wait until the environment shows Ready (often several minutes).',
                    'Expected result: the environment is listed with a Dataverse URL. Setup then asks you to choose it.'
                )
            }
            Confirm = { param($Ctx) if (@(Get-LabPowerPlatformEnvironments).Count) { Select-LabPowerPlatformEnvironment $Ctx.State } }
        })

    $stages.Add(@{
            Id = 'mcs-table'; When = 'mcs'; Kind = 'auto'
            Title = 'Create the Dataverse trigger table'
            Purpose = 'The handoff service writes one row per transfer; the new row starts the Copilot Studio agent.'
            Who = 'You (System Administrator in the environment)'
            Plan = { param($Ctx) "Run scripts\mcs\New-McsTriggerTable.ps1 -Apply to create table $($Ctx.State.choices.publisherPrefix)_claimrequest (skipped if it exists)." }
            Check = {
                param($Ctx)
                $t = "$($Ctx.State.choices.publisherPrefix)_claimrequest"
                $r = Invoke-LabDataverse -State $Ctx.State -Path "EntityDefinitions(LogicalName='$t')?`$select=LogicalName"
                if ($r.Ok) { return (New-LabResult $true "Table $t exists") }
                if ($r.NotFound) { return (New-LabResult $false "Table $t does not exist yet.") }
                throw "Could not read Dataverse: $($r.Message)"
            }
            Apply = { param($Ctx) Invoke-LabScript 'scripts\mcs\New-McsTriggerTable.ps1' @{ OrgUrl = $Ctx.State.choices.dataverseUrl; PublisherPrefix = $Ctx.State.choices.publisherPrefix; Apply = $true } | Out-Null }
            NextAction = 'This needs the System Administrator role in the environment. Ask an environment administrator to run setup again on this computer.'
        })

    $stages.Add(@{
            Id = 'mcs-app-user'; When = 'mcs'; Kind = 'auto'
            Title = 'Let the handoff service use Dataverse'
            Purpose = 'Adds the handoff service''s managed identity as a Dataverse application user with a narrow role: write trigger rows, read Computer Use progress.'
            Who = 'You (System Administrator in the environment)'
            Plan = { param($Ctx) "Create or reuse security role '$($script:LabRoleName)' (organization-wide Create/Read/Write on the trigger table; Read on flowsession, flowlog, flowsessionbinary, conversationtranscript) and an application user for the handoff service with only that role." }
            Check = {
                param($Ctx)
                $u = Get-LabAppUser $Ctx.State
                if (-not $u) { return (New-LabResult $false 'The handoff service is not a Dataverse application user yet.') }
                $role = @($u.systemuserroles_association) | Where-Object { $_.name -eq $script:LabRoleName } | Select-Object -First 1
                if (-not $role) { return (New-LabResult $false "The application user exists but does not have the '$($script:LabRoleName)' role.") }
                $diff = Get-LabRolePrivilegeDiff $Ctx.State $role.roleid @(Get-LabRequiredPrivileges $Ctx.State (Get-LabRootBusinessUnit $Ctx.State))
                $extra = Get-LabExtraAccessMessage $Ctx.State $u $diff
                if ($extra) { return (New-LabResult $false $extra) }
                if ($diff.Missing.Count) { return (New-LabResult $false "The role lacks: $($diff.Missing -join ', ').") }
                New-LabResult $true "Application user has only role '$($script:LabRoleName)', with exactly the required privileges"
            }
            Apply = { param($Ctx) Install-LabAppUser $Ctx.State }
            NextAction = { param($Ctx) "If this keeps failing, add the application user by hand: Power Platform admin center > environment $($Ctx.State.choices.ppEnvironmentName) > Settings > Users + permissions > Application users > New app user, application ID $($Ctx.State.found.handoffClientId), with a role holding the permissions listed in docs\install\05-mcs-path.md step 4.2. Then run setup again." }
        })

    $stages.Add(@{
            Id = 'mcs-agent'; When = 'mcs'; Kind = 'portal'
            Title = 'Create the Copilot Studio agent and its Computer use tool'
            Purpose = 'Copilot Studio has no supported way to create this agent from a script, so this is a short portal step. Setup writes the instructions and publishes it next.'
            Who = 'A Copilot Studio maker in the environment (this account will own the Computer use connection)'
            Plan = { param($Ctx) "Portal: create agent '$($Ctx.State.choices.mcsAgentName)' with a Computer use tool on a new Cloud PC pool." }
            Check = {
                param($Ctx)
                $bots = @(Find-LabMcsAgent $Ctx.State)
                if (-not $bots.Count) { return (New-LabResult $false "No agent named '$($Ctx.State.choices.mcsAgentName)' in $($Ctx.State.choices.ppEnvironmentName) yet.") }
                if ($bots.Count -gt 1) { return (New-LabResult $false "$($bots.Count) agents are named '$($Ctx.State.choices.mcsAgentName)'. Rename the extra ones.") }
                $bot = $bots[0]
                $comps = Invoke-LabDataverse -State $Ctx.State -Path "botcomponents?`$select=botcomponentid,data&`$filter=_parentbotid_value eq $($bot.botid)"
                if (-not (@($comps.Json.value) | Where-Object { [string]$_.data -like '*InvokeComputerUsingAgentTaskAction*' })) { return (New-LabResult $false 'The agent exists but has no Computer use tool yet.') }
                Set-LabFound $Ctx.State 'mcsBotId' $bot.botid
                Set-LabFound $Ctx.State 'mcsBotSchema' $bot.schemaname
                New-LabResult $true "$($bot.name) ($($bot.schemaname))"
            }
            Guide = {
                param($Ctx)
                $c = $Ctx.State.choices
                @(
                    'An administrator must first have: turned on Computer use with Cloud PC for this environment (Power Platform admin center > Copilot > Settings > Computer Use), and allowed Anthropic models (prerequisites page, section 0.2).',
                    "1. Open https://copilotstudio.microsoft.com and switch to environment: $($c.ppEnvironmentName)",
                    "2. Create a new agent and name it exactly: $($c.mcsAgentName)",
                    '3. In the agent''s settings: generative orchestration on; authentication "Authenticate with Microsoft" (the default). Computer use does not work without authentication.',
                    '4. Add a tool: Computer use. Under Machines choose Cloud PC pool and create a new pool. Leave Inputs empty. Type any placeholder in Instructions; setup replaces it. Save.',
                    '   The agent uses Claude Sonnet 4.6 and the Computer use tool Claude Sonnet 4.5 (docs\mcs-computer-use-instructions.md). Choose them if they are not already selected.',
                    '5. The pool takes about 30 minutes to provision. You can continue setup now.',
                    'Do not publish yet and do not paste instructions: setup writes the documented instructions and publishes next.',
                    'Expected result: the agent exists with one Computer use tool.'
                )
            }
        })

    $stages.Add(@{
            Id = 'mcs-instructions'; When = 'mcs'; Kind = 'auto'
            Title = 'Write the agent instructions and publish'
            Purpose = 'Applies the documented agent and Computer use instructions exactly (with backups), publishes, and reads them back.'
            Who = 'You (System Customizer or System Administrator in the environment)'
            Plan = { param($Ctx) 'Run scripts\mcs\publish_mcs_agent_config.py: a dry run first, then write the two documented texts and publish. Tool inputs stay empty.' }
            Check = {
                param($Ctx)
                if (-not $Ctx.State.found.mcsBotSchema) { return (New-LabResult $false 'Waiting for the agent.') }
                $r = Invoke-LabPython -Python $Ctx.Paths.VenvPython -Arguments @('scripts\mcs\publish_mcs_agent_config.py', '--org-url', $Ctx.State.choices.dataverseUrl, '--agent-schema', $Ctx.State.found.mcsBotSchema, '--dry-run')
                if ($r.Code -ne 0) { throw "The configuration helper could not read the agent: $(Get-LabShortText $r.Text)" }
                $text = $r.Text.Substring($r.Text.IndexOf('{'))
                $receipt = $text | ConvertFrom-Json
                $pending = @($receipt.components.PSObject.Properties | Where-Object { $_.Value -ne 'already as documented' })
                if ($pending.Count) { return (New-LabResult $false ("Not yet as documented: " + (($pending | ForEach-Object { $_.Name }) -join ', '))) }
                $bot = @(Find-LabMcsAgent $Ctx.State) | Select-Object -First 1
                if (-not $bot.publishedon) { return (New-LabResult $false 'The agent has not been published yet.') }
                New-LabResult $true "Instructions as documented; published $($bot.publishedon)"
            }
            Apply = {
                param($Ctx)
                $r = Invoke-LabPython -Python $Ctx.Paths.VenvPython -Arguments @('scripts\mcs\publish_mcs_agent_config.py', '--org-url', $Ctx.State.choices.dataverseUrl, '--agent-schema', $Ctx.State.found.mcsBotSchema)
                Write-Host $r.Text
                if ($r.Code -ne 0) { throw "Applying the agent configuration failed: $(Get-LabShortText $r.Text)" }
            }
            NextAction = 'Backups of the previous texts are in scripts\mcs\backups. Read the message above; a common cause is a missing System Customizer role.'
        })

    $stages.Add(@{
            Id = 'mcs-flow'; When = 'mcs'; Kind = 'portal'
            Title = 'Create the trigger flow'
            Purpose = 'Starts the agent when the handoff service adds a row, and writes the result back to the same row. Flow connections need your own sign-in in the portal.'
            Who = 'The same Copilot Studio maker (owner of the Computer use connection)'
            Plan = { param($Ctx) 'Portal: one automated cloud flow (Dataverse trigger -> Execute Agent and wait -> Compose -> Update a row).' }
            Check = { param($Ctx) if (-not $Ctx.State.found.mcsBotId) { return (New-LabResult $false 'Waiting for the agent.') }; Get-LabMcsFlowCheck $Ctx.State }
            Guide = {
                param($Ctx)
                $c = $Ctx.State.choices; $p = $c.publisherPrefix
                @(
                    "1. Open https://make.powerautomate.com in environment $($c.ppEnvironmentName). Create > Automated cloud flow. Name: Zava claim request trigger.",
                    "2. Trigger: Microsoft Dataverse 'When a row is added, modified or deleted'. Change type: Added. Table name: Claim Requests ($($p)_claimrequest). Scope: Organization.",
                    "   Trigger settings > Trigger conditions: @not(empty(triggerBody()?['$($p)_handoffcontext']))",
                    "3. Add action: Microsoft Copilot Studio 'Execute Agent and wait'. Agent: $($c.mcsAgentName) ($($Ctx.State.found.mcsBotSchema)).",
                    "   Message (expression): triggerBody()?['$($p)_handoffcontext']",
                    "   Locale (expression): if(equals(json(triggerBody()?['$($p)_handoffcontext'])?['language'], 'ja'), 'ja-JP', 'en-US')",
                    "4. Add action: Compose, renamed Compose_receipt, with the expression from docs\install\05-mcs-path.md step 4.4 item 4.",
                    "5. Add action: Microsoft Dataverse 'Update a row'. Table: Claim Requests. Row ID (expression): triggerBody()?['$($p)_claimrequestid']. Handoff Receipt JSON (expression): string(outputs('Compose_receipt'))",
                    '6. Save. The flow is on after saving.',
                    'Expected result: the flow is listed under My flows and is On. Full reference: docs\install\05-mcs-path.md step 4.4.'
                )
            }
        })
    return $stages
}
