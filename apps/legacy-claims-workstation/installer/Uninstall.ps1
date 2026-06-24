# Uninstall.ps1 - remove Zava Mutual Claims Workstation.

# Switches:
#   -InstallDir <path>  Override install directory
#                       (default: %ProgramFiles%\Business Applications\Zava Claims Workstation).
#   -KeepData           Keep local data under %ProgramData%\ZavaClaims.
#   -AllUsersShortcuts  Accepted for backward compatibility (no-op). Shortcuts are
#                       always removed from the all-users locations. Kept so the
#                       Intune Win32 uninstall command line (which passes
#                       -AllUsersShortcuts) binds successfully under strict parameter
#                       binding instead of aborting with exit 1 (#135 / #132).

[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:ProgramFiles "Business Applications\Zava Claims Workstation"),
    [switch]$KeepData,
    [switch]$AllUsersShortcuts
)

$ErrorActionPreference = "Stop"

# Remove shortcuts (all-users locations - matching Install.ps1)
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$startMenu = [Environment]::GetFolderPath('CommonPrograms')
$shortcuts = @(
    (Join-Path $desktop  "Zava Claims Workstation.lnk"),
    (Join-Path $startMenu "Zava Claims Workstation.lnk"),
    # Also clean up old-named shortcuts if present
    (Join-Path $desktop  "Zava Claims.lnk"),
    (Join-Path $startMenu "Zava Claims.lnk")
)
foreach ($s in $shortcuts) {
    if (Test-Path $s) {
        Remove-Item -Force $s
        Write-Host "Removed shortcut: $s"
    }
}

if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
    Write-Host "Removed install dir: $InstallDir"
}

# Remove the Add/Remove Programs registration (non-fatal; requires admin).
try {
    $regKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ZavaClaimsWorkstation"
    if (Test-Path $regKey) {
        Remove-Item -Path $regKey -Recurse -Force
        Write-Host "Removed Add/Remove Programs entry: $regKey"
    }
}
catch {
    Write-Warning "Add/Remove Programs entry removal failed (non-fatal): $_"
}

if (-not $KeepData) {
    $data = Join-Path $env:ProgramData "ZavaClaims"
    if (Test-Path $data) {
        Remove-Item -Recurse -Force $data
        Write-Host "Removed local data: $data"
    }
}

Write-Host "Uninstall complete."
