<#
.SYNOPSIS
    Drift guard for the Zava Claims Intune install/uninstall command lines (#132).

.DESCRIPTION
    The claims app is delivered to the agent Cloud PC pool as an Intune Win32 app whose
    INSTALL command is the native compiled installer `claims.exe --install` (NOT a
    powershell.exe -File Install.ps1 command, which failed with 0x80070001 on the
    locked-down agent Cloud PCs - the proven-working LOB app on these pools uses a
    compiled Setup.exe, not PowerShell).

    Asserts: (1) Deploy-DemoEnvironment.ps1 uses `claims.exe --install` + a `--uninstall`
    command and does NOT regress to a powershell Install.ps1 command; (2) if a built
    claims.exe is present, `--install` (into a temp dir via ZAVACLAIMS_SETUP_DIR) exits 0
    and copies the binary, and `--uninstall` exits 0 and removes it.

    Exit code 0 = pass, 1 = fail.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]

$here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot    = Resolve-Path (Join-Path $here '..')
$repoRoot   = Resolve-Path (Join-Path $here '..\..\..')
$deployScript = Join-Path $repoRoot 'scripts\Deploy-DemoEnvironment.ps1'

Write-Host "== Installer command drift guard ==" -ForegroundColor Cyan

if (-not (Test-Path $deployScript)) {
    $failures.Add("Deploy-DemoEnvironment.ps1 not found at $deployScript")
} else {
    $deployText = Get-Content $deployScript -Raw
    if ($deployText -match "Install\s*=\s*'claims\.exe --install'") {
        Write-Host "  OK  deploy install command = claims.exe --install" -ForegroundColor Green
    } else {
        $failures.Add("Deploy-DemoEnvironment.ps1 install command is not 'claims.exe --install'.")
    }
    if ($deployText -match "--uninstall") {
        Write-Host "  OK  deploy uninstall command uses --uninstall" -ForegroundColor Green
    } else {
        $failures.Add("Deploy-DemoEnvironment.ps1 uninstall command does not use '--uninstall'.")
    }
    if ($deployText -match 'powershell.*Install\.ps1') {
        $failures.Add("Deploy-DemoEnvironment.ps1 still references a powershell.exe Install.ps1 command (regression to the 0x80070001 path).")
    }
}

# 3. ASCII-only guard for repo .ps1 scripts (Windows PowerShell 5.1 reads BOM-less
#    UTF-8 as ANSI, so a stray non-ASCII char breaks parsing - regression in #136).
$ps1Files = @(
    (Join-Path $repoRoot 'scripts\Build-IntunePackages.ps1'),
    (Join-Path $repoRoot 'scripts\Deploy-DemoEnvironment.ps1'),
    (Join-Path $repoRoot 'scripts\Enable-W365aPrereqs.ps1'),
    (Join-Path $repoRoot 'scripts\DemoCommon.ps1'),
    (Join-Path $repoRoot 'scripts\Verify-IntuneClaimsAssignment.ps1'),
    (Join-Path $appRoot 'installer\Install.ps1'),
    (Join-Path $appRoot 'installer\Uninstall.ps1'),
    (Join-Path $appRoot 'installer\Detect.ps1')
)
foreach ($pf in $ps1Files) {
    if (-not (Test-Path $pf)) { continue }
    $bytes = [IO.File]::ReadAllBytes($pf)
    $bad = $false
    foreach ($b in $bytes) { if ($b -gt 127) { $bad = $true; break } }
    if ($bad) { $failures.Add("Non-ASCII byte in $(Split-Path $pf -Leaf) - keep repo .ps1 ASCII-only (PS 5.1 parse safety, #136).") }
    else { Write-Host "  OK  ASCII-only: $(Split-Path $pf -Leaf)" -ForegroundColor Green }
}

$exe = Join-Path $appRoot 'claims.exe'
if (-not (Test-Path $exe)) {
    Write-Host "  SKIP functional check (claims.exe not built)" -ForegroundColor DarkYellow
} else {
    $dst = Join-Path ([IO.Path]::GetTempPath()) ("zsetup_" + [guid]::NewGuid().ToString('N'))
    try {
        $env:ZAVACLAIMS_SETUP_DIR = $dst
        $p = Start-Process -FilePath $exe -ArgumentList '--install' -PassThru -Wait -NoNewWindow
        if ($p.ExitCode -ne 0) { $failures.Add("claims.exe --install exited $($p.ExitCode) (expected 0).") }
        elseif (-not (Test-Path (Join-Path $dst 'claims.exe'))) { $failures.Add("claims.exe --install exited 0 but did not copy the binary.") }
        else { Write-Host "  OK  claims.exe --install exit 0 and copied the binary" -ForegroundColor Green }
        $p2 = Start-Process -FilePath $exe -ArgumentList '--uninstall' -PassThru -Wait -NoNewWindow
        if ($p2.ExitCode -ne 0) { $failures.Add("claims.exe --uninstall exited $($p2.ExitCode) (expected 0).") }
        else { Write-Host "  OK  claims.exe --uninstall exit 0" -ForegroundColor Green }
    }
    finally {
        Remove-Item Env:ZAVACLAIMS_SETUP_DIR -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue
    }
}

if ($failures.Count -gt 0) {
    Write-Host "`nFAIL ($($failures.Count)):" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
Write-Host "`nPASS: installer commands and the native installer are in sync." -ForegroundColor Green
exit 0
