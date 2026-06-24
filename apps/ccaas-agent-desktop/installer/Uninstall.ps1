# Uninstall.ps1 - remove Zava Contact Center Agent Workspace.

[CmdletBinding()]
param(
    [string]$InstallDir = "C:\Program Files\Zava\CCaaSAgentDesktop"
)

$ErrorActionPreference = "Stop"

$shortcuts = @(
    (Join-Path ([Environment]::GetFolderPath("CommonDesktopDirectory")) "Zava Contact Center.lnk"),
    (Join-Path ([Environment]::GetFolderPath("CommonPrograms")) "Zava Contact Center.lnk")
)

foreach ($shortcut in $shortcuts) {
    if (Test-Path $shortcut) {
        Remove-Item -Force $shortcut
        Write-Host "Removed shortcut: $shortcut"
    }
}

if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
    Write-Host "Removed install dir: $InstallDir"
}

Write-Host "Uninstall complete."
