# Offline fakes for the Install-Lab tests. Nothing here signs in or reaches Microsoft.
#
# Use-LabCopy copies only the files setup reads into a temporary folder (an isolated starting
# point, as a fresh download would be) and dot-sources setup from there. Reset-LabFake creates
# an empty fake tenant in $global:F; the stub functions below read and change it the way the
# real services would.

$script:SourceRepo = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..')).Path

function New-LabCopy {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('lab-copy-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    foreach ($rel in 'scripts\DemoCommon.ps1', 'scripts\Install-Lab.ps1', 'scripts\demo-config.sample.json', 'deploy\foundry\foundry-agent.sample.json',
        'scripts\foundry-demo-prep\foundry-demo.config.template.json', 'apps\ccaas-agent-desktop\public\entra-config.sample.json', 'apps\ccaas-agent-desktop\public\region-config.sample.json') {
        $to = Join-Path $root $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
        Copy-Item -LiteralPath (Join-Path $script:SourceRepo $rel) -Destination $to
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'scripts\lab'), (Join-Path $root 'apps\ccaas-agent-desktop\src'), (Join-Path $root 'apps\ccaas-agent-desktop\api'), (Join-Path $root 'apps\handoff-orchestrator'), (Join-Path $root 'samples\foundry-hosted-claims') | Out-Null
    Copy-Item -Path (Join-Path $script:SourceRepo 'scripts\lab\*.ps1') -Destination (Join-Path $root 'scripts\lab')
    return $root
}

function Reset-LabFake {
    $global:F = @{
        T = '11111111-1111-1111-1111-111111111111'; S = '22222222-2222-2222-2222-222222222222'
        Calls = New-Object System.Collections.Generic.List[string]
        Scripts = New-Object System.Collections.Generic.List[object]
        Answers = New-Object System.Collections.Generic.Queue[string]
        Prompts = New-Object System.Collections.Generic.List[string]
        Fn = $false; Code = $true; Swa = $false; App = $null; Sp = $false; Settings = @{}; Cors = @()
        Groups = @{}; Intune = @{}; Table = $false; AppUser = $false; Bot = $false; Instructions = $false; Published = $false; PublishCalls = @(); AuthMode = 2; Flow = $false; Policies = @{}; DenyIntuneRead = $false; WebLinkRuns = @()
        Acc = $false; Proj = $false; Dep = $false; Acr = $false; Roles = @(); Digest = ''; Agent = $null; Identity = $false; Pool = $false
        Site = $null; Venv = $false; Deployed = @(); FailSwa = $false; DenyAppCreate = $false; ExistingSettings = @{}
    }
}

function Read-Host {
    param([Parameter(Position = 0)]$Prompt)
    $global:F.Prompts.Add([string]$Prompt)
    if ($global:F.Answers.Count -eq 0) { throw "Unexpected prompt: $Prompt" }
    return $global:F.Answers.Dequeue()
}

function Set-FakeAnswers([string[]]$Answers) { $global:F.Answers.Clear(); foreach ($a in $Answers) { $global:F.Answers.Enqueue($a) } }

function Fake-Ok($Object) { $global:LASTEXITCODE = 0; if ($null -ne $Object) { return (ConvertTo-Json -InputObject $Object -Depth 20) } }
function Fake-Missing { $global:LASTEXITCODE = 3; return 'ERROR: (ResourceNotFound) Not Found' }

function Get-FakeBody([object[]]$a) {
    $i = [array]::IndexOf($a, '--body'); if ($i -lt 0) { $i = [array]::IndexOf($a, '--settings') }
    if ($i -lt 0) { return $null }
    return (Get-Content -Raw -LiteralPath ([string]$a[$i + 1]).TrimStart('@') | ConvertFrom-Json -AsHashtable)
}

function Get-FakeArg([object[]]$a, [string]$Name) { $i = [array]::IndexOf($a, $Name); if ($i -ge 0) { return [string]$a[$i + 1] } }

function az {
    $a = @($args | ForEach-Object { [string]$_ })
    $j = $a -join ' '
    $global:F.Calls.Add($j)
    $F = $global:F
    switch -Regex ($j) {
        '^account show' { return (Fake-Ok @{ tenantId = $F.T; id = $F.S; user = @{ name = 'admin@contoso.onmicrosoft.com' } }) }
        '^account list-locations' { return (Fake-Ok @(@{ name = 'australiaeast' }, @{ name = 'eastus2' })) }
        '^account list' { return (Fake-Ok @(@{ id = $F.S; name = 'Lab subscription'; tenantId = $F.T; state = 'Enabled' }, @{ id = '33333333-3333-3333-3333-333333333333'; name = 'Other tenant'; tenantId = '44444444-4444-4444-4444-444444444444'; state = 'Enabled' })) }
        '^account set' { return (Fake-Ok $null) }
        '^login' { throw 'The test must not sign in.' }
        '^group exists' { $global:LASTEXITCODE = 0; return 'false' }
        '^resource list' { return (Fake-Ok @()) }
        '^functionapp show' { if ($F.Fn) { return (Fake-Ok @{ identity = @{ principalId = 'handoff-mi' }; defaultHostName = 'zava-handoff-x.azurewebsites.net' }) } else { return (Fake-Missing) } }
        '^functionapp config appsettings list' { return (Fake-Ok @($F.Settings.Keys | ForEach-Object { @{ name = $_; value = $F.Settings[$_] } })) }
        '^functionapp config appsettings set' { $b = Get-FakeBody $a; foreach ($k in $b.Keys) { $F.Settings[$k] = $b[$k] }; return (Fake-Ok $null) }
        '^functionapp cors show' { return (Fake-Ok @{ allowedOrigins = $F.Cors }) }
        '^ad sp show --id handoff-mi' { return (Fake-Ok @{ appId = 'handoff-app-id' }) }
        '^ad sp show' { if ($F.Sp) { return (Fake-Ok @{ id = 'sp' }) } else { return (Fake-Missing) } }
        '^ad sp create' { $F.Sp = $true; return (Fake-Ok $null) }
        '^staticwebapp show' { if ($F.Swa) { return (Fake-Ok @{ defaultHostname = 'calm-sea-1.azurestaticapps.net' }) } else { return (Fake-Missing) } }
        '^ad app list' { if ($F.DenyAppRead) { $global:LASTEXITCODE = 1; return 'ERROR: Forbidden (403): Authorization_RequestDenied' }; return (Fake-Ok @($(if ($F.App) { $F.App }))) }
        '^ad app show' { if ($F.App) { return (Fake-Ok $F.App) } else { return (Fake-Missing) } }
        '^ad app create' {
            if ($F.DenyAppCreate) { $global:LASTEXITCODE = 1; return 'ERROR: Insufficient privileges to complete the operation. Authorization_RequestDenied' }
            $F.App = @{ id = 'app-object'; appId = 'zava-client-id'; displayName = (Get-FakeArg $a '--display-name'); api = @{ oauth2PermissionScopes = @(); preAuthorizedApplications = @() }; spa = @{ redirectUris = @() }; identifierUris = @(); requiredResourceAccess = @() }
            return (Fake-Ok $F.App)
        }
        '^rest --method patch --url https://graph.microsoft.com/v1.0/applications/' { $b = Get-FakeBody $a; foreach ($k in $b.Keys) { $F.App[$k] = $b[$k] }; return (Fake-Ok $null) }
        'graph.microsoft.com/v1.0/domains' { return (Fake-Ok @{ value = @(@{ id = 'contoso.onmicrosoft.com'; isInitial = $true; isVerified = $true }) }) }
        'remoteDesktopSecurityConfiguration' { $global:LASTEXITCODE = 1; return 'ERROR: Forbidden (403): Authorization_RequestDenied' }
        '^ad group list' { $n = ([regex]::Match($j, "displayName eq '([^']+)'")).Groups[1].Value; if ($F.Groups.ContainsKey($n)) { return (Fake-Ok @(@{ id = $F.Groups[$n]; displayName = $n })) } else { return (Fake-Ok @()) } }
        'configurationPolicies\?' {
            if ($F.DenyIntuneRead) { $global:LASTEXITCODE = 1; return 'ERROR: Forbidden (403): Authorization_RequestDenied' }
            $n = ([regex]::Match($j, "name eq '([^']+)'")).Groups[1].Value
            return (Fake-Ok @{ value = @($F.Policies.Keys | Where-Object { $_ -eq $n } | ForEach-Object { @{ id = "pol-$_"; name = $_ } }) })
        }
        'configurationPolicies/pol-(.+)/settings' {
            $p = $F.Policies[$Matches[1]]
            $list = ConvertTo-Json -InputObject @(@{ url = $p.Url; create_desktop_shortcut = $true; default_launch_container = 'window' }) -Compress
            return (Fake-Ok @{ value = @(@{ settingInstance = @{ choiceSettingValue = @{ children = @(@{ simpleSettingCollectionValue = @(@{ value = $list }) }) } } }) })
        }
        'configurationPolicies/pol-(.+)/assignments' {
            $p = $F.Policies[$Matches[1]]
            return (Fake-Ok @{ value = @($p.Targets | ForEach-Object { @{ target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $_ } } }) })
        }
        'deviceAppManagement/mobileApps' {
            if ($F.DenyIntuneRead) { $global:LASTEXITCODE = 1; return 'ERROR: Forbidden (403): Authorization_RequestDenied' }
            $n = ([regex]::Match($j, "displayName eq '([^']+)'")).Groups[1].Value
            $assign = @($F.Intune[$n] | Where-Object { $_ } | ForEach-Object { @{ target = @{ groupId = $_ } } })
            return (Fake-Ok @{ value = @(@{ displayName = $n; assignments = $assign }) })
        }
        '^cognitiveservices account show' { if ($F.Acc) { return (Fake-Ok @{ properties = @{ customSubDomainName = 'zava-lab-sub'; provisioningState = 'Succeeded' } }) } else { return (Fake-Missing) } }
        '^cognitiveservices account create' { $F.Acc = $true; return }
        '^cognitiveservices account project show' { if ($F.Proj) { return (Fake-Ok @{ id = '/proj'; identity = @{ principalId = 'project-mi' } }) } else { return (Fake-Missing) } }
        '^cognitiveservices account project create' { $F.Proj = $true; return (Fake-Ok $null) }
        '^cognitiveservices account deployment show' { if ($F.Dep) { return (Fake-Ok @{ name = 'gpt-4.1-mini' }) } else { return (Fake-Missing) } }
        '^cognitiveservices account deployment create' { $F.Dep = $true; return (Fake-Ok $null) }
        '^acr show' { if ($F.Acr) { return (Fake-Ok @{ id = '/acr' }) } else { return (Fake-Missing) } }
        '^acr create' { $F.Acr = $true; return (Fake-Ok $null) }
        '^acr repository show' { if ($F.Digest -and $j -like "*@$($F.Digest)*") { return (Fake-Ok @{ digest = $F.Digest }) } else { return (Fake-Missing) } }
        '^role assignment list' { $who = Get-FakeArg $a '--assignee'; $scope = Get-FakeArg $a '--scope'; return (Fake-Ok @($F.Roles | Where-Object { $_.who -eq $who -and $_.scope -eq $scope } | ForEach-Object { @{ roleDefinitionName = $_.role } })) }
        '^role assignment create' { $F.Roles += @{ who = (Get-FakeArg $a '--assignee-object-id'); scope = (Get-FakeArg $a '--scope'); role = (Get-FakeArg $a '--role') }; return (Fake-Ok $null) }
        '^role definition list' { if ((Get-FakeArg $a '--name') -eq 'Foundry User') { return (Fake-Ok @(@{ roleName = 'Foundry User' })) } else { return (Fake-Ok @()) } }
        '^ad signed-in-user show' { return (Fake-Ok @{ id = 'me' }) }
        'services.ai.azure.com/api/projects/.*/agents/' { if ($F.Agent) { return (Fake-Ok $F.Agent) } else { return (Fake-Missing) } }
        default { throw "Unexpected az call in test: $j" }
    }
}

function Invoke-LabDataverse {
    param([hashtable]$State, [string]$Method = 'GET', [string]$Path, $Body, [string[]]$Headers)
    $F = $global:F
    $F.Calls.Add("dataverse $Method $Path")
    $ok = { param($o) [pscustomobject]@{ Ok = $true; Json = ($o | ConvertTo-Json -Depth 20 | ConvertFrom-Json); NotFound = $false; Denied = $false; Message = '' } }
    switch -Regex ("$Method $Path") {
        "^GET EntityDefinitions\(LogicalName='crcce_claimrequest'\)\?\`$select=LogicalName$" { if ($F.Table) { return (& $ok @{ LogicalName = 'crcce_claimrequest' }) } return [pscustomobject]@{ Ok = $false; NotFound = $true; Message = 'Not Found' } }
        '^GET EntityDefinitions\(LogicalName=''([a-z_]+)''\)\?\$select=LogicalName,Privileges' { return (& $ok @{ Privileges = @(@{ PrivilegeType = 'Create'; PrivilegeId = 'p-c'; Name = 'prvCreate' }, @{ PrivilegeType = 'Read'; PrivilegeId = 'p-r'; Name = 'prvRead' }, @{ PrivilegeType = 'Write'; PrivilegeId = 'p-w'; Name = 'prvWrite' }) }) }
        '^GET businessunits' { return (& $ok @{ value = @(@{ businessunitid = 'bu-1' }) }) }
        '^GET roles\?' { return (& $ok @{ value = @() }) }
        '^POST roles$' { return (& $ok @{ roleid = 'role-1' }) }
        '^POST roles\(role-1\)/Microsoft.Dynamics.CRM.AddPrivilegesRole' { $F.Privileges = $Body.Privileges; return (& $ok $null) }
        '^GET roles\(role-1\)/Microsoft.Dynamics.CRM.RetrieveRolePrivilegesRole' { return (& $ok @{ RolePrivileges = @($F.Privileges | ForEach-Object { @{ PrivilegeId = $_.PrivilegeId; Depth = 'Global' } }) }) }
        '^GET systemusers' { if ($F.AppUser) { return (& $ok @{ value = @(@{ systemuserid = 'u-1'; systemuserroles_association = @(@{ roleid = 'role-1'; name = 'Zava Handoff Service' }) }) }) } return (& $ok @{ value = @() }) }
        '^POST systemusers$' { return (& $ok @{ systemuserid = 'u-1'; systemuserroles_association = @() }) }
        '^POST systemusers\(u-1\)/systemuserroles_association' { $F.AppUser = $true; return (& $ok $null) }
        '^GET bots' { if ($F.Bot) { return (& $ok @{ value = @(@{ botid = 'bot-1'; name = 'Zava Claims Intake (CUA)'; schemaname = 'crcce_zava'; publishedon = $(if ($F.Published) { '2026-10-09T00:00:00Z' } else { $null }); authenticationmode = $F.AuthMode }) }) } return (& $ok @{ value = @() }) }
        '^GET botcomponents' { return (& $ok @{ value = @(@{ data = 'kind: TaskDialog action: kind: InvokeComputerUsingAgentTaskAction' }) }) }
        '^GET workflows' { if ($F.Flow) { return (& $ok @{ value = @(@{ name = 'Zava claim request trigger'; statecode = 1; clientdata = 'crcce_claimrequest ExecuteCopilotAsyncV2 crcce_handoffreceipt crcce_zava' }) }) } return (& $ok @{ value = @() }) }
        default { throw "Unexpected Dataverse call in test: $Method $Path" }
    }
}

function Get-LabPowerPlatformEnvironments { @([pscustomobject]@{ Id = 'env-1'; Name = 'Zava Lab'; OrgUrl = 'https://zavalab.crm6.dynamics.com'; Geo = 'australia' }) }

function Test-LabTools { @([pscustomobject]@{ Name = 'All tools'; Ok = $true; Found = 'stub'; Fix = '' }) }
function Get-LabMissingModules { @() }

function Invoke-LabWeb {
    param([string]$Url)
    $F = $global:F
    if ($Url -like '*/foundry-claims/availability') {
        if (-not $F.Code) { return [pscustomobject]@{ Status = 404; Json = $null; Content = '' } }
        $ready = $F.Settings.FOUNDRY_CLAIMS_READY -eq '1' -and $F.Settings.FOUNDRY_INVOCATIONS_URL
        return [pscustomobject]@{ Status = 200; Json = [pscustomobject]@{ configured = [bool]$F.Settings.FOUNDRY_INVOCATIONS_URL; ready = [bool]$ready; message = 'stub' }; Content = '' }
    }
    if (-not $F.Site) { return [pscustomobject]@{ Status = 404; Json = $null; Content = '' } }
    if ($Url -like '*/entra-config.json') { return [pscustomobject]@{ Status = 200; Json = [pscustomobject]$F.Site.Entra; Content = '' } }
    if ($Url -like '*/region-config.json') { if ($F.Site.Region) { return [pscustomobject]@{ Status = 200; Json = ($F.Site.Region | ConvertFrom-Json); Content = $F.Site.Region } }; return [pscustomobject]@{ Status = 404; Json = $null; Content = '' } }
    if ($Url -like '*/assets/*') { return [pscustomobject]@{ Status = 200; Json = $null; Content = "x=`"$($F.Site.Base)`"" } }
    return [pscustomobject]@{ Status = 200; Json = $null; Content = '<script type="module" src="/assets/index-abc.js"></script>' }
}

function New-DemoHandoffOrchestrator { param($Config, $RepoRoot) $global:F.Calls.Add('New-DemoHandoffOrchestrator'); $global:F.Fn = $true; $global:F.Code = $true }

function New-DemoStaticWebApp {
    param($Config, $RepoRoot, $OrchestratorUrl, $FoundryOrchestratorUrl, $DefaultBackend, [switch]$ResourceOnly)
    $F = $global:F
    if ($F.FailSwa) { throw 'Static Web Apps is not available in this subscription.' }
    if ($ResourceOnly) { $F.Calls.Add('New-DemoStaticWebApp -ResourceOnly'); $F.Swa = $true; return }
    $F.Calls.Add("New-DemoStaticWebApp build mcs=$OrchestratorUrl foundry=$FoundryOrchestratorUrl default=$DefaultBackend")
    $F.BuildEnv = @{ VITE_CUA_RUN_BASE_URL = $env:VITE_CUA_RUN_BASE_URL; VITE_AZURE_CLIENT_ID = $env:VITE_AZURE_CLIENT_ID; VITE_AZURE_TENANT_ID = $env:VITE_AZURE_TENANT_ID; VITE_AZURE_REDIRECT_URI = $env:VITE_AZURE_REDIRECT_URI }
    $entra = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'apps\ccaas-agent-desktop\public\entra-config.json') | ConvertFrom-Json
    $regionFile = Join-Path $RepoRoot 'apps\ccaas-agent-desktop\public\region-config.json'
    $F.Site = @{ Entra = @{ clientId = $entra.clientId; tenantId = $entra.tenantId }; Base = $env:VITE_CUA_RUN_BASE_URL; Region = $(if (Test-Path $regionFile) { Get-Content -Raw $regionFile }) }
}

function Set-DemoHandoffOrchestratorCors { param($FunctionAppName, $ResourceGroup, $AllowedOrigin) $global:F.Cors += $AllowedOrigin }

function Invoke-LabScript {
    param([string]$RelativePath, [hashtable]$Arguments = @{})
    $F = $global:F
    $F.Scripts.Add([pscustomobject]@{ Path = $RelativePath; Args = $Arguments.Clone() })
    switch -Wildcard ($RelativePath) {
        '*Enable-W365aPrereqs.ps1' { $F.Groups[$Arguments.DynamicGroupName] = 'g-mcs' }
        '*Deploy-DemoEnvironment.ps1' {
            if ($Arguments.Phase -eq 'WebLink') {
                # The real helper deletes a same-named policy and recreates it; record that it ran.
                $F.WebLinkRuns += , $Arguments.Clone()
                $F.Policies[$Arguments.CcaasWebLinkName] = @{ Url = $Arguments.CcaasWebLinkUrl; Targets = @($F.Groups[$Arguments.UserGroupName]) }
                return
            }
            $gid = if ($F.Groups.ContainsKey($Arguments.DeviceGroupName)) { $F.Groups[$Arguments.DeviceGroupName] } else { 'g-' + $F.Groups.Count }
            $F.Groups[$Arguments.DeviceGroupName] = $gid
            $F.Groups[$Arguments.UserGroupName] = 'g-presenters'
            $F.Intune['Zava Claims Workstation'] = @($F.Intune['Zava Claims Workstation']) + $gid
        }
        '*Deploy-McsAgentShortcut.ps1' { $F.Intune['Zava Claims Agent Launch Shortcut'] = @($F.Groups[$Arguments.GroupName]) }
        '*New-McsTriggerTable.ps1' { $F.Table = $true }
        '*Deploy-FoundryAgent.ps1' {
            $cfg = Get-Content -Raw -LiteralPath $Arguments.ConfigPath | ConvertFrom-Json
            if ($Arguments.BuildImage) {
                $F.Digest = 'sha256:' + ('a' * 64)
                $cfg.imageDigest = $F.Digest
                $cfg | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Arguments.ConfigPath
            }
            if ($Arguments.DeployVersion) {
                $F.Deployed += , ($cfg.hostedAgent.environmentVariables | ConvertTo-Json | ConvertFrom-Json -AsHashtable)
                $n = $F.Deployed.Count
                $F.Agent = @{
                    instance_identity = @{ client_id = 'agent-identity' }
                    agent_endpoint = $(if ($F.Agent) { $F.Agent.agent_endpoint } else { $null })
                    versions = @{ latest = @{ version = "$n"; status = 'active'; definition = @{ container_configuration = @{ image = "zavalab.azurecr.io/claims-w365@$($cfg.imageDigest)" }; environment_variables = $F.Deployed[-1] } } }
                }
            }
            if ($Arguments.ConfigureEndpoint) { $F.Agent.agent_endpoint = @{ protocol_configuration = @{ invocations = @{} }; authorization_schemes = @(@{ type = 'Entra' }) } }
        }
        '*Set-FoundryAgentIdentity.ps1' {
            if ($Arguments.Apply) { $F.Identity = $true }
            return [pscustomobject]@{ TenantId = $Arguments.TenantId; BlueprintId = 'blueprint-app'; AgentId = 'agent-identity'; AgentUserId = $(if ($F.Identity) { 'agent-user' } else { '' }); Changes = $(if ($F.Identity) { @() } else { @('Create agent user', 'Grant tenant-wide consent for Computer.See') }); Applied = [bool]$Arguments.Apply }
        }
        default { throw "Unexpected helper script in test: $RelativePath" }
    }
}

function Find-LabPython { [pscustomobject]@{ Exe = 'Fake-Python'; Prefix = @(); Version = '3.12' } }
function Fake-Python { $p = Join-Path $args[-1] 'Scripts\python.exe'; New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null; Set-Content -LiteralPath $p -Value 'stub'; $global:LASTEXITCODE = 0 }

function Invoke-LabPython {
    param([string]$Python, [string[]]$Arguments)
    $F = $global:F
    $j = $Arguments -join ' '
    $F.Calls.Add("python $j")
    if ($j -like '-m pip install*') { $F.Venv = $true; return [pscustomobject]@{ Code = 0; Text = '' } }
    if ($j -like '-c import*') { return [pscustomobject]@{ Code = $(if ($F.Venv) { 0 } else { 1 }); Text = '' } }
    if ($j -like '*publish_mcs_agent_config.py*') {
        # Mirrors the real helper: a dry run reports texts and publication; a write saves the
        # texts and then publishes; --publish-only publishes only when something is unpublished.
        $pending = -not $F.Published
        if ($j -match '--published-after (\S+)' -and $F.Published -and $F.PublishedAt -and $F.PublishedAt -lt $Matches[1]) { $pending = $true }
        $publication = @{ publishedon = $(if ($F.Published) { $F.PublishedAt }); latest_change = '2026-10-08T00:00:00Z'; unpublished_changes = $pending }
        $comp = if ($F.Instructions) { @{ agent = 'already as documented'; tool = 'already as documented' } } else { @{ agent = @{ will_change = @('instructions') }; tool = @{ will_change = @('action.instructions') } } }
        if ($j -like '*--dry-run*') { return [pscustomobject]@{ Code = 0; Text = (@{ agent = 'x'; components = $comp; publication = $publication } | ConvertTo-Json -Depth 5) } }
        if ($j -like '*--publish-only*') {
            if (-not $F.Instructions) { return [pscustomobject]@{ Code = 1; Text = '--publish-only: the texts differ from the document' } }
            if (-not $pending) { return [pscustomobject]@{ Code = 0; Text = '{"published": "not needed"}' } }
        }
        else { $F.Instructions = $true }
        if ($F.FailPublishOnce) { $F.FailPublishOnce = $false; return [pscustomobject]@{ Code = 1; Text = 'Dataverse POST bots(bot-1)/Microsoft.Dynamics.CRM.PvaPublish failed: HTTP 500' } }
        $F.PublishCalls += $j
        $F.Published = $true; $F.PublishedAt = (Get-Date).ToUniversalTime().AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ssZ')
        return [pscustomobject]@{ Code = 0; Text = '{"published": true}' }
    }
    throw "Unexpected python call in test: $j"
}

function Invoke-LabGraphPs {
    param([string]$Uri, [string]$TenantId, [string[]]$Scopes, [switch]$DeviceCode)
    if ($Uri -like '*configurationPolicies*') { throw 'Graph PowerShell sign-in refused (offline test).' }
    if ($Uri -like '*/assignments') { return [pscustomobject]@{ value = @($(if ($global:F.Pool) { @{ userPrincipalId = 'agent-user' } })) } }
    return [pscustomobject]@{ value = @([pscustomobject]@{ id = 'pool-1'; displayName = 'Zava Foundry pool' }) }
}

function Start-Sleep { }

function Get-LabMutations {
    @($global:F.Calls | Where-Object { $_ -match '(^| )(create|set|add|patch|post|delete|login|assign)( |$)|^New-Demo|^dataverse (POST|PATCH)|pip install' -and $_ -notmatch '^account set' })
}
