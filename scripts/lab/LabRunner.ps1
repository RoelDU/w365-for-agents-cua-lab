<#
.SYNOPSIS
    The Install-Lab runner: tool check, choices, destination, plan, one approval, then the
    ordered stages. Every stage is re-checked against the live tenant on every run, so a
    second run continues where the first stopped and never redoes finished work.
    Keep this file ASCII-only.
#>

$script:LabCommand = 'pwsh -File .\scripts\Install-Lab.ps1'

function Get-LabStages([hashtable]$State) {
    $all = @(Get-LabSharedStages) + @(Get-LabMcsStages) + @(Get-LabFoundryStages) + @(Get-LabFinalStages)
    @($all | Where-Object {
            $_.When -eq 'both' -or ($_.When -eq 'mcs' -and (Test-LabUseMcs $State)) -or ($_.When -eq 'foundry' -and (Test-LabUseFoundry $State))
        })
}

function Invoke-LabCheck([hashtable]$Stage, [hashtable]$Ctx) {
    try { return (& $Stage.Check $Ctx) }
    catch { return [pscustomobject]@{ Done = $false; Detail = "Could not check: $(Get-LabShortText $_.Exception.Message 400)"; Error = $true } }
}

function Get-LabText($Value, [hashtable]$Ctx) {
    if ($Value -is [scriptblock]) { return ((& $Value $Ctx) -join ' ') }
    return [string]$Value
}

function Show-LabPlan([object[]]$Stages, [hashtable]$Ctx) {
    # Read-only: every check runs, nothing is applied, interactive sign-ins are skipped.
    $wasPreview = $Ctx.Preview; $Ctx.Preview = $true
    $todo = 0
    Write-LabTitle 'Plan (read from your tenant and subscription just now)'
    try {
        for ($i = 0; $i -lt $Stages.Count; $i++) {
            $s = $Stages[$i]
            $r = Invoke-LabCheck $s $Ctx
            if ($r.Done) {
                $mark = if ($r.PSObject.Properties['Earlier'] -and $r.Earlier) { '[done*]' } else { '[done] ' }
                Write-Host ("  {0,2}. {1} {2}" -f ($i + 1), $mark, $s.Title) -ForegroundColor Green
                Write-Host ("               {0}" -f $r.Detail)
                continue
            }
            if ($r.PSObject.Properties['Deferred'] -and $r.Deferred) {
                Write-Host ("  {0,2}. [check] {1}" -f ($i + 1), $s.Title)
                Write-Host ("               {0}" -f $r.Detail)
                continue
            }
            $todo++
            $kind = @{ auto = 'setup does it'; admin = 'setup runs it; an administrator signs in'; portal = 'you do it in a portal, setup guides and checks'; check = 'read-only' }[$s.Kind]
            Write-Host ("  {0,2}. [to do] {1}  ({2})" -f ($i + 1), $s.Title, $kind) -ForegroundColor Yellow
            Write-Host ("               Why:  {0}" -f $s.Purpose)
            Write-Host ("               Who:  {0}" -f $s.Who)
            Write-Host ("               What: {0}" -f (Get-LabText $s.Plan $Ctx))
            Write-Host ("               Now:  {0}" -f $r.Detail)
        }
    }
    finally { $Ctx.Preview = $wasPreview }
    return $todo
}

function Wait-LabCheck([hashtable]$Stage, [hashtable]$Ctx) {
    $deadline = (Get-Date).AddSeconds([int]$Stage.Settle)
    while ($true) {
        $r = Invoke-LabCheck $Stage $Ctx
        if ($r.Done -or (Get-Date) -ge $deadline) { return $r }
        Write-LabInfo "Waiting for Azure to finish ($($r.Detail))"
        Start-Sleep -Seconds 15
    }
}

function New-LabOutcome([string]$Status, [string]$Stage, [string]$Message) {
    [pscustomobject]@{ Status = $Status; Stage = $Stage; Message = $Message }
}

function Write-LabStop([hashtable]$Stage, [int]$Index, [int]$Count, [string]$What, [hashtable]$Ctx) {
    Write-Host ''
    Write-Host "Setup stopped at step $Index of ${Count}: $($Stage.Title)" -ForegroundColor Red
    Write-Host "  What happened:   $What"
    Write-Host "  Who can fix it:  $($Stage.Who)"
    Write-Host "  What to do next: $(Get-LabText $Stage.NextAction $Ctx)"
    Write-Host "  Then run the same command again: $script:LabCommand"
    Write-Host '  Finished steps are checked again, not repeated.'
}

function Invoke-LabStages([object[]]$Stages, [hashtable]$Ctx) {
    if (-not $Ctx.ContainsKey('Earlier')) { $Ctx.Earlier = New-Object System.Collections.Generic.List[string] }
    if (-not $Ctx.ContainsKey('RanThisRun')) { $Ctx.RanThisRun = @{} }
    $n = $Stages.Count
    for ($i = 0; $i -lt $n; $i++) {
        $s = $Stages[$i]
        $r = Invoke-LabCheck $s $Ctx
        Save-LabState $Ctx.State $Ctx.Paths.State
        if ($r.Done) {
            if ($r.PSObject.Properties['Earlier'] -and $r.Earlier) {
                $Ctx.Earlier.Add("$($s.Title): $($r.Detail)")
                Write-Host ("  [done, not re-read] {0,2}/{1} {2} - {3}" -f ($i + 1), $n, $s.Title, $r.Detail) -ForegroundColor Yellow
            }
            else { Write-Host ("  [done] {0,2}/{1} {2} - {3}" -f ($i + 1), $n, $s.Title, $r.Detail) -ForegroundColor Green }
            continue
        }
        if ($r.PSObject.Properties['Error'] -and $r.Error) {
            $msg = "Setup could not read the current state, so it changed nothing here. $($r.Detail)"
            Write-LabStop $s ($i + 1) $n $msg $Ctx
            return (New-LabOutcome 'Failed' $s.Id $msg)
        }

        Write-LabTitle ("Step {0} of {1}: {2}" -f ($i + 1), $n, $s.Title)
        Write-LabInfo "Why: $($s.Purpose)"
        Write-LabInfo "Who: $($s.Who)"
        Write-LabInfo "Now: $($r.Detail)"

        if ($s.Kind -eq 'check') {
            Write-LabStop $s ($i + 1) $n $r.Detail $Ctx
            return (New-LabOutcome 'Failed' $s.Id $r.Detail)
        }

        if ($s.Kind -eq 'portal') {
            Write-LabTitle 'Please do this in the portal:'
            foreach ($line in (& $s.Guide $Ctx)) { Write-Host "  $line" }
            while (-not $r.Done) {
                $answer = [string](Read-Host "  When it is done, press Enter and setup checks it. Type later to stop here and continue another time")
                if ($answer.Trim() -ieq 'later') {
                    Save-LabState $Ctx.State $Ctx.Paths.State
                    Write-Host ''
                    Write-Host "Paused at step $($i + 1) of ${n}: $($s.Title). Nothing is lost. When the portal work is done, run: $script:LabCommand" -ForegroundColor Yellow
                    return (New-LabOutcome 'Waiting' $s.Id $r.Detail)
                }
                $r = Invoke-LabCheck $s $Ctx
                if (-not $r.Done -and $s.Confirm) { & $s.Confirm $Ctx; $r = Invoke-LabCheck $s $Ctx }
                Save-LabState $Ctx.State $Ctx.Paths.State
                if ($r.PSObject.Properties['Error'] -and $r.Error) {
                    $msg = "Setup could not read the current state, so it changed nothing here. $($r.Detail)"
                    Write-LabStop $s ($i + 1) $n $msg $Ctx
                    return (New-LabOutcome 'Failed' $s.Id $msg)
                }
                if (-not $r.Done) { Write-LabWarn "Not finished yet: $($r.Detail)" }
            }
            if ($r.PSObject.Properties['Earlier'] -and $r.Earlier) { $Ctx.Earlier.Add("$($s.Title): $($r.Detail)") }
            Write-LabGood "Done: $($r.Detail)"
            continue
        }

        try { & $s.Apply $Ctx }
        catch {
            Save-LabState $Ctx.State $Ctx.Paths.State
            $msg = Get-LabShortText $_.Exception.Message 800
            Write-LabStop $s ($i + 1) $n $msg $Ctx
            return (New-LabOutcome 'Failed' $s.Id $msg)
        }
        Save-LabState $Ctx.State $Ctx.Paths.State
        $Ctx.RanThisRun[$s.Id] = $true
        $r = Wait-LabCheck $s $Ctx
        Save-LabState $Ctx.State $Ctx.Paths.State
        if (-not $r.Done) {
            $msg = "The step ran, but checking it afterwards says: $($r.Detail)"
            Write-LabStop $s ($i + 1) $n $msg $Ctx
            return (New-LabOutcome 'Failed' $s.Id $msg)
        }
        Write-LabGood "Done: $($r.Detail)"
    }
    if ($Ctx.Earlier.Count) { return (New-LabOutcome 'ReadyUnverified' 'readiness' $Ctx.State.found.zavaUrl) }
    return (New-LabOutcome 'Ready' 'readiness' $Ctx.State.found.zavaUrl)
}

function Write-LabPrepConfig([hashtable]$State, [string]$Path) {
    # The optional operator readiness tool (scripts\foundry-demo-prep). Written once; never replaced.
    if ((Test-Path -LiteralPath $Path) -or -not (Test-LabUseFoundry $State)) { return }
    $f = $State.found
    [ordered]@{
        _readme                = 'Generated by scripts\Install-Lab.ps1. See START-HERE.txt.'
        zavaUrl                = $f.zavaUrl
        relayUrl               = "$($f.handoffBaseUrl)/foundry-claims"
        foundryAgentUrl        = "$(Get-LabFoundryEndpoint $State)/agents/$($State.choices.agentName)?api-version=v1"
        cloudPcPoolId          = [string]$f.foundryPoolId
        tenantId               = $State.choices.tenantId
        expectedFoundryVersion = ''
        poolAzureConfigDir     = ''
        foundryAzureConfigDir  = ''
    } | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding utf8
    Write-LabInfo "Wrote the operator readiness config: $Path"
}

function Install-LabModules([string[]]$Names) {
    foreach ($n in $Names) {
        $p = @{ Name = $n; Scope = 'CurrentUser'; Force = $true; AllowClobber = $true; ErrorAction = 'Stop' }
        if ($n -eq 'IntuneWin32App') { $p.MinimumVersion = '1.4.0' }
        Install-Module @p
    }
}

function Invoke-LabSetup {
    param([string]$StatePath, [switch]$Preview, [string]$AgentBackend, [switch]$ChooseAgain, [switch]$DeviceCode)
    $paths = Get-LabPaths -StatePath $StatePath
    Write-LabTitle 'Windows 365 for Agents lab: guided setup'
    if ($Preview) { Write-LabInfo 'Preview: signs in and reads, changes nothing.' }

    # 1. Tools on this computer. Nothing is installed without asking.
    $tools = @(Test-LabTools)
    Write-LabTitle 'Tools on this computer'
    foreach ($t in $tools) {
        $mark = if ($t.Ok) { 'ok     ' } else { 'MISSING' }
        Write-Host ("  {0} {1,-34} {2}" -f $mark, $t.Name, $t.Found)
    }
    $missing = @($tools | Where-Object { -not $_.Ok })
    if ($missing.Count) {
        Write-Host ''
        Write-Host 'Install the missing tools, one command each, in a normal PowerShell window:' -ForegroundColor Yellow
        foreach ($t in $missing) { Write-Host "  $($t.Fix)" }
        Write-Host 'Then close PowerShell, open it again (so it finds the new tools) and run setup again.'
        Write-Host 'If your organisation installs software for you, ask for these tools by name.'
        return (New-LabOutcome 'MissingTools' 'tools' (($missing | ForEach-Object { $_.Name }) -join ', '))
    }
    $mods = @(Get-LabMissingModules)
    if ($mods.Count) {
        Write-LabWarn "PowerShell modules the tenant and Intune steps sign in with are missing: $($mods -join ', ')"
        if ($Preview) { Write-LabInfo 'Setup offers to install them for your account when you run it without -Preview.' }
        elseif (Confirm-Lab 'Install them for your Windows account only, from the PowerShell Gallery?') { Install-LabModules $mods }
        else { return (New-LabOutcome 'MissingTools' 'modules' ($mods -join ', ')) }
    }

    # 2. Choices, asked once.
    $state = Read-LabState $paths.State
    if ($AgentBackend -and $state.choices.backends -and $state.choices.backends -ne $AgentBackend) { $ChooseAgain = $true }
    if ($ChooseAgain -or -not (Test-LabChoicesComplete $state)) {
        $before = Get-LabDestinationKey $state
        Select-LabChoices -State $state -Backends $AgentBackend -DeviceCode:$DeviceCode
        if ($before -ne (Get-LabDestinationKey $state) -and ($state.found.Count -or $state.runs.Count -or $state.approvals.Count)) {
            Write-LabWarn 'The destination changed, so everything setup found or recorded for the previous destination was cleared.'
            $state.found = @{}; $state.runs = @{}; $state.approvals = @{}
        }
        $stale = @(Remove-LabStaleRuns $state)
        if ($stale.Count) { Write-LabWarn "These steps are checked again, because their target changed (for example a group name): $($stale -join ', ')." }
        Save-LabState $state $paths.State
    }
    else {
        Connect-LabAzure -Tenant $state.choices.tenantId -SubscriptionId $state.choices.subscriptionId -DeviceCode:$DeviceCode | Out-Null
    }
    Show-LabDestination $state

    # 3. Plan.
    $ctx = @{ State = $state; Paths = $paths; Preview = [bool]$Preview; DeviceCode = [bool]$DeviceCode; Earlier = (New-Object System.Collections.Generic.List[string]); RanThisRun = @{} }
    $stages = Get-LabStages $state
    $todo = Show-LabPlan $stages $ctx
    Save-LabState $state $paths.State
    if ($Preview) {
        Write-Host ''
        Write-Host "Preview only: nothing in your tenant or subscription was changed. $todo step(s) to do." -ForegroundColor Green
        Write-Host "To install, run: $script:LabCommand"
        return (New-LabOutcome 'Preview' '' "$todo to do")
    }
    if ($todo -gt 0) {
        Write-Host ''
        Write-LabInfo 'Setup now works through the steps marked [to do], in order. It asks again before tenant-wide consent, before publishing the Copilot Studio agent, before turning the Foundry agent on, and before changing anything that already exists.'
        if (-not (Confirm-Lab 'Start?')) { return (New-LabOutcome 'Declined' '' 'Nothing was changed.') }
    }

    # 4. Stages.
    $outcome = Invoke-LabStages $stages $ctx
    Save-LabState $state $paths.State
    if ($outcome.Status -in @('Ready', 'ReadyUnverified')) {
        Write-LabPrepConfig $state $paths.PrepConfig
        Write-Host ''
        if ($outcome.Status -eq 'Ready') {
            Write-Host 'The lab is installed and every step was read back from your tenant on this run.' -ForegroundColor Green
        }
        else {
            Write-Host 'The lab is installed, but not every step could be read back on this run:' -ForegroundColor Yellow
            foreach ($e in $ctx.Earlier) { Write-Host "  - $e" }
            Write-Host '  These rely on an earlier run or on your own confirmation, because your current sign-in cannot read them.'
            Write-Host '  If anything may have changed, check them in the portal, or have the named administrator run setup again.'
        }
        Write-Host "  Open Zava: $($state.found.zavaUrl)/"
        Write-Host '  Sign in with a presenter account, answer a simulated call and choose Transfer. Setup did not start a transfer.'
        Write-Host "  Presenters: add their accounts to the group $($state.choices.presenterGroup) for the desktop icon."
        Write-Host '  Next: docs\install\presenting.md. A new Cloud PC pool can take a while before its first Cloud PC is ready.'
    }
    return $outcome
}
