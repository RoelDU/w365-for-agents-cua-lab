<#
.SYNOPSIS
    Core helpers for scripts\Install-Lab.ps1: private state, prompts, Azure CLI calls and the
    local tool check. Dot-sourced; nothing here changes anything on its own.

.NOTES
    Every cloud call goes through az (Invoke-LabAz / Invoke-LabRest), so the sign-in is the
    administrator's own Azure CLI session and no token is held or stored by this code.
    Keep this file ASCII-only.
#>

$script:LabRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $script:LabRepoRoot 'scripts\DemoCommon.ps1')

# Generated files. All names end in .local.json (git-ignored by **/*.local.json) so they never
# replace a file someone wrote by hand.
function Get-LabPaths {
    param([string]$StatePath)
    $root = $script:LabRepoRoot
    if (-not $StatePath) { $StatePath = Join-Path $root 'scripts\lab-setup.local.json' }
    [pscustomobject]@{
        Root           = $root
        State          = $StatePath
        DemoConfig     = Join-Path $root 'scripts\demo-config.lab.local.json'
        FoundryConfig  = Join-Path $root 'deploy\foundry\foundry-agent.lab.local.json'
        FoundryReceipt = 'deploy/foundry/foundry-agent-deployment.lab.local.json'
        FoundrySample  = Join-Path $root 'deploy\foundry\foundry-agent.sample.json'
        Venv           = Join-Path $root 'samples\foundry-hosted-claims\.venv'
        VenvPython     = Join-Path $root 'samples\foundry-hosted-claims\.venv\Scripts\python.exe'
        ZavaPublic     = Join-Path $root 'apps\ccaas-agent-desktop\public'
        Backups        = Join-Path $root 'scripts'
        PrepConfig     = Join-Path $root 'scripts\foundry-demo-prep\foundry-demo.config.json'
    }
}

# ---------------------------------------------------------------- output and prompts
function Write-LabTitle([string]$Text) { Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
function Write-LabInfo([string]$Text) { Write-Host "  $Text" }
function Write-LabGood([string]$Text) { Write-Host "  $Text" -ForegroundColor Green }
function Write-LabWarn([string]$Text) { Write-Host "  $Text" -ForegroundColor Yellow }

function Read-LabText {
    param([Parameter(Mandatory)][string]$Prompt, [string]$Default, [scriptblock]$Validate)
    while ($true) {
        $label = if ($Default) { "$Prompt [$Default]" } else { $Prompt }
        $answer = [string](Read-Host "  $label")
        if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $Default }
        $answer = ([string]$answer).Trim()
        if (-not $answer) { Write-LabWarn 'An answer is needed.'; continue }
        if ($Validate) {
            $problem = & $Validate $answer
            if ($problem) { Write-LabWarn $problem; continue }
        }
        return $answer
    }
}

function Read-LabNumber {
    # A numbered pick list. There is deliberately no default: the person must choose.
    param([Parameter(Mandatory)][string]$Prompt, [Parameter(Mandatory)][string[]]$Options)
    for ($i = 0; $i -lt $Options.Count; $i++) { Write-Host ("    {0}. {1}" -f ($i + 1), $Options[$i]) }
    $count = $Options.Count
    $n = Read-LabText -Prompt $Prompt -Validate {
        param($a)
        $v = 0
        if (-not [int]::TryParse($a, [ref]$v) -or $v -lt 1 -or $v -gt $count) { "Type a number from 1 to $count." }
    }.GetNewClosure()
    return ([int]$n) - 1
}

function Confirm-Lab {
    # Explicit approval: only the word yes counts.
    param([Parameter(Mandatory)][string]$Question)
    $a = [string](Read-Host "  $Question Type yes to agree")
    return ($a.Trim() -ieq 'yes')
}

function Get-LabShortText([string]$Text, [int]$Max = 600) {
    $t = ([string]$Text).Trim()
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max) + ' ...' }
    return $t
}

# ---------------------------------------------------------------- private state
function New-LabState {
    @{ version = 1; createdUtc = (Get-Date).ToUniversalTime().ToString('o'); choices = @{}; found = @{}; runs = @{}; approvals = @{} }
}

function Read-LabState([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return (New-LabState) }
    $s = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable
    foreach ($k in 'choices', 'found', 'runs', 'approvals') { if (-not $s.ContainsKey($k) -or $null -eq $s[$k]) { $s[$k] = @{} } }
    return $s
}

function Save-LabState([hashtable]$State, [string]$Path) {
    # IDs, names and URLs only. Never tokens, keys or passwords.
    $State['savedUtc'] = (Get-Date).ToUniversalTime().ToString('o')
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    ($State | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $Path -Encoding utf8
}

function Set-LabFound([hashtable]$State, [string]$Key, $Value) { if ($null -ne $Value -and "$Value" -ne '') { $State.found[$Key] = $Value } }

function Add-LabRun([hashtable]$State, [string]$StageId, [string]$Note) {
    # A record that a helper script finished without an error. Used only together with a live
    # read, never as proof on its own.
    $State.runs[$StageId] = @{ atUtc = (Get-Date).ToUniversalTime().ToString('o'); note = $Note }
}

# ---------------------------------------------------------------- Azure CLI and HTTP
function Invoke-LabAz {
    param([Parameter(Mandatory)][string[]]$Arguments, [switch]$AllowFailure)
    $global:LASTEXITCODE = 0
    $out = & az @Arguments 2>&1
    $code = $LASTEXITCODE
    $text = (@($out) | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ }) -join "`n"
    $err = (@($out) | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    $json = $null
    if ($code -eq 0 -and $text.Trim()) { try { $json = $text | ConvertFrom-Json } catch { $json = $null } }
    $r = [pscustomobject]@{ Ok = ($code -eq 0); Code = $code; Text = $text; Error = $err; Json = $json }
    if (-not $r.Ok -and -not $AllowFailure) {
        $why = if ($err) { $err } else { $text }
        throw "Azure CLI 'az $($Arguments[0]) $($Arguments[1])' failed: $(Get-LabShortText $why)"
    }
    return $r
}

function Test-LabNotFound($Result) {
    $all = "$($Result.Error) $($Result.Text)"
    return ($Result.Code -eq 3 -or $all -match 'ResourceNotFound|NotFound|not found|could not be found|does not exist')
}

function Get-LabAzJson {
    # Read-only lookup: the parsed result, or nothing at all when the thing does not exist (so
    # @(...) around a missing item counts zero, not one $null). Any other failure, such as a
    # missing permission or throttling, stops with the error: it must never look like "missing",
    # because setup would then create a duplicate. -Lenient returns nothing on any failure.
    param([Parameter(Mandatory)][string[]]$Arguments, [switch]$Lenient)
    $r = Invoke-LabAz -Arguments ($Arguments + @('-o', 'json', '--only-show-errors')) -AllowFailure
    if ($r.Ok) { if ($null -ne $r.Json) { return $r.Json }; return }
    if ($Lenient -or (Test-LabNotFound $r)) { return }
    $why = if ($r.Error) { $r.Error } else { $r.Text }
    throw "Could not read 'az $(($Arguments | Select-Object -First 3) -join ' ')': $(Get-LabShortText $why 400)"
}

function Invoke-LabAzVisible {
    # For az commands that may ask the person something (for example terms to accept): output
    # and prompts go straight to the screen instead of being captured.
    param([Parameter(Mandatory)][string[]]$Arguments)
    $global:LASTEXITCODE = 0
    & az @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI 'az $($Arguments[0]) $($Arguments[1]) $($Arguments[2])' failed (exit $LASTEXITCODE); see the message above." }
}

function Invoke-LabRest {
    param(
        [ValidateSet('GET', 'POST', 'PATCH', 'PUT', 'DELETE')][string]$Method = 'GET',
        [Parameter(Mandatory)][string]$Url,
        [string]$Resource,
        $Body,
        [string[]]$Headers = @()
    )
    $a = @('rest', '--method', $Method.ToLowerInvariant(), '--url', $Url, '--only-show-errors')
    if ($Resource) { $a += @('--resource', $Resource) }
    $file = $null
    if ($null -ne $Body) {
        $file = [IO.Path]::GetTempFileName()
        ($Body | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $file -Encoding utf8
        $a += @('--body', "@$file")
        $Headers = @('Content-Type=application/json') + $Headers
    }
    if ($Headers.Count) { $a += '--headers'; $a += $Headers }
    try { $r = Invoke-LabAz -Arguments $a -AllowFailure }
    finally { if ($file) { Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue } }
    $all = "$($r.Error) $($r.Text)"
    [pscustomobject]@{
        Ok       = $r.Ok
        Json     = $r.Json
        NotFound = (-not $r.Ok) -and ($all -match 'Not ?Found|\b404\b|does not exist|ResourceNotFound')
        Denied   = (-not $r.Ok) -and ($all -match 'Forbidden|\b403\b|Authorization_RequestDenied|AuthorizationFailed|insufficient privileges')
        Message  = Get-LabShortText $all
    }
}

function Invoke-LabWeb {
    # Plain HTTPS read of a public URL (Zava site, handoff health). No credentials are sent.
    param([Parameter(Mandatory)][string]$Url)
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck -ErrorAction Stop
        $json = $null
        try { $json = $resp.Content | ConvertFrom-Json } catch { $json = $null }
        return [pscustomobject]@{ Status = [int]$resp.StatusCode; Json = $json; Content = [string]$resp.Content }
    }
    catch { return [pscustomobject]@{ Status = 0; Json = $null; Content = $_.Exception.Message } }
}

function Invoke-LabScript {
    # Runs one of the repository's existing helper scripts in this process, from the repository root.
    param([Parameter(Mandatory)][string]$RelativePath, [hashtable]$Arguments = @{})
    $path = Join-Path $script:LabRepoRoot $RelativePath
    Write-LabInfo "Running $RelativePath"
    Push-Location $script:LabRepoRoot
    try {
        $global:LASTEXITCODE = 0
        $result = & $path @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$RelativePath ended with exit code $LASTEXITCODE." }
        return $result
    }
    finally { Pop-Location }
}

function Invoke-LabPython {
    # Runs Python from the setup-managed environment and returns its text output.
    param([Parameter(Mandatory)][string]$Python, [Parameter(Mandatory)][string[]]$Arguments)
    Push-Location $script:LabRepoRoot
    try {
        $global:LASTEXITCODE = 0
        $out = & $Python @Arguments 2>&1
        [pscustomobject]@{ Code = $LASTEXITCODE; Text = ((@($out) | ForEach-Object { [string]$_ }) -join "`n") }
    }
    finally { Pop-Location }
}

# ---------------------------------------------------------------- local tools
function Get-LabCommandVersion([string]$Name, [string[]]$Arguments = @('--version')) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { return $null }
    try { $global:LASTEXITCODE = 0; $out = & $Name @Arguments 2>&1; if ($LASTEXITCODE -ne 0) { return $null } }
    catch { return $null }
    return ((@($out) | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

function Find-LabPython {
    # Python 3.12 or later, through the Python launcher first (python.exe can be the Store stub).
    foreach ($candidate in @(@('py', '-3.13'), @('py', '-3.12'), @('python'))) {
        $exe = $candidate[0]; $pre = @($candidate | Select-Object -Skip 1)
        $v = Get-LabCommandVersion $exe ($pre + @('-c', 'import sys; print("%d.%d" % sys.version_info[:2])'))
        if ($v -and $v -match '^(\d+)\.(\d+)$' -and ([int]$Matches[1] -gt 3 -or ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 12))) {
            return [pscustomobject]@{ Exe = $exe; Prefix = $pre; Version = $v }
        }
    }
    return $null
}

function Test-LabTools {
    # One row per tool: whether it is usable and the one command that installs it.
    $rows = New-Object System.Collections.Generic.List[object]

    $rows.Add([pscustomobject]@{ Name = 'PowerShell 7'; Ok = ($PSVersionTable.PSVersion.Major -ge 7); Found = "$($PSVersionTable.PSVersion)"; Fix = 'winget install --exact --id Microsoft.PowerShell' })

    $azText = Get-LabCommandVersion 'az' @('version', '-o', 'json')
    $azVer = $null
    if ($azText) { try { $azVer = [version](($azText | ConvertFrom-Json).'azure-cli') } catch { $azVer = $null } }
    $rows.Add([pscustomobject]@{ Name = 'Azure CLI 2.80 or later'; Ok = [bool]($azVer -and $azVer -ge [version]'2.80.0'); Found = $(if ($azVer) { "$azVer" } else { 'not found' }); Fix = 'winget install --exact --id Microsoft.AzureCLI' })

    $node = Get-LabCommandVersion 'node'
    $nodeOk = [bool]($node -and $node -match '^v(\d+)' -and [int]$Matches[1] -ge 20 -and (Get-LabCommandVersion 'npm'))
    $rows.Add([pscustomobject]@{ Name = 'Node.js 20 or later (with npm)'; Ok = $nodeOk; Found = $(if ($node) { $node } else { 'not found' }); Fix = 'winget install --exact --id OpenJS.NodeJS.LTS' })

    $func = Get-LabCommandVersion 'func'
    $rows.Add([pscustomobject]@{ Name = 'Azure Functions Core Tools 4'; Ok = [bool]($func -and $func -match '^4\.'); Found = $(if ($func) { $func } else { 'not found' }); Fix = 'winget install --exact --id Microsoft.Azure.FunctionsCoreTools' })

    $py = Find-LabPython
    $rows.Add([pscustomobject]@{ Name = 'Python 3.12 or later'; Ok = [bool]$py; Found = $(if ($py) { $py.Version } else { 'not found' }); Fix = 'winget install --exact --id Python.Python.3.12' })
    return $rows
}

function Get-LabMissingModules {
    # The PowerShell modules the existing tenant and Intune scripts sign in with.
    $need = @(
        @{ Name = 'Microsoft.Graph.Authentication'; Min = '2.0.0' },
        @{ Name = 'Microsoft.Graph.Applications'; Min = '2.0.0' },
        @{ Name = 'Microsoft.Graph.Groups'; Min = '2.0.0' },
        @{ Name = 'IntuneWin32App'; Min = '1.4.0' }
    )
    @($need | Where-Object {
            $n = $_.Name; $min = [version]$_.Min
            -not (Get-Module -ListAvailable -Name $n | Where-Object { $_.Version -ge $min })
        } | ForEach-Object { $_.Name })
}
