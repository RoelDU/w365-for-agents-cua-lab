# Detect-AgentShortcut.ps1 - Intune detection script for the MCS-only
# "Zava Claims Agent Launch Shortcut" app. Exit 0 + output = installed; exit 1 = missing.
# Installed only when the Public Desktop shortcut exists with the exact target and options,
# so a wrong or edited shortcut is replaced on the next Intune check, and only once the
# Claims app itself is installed, so the shortcut never reports ready before Claims.
# Intune uploads this file on its own, so the values are repeated from
# AgentShortcut.Settings.ps1 (tests\Test-AgentShortcut.ps1 keeps them identical).

$ErrorActionPreference = 'SilentlyContinue'

$name = 'Zava Claims Agent Launch.lnk'
$target = 'C:\Program Files\Business Applications\Zava Claims Workstation\claims.exe'
$arguments = '--no-splash --fast-auth --stable-host --idle-timeout=0 --demo-pin=1234'

if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { exit 1 }

$desktop = if ($env:PUBLIC) { Join-Path $env:PUBLIC 'Desktop' } else { [Environment]::GetFolderPath('CommonDesktopDirectory') }
$path = Join-Path $desktop $name
if (-not (Test-Path -LiteralPath $path)) { exit 1 }

$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
if ($lnk.TargetPath -eq $target -and $lnk.Arguments -ceq $arguments) {
    Write-Output "Detected: $path"
    exit 0
}
exit 1
