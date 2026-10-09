<#
.SYNOPSIS
    Install-Lab stages shared by both agent paths. Each stage has a read-only Check that looks
    at the live tenant or subscription, and an Apply that reuses the existing helpers.
    Keep this file ASCII-only.
#>

function New-LabResult([bool]$Done, [string]$Detail) { [pscustomobject]@{ Done = $Done; Detail = $Detail } }

# Done, but only on evidence from an earlier run or a person's confirmation, because the current
# sign-in cannot read it. Shown as such during the run and listed again at the end.
function New-LabEarlierResult([string]$Detail) { [pscustomobject]@{ Done = $true; Earlier = $true; Detail = $Detail } }

function Get-LabSettingsMap([object[]]$List) {
    $m = @{}
    foreach ($s in @($List)) { if ($s.name) { $m[[string]$s.name] = [string]$s.value } }
    return $m
}

function Get-LabDesiredSettings([hashtable]$State) {
    $c = $State.choices; $f = $State.found
    $want = [ordered]@{}
    if (Test-LabUseMcs $State) {
        foreach ($k in 'dataverseUrl') { if (-not $c[$k]) { throw 'The Power Platform environment is not chosen yet.' } }
        if (-not $f.mcsBotId) { throw 'The Copilot Studio agent has not been found yet.' }
        $p = $c.publisherPrefix
        $want.DATAVERSE_ORG_URL = $c.dataverseUrl
        $want.CUA_AGENT_BOTID = $f.mcsBotId
        $want.CUA_TRIGGER_ENTITYSET = "${p}_claimrequests"
        $want.CUA_TRIGGER_FIELD_POLICY = "${p}_policynumber"
        $want.CUA_TRIGGER_FIELD_SUMMARY = "${p}_summary"
        $want.CUA_TRIGGER_FIELD_CORRELATION = "${p}_correlationid"
        $want.CUA_TRIGGER_FIELD_LANG = "${p}_lang"
        $want.CUA_TRIGGER_FIELD_HANDOFF_CONTEXT = "${p}_handoffcontext"
        $want.CUA_RESULT_FIELD_CLAIMID = "${p}_claimid"
        $want.CUA_RESULT_FIELD_STATUS = "${p}_status"
        $want.CUA_RESULT_FIELD_RECEIPT = "${p}_handoffreceipt"
        $want.CUA_TRIGGER_ID_ATTR = "${p}_claimrequestid"
        $want.CUA_REGION = 'primary'
        $want.CUA_REQUIRE_REAL_RESULT = '1'
        $want.CUA_PROGRESS_MOCK = '0'
    }
    if (Test-LabUseFoundry $State) {
        if (-not $f.invocationsUrl) { throw 'The Foundry agent endpoint is not known yet.' }
        if (-not $f.zavaClientId) { throw 'The Zava sign-in app is not known yet.' }
        $want.FOUNDRY_INVOCATIONS_URL = $f.invocationsUrl
        $want.FOUNDRY_RELAY_TENANT_ID = $c.tenantId
        $want.FOUNDRY_RELAY_CLIENT_ID = $f.zavaClientId
        # Zava offers Foundry transfers only after the owner turned the agent on (foundry-enable).
        $want.FOUNDRY_CLAIMS_READY = $(if ($f.foundryEnabled) { '1' } else { '0' })
        if ($f.foundryPoolId) { $want.FOUNDRY_CLOUDPC_POOL_ID = $f.foundryPoolId }
    }
    return $want
}

function Find-LabSignInApp([hashtable]$State) {
    $f = $State.found; $c = $State.choices
    if ($f.zavaClientId) {
        $app = Get-LabAzJson @('ad', 'app', 'show', '--id', $f.zavaClientId)
        if ($app) { return $app }
    }
    $list = @(Get-LabAzJson @('ad', 'app', 'list', '--filter', "displayName eq '$($c.signInAppName)'"))
    if ($list.Count -gt 1) { throw "$($list.Count) app registrations are named '$($c.signInAppName)'. Rename the extra ones, or run setup with -ChooseAgain and pick another name." }
    if ($list.Count -eq 1) { return (Get-LabAzJson @('ad', 'app', 'show', '--id', $list[0].appId)) }
    return $null
}

$script:GraphAppId = '00000003-0000-0000-c000-000000000000'
$script:GraphUserRead = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'

function Get-LabSignInGaps($App, [string]$ZavaUrl) {
    $gaps = New-Object System.Collections.Generic.List[string]
    $appId = [string]$App.appId
    if (@($App.spa.redirectUris) -notcontains "$ZavaUrl/") { $gaps.Add("single-page app redirect URI $ZavaUrl/") }
    if (@($App.identifierUris) -notcontains "api://$appId") { $gaps.Add("Application ID URI api://$appId") }
    if ([string]$App.api.requestedAccessTokenVersion -ne '2') { $gaps.Add('version 2 access tokens') }
    $scope = @($App.api.oauth2PermissionScopes) | Where-Object { $_.value -eq 'Handoff.Access' } | Select-Object -First 1
    if (-not $scope -or -not $scope.isEnabled) { $gaps.Add('delegated scope Handoff.Access') }
    elseif (-not (@($App.api.preAuthorizedApplications) | Where-Object { $_.appId -eq $appId -and (@($_.delegatedPermissionIds) -contains $scope.id) })) {
        $gaps.Add('Zava itself authorised for Handoff.Access')
    }
    $graph = @($App.requiredResourceAccess) | Where-Object { $_.resourceAppId -eq $script:GraphAppId } | Select-Object -First 1
    if (-not ($graph -and (@($graph.resourceAccess) | Where-Object { $_.id -eq $script:GraphUserRead }))) { $gaps.Add('Microsoft Graph User.Read sign-in permission') }
    return $gaps.ToArray()
}

function ConvertTo-LabHashtable($Object) {
    if ($null -eq $Object) { return @{} }
    return ($Object | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable)
}

function Get-LabFingerprint([string]$Text) {
    # A short fingerprint of an approved change list, so a different list is asked about again.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text)) } finally { $sha.Dispose() }
    return (-join ($bytes[0..7] | ForEach-Object { $_.ToString('x2') }))
}

function Get-LabSignInAllGaps($App, [string]$ZavaUrl) {
    $gaps = @(Get-LabSignInGaps $App $ZavaUrl)
    if (-not (Get-LabAzJson @('ad', 'sp', 'show', '--id', $App.appId))) { $gaps += 'enterprise application (service principal)' }
    return $gaps
}

function Update-LabSignInApp([hashtable]$State) {
    # Creates the app registration if needed, then adds only what is missing. Existing redirect
    # URIs, scopes and permissions are kept.
    $c = $State.choices; $url = $State.found.zavaUrl
    $app = Find-LabSignInApp $State
    $created = $false
    if (-not $app) {
        $new = (Invoke-LabAz -Arguments @('ad', 'app', 'create', '--display-name', $c.signInAppName, '--sign-in-audience', 'AzureADMyOrg', '-o', 'json', '--only-show-errors')).Json
        Write-LabGood "Created app registration '$($c.signInAppName)' ($($new.appId))."
        $State.approvals.signInApp = [string]$new.appId
        $created = $true
        $app = Get-LabAzJson @('ad', 'app', 'show', '--id', $new.appId)
        if (-not $app) { $app = $new }
    }
    $gaps = @(Get-LabSignInAllGaps $app $url)
    $changes = Get-LabFingerprint (($gaps | Sort-Object) -join '; ')
    if (-not $created -and ($State.approvals.signInApp -ne [string]$app.appId -or ($gaps.Count -and $State.approvals.signInAppChanges -ne $changes))) {
        # An app registration setup did not just create: show exactly what would be added, and ask.
        Write-LabWarn "App registration '$($app.displayName)' (application ID $($app.appId), object ID $($app.id))."
        if ($gaps.Count) {
            Write-LabWarn 'Setup would add only these parts and remove nothing:'
            foreach ($g in $gaps) { Write-LabWarn "  - $g" }
        }
        else { Write-LabWarn 'It already has everything Zava needs; setup would change nothing.' }
        if (-not (Confirm-Lab 'Use this app registration for Zava, with exactly these changes?')) {
            throw "You chose not to use the app registration '$($app.displayName)'. Run setup with -ChooseAgain and give the sign-in app another name."
        }
        $State.approvals.signInApp = [string]$app.appId
    }
    $State.approvals.signInAppChanges = $changes
    $appId = [string]$app.appId; $objectId = [string]$app.id
    Set-LabFound $State 'zavaClientId' $appId
    if (-not @(Get-LabSignInGaps $app $url).Count) {
        if ($gaps.Count) { Invoke-LabAz -Arguments @('ad', 'sp', 'create', '--id', $appId, '--only-show-errors', '-o', 'none') | Out-Null }
        return
    }

    $api = ConvertTo-LabHashtable $app.api
    $api.requestedAccessTokenVersion = 2
    $scopes = @($api.oauth2PermissionScopes | Where-Object { $_ })
    $existing = $scopes | Where-Object { $_.value -eq 'Handoff.Access' } | Select-Object -First 1
    if ($existing) { $existing.isEnabled = $true }
    else {
        $scopes += @{
            id = [guid]::NewGuid().ToString(); value = 'Handoff.Access'; type = 'User'; isEnabled = $true
            adminConsentDisplayName = 'Use the Zava handoff service'
            adminConsentDescription = 'Lets Zava call the lab handoff service for the signed-in user.'
            userConsentDisplayName  = 'Use the Zava handoff service'
            userConsentDescription  = 'Lets Zava call the lab handoff service for you.'
        }
    }
    $api.oauth2PermissionScopes = @($scopes)
    $uris = @(@($app.identifierUris) + "api://$appId" | Where-Object { $_ } | Select-Object -Unique)
    $redirects = @(@($app.spa.redirectUris) + "$url/" | Where-Object { $_ } | Select-Object -Unique)
    $rra = @((ConvertTo-LabHashtable @{ v = @($app.requiredResourceAccess) }).v | Where-Object { $_ })
    $graph = $rra | Where-Object { $_.resourceAppId -eq $script:GraphAppId } | Select-Object -First 1
    if (-not $graph) { $rra += @{ resourceAppId = $script:GraphAppId; resourceAccess = @(@{ id = $script:GraphUserRead; type = 'Scope' }) } }
    elseif (-not (@($graph.resourceAccess) | Where-Object { $_.id -eq $script:GraphUserRead })) { $graph.resourceAccess = @($graph.resourceAccess) + @{ id = $script:GraphUserRead; type = 'Scope' } }

    $r = Invoke-LabRest -Method PATCH -Url "https://graph.microsoft.com/v1.0/applications/$objectId" -Body @{
        identifierUris = $uris; spa = @{ redirectUris = $redirects }; api = $api; requiredResourceAccess = @($rra)
    }
    if (-not $r.Ok) { throw "Could not update the app registration: $($r.Message)" }

    # Pre-authorising needs the scope to exist first.
    $app = Get-LabAzJson @('ad', 'app', 'show', '--id', $appId)
    $scope = @($app.api.oauth2PermissionScopes) | Where-Object { $_.value -eq 'Handoff.Access' } | Select-Object -First 1
    $api = ConvertTo-LabHashtable $app.api
    $pre = @($api.preAuthorizedApplications | Where-Object { $_ -and $_.appId -ne $appId })
    $self = @($app.api.preAuthorizedApplications) | Where-Object { $_.appId -eq $appId } | Select-Object -First 1
    $ids = @(@($self.delegatedPermissionIds) + $scope.id | Where-Object { $_ } | Select-Object -Unique)
    $api.preAuthorizedApplications = @($pre) + @(@{ appId = $appId; delegatedPermissionIds = $ids })
    $r = Invoke-LabRest -Method PATCH -Url "https://graph.microsoft.com/v1.0/applications/$objectId" -Body @{ api = $api }
    if (-not $r.Ok) { throw "Could not authorise Zava for its own Handoff.Access scope: $($r.Message)" }

    if (-not (Get-LabAzJson @('ad', 'sp', 'show', '--id', $appId))) {
        Invoke-LabAz -Arguments @('ad', 'sp', 'create', '--id', $appId, '--only-show-errors', '-o', 'none') | Out-Null
    }
}

function Sync-LabZavaRuntimeFiles([hashtable]$State, [string]$PublicDir, [string]$BackupDir) {
    # Zava reads /entra-config.json and /region-config.json at run time; files in public\ are
    # copied into the site. Setup writes entra-config.json and never silently replaces a
    # different existing file.
    $c = $State.choices; $f = $State.found
    $want = [ordered]@{ tenantId = $c.tenantId; clientId = $f.zavaClientId; redirectUri = "$($f.zavaUrl)/" }
    $entra = Join-Path $PublicDir 'entra-config.json'
    if (Test-Path -LiteralPath $entra) {
        $have = Get-Content -Raw -LiteralPath $entra | ConvertFrom-Json
        if ($have.tenantId -ne $want.tenantId -or $have.clientId -ne $want.clientId -or $have.redirectUri -ne $want.redirectUri) {
            Write-LabWarn "This computer already has $entra with other values:"
            Write-LabWarn "  now: tenant $($have.tenantId), client $($have.clientId), redirect $($have.redirectUri)"
            Write-LabWarn "  new: tenant $($want.tenantId), client $($want.clientId), redirect $($want.redirectUri)"
            if (-not (Confirm-Lab 'Replace it (the current file is kept as scripts\entra-config.previous.local.json)?')) { throw 'Stopped: the existing entra-config.json was kept, so Zava was not built.' }
            Copy-Item -LiteralPath $entra -Destination (Join-Path $BackupDir 'entra-config.previous.local.json') -Force
        }
    }
    ($want | ConvertTo-Json) | Set-Content -LiteralPath $entra -Encoding utf8

    $region = Join-Path $PublicDir 'region-config.json'
    if (Test-Path -LiteralPath $region) {
        $rc = Get-Content -Raw -LiteralPath $region | ConvertFrom-Json
        $other = @($rc.regions | Where-Object { $_.cuaRunBaseUrl -and $_.cuaRunBaseUrl -ne $f.handoffBaseUrl })
        if ($other.Count) {
            Write-LabWarn "This computer has $region, which points Zava at another handoff service ($($other[0].cuaRunBaseUrl))."
            if (-not (Confirm-Lab 'Move it aside to scripts\region-config.previous.local.json so this lab''s address is used?')) { throw 'Stopped: the existing region-config.json was kept, so Zava was not built.' }
            Move-Item -LiteralPath $region -Destination (Join-Path $BackupDir 'region-config.previous.local.json') -Force
        }
    }
}

function Test-LabZavaBundle([string]$ZavaUrl, [string]$BaseUrl) {
    $index = Invoke-LabWeb $ZavaUrl
    if ($index.Status -ne 200) { return "The Zava site does not answer yet (HTTP $($index.Status))." }
    $scripts = [regex]::Matches($index.Content, 'src="(/assets/[^"]+\.js)"') | ForEach-Object { $_.Groups[1].Value }
    foreach ($s in $scripts) { if ((Invoke-LabWeb "$ZavaUrl$s").Content -like "*$BaseUrl*") { return $null } }
    return 'The Zava site was not built with this lab''s handoff address.'
}

function Get-LabSharedStages {
    $stages = New-Object System.Collections.Generic.List[hashtable]

    $stages.Add(@{
            Id = 'azure-handoff'; When = 'both'; Kind = 'auto'; Settle = 240
            Title = 'Create the handoff service in Azure'
            Purpose = 'Zava sends each transfer to this Azure Functions app. It hosts the Copilot Studio trigger and the Foundry relay.'
            Who = 'You (Owner, or Contributor plus User Access Administrator, on the subscription)'
            Plan = { param($Ctx) "Create or reuse resource group $($Ctx.State.choices.resourceGroup), storage, key vault and Function app $($Ctx.State.choices.functionApp) (Linux Consumption, Node.js 22), then publish the handoff code. An existing Function app is not changed; if its code is missing you are asked first." }
            Check = {
                param($Ctx)
                $c = $Ctx.State.choices
                $app = Get-LabAzJson @('functionapp', 'show', '--name', $c.functionApp, '--resource-group', $c.resourceGroup)
                if (-not $app) { return (New-LabResult $false "Function app $($c.functionApp) does not exist yet.") }
                $principal = [string]$app.identity.principalId
                if (-not $principal) { return (New-LabResult $false 'The Function app has no system-assigned managed identity.') }
                $sp = Get-LabAzJson @('ad', 'sp', 'show', '--id', $principal)
                Set-LabFound $Ctx.State 'handoffPrincipalId' $principal
                Set-LabFound $Ctx.State 'handoffClientId' $sp.appId
                $base = "https://$($app.defaultHostName)/api"
                Set-LabFound $Ctx.State 'handoffBaseUrl' $base
                $probe = Invoke-LabWeb "$base/foundry-claims/availability"
                if (-not $probe.Json) { return (New-LabResult $false "The Function app exists but the handoff code does not answer at $base yet (HTTP $($probe.Status)).") }
                New-LabResult $true "$($c.functionApp) answers at $base"
            }
            Apply = {
                param($Ctx)
                $c = $Ctx.State.choices
                if (-not (Get-LabAzJson @('functionapp', 'show', '--name', $c.functionApp, '--resource-group', $c.resourceGroup))) {
                    Write-LabDemoConfig -State $Ctx.State -Path $Ctx.Paths.DemoConfig | Out-Null
                    $cfg = Get-DemoConfig -Path $Ctx.Paths.DemoConfig -RequireOrchestrator
                    New-DemoHandoffOrchestrator -Config $cfg -RepoRoot $Ctx.Paths.Root | Out-Null
                    return
                }
                if (-not (Confirm-Lab "Function app $($c.functionApp) already exists, but the handoff code does not answer. Publish this repository's handoff code to it (its settings and runtime stay as they are)?")) {
                    throw 'You chose not to publish the code to the existing Function app.'
                }
                Push-Location (Join-Path $Ctx.Paths.Root 'apps\handoff-orchestrator')
                try {
                    Invoke-Native -File 'npm' -Arguments @('ci') -Action 'install handoff service dependencies' | Out-Null
                    Invoke-Native -File 'func' -Arguments @('azure', 'functionapp', 'publish', $c.functionApp, '--javascript') -Action 'publish the handoff code' | Out-Null
                }
                finally { Pop-Location }
            }
            NextAction = 'Read the message above. Typical causes: the subscription does not allow the Microsoft.Web or Microsoft.Storage resource providers, or a name is already taken (run setup with -ChooseAgain to pick another).'
        })

    $stages.Add(@{
            Id = 'zava-site'; When = 'both'; Kind = 'auto'
            Title = 'Create the Zava web site address'
            Purpose = 'Reserves the Static Web App so its address is known before the sign-in app is registered. The site itself is built later.'
            Who = 'You (Contributor on the resource group)'
            Plan = { param($Ctx) "Create or reuse the Free Static Web App $($Ctx.State.choices.staticWebApp) and record its address." }
            Check = {
                param($Ctx)
                $c = $Ctx.State.choices
                $swa = Get-LabAzJson @('staticwebapp', 'show', '--name', $c.staticWebApp, '--resource-group', $c.resourceGroup)
                if (-not ($swa -and $swa.defaultHostname)) { return (New-LabResult $false "Static Web App $($c.staticWebApp) does not exist yet.") }
                Set-LabFound $Ctx.State 'zavaUrl' "https://$($swa.defaultHostname)"
                New-LabResult $true "https://$($swa.defaultHostname)"
            }
            Apply = {
                param($Ctx)
                Write-LabDemoConfig -State $Ctx.State -Path $Ctx.Paths.DemoConfig | Out-Null
                $cfg = Get-DemoConfig -Path $Ctx.Paths.DemoConfig
                New-DemoStaticWebApp -Config $cfg -RepoRoot $Ctx.Paths.Root -ResourceOnly | Out-Null
            }
            NextAction = 'Static Web Apps is offered in a few regions only; setup picks the nearest. Read the message above.'
        })

    $stages.Add(@{
            Id = 'zava-signin'; When = 'both'; Kind = 'auto'
            Title = 'Register the Zava sign-in app'
            Purpose = 'Presenters sign in to Zava with Microsoft Entra ID; the handoff service accepts only tokens issued to this app.'
            Who = 'You (Application Administrator or Cloud Application Administrator)'
            Plan = { param($Ctx) "Create or update app registration '$($Ctx.State.choices.signInAppName)': redirect URI = the Zava address, scope api://<its ID>/Handoff.Access, version 2 tokens, Zava authorised for that scope, Microsoft Graph User.Read. Missing parts only; nothing is removed. No admin consent is granted." }
            Check = {
                param($Ctx)
                if (-not $Ctx.State.found.zavaUrl) { return (New-LabResult $false 'Waiting for the Zava address.') }
                $app = Find-LabSignInApp $Ctx.State
                if (-not $app) { return (New-LabResult $false "No app registration named '$($Ctx.State.choices.signInAppName)' yet.") }
                if ($Ctx.State.approvals.signInApp -ne [string]$app.appId) { return (New-LabResult $false "An app registration named '$($app.displayName)' ($($app.appId)) already exists; setup asks before using it.") }
                Set-LabFound $Ctx.State 'zavaClientId' $app.appId
                $gaps = @(Get-LabSignInAllGaps $app $Ctx.State.found.zavaUrl)
                if ($gaps.Count) { return (New-LabResult $false ("Missing: " + ($gaps -join '; '))) }
                New-LabResult $true "$($app.displayName) ($($app.appId))"
            }
            Apply = { param($Ctx) Update-LabSignInApp $Ctx.State }
            NextAction = 'This needs Application Administrator or Cloud Application Administrator. Ask someone with that role to sign in on this computer (az login --tenant <tenant>) and run setup again.'
        })

    $stages.Add(@{
            Id = 'local-python'; When = 'both'; Kind = 'auto'
            Title = 'Prepare Python on this computer'
            Purpose = 'The Foundry deploy helper and the Copilot Studio configuration helper are Python scripts. Setup keeps their packages in a private folder of this download.'
            Who = 'This setup (changes this computer only)'
            Plan = { param($Ctx) "Create samples\foundry-hosted-claims\.venv and install the pinned packages into it (from PyPI)." }
            Check = {
                param($Ctx)
                $py = $Ctx.Paths.VenvPython
                if (-not (Test-Path -LiteralPath $py)) { return (New-LabResult $false 'The private Python environment does not exist yet.') }
                $mods = @('yaml')
                if (Test-LabUseFoundry $Ctx.State) { $mods += @('azure.ai.projects', 'azure.identity') }
                $r = Invoke-LabPython -Python $py -Arguments @('-c', "import $($mods -join ', ')")
                if ($r.Code -ne 0) { return (New-LabResult $false 'The private Python environment is missing packages.') }
                New-LabResult $true $py
            }
            Apply = {
                param($Ctx)
                $found = Find-LabPython
                if (-not $found) { throw 'Python 3.12 or later is not installed. Install it with: winget install --exact --id Python.Python.3.12' }
                if (-not (Test-Path -LiteralPath $Ctx.Paths.VenvPython)) {
                    $global:LASTEXITCODE = 0
                    & $found.Exe @($found.Prefix + @('-m', 'venv', $Ctx.Paths.Venv))
                    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
                }
                $pkgs = @('pyyaml>=6')
                if (Test-LabUseFoundry $Ctx.State) { $pkgs = @('-e', (Join-Path $Ctx.Paths.Root 'samples\foundry-hosted-claims')) + $pkgs }
                $r = Invoke-LabPython -Python $Ctx.Paths.VenvPython -Arguments (@('-m', 'pip', 'install', '--disable-pip-version-check', '--quiet') + $pkgs)
                if ($r.Code -ne 0) { throw "Installing Python packages failed: $(Get-LabShortText $r.Text)" }
            }
            NextAction = 'Check that this computer can reach pypi.org (a proxy or firewall can block it), then run setup again.'
        })
    return $stages
}

function Get-LabFinalStages {
    $stages = New-Object System.Collections.Generic.List[hashtable]

    $stages.Add(@{
            Id = 'handoff-settings'; When = 'both'; Kind = 'auto'
            Title = 'Connect the handoff service to the agents'
            Purpose = 'Writes the Dataverse, Copilot Studio and Foundry addresses and IDs that setup found into the Function app settings.'
            Who = 'You (Contributor on the resource group)'
            Plan = { param($Ctx) 'Set the DATAVERSE_*, CUA_* and FOUNDRY_* settings from the values found above. New settings are added; changing an existing value is shown and needs your yes. FOUNDRY_CLAIMS_READY is 1 only after you turned the Foundry agent on.' }
            Check = {
                param($Ctx)
                $c = $Ctx.State.choices
                $want = Get-LabDesiredSettings $Ctx.State
                $have = Get-LabSettingsMap (Get-LabAzJson @('functionapp', 'config', 'appsettings', 'list', '--name', $c.functionApp, '--resource-group', $c.resourceGroup))
                $diff = @($want.Keys | Where-Object { $have[$_] -ne $want[$_] })
                if ($diff.Count) { return (New-LabResult $false ("Not set yet: " + ($diff -join ', '))) }
                New-LabResult $true "$($want.Count) settings match"
            }
            Apply = {
                param($Ctx)
                $c = $Ctx.State.choices
                $want = Get-LabDesiredSettings $Ctx.State
                $have = Get-LabSettingsMap (Get-LabAzJson @('functionapp', 'config', 'appsettings', 'list', '--name', $c.functionApp, '--resource-group', $c.resourceGroup))
                $set = [ordered]@{}; $changed = @()
                foreach ($k in $want.Keys) {
                    if ($have[$k] -eq $want[$k]) { continue }
                    $set[$k] = $want[$k]
                    $old = if ($have.ContainsKey($k)) { $have[$k] } else { '(not set)' }
                    if ($have.ContainsKey($k)) { $changed += $k }
                    Write-Host ("    {0,-34} {1}  ->  {2}" -f $k, $old, $want[$k])
                }
                if ($changed.Count -and -not (Confirm-Lab "This changes $($changed.Count) existing setting(s) on $($c.functionApp). Saving restarts the app; make sure no transfer is running. Change them?")) {
                    throw 'You kept the existing settings.'
                }
                $file = Write-AppSettingsFile -Settings $set
                try { Invoke-Native -File 'az' -Arguments @('functionapp', 'config', 'appsettings', 'set', '--name', $c.functionApp, '--resource-group', $c.resourceGroup, '--settings', "@$file", '-o', 'none') -Action 'save Function app settings' | Out-Null }
                finally { Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue }
            }
            NextAction = 'Read the message above, then run setup again.'
        })

    $stages.Add(@{
            Id = 'zava-app'; When = 'both'; Kind = 'auto'; Settle = 120
            Title = 'Build and publish Zava'
            Purpose = 'Builds the Zava agent desktop with this lab''s sign-in app and handoff address, and publishes it.'
            Who = 'You (Contributor on the resource group)'
            Plan = { param($Ctx) "Allow the Zava address to call the handoff service (CORS), write apps\ccaas-agent-desktop\public\entra-config.json, build Zava with the handoff address and deploy it to $($Ctx.State.choices.staticWebApp). An existing different site or config file is shown first and needs your yes." }
            Check = {
                param($Ctx)
                $c = $Ctx.State.choices; $f = $Ctx.State.found
                $ec = Invoke-LabWeb "$($f.zavaUrl)/entra-config.json"
                if (-not ($ec.Json -and $ec.Json.clientId -eq $f.zavaClientId -and $ec.Json.tenantId -eq $c.tenantId)) { return (New-LabResult $false 'The Zava site does not serve this lab''s sign-in settings yet.') }
                $rc = Invoke-LabWeb "$($f.zavaUrl)/region-config.json"
                if ($rc.Json -and (@($rc.Json.regions) | Where-Object { $_.cuaRunBaseUrl -and $_.cuaRunBaseUrl -ne $f.handoffBaseUrl })) { return (New-LabResult $false 'The Zava site serves a region-config.json that points at another handoff service.') }
                $bundle = Test-LabZavaBundle $f.zavaUrl $f.handoffBaseUrl
                if ($bundle) { return (New-LabResult $false $bundle) }
                $cors = Get-LabAzJson @('functionapp', 'cors', 'show', '--name', $c.functionApp, '--resource-group', $c.resourceGroup)
                if (@($cors.allowedOrigins) -notcontains $f.zavaUrl) { return (New-LabResult $false 'The handoff service does not accept calls from the Zava address yet (CORS).') }
                New-LabResult $true "Zava is live at $($f.zavaUrl)"
            }
            Apply = {
                param($Ctx)
                $c = $Ctx.State.choices; $f = $Ctx.State.found
                $ec = Invoke-LabWeb "$($f.zavaUrl)/entra-config.json"
                if ($ec.Json -and $ec.Json.clientId -and $ec.Json.clientId -ne $f.zavaClientId) {
                    if (-not (Confirm-Lab "$($f.zavaUrl) already serves a Zava site for another sign-in app ($($ec.Json.clientId)). Replace that site with this lab's build?")) { throw 'You kept the existing Zava site.' }
                }
                Set-DemoHandoffOrchestratorCors -FunctionAppName $c.functionApp -ResourceGroup $c.resourceGroup -AllowedOrigin $f.zavaUrl
                Sync-LabZavaRuntimeFiles -State $Ctx.State -PublicDir $Ctx.Paths.ZavaPublic -BackupDir $Ctx.Paths.Backups
                $build = [ordered]@{
                    VITE_CUA_RUN_BASE_URL   = $f.handoffBaseUrl
                    VITE_AZURE_CLIENT_ID    = $f.zavaClientId
                    VITE_AZURE_TENANT_ID    = $c.tenantId
                    VITE_AZURE_REDIRECT_URI = "$($f.zavaUrl)/"
                }
                $saved = @{}
                foreach ($k in $build.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $build[$k]) }
                try {
                    Write-LabDemoConfig -State $Ctx.State -Path $Ctx.Paths.DemoConfig | Out-Null
                    $cfg = Get-DemoConfig -Path $Ctx.Paths.DemoConfig
                    $mcsUrl = if (Test-LabUseMcs $Ctx.State) { $f.handoffBaseUrl } else { '' }
                    $foundryUrl = if (Test-LabUseFoundry $Ctx.State) { $f.handoffBaseUrl } else { '' }
                    $default = if (Test-LabUseMcs $Ctx.State) { 'mcs' } else { 'foundry' }
                    New-DemoStaticWebApp -Config $cfg -RepoRoot $Ctx.Paths.Root -OrchestratorUrl $mcsUrl -FoundryOrchestratorUrl $foundryUrl -DefaultBackend $default | Out-Null
                }
                finally { foreach ($k in $build.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
            }
            NextAction = 'If the build failed, close any program using apps\ccaas-agent-desktop (for example an editor or a running dev server) and run setup again.'
        })

    $stages.Add(@{
            Id = 'presenter-icon'; When = 'both'; Kind = 'admin'
            Title = 'Give presenters the Zava desktop icon'
            Purpose = 'Publishes Zava as a Microsoft Edge app with a desktop icon to the presenter group. Presenters can also just open the address.'
            Who = 'Intune Administrator (signs in when asked)'
            Plan = { param($Ctx) "Run scripts\Deploy-DemoEnvironment.ps1 -Phase WebLink for group $($Ctx.State.choices.presenterGroup). It changes only that Edge policy." }
            Check = {
                param($Ctx)
                $c = $Ctx.State.choices; $f = $Ctx.State.found
                $g = @(Get-LabAzJson @('ad', 'group', 'list', '--filter', "displayName eq '$($c.presenterGroup)'"))
                if (-not $g.Count) { return (New-LabResult $false "Group $($c.presenterGroup) does not exist yet.") }
                if ($Ctx.RanThisRun -and $Ctx.RanThisRun['presenter-icon']) { return (New-LabResult $true "Published during this run for $($c.presenterGroup). Add presenters' accounts to that group.") }
                $run = $Ctx.State.runs['presenter-icon']
                if ($run -and $run.note -eq "$($f.zavaUrl)/") { return (New-LabEarlierResult "Edge policy published for this Zava address on $($run.atUtc); setup does not read the policy back.") }
                New-LabResult $false 'The Edge policy has not been published for this Zava address yet.'
            }
            Apply = {
                param($Ctx)
                $c = $Ctx.State.choices; $url = "$($Ctx.State.found.zavaUrl)/"
                $a = @{ TenantId = $c.tenantId; Phase = 'WebLink'; UserGroupName = $c.presenterGroup; CcaasWebLinkName = 'Zava Contact Center'; CcaasWebLinkUrl = $url }
                if ($Ctx.DeviceCode) { $a.DeviceCode = $true }
                Invoke-LabScript 'scripts\Deploy-DemoEnvironment.ps1' $a | Out-Null
                Add-LabRun $Ctx.State 'presenter-icon' $url
            }
            NextAction = 'This needs an Intune Administrator. Ask one to run setup again on this computer and sign in when the Intune sign-in window opens.'
        })

    $stages.Add(@{
            Id = 'readiness'; When = 'both'; Kind = 'check'
            Title = 'Readiness check'
            Purpose = 'Reads the finished installation once more. It does not start a transfer or file a claim.'
            Who = 'This setup (read-only)'
            Plan = { param($Ctx) 'Read the Zava site; for Foundry, the relay must report configured and ready; for Copilot Studio, the agent must be published and its trigger flow on.' }
            Check = {
                param($Ctx)
                $f = $Ctx.State.found; $problems = @()
                if ((Invoke-LabWeb $f.zavaUrl).Status -ne 200) { $problems += 'Zava site does not answer.' }
                if (Test-LabUseFoundry $Ctx.State) {
                    $av = (Invoke-LabWeb "$($f.handoffBaseUrl)/foundry-claims/availability").Json
                    if (-not ($av -and $av.configured -and $av.ready)) { $problems += "Foundry relay is not ready: $(if ($av) { $av.message } else { 'no answer' })" }
                }
                if (Test-LabUseMcs $Ctx.State) {
                    $flow = Get-LabMcsFlowCheck $Ctx.State
                    if (-not $flow.Done) { $problems += "Copilot Studio: $($flow.Detail)" }
                    $bot = @(Find-LabMcsAgent $Ctx.State) | Select-Object -First 1
                    if (-not ($bot -and $bot.publishedon)) { $problems += 'Copilot Studio: the agent is not published.' }
                }
                if ($problems.Count) { return (New-LabResult $false ($problems -join ' ')) }
                New-LabResult $true "Ready. Open Zava: $($f.zavaUrl)/"
            }
            NextAction = 'A Foundry relay that is "not ready" usually means the agent is not turned on yet or FOUNDRY_CLAIMS_READY is 0. Run setup again; it re-checks every stage.'
        })
    return $stages
}
