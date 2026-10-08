<#
.SYNOPSIS
    Checks the MCS agent launch shortcut package (no tenant access, no Cloud PC).

.DESCRIPTION
    1. The launch command in docs\mcs-computer-use-instructions.md, the shortcut settings,
       the detection script and the Foundry engine all use the same target and options.
    2. The generated shortcut has that exact target, options and working folder, and no
       machine-tracking block (no packaging machine name inside).
    3. The exact Intune install command copies it to %PUBLIC%\Desktop, detection then passes,
       the exact uninstall command removes only that file, and detection then fails. The
       normal "Zava Claims Workstation" / "Zava Claims" shortcuts in the same folder are left
       byte-for-byte unchanged. %PUBLIC% points at a temporary folder for this test.
    4. Detection rejects a shortcut with the right name but different options.
    5. Detection fails while claims.exe is missing, even with the right shortcut in place, and
       Deploy-McsAgentShortcut.ps1 makes the app depend on the Claims app that
       Deploy-DemoEnvironment.ps1 creates. Detection runs from a copy whose claims.exe path
       points at a temporary file, so the test does not depend on Claims being installed here.

    Exit code 0 = pass, 1 = fail.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]
function Check([bool]$ok, [string]$what) {
    if ($ok) { Write-Host "  OK  $what" -ForegroundColor Green } else { $failures.Add($what) }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Resolve-Path (Join-Path $here '..')
$repoRoot = Resolve-Path (Join-Path $here '..\..\..')
$pkgDir = Join-Path $appRoot 'installer\agent-shortcut'
. (Join-Path $pkgDir 'AgentShortcut.Settings.ps1')
$detect = Join-Path $pkgDir 'Detect-AgentShortcut.ps1'

Write-Host "== MCS agent launch shortcut ==" -ForegroundColor Cyan

# 1. One launch command everywhere.
$doc = Get-Content -Raw (Join-Path $repoRoot 'docs\mcs-computer-use-instructions.md')
Check ($doc.Contains("`"$AgentShortcutTarget`" $AgentShortcutArguments")) 'MCS instructions Run fallback uses the shortcut target and options'
$detText = Get-Content -Raw $detect
Check ($detText.Contains("'$AgentShortcutFileName'") -and $detText.Contains("'$AgentShortcutTarget'") -and $detText.Contains("'$AgentShortcutArguments'")) 'detection script repeats the same name, target and options'
$engine = Join-Path $repoRoot 'samples\foundry-hosted-claims\hosted_claims\engine.py'
if (Test-Path $engine) {
    $eng = Get-Content -Raw $engine
    $pyArgs = ($AgentShortcutArguments -split ' ' | ForEach-Object { "`"$_`"" }) -join ', '
    Check ($eng.Contains("CLAIMS_EXE = r`"$AgentShortcutTarget`"") -and $eng.Contains("CLAIMS_ARGS = [$pyArgs]")) 'Foundry engine launches the same target with the same options'
}
foreach ($f in @(Get-ChildItem $pkgDir -Filter *.ps1) + @(Get-Item (Join-Path $repoRoot 'scripts\Deploy-McsAgentShortcut.ps1'))) {
    Check (-not ([IO.File]::ReadAllBytes($f.FullName) | Where-Object { $_ -gt 127 })) "ASCII-only: $($f.Name)"
}
$deployText = Get-Content -Raw (Join-Path $repoRoot 'scripts\Deploy-McsAgentShortcut.ps1')
$demoText = Get-Content -Raw (Join-Path $repoRoot 'scripts\Deploy-DemoEnvironment.ps1')
$claimsName = [regex]::Match($deployText, "\`$ClaimsAppDisplayName = '([^']+)'").Groups[1].Value
Check ($claimsName -and $demoText.Contains("DisplayName  = `"$claimsName`"")) "shortcut app depends on the Claims app Deploy-DemoEnvironment creates ('$claimsName')"
Check ($deployText.Contains("New-IntuneWin32AppDependency -ID `$claimsAppId -DependencyType 'AutoInstall'")) 'Claims is installed first (auto-install dependency)'

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("zagent_" + [guid]::NewGuid().ToString('N'))
$src = Join-Path $tmp 'package'
$pub = Join-Path $tmp 'Public'
$desk = Join-Path $pub 'Desktop'
New-Item -ItemType Directory -Force -Path $src, $desk | Out-Null
$fakeExe = Join-Path $tmp 'claims.exe'
$existence = 'Test-Path -LiteralPath $target -PathType Leaf'
Check ($detText.Contains($existence)) 'detection requires claims.exe'
$detectCopy = Join-Path $tmp 'Detect-AgentShortcut.ps1'
Set-Content -LiteralPath $detectCopy -Value $detText.Replace($existence, "Test-Path -LiteralPath '$fakeExe' -PathType Leaf") -NoNewline
$detect = $detectCopy
Set-Content -LiteralPath $fakeExe -Value 'stand-in for the installed claims.exe'
$oldPublic = $env:PUBLIC
try {
    # 2. Generated shortcut.
    $lnkPath = Join-Path $src $AgentShortcutFileName
    & (Join-Path $pkgDir 'New-AgentLaunchShortcut.ps1') -OutputPath $lnkPath | Out-Null
    $wsh = New-Object -ComObject WScript.Shell
    $l = $wsh.CreateShortcut($lnkPath)
    Check ($l.TargetPath -eq $AgentShortcutTarget) "target = $AgentShortcutTarget"
    Check ($l.Arguments -ceq $AgentShortcutArguments) "options = $AgentShortcutArguments"
    Check ($l.WorkingDirectory -eq $AgentShortcutWorkingDirectory) 'working folder = install folder'
    $bytes = [IO.File]::ReadAllBytes($lnkPath)
    $hasTracker = $false
    for ($i = 0; $i -le $bytes.Length - 4; $i++) {
        if ([BitConverter]::ToUInt32($bytes, $i) -eq [uint32]2684354563) { $hasTracker = $true; break }  # 0xA0000003
    }
    Check (-not $hasTracker) 'no machine-tracking block'
    $ascii = [Text.Encoding]::ASCII.GetString($bytes)
    $uni = [Text.Encoding]::Unicode.GetString($bytes)
    Check (-not ($ascii -match [regex]::Escape($env:COMPUTERNAME) -or $uni -match [regex]::Escape($env:COMPUTERNAME))) 'packaging machine name not inside the shortcut'

    # 3. Install, detect, uninstall with the exact Intune command lines.
    $normal = @('Zava Claims Workstation.lnk', 'Zava Claims.lnk')
    foreach ($n in $normal) { [IO.File]::WriteAllBytes((Join-Path $desk $n), [byte[]](1, 2, 3, (Get-Random -Maximum 250))) }
    $before = @{}; foreach ($n in $normal) { $before[$n] = (Get-FileHash (Join-Path $desk $n)).Hash }
    $env:PUBLIC = $pub

    $p = Start-Process cmd.exe -ArgumentList ($AgentShortcutInstallCommand -replace '^cmd\.exe ', '') -WorkingDirectory $src -Wait -PassThru -NoNewWindow
    Check ($p.ExitCode -eq 0) 'install command exit 0'
    Check ((Get-FileHash (Join-Path $desk $AgentShortcutFileName)).Hash -eq (Get-FileHash $lnkPath).Hash) 'install copied the shortcut to %PUBLIC%\Desktop'
    $d = Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$detect`"" -Wait -PassThru -NoNewWindow
    Check ($d.ExitCode -eq 0) 'detection passes after install'

    # 4. Same name, different options: not detected.
    $bad = $wsh.CreateShortcut((Join-Path $desk $AgentShortcutFileName))
    $bad.Arguments = '--no-splash'
    $bad.Save()
    $d = Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$detect`"" -Wait -PassThru -NoNewWindow
    Check ($d.ExitCode -eq 1) 'detection rejects a shortcut with other options'
    $p = Start-Process cmd.exe -ArgumentList ($AgentShortcutInstallCommand -replace '^cmd\.exe ', '') -WorkingDirectory $src -Wait -PassThru -NoNewWindow
    $d = Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$detect`"" -Wait -PassThru -NoNewWindow
    Check ($p.ExitCode -eq 0 -and $d.ExitCode -eq 0) 'reinstall repairs it'

    # 5. Shortcut in place but Claims not installed: not ready.
    Remove-Item -LiteralPath $fakeExe
    $d = Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$detect`"" -Wait -PassThru -NoNewWindow
    Check ($d.ExitCode -eq 1) 'detection fails while claims.exe is missing'
    Set-Content -LiteralPath $fakeExe -Value 'stand-in for the installed claims.exe'

    $p = Start-Process cmd.exe -ArgumentList ($AgentShortcutUninstallCommand -replace '^cmd\.exe ', '') -Wait -PassThru -NoNewWindow
    Check ($p.ExitCode -eq 0) 'uninstall command exit 0'
    Check (-not (Test-Path (Join-Path $desk $AgentShortcutFileName))) 'uninstall removed the agent shortcut'
    $d = Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$detect`"" -Wait -PassThru -NoNewWindow
    Check ($d.ExitCode -eq 1) 'detection fails after uninstall'
    $p = Start-Process cmd.exe -ArgumentList ($AgentShortcutUninstallCommand -replace '^cmd\.exe ', '') -Wait -PassThru -NoNewWindow
    Check ($p.ExitCode -eq 0) 'uninstall when already absent exit 0'
    foreach ($n in $normal) { Check ((Get-FileHash (Join-Path $desk $n)).Hash -eq $before[$n]) "normal shortcut unchanged: $n" }
}
finally {
    $env:PUBLIC = $oldPublic
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) {
    Write-Host "`nFAIL ($($failures.Count)):" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
Write-Host "`nPASS: agent launch shortcut package." -ForegroundColor Green
exit 0
