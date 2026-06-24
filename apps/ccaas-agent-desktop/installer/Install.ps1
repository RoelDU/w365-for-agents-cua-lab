# Install.ps1 - install Zava Contact Center Agent Workspace locally.
#
# Intune-friendly: copies a production Vite build and creates all-users
# shortcuts that launch a local static HTTP server before opening Edge.

[CmdletBinding()]
param(
    [string]$Source = $PSScriptRoot,
    [string]$InstallDir = "C:\Program Files\Zava\CCaaSAgentDesktop",
    [int]$Port = 5173,
    [switch]$NoShortcuts
)

$ErrorActionPreference = "Stop"

$dist = Join-Path $Source "dist"
if (-not (Test-Path (Join-Path $dist "index.html"))) {
    $parentDist = Join-Path (Split-Path $Source -Parent) "dist"
    if (Test-Path (Join-Path $parentDist "index.html")) {
        $dist = $parentDist
    } else {
        throw "dist\index.html not found beside Install.ps1 or in the parent directory. Run npm run build before packaging."
    }
}

$payloadScripts = @("Start-CCaaSAgentDesktop.ps1", "Serve-Static.ps1")
foreach ($script in $payloadScripts) {
    if (-not (Test-Path (Join-Path $Source $script))) {
        throw "$script not found beside Install.ps1."
    }
}

Write-Host "Installing Zava Contact Center Agent Workspace to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$targetDist = Join-Path $InstallDir "dist"
if (Test-Path $targetDist) {
    Remove-Item -Recurse -Force $targetDist
}
Copy-Item -Recurse -Force $dist $targetDist

foreach ($script in $payloadScripts) {
    Copy-Item -Force (Join-Path $Source $script) (Join-Path $InstallDir $script)
}

$versionFile = Join-Path $Source "version.txt"
if (Test-Path $versionFile) {
    Copy-Item -Force $versionFile (Join-Path $InstallDir "version.txt")
}

Unblock-File -Path (Join-Path $InstallDir "*.ps1") -ErrorAction SilentlyContinue

if (-not $NoShortcuts) {
    $wsh = New-Object -ComObject WScript.Shell
    $shortcutTargets = @(
        (Join-Path ([Environment]::GetFolderPath("CommonDesktopDirectory")) "Zava Contact Center.lnk"),
        (Join-Path ([Environment]::GetFolderPath("CommonPrograms")) "Zava Contact Center.lnk")
    )

    foreach ($shortcutPath in $shortcutTargets) {
        $shortcut = $wsh.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstallDir\Start-CCaaSAgentDesktop.ps1`" -Port $Port"
        $shortcut.WorkingDirectory = $InstallDir
        $shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,220"
        $shortcut.Description = "Zava Contact Center Agent Workspace"
        $shortcut.Save()
        Write-Host "  Shortcut: $shortcutPath"
    }
}

Write-Host "Install complete."
