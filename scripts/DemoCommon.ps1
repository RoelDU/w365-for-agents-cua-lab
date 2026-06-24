<#
.SYNOPSIS
    Shared helpers for the Zava CCaaS / Computer-Use demo build + teardown scripts.

.DESCRIPTION
    Dot-sourced by Build-DemoFromScratch.ps1 and Remove-DemoEnvironment.ps1. Nothing
    here is tenant- or region-specific: every value comes from demo-config.local.json
    (see scripts\demo-config.sample.json), so a brand-new user in a brand-new
    subscription/tenant/region only edits that one config file.

    Design rules honoured throughout:
      - Config-driven, no hardcoded subscription / tenant / region / resource names.
      - Prerequisites are CHECKED (fail fast with the exact fix), not assumed.
      - Secrets are kept out of OUR logs/transcripts: the SWA deployment token is
        passed via an environment variable (never as an argument), and other secret
        values (e.g. the client secret on app settings) are passed with -NoEcho so the
        command and its arguments are not echoed. Note: a value passed with -NoEcho is
        still a process argument of the child tool (e.g. az), so it can be visible to
        local process inspection - it is just never written to our output or log.
      - Every external mutation honours -WhatIf (inherited via $WhatIfPreference).

    Keep this file ASCII-only: Windows PowerShell 5.1 reads a non-BOM UTF-8 .ps1 as
    ANSI, and a stray non-ASCII character breaks parsing.
#>

# Azure Static Web Apps is offered only in these regions (resource/Functions
# location). Static content is still served from a global edge network. Kept here
# as the single source of truth so the validator and the docs cannot drift.
$script:SwaSupportedRegions = @('westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia')

# Best-effort "nearest SWA region" for common Azure regions, so an unsupported
# choice yields a helpful suggestion instead of a raw Azure error. Generic, not
# tied to any one tenant.
$script:SwaNearestRegion = @{
    'australiaeast'      = 'eastasia'
    'australiasoutheast' = 'eastasia'
    'southeastasia'      = 'eastasia'
    'eastasia'           = 'eastasia'
    'japaneast'          = 'eastasia'
    'japanwest'          = 'eastasia'
    'koreacentral'       = 'eastasia'
    'centralindia'       = 'eastasia'
    'uksouth'            = 'westeurope'
    'northeurope'        = 'westeurope'
    'westeurope'         = 'westeurope'
    'francecentral'      = 'westeurope'
    'germanywestcentral' = 'westeurope'
    'eastus'             = 'eastus2'
    'eastus2'            = 'eastus2'
    'centralus'          = 'centralus'
    'southcentralus'     = 'centralus'
    'westus'             = 'westus2'
    'westus2'            = 'westus2'
    'westus3'            = 'westus2'
}

function Get-SwaSupportedRegions { return $script:SwaSupportedRegions }

function Get-DemoNameSuffix {
    <#
        Returns a short, stable, lowercase-alphanumeric suffix derived from a seed
        (the subscription id). Used to auto-generate globally-unique resource names
        when the user leaves them blank, so re-runs and teardown compute the SAME
        names (deterministic in the subscription) and reuse the same resources.
    #>
    param([Parameter(Mandatory)][string]$Seed)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Seed)) }
    finally { $sha.Dispose() }
    $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    return $hex.Substring(0, 6)
}

function Get-NearestSwaRegion {
    # Always returns a SUPPORTED Static Web Apps region for any Azure region: exact
    # map first, then a geography-based closest match, so a blank staticWebApp.location
    # never dead-ends the build with a manual question ("use the region, or closest").
    param([string]$AzureRegion)
    $r = ([string]$AzureRegion).Trim().ToLowerInvariant().Replace(' ', '')
    if ($script:SwaSupportedRegions -contains $r) { return $r }
    if ($script:SwaNearestRegion.ContainsKey($r)) { return $script:SwaNearestRegion[$r] }
    switch (ConvertTo-PowerPlatformGeo -AzureRegion $r) {
        { $_ -in @('europe','unitedkingdom','france','germany','switzerland','norway','southafrica') } { return 'westeurope' }
        { $_ -in @('asia','australia','japan','korea','india','unitedarabemirates') }                  { return 'eastasia' }
        default                                                                                        { return 'centralus' }   # Americas + last resort
    }
}

function Resolve-SwaRegion {
    <#
        Returns the requested SWA region if it is supported. Otherwise throws an
        actionable error naming the supported regions and the nearest match.
    #>
    param([Parameter(Mandatory)][string]$Requested)

    $r = $Requested.Trim().ToLowerInvariant().Replace(' ', '')
    if ($script:SwaSupportedRegions -contains $r) { return $r }

    $nearest = $script:SwaNearestRegion[$r]
    $hint = if ($nearest) { " Nearest supported region to '$Requested' is '$nearest'." } else { "" }
    throw "Static Web Apps is not available in region '$Requested'. Set staticWebApp.location in demo-config.local.json to one of: $($script:SwaSupportedRegions -join ', ').$hint Static content is served globally regardless of this choice; it only sets where the managed Functions run."
}

function Get-DemoConfig {
    <#
        Loads + validates demo-config.local.json. Throws a single, complete list of
        everything missing or still set to a placeholder, so the user fixes it once.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        # Validate the Foundry block needed to create the Computer-Use agent and run the
        # samples/foundry-w365a-runner backend (foundry.endpoint/agentName/modelDeployment/
        # apiVersion + a default orchestratorUrl). Used for -AgentBackend foundry|both.
        [switch]$RequireFoundry,
        # Additionally validate the fields that ONLY the deprecated SWA-managed /api path
        # consumes (appRegistration.clientId + foundry.tokenAudience). The first-class
        # runner backend does not use these, so they are gated on the legacy -IncludeFoundryAgent.
        [switch]$RequireLegacyFoundryApi,
        # Validate the handoffOrchestrator block (the current AI invocation path).
        [switch]$RequireOrchestrator
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        $sample = Join-Path (Split-Path -Parent $Path) 'demo-config.sample.json'
        throw "Config file '$Path' not found. Copy '$sample' to '$Path' and fill in your values (subscription, tenant, Static Web App, Foundry, app registration). It is git-ignored so nothing sensitive is committed."
    }

    try {
        $cfg = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        throw "Failed to parse '$Path' as JSON: $($_.Exception.Message)"
    }

    $problems = New-Object System.Collections.Generic.List[string]
    function Test-Field {
        param($Object, [string]$Name, [string]$Label, [switch]$AllowEmpty)
        $val = $null
        if ($Object) { $val = $Object.$Name }
        if (-not $AllowEmpty -and ([string]::IsNullOrWhiteSpace([string]$val) -or "$val" -match '^0{8}-' -or "$val" -match '[<>]')) {
            $problems.Add($Label)
        }
        return $val
    }

    # Low-touch resource naming. The globally-unique resource names (Static Web App,
    # Function app, Storage, Key Vault) may be left BLANK in the config. When blank, we
    # derive a stable, unique-per-subscription name so the user only has to provide
    # subscription, tenant, region and the Direct Line secret. The names are a
    # deterministic function of the subscription id, so re-runs AND teardown compute the
    # same names and reuse the same resources. Set an explicit name to override.
    function Set-OrAddProp {
        param($Object, [string]$Name, [string]$Value)
        if (-not $Object) { return }
        if ($Object.PSObject.Properties.Name -contains $Name) { $Object.$Name = $Value }
        else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
    }
    $nameSeed = "$([string]$cfg.azure.subscriptionId)|$([string]$cfg.azure.tenantId)"
    $nameSuffix = Get-DemoNameSuffix -Seed $nameSeed

    if ($cfg.staticWebApp -and [string]::IsNullOrWhiteSpace([string]$cfg.staticWebApp.name)) {
        Set-OrAddProp $cfg.staticWebApp 'name' "zava-ccaas-$nameSuffix"
        Write-Host "  [info] staticWebApp.name was blank; using auto-generated '$($cfg.staticWebApp.name)' (override by setting it explicitly)."
    }

    $orchOn = $true
    if ($cfg.handoffOrchestrator -and ($cfg.handoffOrchestrator.PSObject.Properties.Name -contains 'enabled')) {
        $orchOn = [bool]$cfg.handoffOrchestrator.enabled
    }
    if ($cfg.handoffOrchestrator -and $orchOn) {
        $oo = $cfg.handoffOrchestrator
        if ([string]::IsNullOrWhiteSpace([string]$oo.functionAppName)) {
            Set-OrAddProp $oo 'functionAppName' "zava-handoff-$nameSuffix"
            Write-Host "  [info] handoffOrchestrator.functionAppName was blank; using auto-generated '$($oo.functionAppName)'."
        }
        if ([string]::IsNullOrWhiteSpace([string]$oo.storageAccountName)) {
            Set-OrAddProp $oo 'storageAccountName' "zavahandoff$nameSuffix"
            Write-Host "  [info] handoffOrchestrator.storageAccountName was blank; using auto-generated '$($oo.storageAccountName)'."
        }
        if ([string]::IsNullOrWhiteSpace([string]$oo.keyVaultName)) {
            Set-OrAddProp $oo 'keyVaultName' "zava-handoff-kv-$nameSuffix"
            Write-Host "  [info] handoffOrchestrator.keyVaultName was blank; using auto-generated '$($oo.keyVaultName)'."
        }
    }

    Test-Field $cfg.azure 'subscriptionId' 'azure.subscriptionId' | Out-Null
    Test-Field $cfg.azure 'tenantId'       'azure.tenantId'       | Out-Null
    Test-Field $cfg.azure 'location'       'azure.location'       | Out-Null
    Test-Field $cfg.staticWebApp 'location'       'staticWebApp.location'       -AllowEmpty | Out-Null
    Test-Field $cfg.staticWebApp 'resourceGroup'  'staticWebApp.resourceGroup'  | Out-Null
    Test-Field $cfg.staticWebApp 'name'           'staticWebApp.name'           | Out-Null
    Test-Field $cfg.staticWebApp 'appLocation'    'staticWebApp.appLocation'    | Out-Null
    Test-Field $cfg.staticWebApp 'apiLocation'    'staticWebApp.apiLocation'    | Out-Null
    Test-Field $cfg.staticWebApp 'outputLocation' 'staticWebApp.outputLocation' | Out-Null

    # Backend selector. 'agentBackend' is optional (defaults to 'mcs'); when present it
    # must be one of mcs|foundry|both. This mirrors the -AgentBackend build param.
    if ($cfg.PSObject.Properties.Name -contains 'agentBackend') {
        $ab = [string]$cfg.agentBackend
        if (-not [string]::IsNullOrWhiteSpace($ab) -and ($ab.ToLowerInvariant() -notin @('mcs', 'foundry', 'both'))) {
            $problems.Add("agentBackend must be one of 'mcs', 'foundry', or 'both' (got '$ab')")
        }
    }

    # Foundry agent fields are needed both to create the Computer-Use agent (Deploy-Agent)
    # and to run the samples/foundry-w365a-runner backend. The runner authenticates with its
    # own @azure/identity credentials (its .env), so the SWA app registration is NOT required
    # here - that is gated separately on the legacy SWA /api path below.
    if ($RequireFoundry) {
        Test-Field $cfg.foundry 'endpoint'        'foundry.endpoint'        | Out-Null
        Test-Field $cfg.foundry 'agentName'       'foundry.agentName'       | Out-Null
        Test-Field $cfg.foundry 'modelDeployment' 'foundry.modelDeployment' | Out-Null
        Test-Field $cfg.foundry 'apiVersion'      'foundry.apiVersion'      | Out-Null
        # Desktop endpoint for the Foundry + W365A backend: the local-orchestrator paired
        # with samples/foundry-w365a-runner (the orchestrator serves HTTP; the runner watches
        # its file-drop). Baked into the SPA as VITE_FOUNDRY_ORCHESTRATOR_URL. Defaults to the
        # standard local-orchestrator URL when left blank so a new user does not have to know
        # it up front.
        if ($cfg.foundry -and [string]::IsNullOrWhiteSpace([string]$cfg.foundry.orchestratorUrl)) {
            Set-OrAddProp $cfg.foundry 'orchestratorUrl' 'http://localhost:4000'
            Write-Host "  [info] foundry.orchestratorUrl was blank; using default '$($cfg.foundry.orchestratorUrl)' (the local-orchestrator paired with the W365A runner)."
        }
    }

    # The deprecated SWA-managed /api calls Foundry directly using the SWA's app registration
    # (client-credentials) and a token audience. Only that legacy opt-in path needs these; the
    # first-class runner backend does not.
    if ($RequireLegacyFoundryApi) {
        Test-Field $cfg.appRegistration 'clientId' 'appRegistration.clientId' | Out-Null
        Test-Field $cfg.foundry 'tokenAudience'   'foundry.tokenAudience'   | Out-Null
    }

    # The handoffOrchestrator (Durable Functions + Direct Line) is the current AI
    # invocation path and is deployed by default. Validate its inputs - including the
    # globally-unique resource names - eagerly so the user learns now, not 5 minutes in.
    $orchEnabled = $true
    if ($cfg.handoffOrchestrator -and ($cfg.handoffOrchestrator.PSObject.Properties.Name -contains 'enabled')) {
        $orchEnabled = [bool]$cfg.handoffOrchestrator.enabled
    }
    if ($RequireOrchestrator -and $orchEnabled) {
        $o = $cfg.handoffOrchestrator
        if (-not $o) {
            $problems.Add('handoffOrchestrator (entire block missing)')
        }
        else {
            $fnName = Test-Field $o 'functionAppName'    'handoffOrchestrator.functionAppName'
            $saName = Test-Field $o 'storageAccountName' 'handoffOrchestrator.storageAccountName'
            $kvName = Test-Field $o 'keyVaultName'       'handoffOrchestrator.keyVaultName'
            Test-Field $o 'resourceGroup'   'handoffOrchestrator.resourceGroup'   | Out-Null
            # directLineSecret is intentionally NOT required here. If it's blank, the
            # build auto-skips the orchestrator phase (you run the build again after you
            # publish the agent and paste the secret in). So a new user never has to
            # decide whether to pass -SkipOrchestrator - leaving the secret blank just
            # defers the orchestrator cleanly.

            # Globally-unique Azure name rules - fail fast with the exact constraint.
            if ($saName -and ([string]$saName -notmatch '^[a-z0-9]{3,24}$')) {
                $problems.Add("handoffOrchestrator.storageAccountName must be 3-24 chars, lowercase letters and digits only")
            }
            if ($fnName -and ([string]$fnName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9-]{0,58}[a-zA-Z0-9]$')) {
                $problems.Add("handoffOrchestrator.functionAppName must be 2-60 chars: letters/digits/hyphens, starting and ending alphanumeric")
            }
            if ($kvName -and (([string]$kvName -notmatch '^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$') -or ([string]$kvName -match '--'))) {
                $problems.Add("handoffOrchestrator.keyVaultName must be 3-24 chars, start with a letter, letters/digits/hyphens, no consecutive hyphens")
            }
        }
    }

    # --- Two-machine targeting (see demo-config.sample.json: agentPool vs agentWorkstation) ---
    # Fail with a clear migration message if an OLD-shape config (intune / ccaasWebLink) is
    # still in use, so a stale local config is rewritten rather than silently ignored.
    if (($cfg.PSObject.Properties.Name -contains 'intune') -or ($cfg.PSObject.Properties.Name -contains 'ccaasWebLink')) {
        if (-not ($cfg.PSObject.Properties.Name -contains 'agentPool')) {
            throw "demo-config: the 'intune' and 'ccaasWebLink' blocks are obsolete. Replace them with 'agentPool' { deviceGroupName, scopeTagName, pilotCloudPcName } and 'agentWorkstation' { userGroupName, agentUserName, webLink { displayName, url } }. See scripts\demo-config.sample.json."
        }
    }
    Test-Field $cfg.agentPool 'deviceGroupName' 'agentPool.deviceGroupName' | Out-Null
    Test-Field $cfg.agentPool 'scopeTagName'    'agentPool.scopeTagName'    | Out-Null
    Test-Field $cfg.agentWorkstation 'userGroupName' 'agentWorkstation.userGroupName' | Out-Null
    Test-Field $cfg.agentWorkstation.webLink 'displayName' 'agentWorkstation.webLink.displayName' | Out-Null

    if ($problems.Count -gt 0) {
        $msg = "demo-config.local.json is incomplete. Fill in these field(s): $($problems -join ', '). See scripts\demo-config.sample.json for guidance."
        if ($problems | Where-Object { $_ -like 'foundry.*' }) {
            $msg += " The Foundry backend needs a Microsoft Foundry project first: create or locate one, then copy its Project endpoint into foundry.endpoint. Step-by-step (project + resource, RBAC, computer-use-preview access and deployment): docs\agent-cua-setup.md > 'Prerequisites (one-time, greenfield)'."
        }
        throw $msg
    }

    # Region: any user in any region can run this. staticWebApp.location may be left BLANK;
    # derive the nearest supported SWA region from the workload region so the user does not
    # have to know SWA's limited region list. An explicit value is validated strictly.
    if ([string]::IsNullOrWhiteSpace([string]$cfg.staticWebApp.location)) {
        $derived = Get-NearestSwaRegion -AzureRegion ([string]$cfg.azure.location)
        $cfg.staticWebApp.location = $derived
        Write-Host "  [info] staticWebApp.location was blank; using nearest supported SWA region '$derived' for workload region '$($cfg.azure.location)'."
    }

    # Validate the SWA region eagerly so the user learns now, not 5 minutes in.
    $null = Resolve-SwaRegion -Requested $cfg.staticWebApp.location

    # Orchestrator location may be left BLANK - default it to the workload region
    # (Functions/Storage/Key Vault are available in effectively all regions).
    if ($RequireOrchestrator -and $orchEnabled -and $cfg.handoffOrchestrator) {
        $o = $cfg.handoffOrchestrator
        $hasLoc = $o.PSObject.Properties.Name -contains 'location'
        if (-not $hasLoc) {
            $o | Add-Member -NotePropertyName location -NotePropertyValue ([string]$cfg.azure.location)
        }
        elseif ([string]::IsNullOrWhiteSpace([string]$o.location)) {
            $o.location = [string]$cfg.azure.location
            Write-Host "  [info] handoffOrchestrator.location was blank; using workload region '$($cfg.azure.location)'."
        }
    }

    return $cfg
}

function Test-CommandAvailable {
    param([Parameter(Mandatory)][string]$Name)
    [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-Prerequisite {
    <#
        Fails fast if a required external tool is missing OR broken, with the exact
        install command. -Optional only warns. Returns nothing; throws on hard failures.

        A tool is "broken" when it is on PATH (a shim exists) but 'tool --version'
        does not exit 0 / does not emit a sane version string. This catches e.g. an
        npm-installed Azure Functions Core Tools shim whose target binary is missing
        (func --version => "spawn ...\bin/func ENOENT"), which previously slipped
        through as OK and only failed much later during publish.

        -VersionPattern, when supplied, must match the first non-empty output line of
        'tool --version' (in addition to requiring a zero exit code).
    #>
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$InstallHint,
        [string]$VersionPattern,
        [switch]$Optional
    )
    if (Test-CommandAvailable -Name $Name) {
        $out = $null
        $exit = $null
        try {
            $out = (& $Name --version 2>&1)
            $exit = $LASTEXITCODE
        }
        catch {
            $out = $_.Exception.Message
            $exit = 1
        }
        $firstLine = (($out | ForEach-Object { [string]$_ }) | Where-Object { $_.Trim() } | Select-Object -First 1)
        $broken = ($exit -ne 0) -or ($VersionPattern -and ($firstLine -notmatch $VersionPattern))
        if (-not $broken) {
            Write-Host "  [ok]   $Name $firstLine"
            return
        }
        # On PATH but not working: surface the diagnostic instead of reporting OK.
        $detail = if ($firstLine) { " ($firstLine)" } else { '' }
        if ($Optional) {
            Write-Warning "  [warn] '$Name' is on PATH but appears broken$detail. $InstallHint"
            return
        }
        throw "Required tool '$Name' is on PATH but appears broken (exit $exit)$detail. $InstallHint"
    }
    if ($Optional) {
        Write-Warning "  [warn] '$Name' not found. $InstallHint"
        return
    }
    throw "Required tool '$Name' is not on PATH. $InstallHint"
}

function Format-NativeCommand {
    # Render argv for logging, quoting args that contain whitespace.
    param([string]$File, [string[]]$Arguments)
    $parts = foreach ($a in $Arguments) { if ($a -match '\s') { '"' + $a + '"' } else { $a } }
    return ("$File " + ($parts -join ' ')).Trim()
}

function Invoke-Native {
    <#
        Runs an external command (az / npm / npx) with:
          - -WhatIf support: prints the (redacted) command and does nothing.
          - secret safety: -NoEcho hides args from logs; -SecretEnv injects secrets
            via environment variables that are removed again in a finally block.
          - error recording: non-zero exit throws with the captured output unless
            -AllowNonZero, in which case the result is returned for inspection.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$Arguments = @(),
        [string]$Action,
        [hashtable]$SecretEnv,
        [switch]$NoEcho,
        [switch]$AllowNonZero
    )

    $display = if ($NoEcho) { "$File <arguments hidden>" } else { Format-NativeCommand -File $File -Arguments $Arguments }
    if ($Action) { Write-Host "  -> $Action" }

    if ($WhatIfPreference) {
        Write-Host "     [WhatIf] would run: $display" -ForegroundColor Yellow
        return [pscustomobject]@{ ExitCode = 0; Output = @(); WhatIf = $true }
    }

    if (-not (Test-CommandAvailable -Name $File)) {
        throw "Cannot run '$File': it is not on PATH."
    }

    $added = @()
    try {
        if ($SecretEnv) {
            foreach ($k in $SecretEnv.Keys) {
                Set-Item -Path "Env:$k" -Value ([string]$SecretEnv[$k])
                $added += $k
            }
        }
        Write-Host "     run: $display"
        $output = & $File @Arguments 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        foreach ($k in $added) { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue }
    }

    if ($code -ne 0 -and -not $AllowNonZero) {
        $tail = ($output | Select-Object -Last 20) -join [Environment]::NewLine
        throw "Command failed (exit $code): $display`n$tail"
    }
    return [pscustomobject]@{ ExitCode = $code; Output = $output; WhatIf = $false }
}

function Write-AppSettingsFile {
    <#
        Serializes Function/Web app settings to a JSON object file for use with
        'az ... appsettings set --settings @<file>'.

        On Windows 'az' is a batch wrapper (az.cmd) that re-parses arguments through
        cmd.exe. Passing 'KEY=VALUE' settings inline breaks when a value contains
        cmd metacharacters such as the '(' ';' ')' in a Key Vault reference like
        '@Microsoft.KeyVault(VaultName=...;SecretName=...)' (cmd reports e.g.
        "DIRECTLINE_TOKEN_ENDPOINT was unexpected at this time"). Routing the values
        through an '@file' avoids cmd.exe interpretation entirely, since the only
        inline argument ('@<path>') contains no special characters.

        $Settings is an ordered map of name -> value. Returns the temp file path.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Settings
    )

    $obj = [ordered]@{}
    foreach ($key in $Settings.Keys) { $obj[$key] = [string]$Settings[$key] }

    $path = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "demo-appsettings-$([guid]::NewGuid().ToString('N')).json")
    ($obj | ConvertTo-Json -Depth 5) | Set-Content -Path $path -Encoding UTF8
    return $path
}

function Connect-DemoAzureCli {
    <#
        Ensures the Azure CLI is signed into the right tenant + subscription. Idempotent:
        reuses an existing session when it already points at the configured subscription.
    #>
    param(
        [Parameter(Mandatory)]$Config,
        [switch]$DeviceCode
    )
    $subId = $Config.azure.subscriptionId
    $tenantId = $Config.azure.tenantId

    $current = (& az account show --query id -o tsv 2>$null)
    if ($LASTEXITCODE -eq 0 -and $current -eq $subId) {
        Write-Host "  [ok]   Azure CLI already signed in to subscription $subId"
        return
    }

    if ($WhatIfPreference) {
        Write-Host "     [WhatIf] would: az login --tenant $tenantId; az account set --subscription $subId" -ForegroundColor Yellow
        return
    }

    Write-Host "  Signing in to Azure (tenant $tenantId)..."
    $loginArgs = @('login', '--tenant', $tenantId)
    if ($DeviceCode) { $loginArgs += '--use-device-code' }
    Invoke-Native -File 'az' -Arguments $loginArgs -Action 'az login' | Out-Null
    Invoke-Native -File 'az' -Arguments @('account', 'set', '--subscription', $subId) -Action 'select subscription' | Out-Null
}

function Get-SwaPaths {
    # Resolve repo-relative SWA paths to absolute, validating they exist.
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$RepoRoot)
    $app = Join-Path $RepoRoot ($Config.staticWebApp.appLocation -replace '/', '\')
    $api = Join-Path $RepoRoot ($Config.staticWebApp.apiLocation -replace '/', '\')
    $out = Join-Path $RepoRoot ($Config.staticWebApp.outputLocation -replace '/', '\')
    if (-not (Test-Path -LiteralPath $app)) { throw "staticWebApp.appLocation does not exist: $app" }
    if (-not (Test-Path -LiteralPath $api)) { throw "staticWebApp.apiLocation does not exist: $api" }
    return [pscustomobject]@{ App = $app; Api = $api; Output = $out }
}

function New-DemoRandomKey {
    # ASCII-only strong random key (letters + digits), default 48 chars. Used to
    # auto-generate the result-callback shared key when the user leaves it blank.
    param([int]$Length = 48)
    $chars = @( (48..57) + (65..90) + (97..122) | ForEach-Object { [char]$_ } )
    -join (1..$Length | ForEach-Object { $chars | Get-Random })
}

function Register-DemoProvider {
    # Best-effort idempotent resource-provider registration so a brand-new
    # subscription does not fail with an opaque ARM error (e.g. "subscription is
    # not registered for provider namespace Microsoft.Web"). Never throws.
    #
    # 'az provider register' is asynchronous: it returns immediately while ARM
    # moves the provider from NotRegistered -> Registering -> Registered over
    # ~30-120s. Pass -Wait to block (with a timeout) until it reaches Registered
    # before the caller creates resources in that namespace.
    param(
        [Parameter(Mandatory)][string]$Namespace,
        [switch]$Wait,
        [int]$TimeoutSeconds = 300
    )
    if ($WhatIfPreference) { Write-Host "     [WhatIf] would ensure resource provider '$Namespace' is registered" -ForegroundColor Yellow; return }
    $state = (& az provider show --namespace $Namespace --query registrationState -o tsv 2>$null)
    if ($state -eq 'Registered') { Write-Host "  [ok]   resource provider $Namespace registered"; return }
    Write-Host "  Registering resource provider $Namespace (current state: $state)..."
    Invoke-Native -File 'az' -Arguments @('provider', 'register', '--namespace', $Namespace) -Action "register provider $Namespace" -AllowNonZero | Out-Null
    if (-not $Wait) { return }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        $state = (& az provider show --namespace $Namespace --query registrationState -o tsv 2>$null)
        if ($state -eq 'Registered') { Write-Host "  [ok]   resource provider $Namespace registered"; return }
        Write-Host "  ... waiting for $Namespace to register (state: $state)"
    }
    Write-Warning "  Resource provider $Namespace did not reach 'Registered' within $TimeoutSeconds s (last state: $state). The next create may fail; rerun the script once 'az provider show --namespace $Namespace --query registrationState -o tsv' reports 'Registered'."
}

function ConvertTo-PowerPlatformGeo {
    # Map an Azure region (e.g. 'australiaeast') to the Power Platform geo code the
    # BAP environments API reports in its top-level 'location' field (e.g. 'australia').
    # Implements "use the region the user gave, or the CLOSEST available geo": every
    # real Azure region resolves to a supported Power Platform geography. Returns $null
    # only for blank/garbage input so callers can skip the comparison.
    param([string]$AzureRegion)
    if ([string]::IsNullOrWhiteSpace($AzureRegion)) { return $null }
    $r = $AzureRegion.Trim().ToLowerInvariant().Replace(' ', '')
    switch -Regex ($r) {
        '^australia|^newzealand'                       { return 'australia' }
        '^(eastus|westus|centralus|southcentralus|northcentralus|westcentralus|mexico)' { return 'unitedstates' }
        '^uk'                                          { return 'unitedkingdom' }
        '^canada'                                      { return 'canada' }
        '^(westeurope|northeurope|sweden|poland|italy|spain|austria|belgium|denmark|finland|greece|ireland|netherlands)' { return 'europe' }
        '^japan'                                       { return 'japan' }
        '^(centralindia|southindia|westindia|jioindia)'{ return 'india' }
        '^korea'                                       { return 'korea' }
        '^(southeastasia|eastasia|indonesia|malaysia|singapore|taiwan|china|hongkong|philippines|thailand|vietnam)' { return 'asia' }
        '^brazil|^chile|^argentina'                    { return 'southamerica' }
        '^france'                                      { return 'france' }
        '^germany'                                     { return 'germany' }
        '^switzerland'                                 { return 'switzerland' }
        '^norway'                                      { return 'norway' }
        '^southafrica'                                 { return 'southafrica' }
        '^(uaenorth|uaecentral|qatar|israel|saudi|kuwait|bahrain|oman)' { return 'unitedarabemirates' }
        default                                        { return 'unitedstates' }   # last-resort closest for an unrecognised region
    }
}

function Test-CopilotStudioReady {
    # Read-only preflight (advisory; NEVER throws). Copilot Studio stores the agent
    # in Dataverse, so an environment with databaseType 'None' only ever shows the
    # loading donut (README Step 3 is then blocked). This warns EARLY - during the
    # build - if no Dataverse-backed Power Platform environment exists, instead of
    # letting the user discover it later at the portal. It cannot create the agent
    # (no public API) or provision Dataverse (a licensed, opinionated, async tenant
    # action); it only detects and points at docs/build-the-agent.md.
    #
    # It also surfaces each Dataverse environment's GEOGRAPHY and warns when none
    # matches the configured workload region: the Copilot Studio Computer Use Cloud
    # PC pool inherits the ENVIRONMENT's geography, not azure.location, so a US
    # environment yields a US (Central US) pool even when azure.location is Australia.
    [CmdletBinding()]
    param([string]$WorkloadRegion)

    Write-Host "`n=== Preflight: Copilot Studio environment (Dataverse) ==="
    # Whole body is guarded: this preflight is advisory and must NEVER turn into a
    # build failure (Invoke-Step would mark it FAILED on any terminating error).
    try {
        $tenant = (& az account show --query tenantId -o tsv 2>$null)
        $token = (& az account get-access-token --resource "https://service.powerapps.com/" --query accessToken -o tsv 2>$null)
        if ([string]::IsNullOrWhiteSpace($token)) {
            Write-Host "  [skip] No Power Platform token (az not signed in, or no Power Platform access). Skipping; verify Copilot Studio manually per docs/build-the-agent.md (Preflight)." -ForegroundColor Yellow
            return
        }
        if (-not [string]::IsNullOrWhiteSpace($tenant)) {
            Write-Host ("  Checking the tenant the Azure CLI is currently signed in to: {0}" -f $tenant)
        }

        # Page through all environments (the BAP API returns a nextLink for large
        # tenants; reading only the first page risks a false 'no Dataverse' warning).
        $headers = @{ Authorization = "Bearer $token" }
        $uri = 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments?api-version=2020-10-01&$expand=properties'
        $envs = @()
        while (-not [string]::IsNullOrWhiteSpace($uri)) {
            $resp = Invoke-RestMethod -Headers $headers -Uri $uri -ErrorAction Stop
            $envs += @($resp.value)
            $uri = $resp.nextLink
        }

        $dataverse = @($envs | Where-Object { $_.properties.databaseType -eq 'CommonDataService' })
        if ($dataverse.Count -gt 0) {
            Write-Host "  [ok]   Dataverse-backed environment(s) found (Copilot Studio Step 3 can use one):"
            foreach ($e in $dataverse) {
                $envGeo = if ($e.PSObject.Properties.Name -contains 'location') { [string]$e.location } else { '' }
                $geoLabel = if ([string]::IsNullOrWhiteSpace($envGeo)) { 'unknown geography' } else { "geography: $envGeo" }
                Write-Host ("           - {0}  (id: {1}; {2})" -f $e.properties.displayName, $e.name, $geoLabel)
            }
            Write-Host "         Pick one of these in the Copilot Studio environment picker when you build the agent."

            # Region/geography advisory: the Computer Use Cloud PC pool inherits the
            # ENVIRONMENT's geography, not azure.location. Warn if the configured
            # workload region maps to a geo that none of the Dataverse environments use.
            $wantGeo = ConvertTo-PowerPlatformGeo -AzureRegion $WorkloadRegion
            if ($wantGeo) {
                $geos = @($dataverse | ForEach-Object { if ($_.PSObject.Properties.Name -contains 'location') { ([string]$_.location).ToLowerInvariant() } } | Where-Object { $_ })
                if ($geos.Count -gt 0 -and -not ($geos -contains $wantGeo)) {
                    Write-Host ""
                    Write-Host ("  [warn] You configured azure.location '{0}' (Power Platform geo '{1}'), but no Dataverse" -f $WorkloadRegion, $wantGeo) -ForegroundColor Yellow
                    Write-Host ("         environment above is in that geo (found: {0})." -f (($geos | Sort-Object -Unique) -join ', ')) -ForegroundColor Yellow
                    Write-Host "         IMPORTANT: the Computer Use Cloud PC pool inherits its ENVIRONMENT's geography, NOT" -ForegroundColor Yellow
                    Write-Host "         azure.location. If you build the agent in one of these environments, the agent's" -ForegroundColor Yellow
                    Write-Host ("         Cloud PC pool (and CPCPool_* devices) will be created in '{0}', not '{1}'." -f ($geos | Sort-Object -Unique | Select-Object -First 1), $wantGeo) -ForegroundColor Yellow
                    Write-Host "         To get the pool in your configured region, first create a Dataverse environment in" -ForegroundColor Yellow
                    Write-Host ("         the '{0}' geo (admin.powerplatform.microsoft.com -> Environments -> New) and build the" -f $wantGeo) -ForegroundColor Yellow
                    Write-Host "         agent there. See docs/w365a-pool.md (geography) and docs/build-the-agent.md." -ForegroundColor Yellow
                }
                elseif ($geos -contains $wantGeo) {
                    Write-Host ("         [ok] A Dataverse environment exists in your configured geo '{0}' - build the agent there so the Cloud PC pool lands in the right region." -f $wantGeo)
                }
            }

            Write-Host "         Note: this only confirms Dataverse exists - it does NOT validate Copilot Studio"
            Write-Host "         licensing, region availability, or your maker access in that environment."
            Write-Host "         If publishing the agent later shows a '60-day trial' prompt, see"
            Write-Host "         docs/licensing-and-entitlement.md (durable pay-as-you-go entitlement)."
            return
        }

        Write-Host ""
        Write-Host "  [warn] No Dataverse-backed Power Platform environment was found in this tenant." -ForegroundColor Yellow
        Write-Host "         Copilot Studio (README Step 3) requires Dataverse; without it the portal only" -ForegroundColor Yellow
        Write-Host "         ever shows the spinning 'loading donut', so you cannot create the agent or get" -ForegroundColor Yellow
        Write-Host "         its Direct Line secret. This does NOT block the rest of this build." -ForegroundColor Yellow
        if ($envs.Count -gt 0) {
            Write-Host "         Environments seen (all without Dataverse):" -ForegroundColor Yellow
            foreach ($e in $envs) {
                Write-Host ("           - {0}  (databaseType: {1})" -f $e.properties.displayName, $e.properties.databaseType) -ForegroundColor Yellow
            }
        }
        Write-Host "         Fix before Step 3: in the Power Platform admin center" -ForegroundColor Yellow
        Write-Host "         (https://admin.powerplatform.microsoft.com -> Environments -> New) create a" -ForegroundColor Yellow
        Write-Host "         Production or Sandbox environment WITH a Dataverse data store, in a region" -ForegroundColor Yellow
        Write-Host "         where Copilot Studio + Computer Use are available. Details:" -ForegroundColor Yellow
        $wantGeo = ConvertTo-PowerPlatformGeo -AzureRegion $WorkloadRegion
        if ($wantGeo) {
            Write-Host ("         Pick the '{0}' geo to match azure.location '{1}' so the Cloud PC pool lands in your" -f $wantGeo, $WorkloadRegion) -ForegroundColor Yellow
            Write-Host "         region (the pool inherits the ENVIRONMENT's geography, not azure.location)." -ForegroundColor Yellow
        }
        Write-Host "         docs/build-the-agent.md (Preflight)." -ForegroundColor Yellow
        Write-Host ""
    }
    catch {
        Write-Host "  [skip] Could not complete the Copilot Studio preflight ($($_.Exception.Message)). Skipping; verify Copilot Studio manually per docs/build-the-agent.md (Preflight)." -ForegroundColor Yellow
        return
    }
}

function New-DemoHandoffOrchestrator {
    <#
        Deploys the standalone Azure Durable Functions handoff orchestrator
        (apps/handoff-orchestrator) that drives the published Microsoft Copilot
        Studio agent over Bot Framework Direct Line. Idempotent and -WhatIf-safe.

        Creates (or reuses) the resource group, a Storage account (Durable backing
        store), the Function app (Linux consumption, Node 24, Functions v4, with a
        system-assigned managed identity), and a Key Vault (access-policy mode for
        deterministic identity grants). Stores the Direct Line secret + the result-
        callback key in Key Vault, grants the Function app's identity GET on them,
        wires them into the app as Key Vault references, publishes the code, and
        restarts the app so the references resolve.

        Returns { FunctionAppName, ResourceGroup, Location, BaseUrl, CallbackKey,
        KeyVaultName }. BaseUrl ends in /api so the desktop SPA (which appends
        /handoff, /health, ...) points straight at the Functions routes.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$RepoRoot
    )

    Write-Host "`n=== AI handoff backend: Azure Durable Functions orchestrator (Copilot Studio + Direct Line) ==="
    $o = $Config.handoffOrchestrator
    if (-not $o) { throw "handoffOrchestrator config block is missing. See scripts\demo-config.sample.json." }

    $rg  = [string]$o.resourceGroup
    $loc = if ([string]::IsNullOrWhiteSpace([string]$o.location)) { [string]$Config.azure.location } else { [string]$o.location }
    $fn  = [string]$o.functionAppName
    $sa  = [string]$o.storageAccountName
    $kv  = [string]$o.keyVaultName

    $appDir = Join-Path $RepoRoot 'apps\handoff-orchestrator'
    if (-not (Test-Path -LiteralPath $appDir)) { throw "handoff-orchestrator app folder not found: $appDir" }

    # Optional values with safe defaults (mirror apps/handoff-orchestrator/src/config.js).
    $channel   = if ([string]::IsNullOrWhiteSpace([string]$o.channel)) { 'directline' } else { [string]$o.channel }
    $dlBaseUrl = if ([string]::IsNullOrWhiteSpace([string]$o.directLineBaseUrl)) { 'https://directline.botframework.com' } else { [string]$o.directLineBaseUrl }
    $trigger   = if ([string]::IsNullOrWhiteSpace([string]$o.triggerText)) { 'A customer phone call has been handed off to you for automated processing. Using the caller phone, policy number, intent, and summary from the handoff context, open the Zava Mutual Claims Workstation and file a new First Notice of Loss, then return the resulting claim ID.' } else { [string]$o.triggerText }
    $pollMs    = if ($o.pollIntervalMs) { [int]$o.pollIntervalMs } else { 5000 }
    $execMs    = if ($o.executionTimeoutMs) { [int]$o.executionTimeoutMs } else { 900000 }
    $dlSecret  = [string]$o.directLineSecret
    $dlTokenEndpoint = [string]$o.directLineTokenEndpoint

    # Direct-to-Engine (channel pva-engine-direct) config - the CUA-supported path (#112).
    # Mirrors the ENGINE_* settings in apps/handoff-orchestrator/src/config.js. Only used
    # when channel = engine; secrets (client secret / token) go to Key Vault like the
    # Direct Line secret.
    $eng = $o.engine
    $engConversationsUrl = if ($eng) { [string]$eng.conversationsUrl } else { '' }
    $engTenantId         = if ($eng) { [string]$eng.tenantId } else { '' }
    $engClientId         = if ($eng) { [string]$eng.clientId } else { '' }
    $engClientSecret     = if ($eng) { [string]$eng.clientSecret } else { '' }
    $engScope            = if ($eng) { [string]$eng.scope } else { '' }
    $engToken            = if ($eng) { [string]$eng.token } else { '' }
    $engTokenEndpoint    = if ($eng) { [string]$eng.tokenEndpoint } else { '' }
    $isEngineChannel     = ($channel -in @('engine', 'directtoengine', 'pva-engine-direct'))

    # 0) Resource providers (best-effort; never blocks). Wait until registered so
    #    the storage/function/key-vault creates below do not race ARM.
    Register-DemoProvider -Namespace 'Microsoft.Web' -Wait
    Register-DemoProvider -Namespace 'Microsoft.Storage' -Wait
    Register-DemoProvider -Namespace 'Microsoft.KeyVault' -Wait

    # 1) Resource group (idempotent).
    $rgExists = (& az group exists --name $rg 2>$null)
    if ($rgExists -eq 'true') { Write-Host "  [ok]   resource group '$rg' exists" }
    elseif ($PSCmdlet.ShouldProcess($rg, 'Create resource group')) {
        Invoke-Native -File 'az' -Arguments @('group', 'create', '--name', $rg, '--location', $loc, '--tags', 'app=zava-ccaas-demo') -Action "create resource group '$rg'" | Out-Null
    }

    # 2) Storage account (Durable Functions backing store).
    $saExists = (& az storage account show --name $sa --resource-group $rg --query id -o tsv 2>$null)
    if ($LASTEXITCODE -eq 0 -and $saExists) {
        Write-Host "  [ok]   storage account '$sa' exists"
    }
    else {
        if (-not $WhatIfPreference) {
            $avail = (& az storage account check-name --name $sa --query nameAvailable -o tsv 2>$null)
            if ($avail -eq 'false') { throw "Storage account name '$sa' is not available (globally taken). Choose a different handoffOrchestrator.storageAccountName." }
        }
        if ($PSCmdlet.ShouldProcess($sa, "Create storage account in $loc")) {
            Invoke-Native -File 'az' -Arguments @('storage', 'account', 'create', '--name', $sa, '--resource-group', $rg, '--location', $loc, '--sku', 'Standard_LRS', '--kind', 'StorageV2', '--min-tls-version', 'TLS1_2', '--tags', 'app=zava-ccaas-demo') -Action "create storage account '$sa'" | Out-Null
        }
    }

    # 3) Function app (Linux consumption, Node 24, Functions v4, system-assigned MI).
    #    Node 24 is required: Azure rejects new Function apps on Node 20 (EOL 2026-04-30).
    $fnExists = (& az functionapp show --name $fn --resource-group $rg --query id -o tsv 2>$null)
    if ($LASTEXITCODE -eq 0 -and $fnExists) {
        Write-Host "  [ok]   function app '$fn' exists"
        if ($PSCmdlet.ShouldProcess($fn, 'Ensure system-assigned identity')) {
            Invoke-Native -File 'az' -Arguments @('functionapp', 'identity', 'assign', '--name', $fn, '--resource-group', $rg) -Action 'ensure managed identity' -AllowNonZero | Out-Null
        }
        # Idempotently bring an app previously created on an EOL Node runtime up to
        # Node 24. Best-effort: a failure here must never block the build.
        if ($PSCmdlet.ShouldProcess($fn, 'Ensure Node 24 runtime')) {
            Invoke-Native -File 'az' -Arguments @('functionapp', 'config', 'set', '--name', $fn, '--resource-group', $rg, '--linux-fx-version', 'node|24') -Action 'ensure Node 24 runtime' -AllowNonZero | Out-Null
        }
    }
    elseif ($PSCmdlet.ShouldProcess($fn, "Create Function app in $loc")) {
        Invoke-Native -File 'az' -Arguments @('functionapp', 'create', '--name', $fn, '--resource-group', $rg, '--storage-account', $sa, '--consumption-plan-location', $loc, '--runtime', 'node', '--runtime-version', '24', '--functions-version', '4', '--os-type', 'Linux', '--assign-identity', '[system]', '--tags', 'app=zava-ccaas-demo') -Action "create function app '$fn'" | Out-Null
    }

    # 4) Key Vault (access-policy mode = deterministic identity grants regardless of
    #    tenant RBAC defaults). Recover a soft-deleted vault of the same name if present.
    $kvRbac = $null
    $kvExists = (& az keyvault show --name $kv --query id -o tsv 2>$null)
    if ($LASTEXITCODE -eq 0 -and $kvExists) {
        Write-Host "  [ok]   key vault '$kv' exists"
        $kvRbac = (& az keyvault show --name $kv --query properties.enableRbacAuthorization -o tsv 2>$null)
    }
    else {
        if (-not $WhatIfPreference) {
            $deleted = (& az keyvault list-deleted --query "[?name=='$kv'].name" -o tsv 2>$null)
            if ($deleted) {
                Write-Host "  Recovering soft-deleted key vault '$kv'..."
                Invoke-Native -File 'az' -Arguments @('keyvault', 'recover', '--name', $kv) -Action "recover key vault '$kv'" -AllowNonZero | Out-Null
                $kvExists = (& az keyvault show --name $kv --query id -o tsv 2>$null)
                if ($kvExists) { $kvRbac = (& az keyvault show --name $kv --query properties.enableRbacAuthorization -o tsv 2>$null) }
            }
            if (-not $kvExists) {
                $kvAvail = (& az keyvault check-name --name $kv --query nameAvailable -o tsv 2>$null)
                if ($kvAvail -eq 'false') { throw "Key Vault name '$kv' is not available (globally taken). Choose a different handoffOrchestrator.keyVaultName." }
            }
        }
        if (-not $kvExists -and $PSCmdlet.ShouldProcess($kv, "Create key vault in $loc")) {
            Invoke-Native -File 'az' -Arguments @('keyvault', 'create', '--name', $kv, '--resource-group', $rg, '--location', $loc, '--enable-rbac-authorization', 'false', '--tags', 'app=zava-ccaas-demo') -Action "create key vault '$kv'" | Out-Null
            $kvRbac = 'false'
        }
    }
    $useRbac = ([string]$kvRbac -eq 'true')

    # 5) Secrets. The Direct Line secret is required; the callback key is auto-generated
    #    AND REUSED across runs (read back from the vault) so a configured Copilot Studio
    #    flow keeps working after a re-deploy.
    $callbackKey = [string]$o.callbackKey
    if ([string]::IsNullOrWhiteSpace($callbackKey)) {
        if ($WhatIfPreference) {
            $callbackKey = '<auto-generated-or-reused-at-deploy>'
        }
        else {
            $existingCb = (& az keyvault secret show --vault-name $kv --name 'HandoffCallbackKey' --query value -o tsv 2>$null)
            if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($existingCb)) {
                $callbackKey = $existingCb
                Write-Host "  [ok]   reusing existing HandoffCallbackKey from key vault"
            }
            else {
                $callbackKey = New-DemoRandomKey
                Write-Host "  [ok]   generated a new HandoffCallbackKey (stored in key vault; shown in the build summary)"
            }
        }
    }

    if ($PSCmdlet.ShouldProcess($kv, 'Store Direct Line + callback secrets')) {
        if (-not [string]::IsNullOrWhiteSpace($dlSecret)) {
            Invoke-Native -File 'az' -Arguments @('keyvault', 'secret', 'set', '--vault-name', $kv, '--name', 'DirectLineSecret', '--value', $dlSecret) -Action 'store Direct Line secret' -NoEcho | Out-Null
        }
        if (-not [string]::IsNullOrWhiteSpace($dlTokenEndpoint)) {
            Invoke-Native -File 'az' -Arguments @('keyvault', 'secret', 'set', '--vault-name', $kv, '--name', 'DirectLineTokenEndpoint', '--value', $dlTokenEndpoint) -Action 'store Direct Line token endpoint' -NoEcho | Out-Null
        }
        # Direct-to-Engine secrets (channel pva-engine-direct).
        if (-not [string]::IsNullOrWhiteSpace($engClientSecret)) {
            Invoke-Native -File 'az' -Arguments @('keyvault', 'secret', 'set', '--vault-name', $kv, '--name', 'EngineClientSecret', '--value', $engClientSecret) -Action 'store engine client secret' -NoEcho | Out-Null
        }
        if (-not [string]::IsNullOrWhiteSpace($engToken)) {
            Invoke-Native -File 'az' -Arguments @('keyvault', 'secret', 'set', '--vault-name', $kv, '--name', 'EngineToken', '--value', $engToken) -Action 'store engine token' -NoEcho | Out-Null
        }
        if ($isEngineChannel) {
            $engHasAuth = (-not [string]::IsNullOrWhiteSpace($engClientSecret)) -or (-not [string]::IsNullOrWhiteSpace($engToken)) -or (-not [string]::IsNullOrWhiteSpace($engTokenEndpoint))
            if ([string]::IsNullOrWhiteSpace($engConversationsUrl)) {
                Write-Warning "  channel=engine but handoffOrchestrator.engine.conversationsUrl is not set - the agent invocation will fail until you set it and re-run."
            }
            if (-not $engHasAuth) {
                Write-Warning "  channel=engine but no engine auth is set (engine.clientSecret + tenantId + clientId, OR engine.token / engine.tokenEndpoint) - the agent invocation will fail until you set one and re-run."
            }
        }
        elseif ([string]::IsNullOrWhiteSpace($dlSecret) -and [string]::IsNullOrWhiteSpace($dlTokenEndpoint)) {
            Write-Warning "  neither handoffOrchestrator.directLineSecret nor directLineTokenEndpoint is set - the agent invocation will fail until you set one and re-run."
        }
        Invoke-Native -File 'az' -Arguments @('keyvault', 'secret', 'set', '--vault-name', $kv, '--name', 'HandoffCallbackKey', '--value', $callbackKey) -Action 'store callback key' -NoEcho | Out-Null
    }

    # 6) Grant the Function app's managed identity GET on the secrets.
    $principalId = $null
    if (-not $WhatIfPreference) {
        $principalId = (& az functionapp identity show --name $fn --resource-group $rg --query principalId -o tsv 2>$null)
        if ([string]::IsNullOrWhiteSpace($principalId)) { throw "Could not read the Function app's managed identity principalId. Confirm '$fn' exists and has a system-assigned identity." }
    }
    if ($PSCmdlet.ShouldProcess($kv, 'Grant Function app identity GET on secrets')) {
        if ($useRbac) {
            $vaultId = (& az keyvault show --name $kv --query id -o tsv 2>$null)
            Invoke-Native -File 'az' -Arguments @('role', 'assignment', 'create', '--assignee-object-id', $principalId, '--assignee-principal-type', 'ServicePrincipal', '--role', 'Key Vault Secrets User', '--scope', $vaultId) -Action 'grant identity Key Vault Secrets User (RBAC vault)' -AllowNonZero | Out-Null
        }
        else {
            Invoke-Native -File 'az' -Arguments @('keyvault', 'set-policy', '--name', $kv, '--object-id', $principalId, '--secret-permissions', 'get') -Action 'grant identity GET on secrets (access-policy vault)' | Out-Null
        }
    }

    # 7) App settings: non-secret config + Key Vault references for the two secrets.
    #    Set AFTER the identity grant so the references can resolve. The reference
    #    strings carry only vault/secret NAMES (not secret values), so they are safe to log.
    if ($PSCmdlet.ShouldProcess($fn, 'Set Function app settings')) {
        $kvRefCb = "@Microsoft.KeyVault(VaultName=$kv;SecretName=HandoffCallbackKey)"
        $settings = [ordered]@{
            # Required for the Azure Functions v4 Node programming model: the host
            # indexes triggers from the worker. Without this flag, 'func publish'
            # uploads fine but "Syncing triggers..." returns BadRequest and the app
            # serves HTTP 503 for every route. (apps/handoff-orchestrator uses the
            # v4 model - programmatic app.* registration, no function.json.)
            AzureWebJobsFeatureFlags     = 'EnableWorkerIndexing'
            HANDOFF_CHANNEL              = $channel
            DIRECTLINE_BASE_URL          = $dlBaseUrl
            HANDOFF_TRIGGER_TEXT         = $trigger
            HANDOFF_POLL_INTERVAL_MS     = $pollMs
            HANDOFF_EXECUTION_TIMEOUT_MS = $execMs
            HANDOFF_CALLBACK_KEY         = $kvRefCb
        }
        # Reference only the auth secret(s) actually stored, so the Key Vault
        # references always resolve (a ref to a missing secret would 500 the app).
        if (-not [string]::IsNullOrWhiteSpace($dlSecret)) {
            $settings['DIRECTLINE_SECRET'] = "@Microsoft.KeyVault(VaultName=$kv;SecretName=DirectLineSecret)"
        }
        if (-not [string]::IsNullOrWhiteSpace($dlTokenEndpoint)) {
            $settings['DIRECTLINE_TOKEN_ENDPOINT'] = "@Microsoft.KeyVault(VaultName=$kv;SecretName=DirectLineTokenEndpoint)"
        }
        # Direct-to-Engine (channel pva-engine-direct): non-secret config inline,
        # secrets as Key Vault references (only when actually stored).
        if (-not [string]::IsNullOrWhiteSpace($engConversationsUrl)) {
            $settings['ENGINE_CONVERSATIONS_URL'] = $engConversationsUrl
        }
        if (-not [string]::IsNullOrWhiteSpace($engTenantId)) { $settings['ENGINE_TENANT_ID'] = $engTenantId }
        if (-not [string]::IsNullOrWhiteSpace($engClientId)) { $settings['ENGINE_CLIENT_ID'] = $engClientId }
        if (-not [string]::IsNullOrWhiteSpace($engScope))    { $settings['ENGINE_SCOPE'] = $engScope }
        if (-not [string]::IsNullOrWhiteSpace($engTokenEndpoint)) { $settings['ENGINE_TOKEN_ENDPOINT'] = $engTokenEndpoint }
        if (-not [string]::IsNullOrWhiteSpace($engClientSecret)) {
            $settings['ENGINE_CLIENT_SECRET'] = "@Microsoft.KeyVault(VaultName=$kv;SecretName=EngineClientSecret)"
        }
        if (-not [string]::IsNullOrWhiteSpace($engToken)) {
            $settings['ENGINE_TOKEN'] = "@Microsoft.KeyVault(VaultName=$kv;SecretName=EngineToken)"
        }
        # Pass settings via an @file so Key Vault reference values containing
        # '(' ';' ')' survive the az.cmd -> cmd.exe argument re-parsing on Windows.
        $settingsFile = Write-AppSettingsFile -Settings $settings
        try {
            $settingArgs = @('functionapp', 'config', 'appsettings', 'set', '--name', $fn, '--resource-group', $rg, '--settings', "@$settingsFile")
            Invoke-Native -File 'az' -Arguments $settingArgs -Action 'apply function app settings' | Out-Null
        }
        finally {
            Remove-Item -Path $settingsFile -ErrorAction SilentlyContinue
        }
    }

    # 8) Publish the function code. A brand-new consumption app may need a moment to
    #    become publishable, so retry a few times.
    if ($PSCmdlet.ShouldProcess($fn, 'Publish function code (func azure functionapp publish)')) {
        Push-Location $appDir
        try {
            Invoke-Native -File 'npm' -Arguments @('ci') -Action 'install orchestrator dependencies' | Out-Null
            $published = $false
            for ($attempt = 1; $attempt -le 6; $attempt++) {
                $r = Invoke-Native -File 'func' -Arguments @('azure', 'functionapp', 'publish', $fn, '--javascript') -Action "publish to '$fn' (attempt $attempt of 6)" -AllowNonZero
                if ($r.WhatIf -or $r.ExitCode -eq 0) { $published = $true; break }

                # Distinguish "still provisioning" (retryable) from a trigger-sync
                # failure (a config problem that retrying won't fix). The latter
                # means the package uploaded but the host could not index triggers.
                $outText = ($r.Output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
                if ($outText -match 'sync\s*triggers' -or $outText -match 'EnableWorkerIndexing') {
                    $tail = ($r.Output | Select-Object -Last 15) -join [Environment]::NewLine
                    throw @"
func publish to '$fn' uploaded the package but trigger sync failed (the Function host could not index triggers); the app will return HTTP 503.
This app uses the Azure Functions v4 Node programming model, which requires the app setting AzureWebJobsFeatureFlags=EnableWorkerIndexing on Linux Consumption.
Verify it is set:  az functionapp config appsettings list --name $fn --resource-group $rg --query "[?name=='AzureWebJobsFeatureFlags']"
If missing, set it and restart:  az functionapp config appsettings set --name $fn --resource-group $rg --settings AzureWebJobsFeatureFlags=EnableWorkerIndexing ; az functionapp restart --name $fn --resource-group $rg
Underlying publish output:
$tail
"@
                }

                Write-Warning "  publish attempt $attempt failed (exit $($r.ExitCode)); the app may still be provisioning. Waiting 20s..."
                Start-Sleep -Seconds 20
            }
            if (-not $published) { throw "func publish to '$fn' failed after 6 attempts. Confirm Azure Functions Core Tools v4 is installed (npm i -g azure-functions-core-tools@4) and the app exists." }
        }
        finally { Pop-Location }
    }

    # 9) Restart so the Key Vault references resolve with the freshly granted identity.
    if ($PSCmdlet.ShouldProcess($fn, 'Restart Function app')) {
        Invoke-Native -File 'az' -Arguments @('functionapp', 'restart', '--name', $fn, '--resource-group', $rg) -Action 'restart function app' -AllowNonZero | Out-Null
    }

    $apiBase = "https://$fn.azurewebsites.net/api"
    if ($WhatIfPreference) { Write-Host "  [WhatIf] orchestrator API base will be $apiBase" -ForegroundColor Yellow }
    else { Write-Host "  [ok]   orchestrator API base: $apiBase" -ForegroundColor Green }

    return [pscustomobject]@{
        FunctionAppName = $fn
        ResourceGroup   = $rg
        Location        = $loc
        BaseUrl         = $apiBase
        CallbackKey     = $callbackKey
        KeyVaultName    = $kv
    }
}

function Set-DemoHandoffOrchestratorCors {
    <#
        Idempotently allows the CCaaS web app origin to call the orchestrator Function
        app cross-origin (covers /api/health, /api/handoff, status polling). App-level
        CORS, so it applies to every route. Honours -WhatIf.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory)][string]$FunctionAppName,
        [Parameter(Mandatory)][string]$ResourceGroup,
        [Parameter(Mandatory)][string]$AllowedOrigin
    )
    $origin = ([string]$AllowedOrigin).TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($origin)) { Write-Warning "  No SWA origin available; skipping orchestrator CORS."; return }

    if (-not $WhatIfPreference) {
        $existing = (& az functionapp cors show --name $FunctionAppName --resource-group $ResourceGroup --query "allowedOrigins" -o tsv 2>$null)
        if ($existing -and (($existing -split "\s+") -contains $origin)) {
            Write-Host "  [ok]   CORS already allows $origin"
            return
        }
    }
    if ($PSCmdlet.ShouldProcess($FunctionAppName, "Allow CORS origin $origin")) {
        Invoke-Native -File 'az' -Arguments @('functionapp', 'cors', 'add', '--name', $FunctionAppName, '--resource-group', $ResourceGroup, '--allowed-origins', $origin) -Action "add CORS origin $origin" | Out-Null
    }
}

function Remove-DemoHandoffOrchestrator {
    <#
        Deletes the orchestrator Function app, Storage account and Key Vault.
        Preview-by-default: pass -Execute to actually delete. Key Vault is soft-deleted
        (name stays reserved) unless -PurgeKeyVault is also passed.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [switch]$Execute,
        [switch]$PurgeKeyVault
    )
    $o = $Config.handoffOrchestrator
    if (-not $o) { Write-Host "  No handoffOrchestrator config block - nothing to remove."; return }
    $rg = [string]$o.resourceGroup
    $fn = [string]$o.functionAppName
    $sa = [string]$o.storageAccountName
    $kv = [string]$o.keyVaultName

    $targets = @(
        [pscustomobject]@{ Kind = 'function app';    Name = $fn; Args = @('functionapp', 'delete', '--name', $fn, '--resource-group', $rg) },
        [pscustomobject]@{ Kind = 'storage account'; Name = $sa; Args = @('storage', 'account', 'delete', '--name', $sa, '--resource-group', $rg, '--yes') },
        [pscustomobject]@{ Kind = 'key vault';       Name = $kv; Args = @('keyvault', 'delete', '--name', $kv, '--resource-group', $rg) }
    )
    foreach ($t in $targets) {
        if ([string]::IsNullOrWhiteSpace($t.Name)) { continue }
        if (-not $Execute) { Write-Host "  [preview] would delete $($t.Kind) '$($t.Name)' (resource group '$rg')."; continue }
        Invoke-Native -File 'az' -Arguments $t.Args -Action "delete $($t.Kind) '$($t.Name)'" -AllowNonZero | Out-Null
        Write-Host "  Deleted $($t.Kind) '$($t.Name)' (if it existed)."
    }

    if ([string]::IsNullOrWhiteSpace($kv)) { return }
    if ($Execute -and $PurgeKeyVault) {
        Invoke-Native -File 'az' -Arguments @('keyvault', 'purge', '--name', $kv) -Action "purge soft-deleted key vault '$kv'" -AllowNonZero | Out-Null
        Write-Host "  Purged key vault '$kv' (name freed)."
    }
    elseif ($Execute) {
        Write-Host "  Note: key vault '$kv' is soft-deleted; its name stays reserved. Re-run with -PurgeKeyVault to free it, or the next deploy auto-recovers it."
    }
}

# Detect common Windows file-lock conditions that make the SPA 'npm ci' fail with EPERM
# while unlinking node_modules\@esbuild\win32-x64\esbuild.exe (issue #29). Returns a list
# of @{ Severity; Message } objects: 'Hard' problems (a running dev server, or esbuild.exe
# actually locked) should stop the build BEFORE partial work; 'Soft' ones (e.g. a OneDrive-
# synced tree) are warnings only, since that path is normal in this environment.
function Get-SpaBuildLockIssues {
    param([Parameter(Mandatory)][string]$AppPath)
    $issues = New-Object System.Collections.Generic.List[object]
    $appFull = try { (Resolve-Path -LiteralPath $AppPath -ErrorAction Stop).Path } catch { $AppPath }

    # 1) A dev server (vite / npm run dev) launched from this app dir keeps esbuild.exe open.
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            $cl = [string]$p.CommandLine
            if ($cl -and ($cl -match 'vite' -or $cl -match 'npm(\.cmd)?\s+run\s+dev') -and $cl -like "*$appFull*") {
                $issues.Add([pscustomobject]@{ Severity = 'Hard'; Message = "A dev server appears to be running from '$appFull' (PID $($p.ProcessId)). Stop it (close 'npm run dev' / vite) before building - it locks esbuild.exe." })
            }
        }
    }
    catch { }

    # 2) The esbuild binary is currently locked (opening it with no sharing fails).
    $esbuild = Join-Path $AppPath 'node_modules\@esbuild\win32-x64\esbuild.exe'
    if (Test-Path -LiteralPath $esbuild) {
        try {
            $fs = [System.IO.File]::Open($esbuild, 'Open', 'ReadWrite', 'None')
            $fs.Close(); $fs.Dispose()
        }
        catch {
            $issues.Add([pscustomobject]@{ Severity = 'Hard'; Message = "'$esbuild' is locked by another process. Close any running dev server / editor task-watcher, then retry. npm ci must delete this file and fails with EPERM while it is held." })
        }
    }

    # 3) A OneDrive-synced working tree can transiently lock files mid-unlink.
    if ($appFull -match '[\\/]OneDrive') {
        $issues.Add([pscustomobject]@{ Severity = 'Soft'; Message = "The working tree is under OneDrive ('$appFull'). Active sync can lock files during npm ci; if you hit EPERM, pause OneDrive sync or build from a non-synced path." })
    }

    return $issues
}

function New-DemoStaticWebApp {
    <#
        Creates (idempotently) the resource group + Free Static Web App, builds the
        SPA, deploys SPA + managed Functions API via the SWA CLI using a deployment
        token (passed by env var, never logged), pushes the /api app settings, and
        returns the public URL. Honours -WhatIf.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$RepoRoot,
        [string]$FoundryAgentId,
        # Base URL of the deployed handoff orchestrator (ends in /api). Baked into the
        # SPA build as VITE_ORCHESTRATOR_URL so the desktop points at it with no manual
        # config. When empty the SPA falls back to its built-in default ("/api").
        [string]$OrchestratorUrl,
        # Desktop endpoint for the Foundry + W365A backend (the local-orchestrator paired
        # with samples/foundry-w365a-runner - the orchestrator serves HTTP, the runner watches
        # its file-drop). Baked as VITE_FOUNDRY_ORCHESTRATOR_URL so
        # the SPA's backend toggle can switch to it. Empty => toggle hidden (single backend).
        [string]$FoundryOrchestratorUrl,
        # Which backend the SPA selects by default ('mcs' or 'foundry'). Baked as
        # VITE_DEFAULT_BACKEND. Defaults to 'mcs' when not supplied.
        [ValidateSet('mcs', 'foundry')]
        [string]$DefaultBackend = 'mcs',
        # Only set the legacy FOUNDRY_* / AZURE_CLIENT_SECRET /api app settings when the
        # opt-in Foundry path is in play. The default Copilot Studio path does not use
        # the SWA-managed /api, so these are skipped.
        [switch]$IncludeFoundry
    )

    Write-Host "`n=== Central CCaaS host: Azure Static Web Apps (Free) ==="
    $swa = $Config.staticWebApp
    $region = Resolve-SwaRegion -Requested $swa.location
    $rg = $swa.resourceGroup
    $name = $swa.name
    $paths = Get-SwaPaths -Config $Config -RepoRoot $RepoRoot

    # 0) Resource provider. A brand-new subscription is often NotRegistered for
    #    Microsoft.Web, which makes 'staticwebapp create' fail with an opaque ARM
    #    error. Register and wait (async) so the create below succeeds first time.
    Register-DemoProvider -Namespace 'Microsoft.Web' -Wait

    # 1) Resource group (idempotent). RG location is metadata only; use workload region.
    $rgExists = (& az group exists --name $rg 2>$null)
    if ($rgExists -eq 'true') {
        Write-Host "  [ok]   resource group '$rg' exists"
    }
    elseif ($PSCmdlet.ShouldProcess($rg, 'Create resource group')) {
        Invoke-Native -File 'az' -Arguments @('group', 'create', '--name', $rg, '--location', $Config.azure.location, '--tags', 'app=zava-ccaas-demo') -Action "create resource group '$rg'" | Out-Null
    }

    # 2) Static Web App (idempotent). No --source => standalone SWA we deploy to with a
    #    deployment token (no GitHub PAT, no CI wiring required).
    $exists = (& az staticwebapp show --name $name --resource-group $rg --query id -o tsv 2>$null)
    if ($LASTEXITCODE -eq 0 -and $exists) {
        Write-Host "  [ok]   static web app '$name' exists"
    }
    elseif ($PSCmdlet.ShouldProcess($name, "Create Free Static Web App in $region")) {
        Invoke-Native -File 'az' -Arguments @('staticwebapp', 'create', '--name', $name, '--resource-group', $rg, '--location', $region, '--sku', 'Free', '--tags', 'app=zava-ccaas-demo') -Action "create static web app '$name'" | Out-Null
    }

    # 3) Build the SPA (the API is built in the cloud by the SWA deploy/Oryx). When an
    #    orchestrator URL is supplied, bake it into the build via VITE_ORCHESTRATOR_URL
    #    so the deployed desktop points straight at the orchestrator with no manual config.
    if ($PSCmdlet.ShouldProcess($paths.App, 'npm ci + npm run build (SPA)')) {
        Push-Location $paths.App
        $bakeOrch = -not [string]::IsNullOrWhiteSpace($OrchestratorUrl)
        $bakeFoundry = -not [string]::IsNullOrWhiteSpace($FoundryOrchestratorUrl)
        # Snapshot the ambient values so the build is deterministic: we explicitly set
        # OR remove each VITE_* var below (never leave an inherited shell value in place,
        # which would otherwise flip the backend toggle on/off unexpectedly), then restore
        # the original environment in finally.
        $prevVite = if (Test-Path Env:VITE_ORCHESTRATOR_URL) { $env:VITE_ORCHESTRATOR_URL } else { $null }
        $prevFoundry = if (Test-Path Env:VITE_FOUNDRY_ORCHESTRATOR_URL) { $env:VITE_FOUNDRY_ORCHESTRATOR_URL } else { $null }
        $prevBackend = if (Test-Path Env:VITE_DEFAULT_BACKEND) { $env:VITE_DEFAULT_BACKEND } else { $null }
        try {
            if ($bakeOrch) {
                $env:VITE_ORCHESTRATOR_URL = $OrchestratorUrl
                Write-Host "  Baking VITE_ORCHESTRATOR_URL=$OrchestratorUrl into the SPA build."
            }
            else { Remove-Item Env:VITE_ORCHESTRATOR_URL -ErrorAction SilentlyContinue }
            if ($bakeFoundry) {
                $env:VITE_FOUNDRY_ORCHESTRATOR_URL = $FoundryOrchestratorUrl
                Write-Host "  Baking VITE_FOUNDRY_ORCHESTRATOR_URL=$FoundryOrchestratorUrl into the SPA build (enables the backend toggle)."
            }
            else { Remove-Item Env:VITE_FOUNDRY_ORCHESTRATOR_URL -ErrorAction SilentlyContinue }
            $env:VITE_DEFAULT_BACKEND = $DefaultBackend
            Write-Host "  Baking VITE_DEFAULT_BACKEND=$DefaultBackend into the SPA build."

            # Fail fast on file locks that would otherwise make 'npm ci' die mid-unlink with a
            # raw EPERM on esbuild.exe, leaving a half-cleaned node_modules (issue #29).
            $lockIssues = Get-SpaBuildLockIssues -AppPath $paths.App
            foreach ($s in @($lockIssues | Where-Object Severity -eq 'Soft')) { Write-Warning "  $($s.Message)" }
            $hard = @($lockIssues | Where-Object Severity -eq 'Hard')
            if ($hard.Count) {
                throw @"

ERROR: the SPA build can't safely run 'npm ci' - a file lock was detected:
$(($hard | ForEach-Object { "  - $($_.Message)" }) -join [Environment]::NewLine)
Resolve the above and re-run. (npm ci deletes node_modules first and fails with EPERM if esbuild.exe is held.)
"@
            }

            try {
                Invoke-Native -File 'npm' -Arguments @('ci') -Action 'install SPA dependencies' | Out-Null
            }
            catch {
                if ("$_" -match 'EPERM' -and "$_" -match 'esbuild') {
                    throw @"

ERROR: 'npm ci' failed with EPERM while removing esbuild.exe under node_modules.
This almost always means the binary is locked by a running process:
  - Stop any dev server started from apps\ccaas-agent-desktop (npm run dev / vite).
  - Close editors / file-watchers scanning node_modules.
  - If the repo is under OneDrive, pause sync (or build from a non-synced path), then retry.
Original error:
$_
"@
                }
                throw
            }
            Invoke-Native -File 'npm' -Arguments @('run', 'build') -Action 'build SPA' | Out-Null
        }
        finally {
            if ($null -ne $prevVite) { $env:VITE_ORCHESTRATOR_URL = $prevVite }
            else { Remove-Item Env:VITE_ORCHESTRATOR_URL -ErrorAction SilentlyContinue }
            if ($null -ne $prevFoundry) { $env:VITE_FOUNDRY_ORCHESTRATOR_URL = $prevFoundry }
            else { Remove-Item Env:VITE_FOUNDRY_ORCHESTRATOR_URL -ErrorAction SilentlyContinue }
            if ($null -ne $prevBackend) { $env:VITE_DEFAULT_BACKEND = $prevBackend }
            else { Remove-Item Env:VITE_DEFAULT_BACKEND -ErrorAction SilentlyContinue }
            Pop-Location
        }
    }


    # 4) Deploy SPA (+ managed /api only on the Foundry path). The deployment token
    #    is read from SWA_CLI_DEPLOYMENT_TOKEN (set transiently) so it never hits a
    #    log. The default Copilot Studio path does NOT use the SWA-managed /api - the
    #    SPA talks to the standalone Durable Functions orchestrator (VITE_ORCHESTRATOR_URL)
    #    - so we deploy static content only. Passing --api-location there makes the SWA
    #    CLI package managed Functions we never call, and its deprecated default runtime
    #    (Node 16, EOL) fails StaticSitesClient with a generic exit code 1.
    if ($PSCmdlet.ShouldProcess($name, 'Deploy SPA + API (swa deploy)')) {
        $token = $null
        if (-not $WhatIfPreference) {
            $token = (& az staticwebapp secrets list --name $name --resource-group $rg --query "properties.apiKey" -o tsv 2>$null)
            if ([string]::IsNullOrWhiteSpace($token)) { throw "Could not retrieve the deployment token for '$name'. Confirm the SWA exists and you have access." }
        }
        $deployArgs = @('-y', '@azure/static-web-apps-cli', 'deploy', $paths.Output, '--env', 'production')
        # The SPA resolves its backend as the baked orchestrator URL (MCS) or Foundry URL,
        # falling back to "/api" only when NEITHER is baked. So the SWA-managed /api is
        # dead weight whenever an external backend is configured - the default Copilot
        # Studio orchestrator (VITE_ORCHESTRATOR_URL) OR the Foundry + W365A runner
        # (VITE_FOUNDRY_ORCHESTRATOR_URL). The deprecated thread_id/run_id /api is deployed
        # only for the explicit legacy path (-IncludeFoundry) or when no backend URL exists
        # at all. Pin an explicit, supported Functions runtime so the SWA CLI does not fall
        # back to the retired Node 16 default (which fails StaticSitesClient with exit 1).
        $haveExternalBackend = (-not [string]::IsNullOrWhiteSpace($OrchestratorUrl)) -or (-not [string]::IsNullOrWhiteSpace($FoundryOrchestratorUrl))
        $needsManagedApi = $IncludeFoundry -or (-not $haveExternalBackend)
        if ($needsManagedApi) {
            $deployArgs += @('--api-location', $paths.Api, '--api-language', 'node', '--api-version', '20')
            Write-Host "  Deploying SPA + managed /api (Node 20 Functions)."
        }
        else {
            Write-Host "  Deploying SPA static content only (orchestrator backend baked in; SWA-managed /api not used)."
        }
        # The token travels via the SWA_CLI_DEPLOYMENT_TOKEN env var, not argv, so the
        # arguments carry no secret and are shown in full for diagnosability.
        Invoke-Native -File 'npx' -Arguments $deployArgs -Action 'deploy to Static Web Apps' -SecretEnv @{ SWA_CLI_DEPLOYMENT_TOKEN = $token } | Out-Null
    }

    # 5) App settings the legacy /api reads (client-credentials -> Foundry). Only
    #    relevant on the opt-in Foundry path; the default Copilot Studio path does not
    #    use the SWA-managed /api, so skip these entirely. Secret value is passed to az
    #    (its own process arg) but kept out of OUR logs via -NoEcho.
    if (-not $IncludeFoundry) {
        Write-Host "  Skipping legacy FOUNDRY_* /api app settings (Copilot Studio path; pass -IncludeFoundry to set them)."
    }
    elseif ($PSCmdlet.ShouldProcess($name, 'Set /api application settings')) {
        $agentId = if ($FoundryAgentId) { $FoundryAgentId } else { [string]$Config.foundry.agentId }
        $settings = [ordered]@{
            FOUNDRY_PROJECT_ENDPOINT = [string]$Config.foundry.endpoint
            FOUNDRY_API_VERSION      = [string]$Config.foundry.apiVersion
            FOUNDRY_TOKEN_AUDIENCE   = [string]$Config.foundry.tokenAudience
            AZURE_TENANT_ID          = [string]$Config.azure.tenantId
            AZURE_CLIENT_ID          = [string]$Config.appRegistration.clientId
        }
        if ($agentId) { $settings['FOUNDRY_AGENT_ID'] = $agentId }
        else { Write-Warning "  FOUNDRY_AGENT_ID is not set yet - the /api will fail until the agent exists. Re-run after Deploy-Agent, or paste foundry.agentId into the config." }

        $secret = [string]$Config.appRegistration.clientSecret
        if ([string]::IsNullOrWhiteSpace($secret)) {
            Write-Warning "  appRegistration.clientSecret is empty - AZURE_CLIENT_SECRET will not be set, so /api auth will fail. Add it to demo-config.local.json (never commit it)."
        }
        else { $settings['AZURE_CLIENT_SECRET'] = $secret }

        Write-Host "  Setting app settings: $($settings.Keys -join ', ')"
        $pairs = foreach ($k in $settings.Keys) { "$k=$($settings[$k])" }
        $settingArgs = @('staticwebapp', 'appsettings', 'set', '--name', $name, '--resource-group', $rg, '--setting-names') + $pairs
        Invoke-Native -File 'az' -Arguments $settingArgs -Action 'apply app settings' -NoEcho | Out-Null
    }

    # 6) Public URL.
    $url = $null
    if (-not $WhatIfPreference) {
        $swaHost = (& az staticwebapp show --name $name --resource-group $rg --query "defaultHostname" -o tsv 2>$null)
        if ($swaHost) { $url = "https://$swaHost" }
    }
    else {
        # Deterministic placeholder so callers (e.g. the managed web link) can still
        # be previewed end-to-end under -WhatIf.
        $url = "https://$name.azurestaticapps.net"
    }
    if (-not $WhatIfPreference -and $url) { Write-Host "  [ok]   CCaaS web app is live at: $url" -ForegroundColor Green }
    else { Write-Host "  [WhatIf] CCaaS web app URL will be $url" -ForegroundColor Yellow }

    return [pscustomobject]@{ Name = $name; ResourceGroup = $rg; Region = $region; Url = $url }
}

function Remove-DemoStaticWebApp {
    <#
        Deletes the Static Web App. The resource group is left intact UNLESS it is the
        demo's own RG AND -RemoveResourceGroup is passed (it may hold other resources).
        Preview-by-default: pass -Execute to actually delete.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [switch]$Execute,
        [switch]$RemoveResourceGroup
    )
    $rg = $Config.staticWebApp.resourceGroup
    $name = $Config.staticWebApp.name

    $exists = (& az staticwebapp show --name $name --resource-group $rg --query id -o tsv 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($exists)) {
        Write-Host "  Static Web App '$name' not found in '$rg' - nothing to remove."
        return
    }

    if (-not $Execute) {
        Write-Host "  [preview] would delete Static Web App '$name' (resource group '$rg')."
        if ($RemoveResourceGroup) { Write-Host "  [preview] would then delete resource group '$rg'." }
        return
    }

    Invoke-Native -File 'az' -Arguments @('staticwebapp', 'delete', '--name', $name, '--resource-group', $rg, '--yes') -Action "delete static web app '$name'" | Out-Null
    Write-Host "  Deleted Static Web App '$name'."

    if ($RemoveResourceGroup) {
        Invoke-Native -File 'az' -Arguments @('group', 'delete', '--name', $rg, '--yes', '--no-wait') -Action "delete resource group '$rg'" | Out-Null
        Write-Host "  Resource group '$rg' deletion started."
    }
}
