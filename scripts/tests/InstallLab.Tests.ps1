# Install-Lab.ps1: the guided setup, walked offline.
#
# Setup runs from a temporary copy of the files it reads (as a fresh download would), against a
# fake tenant in scripts\tests\LabFakes.ps1. Nothing signs in, nothing reaches Microsoft, and no
# file in this working tree is written.
#
# Run with: Invoke-Pester -Path .\scripts\tests\InstallLab.Tests.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here '..\..')).Path
$labParts = 'LabCore', 'LabChoices', 'LabStagesShared', 'LabStagesMcs', 'LabStagesFoundry', 'LabRunner'

function Get-Stage([hashtable]$State, [string]$Id) { Get-LabStages $State | Where-Object { $_.Id -eq $Id } }

function New-ReadyChoices([string]$Backends = 'both') {
    $s = New-LabState
    $s.choices = @{
        tenantId = $F.T; subscriptionId = $F.S; subscriptionName = 'Lab subscription'; location = 'australiaeast'; backends = $Backends
        resourceGroup = 'zava-lab-rg'; functionApp = 'zava-handoff-x'; storageAccount = 'zavahandoffx'; keyVault = 'zava-handoff-kv-x'; staticWebApp = 'zava-ccaas-x'
        signInAppName = 'Zava Contact Center'; presenterGroup = 'Zava-Demo-Agent-Users'; mcsAgentName = 'Zava Claims Intake (CUA)'; mcsDeviceGroup = 'Zava W365A Cloud PC Pools'
        publisherPrefix = 'crcce'; ppEnvironmentId = 'env-1'; ppEnvironmentName = 'Zava Lab'; dataverseUrl = 'https://zavalab.crm6.dynamics.com'
        foundryMode = 'new'; foundryAccount = 'zava-lab-x'; foundryAccountGroup = 'zava-lab-rg'; foundryProject = 'zava-claims'; registry = 'zavalabx'; agentName = 'claims-w365'
        modelDeployment = 'gpt-4.1-mini'; modelCapacity = '250'; agentUserUpn = 'zava-claims-agent@contoso.onmicrosoft.com'; foundryDeviceGroup = 'Zava W365A Foundry Claims Devices'
    }
    return $s
}

Describe 'Install-Lab.ps1 entry point on a computer without the tools' {
    It 'lists each missing tool with one install command and changes nothing' {
        $savedPath = $env:PATH
        $empty = Join-Path ([IO.Path]::GetTempPath()) ('nopath-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $empty | Out-Null
        $state = Join-Path $empty 'state.local.json'
        try {
            $env:PATH = $empty
            $out = & (Get-Process -Id $PID).Path -NoProfile -File (Join-Path $repo 'scripts\Install-Lab.ps1') -Preview -StatePath $state 2>&1 | Out-String
            $code = $LASTEXITCODE
        }
        finally { $env:PATH = $savedPath }
        $code | Should Be 1
        $out | Should Match 'MISSING Azure CLI'
        $out | Should Match 'winget install --exact --id Microsoft.AzureCLI'
        $out | Should Match 'winget install --exact --id Microsoft.Azure.FunctionsCoreTools'
        $out | Should Match 'winget install --exact --id Python.Python.3.12'
        (Test-Path $state) | Should Be $false
    }
}

Describe 'Guided setup: the whole journey from a fresh copy (both paths)' {
    . (Join-Path $here 'LabFakes.ps1')
    $root = New-LabCopy
    foreach ($p in $labParts) { . (Join-Path $root "scripts\lab\$p.ps1") }
    . (Join-Path $here 'LabFakes.ps1')
    Reset-LabFake
    $F.Deployed = @()
    $statePath = Join-Path $root 'scripts\lab-setup.local.json'

    It 'preview asks the choices once, shows the destination and plan, and changes nothing' {
        # tenant (Enter = signed-in tenant), subscription 1, region, resource group (default),
        # Foundry project: new, accept names, Power Platform environment 1.
        Set-FakeAnswers @('', '1', 'australiaeast', '', '1', 'yes', '1')
        $out = Invoke-LabSetup -StatePath $statePath -Preview -AgentBackend both 6>&1 | Out-String
        $result = Invoke-LabSetup -StatePath $statePath -Preview 6>$null
        $result.Status | Should Be 'Preview'
        $F.Prompts -contains '  Subscription number' | Should Be $true
        @(Get-LabMutations).Count | Should Be 0
        $F.Scripts.Count | Should Be 0
        $out | Should Match 'Destination'
        $out | Should Match 'zava-lab-rg'
        $out | Should Match 'Create the Foundry agent \(switched off\)'
        $out | Should Match 'Preview only: nothing in your tenant or subscription was changed'
        $saved = Get-Content -Raw $statePath | ConvertFrom-Json
        $saved.choices.subscriptionId | Should Be $F.S
        $saved.choices.foundryAccount | Should Match '^zava-lab-[0-9a-f]{6}$'
        @($F.Calls | Where-Object { $_ -like 'cognitiveservices account list*' }).Count | Should Be 0
    }

    It 'first run works in order and pauses at the Copilot Studio portal step' {
        $F.Prompts.Clear()
        Set-FakeAnswers @('yes', 'later')
        $r = Invoke-LabSetup -StatePath $statePath 6>$null
        $r.Status | Should Be 'Waiting'
        $r.Stage | Should Be 'mcs-agent'
        @($F.Prompts | Where-Object { $_ -like '*Subscription*' }).Count | Should Be 0
        $F.App.spa.redirectUris -contains 'https://calm-sea-1.azurestaticapps.net/' | Should Be $true
        $F.App.identifierUris -contains 'api://zava-client-id' | Should Be $true
        $F.App.api.requestedAccessTokenVersion | Should Be 2
        @($F.Privileges).Count | Should Be 7
        $F.AppUser | Should Be $true
        @($F.Scripts | Where-Object { $_.Path -like '*Deploy-FoundryAgent.ps1' }).Count | Should Be 0
    }

    It 'second run resumes, keeps the Foundry order, asks before consent and turn-on, and finishes ready' {
        $F.Bot = $true; $F.Flow = $true; $F.Pool = $true
        $F.Prompts.Clear()
        Set-FakeAnswers @('yes', 'yes', 'yes')
        $all = @(Invoke-LabSetup -StatePath $statePath 6>&1)
        $r = @($all | Where-Object { $_.PSObject.Properties['Status'] })[-1]
        $text = ($all | Where-Object { -not $_.PSObject.Properties['Status'] } | Out-String)
        $r.Status | Should Be 'ReadyUnverified'
        $text | Should Match 'done, not re-read\]\s+5/24 Prepare the tenant'
        $text | Should Match 'not every step could be read back on this run'
        $text | Should Not Match 'every step was read back'
        $F.Answers.Count | Should Be 0
        @($F.Prompts | Where-Object { $_ -like '*tenant-wide consent*' }).Count | Should Be 1
        @($F.Prompts | Where-Object { $_ -like '*Turn the Foundry agent on*' }).Count | Should Be 1

        $order = @($F.Scripts | ForEach-Object { if ($_.Path -like '*Deploy-FoundryAgent.ps1') { 'deploy:' + ((@($_.Args.Keys | Where-Object { $_ -in 'BuildImage', 'DeployVersion', 'ConfigureEndpoint' }) | Sort-Object) -join '+') } elseif ($_.Path -like '*Set-FoundryAgentIdentity.ps1' -and $_.Args.Apply) { 'identity-apply' } })
        $order = @($order | Where-Object { $_ })
        ($order -join ' > ') | Should Be 'deploy:BuildImage > deploy:ConfigureEndpoint+DeployVersion > identity-apply > deploy:DeployVersion'
        $F.Deployed[0].LIVE_EXECUTION_APPROVED | Should Be 'no'
        $F.Deployed[0].CLAIMS_AGENT_USER_ID | Should Be ''
        $F.Deployed[1].CLAIMS_EXECUTION_APPROVED | Should Be 'yes'
        $F.Deployed[1].CLAIMS_AGENT_ID | Should Be 'agent-identity'
        $F.Deployed[1].CLAIMS_BLUEPRINT_ID | Should Be 'blueprint-app'
        $F.Deployed[1].CLAIMS_AGENT_USER_ID | Should Be 'agent-user'

        $F.Settings.FOUNDRY_CLAIMS_READY | Should Be '1'
        $F.Settings.FOUNDRY_RELAY_CLIENT_ID | Should Be 'zava-client-id'
        $F.Settings.FOUNDRY_CLOUDPC_POOL_ID | Should Be 'pool-1'
        $F.Settings.CUA_AGENT_BOTID | Should Be 'bot-1'
        $F.Settings.DATAVERSE_ORG_URL | Should Be 'https://zavalab.crm6.dynamics.com'
        $F.BuildEnv.VITE_CUA_RUN_BASE_URL | Should Be 'https://zava-handoff-x.azurewebsites.net/api'
        $F.BuildEnv.VITE_AZURE_CLIENT_ID | Should Be 'zava-client-id'
        $env:VITE_CUA_RUN_BASE_URL | Should BeNullOrEmpty
        $F.Instructions | Should Be $true
        (Test-Path (Join-Path $root 'scripts\foundry-demo-prep\foundry-demo.config.json')) | Should Be $true
    }

    It 'a third run finds everything done and changes nothing' {
        $before = $F.Calls.Count; $scripts = $F.Scripts.Count
        Set-FakeAnswers @()
        $r = Invoke-LabSetup -StatePath $statePath 6>$null
        $r.Status | Should Be 'ReadyUnverified'
        @($F.Calls | Select-Object -Skip $before | Where-Object { $_ -match ' (create|set|add|patch)( |$)|^New-Demo|^dataverse POST' -and $_ -notmatch '^account set' }).Count | Should Be 0
        @($F.Scripts | Select-Object -Skip $scripts | Where-Object { -not ($_.Path -like '*Set-FoundryAgentIdentity.ps1' -and -not $_.Args.Apply) }).Count | Should Be 0
    }

    It 'keeps only names, IDs and URLs in the private state, and every generated file is git-ignored' {
        $text = Get-Content -Raw $statePath
        $text | Should Not Match '(?i)token|secret|password|apikey'
        foreach ($rel in 'scripts\lab-setup.local.json', 'scripts\demo-config.lab.local.json', 'deploy\foundry\foundry-agent.lab.local.json', 'deploy\foundry\foundry-agent-deployment.lab.local.json',
            'scripts\entra-config.previous.local.json', 'scripts\region-config.previous.local.json', 'apps\ccaas-agent-desktop\public\entra-config.json',
            'scripts\foundry-demo-prep\foundry-demo.config.json', 'samples\foundry-hosted-claims\.venv\Scripts\python.exe') {
            & git -C $repo check-ignore -q --no-index ($rel -replace '\\', '/')
            "$rel ignored=$LASTEXITCODE" | Should Be "$rel ignored=0"
        }
    }
}

Describe 'Guided setup: failure, missing permission and existing resources' {
    . (Join-Path $here 'LabFakes.ps1')
    $root = New-LabCopy
    foreach ($p in $labParts) { . (Join-Path $root "scripts\lab\$p.ps1") }
    . (Join-Path $here 'LabFakes.ps1')

    It 'stops when a read fails, instead of treating it as missing and creating a duplicate' {
        Reset-LabFake
        $F.Fn = $true; $F.Swa = $true; $F.DenyAppRead = $true
        $s = New-ReadyChoices 'foundry'
        $ctx = @{ State = $s; Paths = (Get-LabPaths -StatePath (Join-Path $root 'scripts\f6.local.json')); Preview = $false; DeviceCode = $false }
        $all = @(Invoke-LabStages (Get-LabStages $s) $ctx 6>&1)
        $r = @($all | Where-Object { $_.PSObject.Properties['Status'] })[-1]
        $r.Status | Should Be 'Failed'
        $r.Stage | Should Be 'zava-signin'
        $r.Message | Should Match 'could not read the current state, so it changed nothing'
        @($F.Calls | Where-Object { $_ -like 'ad app create*' }).Count | Should Be 0
    }

    It 'asks before using an existing app registration with the same name' {
        Reset-LabFake
        $F.Fn = $true; $F.Swa = $true
        $F.App = @{ id = 'other-object'; appId = 'other-app'; displayName = 'Zava Contact Center'; identifierUris = @(); spa = @{ redirectUris = @() }; api = @{ oauth2PermissionScopes = @(); preAuthorizedApplications = @() }; requiredResourceAccess = @() }
        $s = New-ReadyChoices 'foundry'
        $ctx = @{ State = $s; Paths = (Get-LabPaths -StatePath (Join-Path $root 'scripts\f7.local.json')); Preview = $false; DeviceCode = $false }
        Set-FakeAnswers @('no')
        $r = @(Invoke-LabStages (Get-LabStages $s)[0..2] $ctx 6>$null)[-1]
        $r.Status | Should Be 'Failed'
        @($F.Calls | Where-Object { $_ -like 'rest --method patch*' }).Count | Should Be 0
        Set-FakeAnswers @('yes')
        $r = @(Invoke-LabStages (Get-LabStages $s)[0..2] $ctx 6>$null)[-1]
        $r.Status | Should Be 'Ready'
        $s.approvals.signInApp | Should Be 'other-app'
        $F.App.identifierUris -contains 'api://other-app' | Should Be $true
    }

    It 'clears what it found for the old destination when the destination changes' {
        Reset-LabFake
        $sp = Join-Path $root 'scripts\f8.local.json'
        $s = New-ReadyChoices 'foundry'
        $s.found = @{ zavaClientId = 'old-client'; foundryPoolConfirmedAt = '2026-10-01T00:00:00Z' }
        $s.runs = @{ 'presenter-icon' = @{ atUtc = 'x'; note = 'y' } }
        Save-LabState $s $sp
        # tenant, subscription, region, new resource group, Foundry: new, accept names; then do not start.
        Set-FakeAnswers @('', '1', 'australiaeast', 'another-rg', '1', 'yes', 'no')
        $r = @(Invoke-LabSetup -StatePath $sp -ChooseAgain -AgentBackend foundry 6>$null)[-1]
        $r.Status | Should Be 'Declined'
        $saved = Read-LabState $sp
        $saved.choices.resourceGroup | Should Be 'another-rg'
        $saved.found.ContainsKey('foundryPoolConfirmedAt') | Should Be $false
        $saved.runs.Count | Should Be 0
    }

    It 'finds a Dataverse role that lacks the required privileges' {
        Reset-LabFake
        $F.AppUser = $true; $F.Privileges = @()
        $s = New-ReadyChoices 'mcs'
        $s.found = @{ handoffClientId = 'handoff-app-id' }
        $ctx = @{ State = $s; Paths = (Get-LabPaths -StatePath (Join-Path $root 'scripts\f9.local.json')); Preview = $false; DeviceCode = $false }
        $res = & (Get-Stage $s 'mcs-app-user').Check $ctx
        $res.Done | Should Be $false
        $res.Detail | Should Match 'The role lacks: Create crcce_claimrequest'
    }

    It 'stops, without changing anything, when the handoff service has more Dataverse access than it needs' {
        Reset-LabFake
        $F.AppUser = $true; $F.Privileges = @(@{ PrivilegeId = 'p-c' }, @{ PrivilegeId = 'p-r' }, @{ PrivilegeId = 'p-w' })
        $s = New-ReadyChoices 'mcs'
        $s.found = @{ handoffClientId = 'handoff-app-id' }
        $ctx = @{ State = $s; Paths = (Get-LabPaths -StatePath (Join-Path $root 'scripts\f10.local.json')); Preview = $false; DeviceCode = $false }
        function Get-LabAppUser { [pscustomobject]@{ systemuserid = 'u-1'; systemuserroles_association = @([pscustomobject]@{ roleid = 'role-1'; name = 'Zava Handoff Service' }, [pscustomobject]@{ roleid = 'r-admin'; name = 'System Administrator' }) } }
        $res = & (Get-Stage $s 'mcs-app-user').Check $ctx
        $res.Done | Should Be $false
        $res.Detail | Should Match 'also has the role\(s\) System Administrator'
        $err = $null; try { Install-LabAppUser $s } catch { $err = $_.Exception.Message }
        $err | Should Match 'Setup does not remove access'
        @($F.Calls | Where-Object { $_ -like 'dataverse POST*' }).Count | Should Be 0
    }

    It 'shows and asks again when an approved sign-in app later needs different changes' {
        Reset-LabFake
        $F.Sp = $true
        $F.App = @{ id = 'app-object'; appId = 'zava-client-id'; displayName = 'Zava Contact Center'; identifierUris = @('api://zava-client-id'); spa = @{ redirectUris = @() }; api = @{ requestedAccessTokenVersion = 2; oauth2PermissionScopes = @(); preAuthorizedApplications = @() }; requiredResourceAccess = @() }
        $s = New-ReadyChoices 'foundry'
        $s.found = @{ zavaUrl = 'https://calm-sea-1.azurestaticapps.net' }
        $s.approvals = @{ signInApp = 'zava-client-id'; signInAppChanges = 'something else' }
        Set-FakeAnswers @('no')
        $err = $null; try { Update-LabSignInApp $s 6>$null } catch { $err = $_.Exception.Message }
        $err | Should Match 'chose not to use'
        @($F.Prompts | Where-Object { $_ -like '*exactly these changes*' }).Count | Should Be 1
        @($F.Calls | Where-Object { $_ -like 'rest --method patch*' }).Count | Should Be 0
    }

    It 'stops at the failing step with what to do next, and runs nothing after it' {
        Reset-LabFake
        $F.FailSwa = $true
        $s = New-ReadyChoices 'foundry'
        $ctx = @{ State = $s; Paths = (Get-LabPaths -StatePath (Join-Path $root 'scripts\f1.local.json')); Preview = $false; DeviceCode = $false }
        $out = Invoke-LabStages (Get-LabStages $s) $ctx 6>&1 | Out-String
        $r = Invoke-LabStages (Get-LabStages $s) $ctx 6>$null
        $r.Status | Should Be 'Failed'
        $r.Stage | Should Be 'zava-site'
        $out | Should Match 'Setup stopped at step 2 of'
        $out | Should Match 'What to do next'
        @($F.Calls | Where-Object { $_ -like 'ad app*' }).Count | Should Be 0
    }

    It 'names the role that is missing when the sign-in may not create the app registration' {
        Reset-LabFake
        $F.Fn = $true; $F.Swa = $true; $F.DenyAppCreate = $true
        $s = New-ReadyChoices 'foundry'
        $ctx = @{ State = $s; Paths = (Get-LabPaths -StatePath (Join-Path $root 'scripts\f2.local.json')); Preview = $false; DeviceCode = $false }
        $out = Invoke-LabStages (Get-LabStages $s) $ctx 6>&1 | Out-String
        $out | Should Match 'Register the Zava sign-in app'
        $out | Should Match 'Application Administrator or Cloud Application Administrator'
        $out | Should Match 'Insufficient privileges'
    }

    It 'never republishes an existing Function app without a yes' {
        Reset-LabFake
        $F.Fn = $true; $F.Code = $false
        $s = New-ReadyChoices 'foundry'
        $ctx = @{ State = $s; Paths = (Get-LabPaths -StatePath (Join-Path $root 'scripts\f3.local.json')); Preview = $false; DeviceCode = $false }
        function Invoke-Native { $global:F.Calls.Add("native $($args -join ' ')") }
        Set-FakeAnswers @('no')
        $r = Invoke-LabStages @(Get-Stage $s 'azure-handoff') $ctx 6>$null
        $r.Status | Should Be 'Failed'
        @($F.Calls | Where-Object { $_ -like 'native*' -or $_ -eq 'New-DemoHandoffOrchestrator' }).Count | Should Be 0
    }

    It 'shows a changed existing setting and keeps it when the answer is not yes' {
        Reset-LabFake
        $F.Fn = $true
        $F.Settings = @{ FOUNDRY_INVOCATIONS_URL = 'https://old.example/invocations'; FOUNDRY_CLAIMS_READY = '1' }
        $s = New-ReadyChoices 'foundry'
        $s.found = @{ invocationsUrl = 'https://zava-lab-sub.services.ai.azure.com/api/projects/zava-claims/agents/claims-w365/endpoint/protocols/invocations?api-version=v1'; zavaClientId = 'zava-client-id' }
        $ctx = @{ State = $s; Paths = (Get-LabPaths -StatePath (Join-Path $root 'scripts\f4.local.json')); Preview = $false; DeviceCode = $false }
        Set-FakeAnswers @('no')
        $out = Invoke-LabStages @(Get-Stage $s 'handoff-settings') $ctx 6>&1 | Out-String
        $out | Should Match 'https://old.example/invocations\s+->'
        $F.Settings.FOUNDRY_INVOCATIONS_URL | Should Be 'https://old.example/invocations'
        $F.Settings.FOUNDRY_CLAIMS_READY | Should Be '1'
    }

    It 'keeps FOUNDRY_CLAIMS_READY at 0 until the agent was turned on' {
        Reset-LabFake
        $s = New-ReadyChoices 'both'
        $s.found = @{ invocationsUrl = 'https://x/invocations'; zavaClientId = 'zava-client-id'; mcsBotId = 'bot-1' }
        (Get-LabDesiredSettings $s).FOUNDRY_CLAIMS_READY | Should Be '0'
        (Get-LabDesiredSettings $s).CUA_TRIGGER_ENTITYSET | Should Be 'crcce_claimrequests'
        $s.found.foundryEnabled = $true
        (Get-LabDesiredSettings $s).FOUNDRY_CLAIMS_READY | Should Be '1'
    }

    It 'does not turn the Foundry agent on without a yes, and never with missing identity IDs' {
        Reset-LabFake
        $s = New-ReadyChoices 'foundry'
        $s.found = @{ agentIdentityId = 'agent-identity'; blueprintId = 'blueprint-app'; agentUserId = 'agent-user'; imageDigest = 'sha256:' + ('a' * 64) }
        $ctx = @{ State = $s; Paths = (Get-LabPaths -StatePath (Join-Path $root 'scripts\f5.local.json')); Preview = $false; DeviceCode = $false; RanThisRun = @{ 'foundry-pool' = $true } }
        Set-FakeAnswers @('no')
        $err = $null; try { & (Get-Stage $s 'foundry-enable').Apply $ctx 6>$null } catch { $err = $_.Exception.Message }
        $err | Should Match 'keep the Foundry agent off'
        @($F.Scripts | Where-Object { $_.Path -like '*Deploy-FoundryAgent.ps1' }).Count | Should Be 0
        $s.found.Remove('agentUserId')
        $err = $null; try { Write-LabFoundryConfig -State $s -Path (Join-Path $root 'x.local.json') -SamplePath $ctx.Paths.FoundrySample -Enabled -ReceiptPath 'r' } catch { $err = $_.Exception.Message }
        $err | Should Match 'agentUserId is not known'
    }

    It 'asks before replacing a different entra-config.json and keeps a copy' {
        Reset-LabFake
        $s = New-ReadyChoices 'foundry'
        $s.found = @{ zavaClientId = 'zava-client-id'; zavaUrl = 'https://calm-sea-1.azurestaticapps.net'; handoffBaseUrl = 'https://h/api' }
        $pub = Join-Path $root 'pub-test'; New-Item -ItemType Directory -Force -Path $pub | Out-Null
        Set-Content -LiteralPath (Join-Path $pub 'entra-config.json') -Value '{"tenantId":"t-old","clientId":"c-old","redirectUri":"https://old/"}'
        Set-FakeAnswers @('no')
        $err = $null; try { Sync-LabZavaRuntimeFiles -State $s -PublicDir $pub -BackupDir $root 6>$null } catch { $err = $_.Exception.Message }
        $err | Should Match 'existing entra-config.json was kept'
        (Get-Content -Raw (Join-Path $pub 'entra-config.json')) | Should Match 'c-old'
        Set-FakeAnswers @('yes')
        Sync-LabZavaRuntimeFiles -State $s -PublicDir $pub -BackupDir $root 6>$null
        (Get-Content -Raw (Join-Path $pub 'entra-config.json') | ConvertFrom-Json).clientId | Should Be 'zava-client-id'
        (Get-Content -Raw (Join-Path $root 'entra-config.previous.local.json')) | Should Match 'c-old'
    }

    It 'adds the missing sign-in settings and keeps the app''s existing redirect URIs and scopes' {
        Reset-LabFake
        $F.App = @{ id = 'app-object'; appId = 'zava-client-id'; displayName = 'Zava Contact Center'; identifierUris = @(); spa = @{ redirectUris = @('http://localhost:5173/') }
            api = @{ requestedAccessTokenVersion = $null; oauth2PermissionScopes = @(@{ id = 'other-scope'; value = 'Other.Read'; isEnabled = $true; type = 'User' }); preAuthorizedApplications = @() }; requiredResourceAccess = @() }
        $s = New-ReadyChoices 'foundry'
        $s.found = @{ zavaUrl = 'https://calm-sea-1.azurestaticapps.net' }
        Set-FakeAnswers @('yes')
        Update-LabSignInApp $s 6>$null
        $F.App.spa.redirectUris -contains 'http://localhost:5173/' | Should Be $true
        $F.App.spa.redirectUris -contains 'https://calm-sea-1.azurestaticapps.net/' | Should Be $true
        @($F.App.api.oauth2PermissionScopes | ForEach-Object { $_.value }) -join ',' | Should Be 'Other.Read,Handoff.Access'
        @(Get-LabSignInGaps ([pscustomobject]($F.App | ConvertTo-Json -Depth 10 | ConvertFrom-Json)) 'https://calm-sea-1.azurestaticapps.net').Count | Should Be 0
    }

    It 'orders the stages so no step needs something a later step creates' {
        $ids = @(Get-LabStages (New-ReadyChoices 'both') | ForEach-Object { $_.Id })
        foreach ($pair in @('zava-site<zava-signin', 'zava-signin<zava-app', 'azure-handoff<foundry-project', 'local-python<foundry-image', 'foundry-image<foundry-agent', 'foundry-agent<foundry-identity',
                'foundry-identity<foundry-pool', 'foundry-claims-app<foundry-pool', 'foundry-pool<foundry-enable', 'foundry-enable<handoff-settings', 'tenant-prep<mcs-claims-app',
                'mcs-claims-app<mcs-shortcut', 'mcs-table<mcs-app-user', 'mcs-agent<mcs-instructions', 'mcs-instructions<mcs-flow', 'mcs-flow<handoff-settings', 'handoff-settings<readiness')) {
            $a, $b = $pair -split '<'
            "$pair $([array]::IndexOf($ids, $a) -lt [array]::IndexOf($ids, $b))" | Should Be "$pair True"
        }
        @(Get-LabStages (New-ReadyChoices 'mcs') | Where-Object { $_.Id -like 'foundry-*' }).Count | Should Be 0
        @(Get-LabStages (New-ReadyChoices 'foundry') | Where-Object { $_.Id -like 'mcs-*' -or $_.Id -eq 'tenant-prep' }).Count | Should Be 0
    }
}

Describe 'Helper changes used by setup' {
    It 'Set-FoundryAgentIdentity.ps1 -PassThru returns the IDs and the planned changes without writing' {
        $global:zWrites = 0
        function az {
            $j = $args -join ' '
            $global:LASTEXITCODE = 0
            if ($j -like 'account show*') { return '11111111-1111-1111-1111-111111111111' }
            if ($j -match '--method (POST|PATCH)') { $global:zWrites++ ; return '{}' }
            if ($j -match 'oauth2PermissionGrants') { return $global:zGrants }
            if ($j -match 'inheritablePermissions|/users\?') { return '{"value":[]}' }
            if ($j -match 'microsoft\.graph\.agentIdentity\?') { return '{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","appId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","displayName":"agent","agentIdentityBlueprintId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}' }
            if ($j -match 'agentIdentityBlueprint\?') { return '{"value":[{"id":"bp-object","appId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","displayName":"bp","requiredResourceAccess":[]}]}' }
            if ($j -match 'servicePrincipals\?.*bbbbbbbb') { return '{"value":[{"id":"bp-sp","appId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}]}' }
            if ($j -match 'servicePrincipals\?') { return '{"value":[{"id":"res-sp","appId":"x","oauth2PermissionScopes":[{"id":"s1","value":"McpServersMetadata.Read.All"},{"id":"s2","value":"Tools.ListInvoke.All"},{"id":"s3","value":"Computer.See"}]}]}' }
            throw "unexpected: $j"
        }
        $global:zGrants = '{"value":[]}'
        $o = & (Join-Path $repo 'deploy\foundry\Set-FoundryAgentIdentity.ps1') -TenantId '11111111-1111-1111-1111-111111111111' -AgentIdentityId 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' -AgentUserPrincipalName 'agent@contoso.com' -PassThru 6>$null
        $o.BlueprintId | Should Be 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
        $o.AgentUserId | Should Be ''
        $o.Applied | Should Be $false
        @($o.Changes).Count | Should BeGreaterThan 3
        $global:zWrites | Should Be 0

        # An existing tenant-wide grant for the resource is extended, not duplicated.
        $global:zGrants = '{"value":[{"id":"g1","resourceId":"res-sp","consentType":"AllPrincipals","scope":"McpServersMetadata.Read.All"}]}'
        $o = & (Join-Path $repo 'deploy\foundry\Set-FoundryAgentIdentity.ps1') -TenantId '11111111-1111-1111-1111-111111111111' -AgentIdentityId 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' -AgentUserPrincipalName 'agent@contoso.com' -PassThru 6>$null
        @($o.Changes | Where-Object { $_ -like 'Add Tools.ListInvoke.All to the existing tenant-wide consent*' }).Count | Should Be 1
        @($o.Changes | Where-Object { $_ -like 'Grant tenant-wide consent*' }).Count | Should Be 0
    }

    It 'New-DemoStaticWebApp -ResourceOnly creates or finds the site without building or deploying it' {
        . (Join-Path $repo 'scripts\DemoCommon.ps1')
        $global:zNative = New-Object System.Collections.Generic.List[string]
        function Invoke-Native { param($File, $Arguments, $Action, $SecretEnv, [switch]$NoEcho, [switch]$AllowNonZero) $global:zNative.Add("$File $($Arguments -join ' ')") }
        function Register-DemoProvider { }
        function az { $global:LASTEXITCODE = 0; $j = $args -join ' '; if ($j -like 'group exists*') { return 'true' }; if ($j -like 'staticwebapp show*defaultHostname*') { return 'calm-sea-1.azurestaticapps.net' }; if ($j -like 'staticwebapp show*') { $global:LASTEXITCODE = 3; return '' }; return '' }
        $cfg = [pscustomobject]@{ azure = [pscustomobject]@{ location = 'australiaeast' }; staticWebApp = [pscustomobject]@{ location = 'eastasia'; resourceGroup = 'rg'; name = 'site'; appLocation = 'apps/ccaas-agent-desktop'; apiLocation = 'apps/ccaas-agent-desktop/api'; outputLocation = 'apps/ccaas-agent-desktop/dist' } }
        $r = New-DemoStaticWebApp -Config $cfg -RepoRoot $repo -ResourceOnly 6>$null
        $r.Url | Should Be 'https://calm-sea-1.azurestaticapps.net'
        @($global:zNative | Where-Object { $_ -like 'az staticwebapp create*' }).Count | Should Be 1
        @($global:zNative | Where-Object { $_ -like 'npm*' -or $_ -like 'npx*' }).Count | Should Be 0
    }
}
