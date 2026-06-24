# Install.ps1 - install Zava Mutual Claims Workstation locally, as a normal
# Program Files application (registered in Add/Remove Programs), the same way a
# conventional Intune Win32 LOB app installs on a Windows 365 Cloud PC.
#
# Layout produced:
#   %ProgramFiles%\Business Applications\Zava Claims Workstation\claims.exe   (executable)
#   %ProgramFiles%\Business Applications\Zava Claims Workstation\Uninstall.ps1 (uninstaller)
#   HKLM\...\Uninstall\ZavaClaimsWorkstation                        (Add/Remove Programs)
#   C:\Users\Public\Desktop\Zava Claims Workstation.lnk             (all-users desktop shortcut)
#   Common Start Menu\Zava Claims Workstation.lnk                   (all-users Start menu shortcut)
#
# Non-interactive by design: no network, no UAC dialog, no first-run wizard.
# Runs as SYSTEM via Intune Management Extension (Win32 app install context).
#
# Switches:
#   -Source <path>      Folder containing claims.exe (default: script directory).
#   -InstallDir <path>  Override install directory
#                       (default: %ProgramFiles%\Business Applications\Zava Claims Workstation).
#   -NoShortcuts        Skip shortcut creation.
#   -AllUsersShortcuts  Accepted for backward compatibility. Shortcuts are ALWAYS
#                       created in all-users locations (Public Desktop / Common Start
#                       Menu), so this switch is a no-op. It is kept so the Intune
#                       Win32 install command line (which passes -AllUsersShortcuts)
#                       binds successfully under [CmdletBinding()] strict parameter
#                       binding instead of aborting with exit 1 (#135 / #132).

[CmdletBinding()]
param(
    [string]$Source = $PSScriptRoot,
    [string]$InstallDir = (Join-Path $env:ProgramFiles "Business Applications\Zava Claims Workstation"),
    [switch]$NoShortcuts,
    [switch]$AllUsersShortcuts
)

$ErrorActionPreference = "Stop"

# Logging for Intune troubleshooting (visible in AgentExecutor.log, also written here).
# Logs live under %ProgramData% (always writable by SYSTEM) rather than Program Files.
# NON-FATAL: a host that blocks PowerShell transcription or the log directory must never
# fail the install. Previously this ran outside the try with ErrorActionPreference=Stop,
# so a transcription failure aborted the script with a non-zero exit, which Intune reports
# as 0x80070001 even though the binary copy never got a chance to run (#132 second cause).
$transcribing = $false
try {
    $logDir = Join-Path $env:ProgramData "ZavaClaims\logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $logFile = Join-Path $logDir "install-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
    Start-Transcript -Path $logFile -Force | Out-Null
    $transcribing = $true
}
catch {
    Write-Warning "Transcript logging unavailable (non-fatal): $_"
}

try {
    Write-Host "Installing Zava Mutual Claims Workstation to $InstallDir"
    Write-Host "  Running as: $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
    Write-Host "  Source: $Source"

    # Locate claims.exe
    if (-not (Test-Path (Join-Path $Source "claims.exe"))) {
        $alt = Join-Path (Split-Path $Source -Parent) "claims.exe"
        if (Test-Path $alt) {
            $exe = $alt
        } else {
            throw "claims.exe not found beside Install.ps1 or in parent directory."
        }
    } else {
        $exe = Join-Path $Source "claims.exe"
    }

    # Copy binary. Retry transient failures (brief file lock / IO contention during the
    # ESP provisioning window) so a momentary miss self-heals instead of failing the install.
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $target = Join-Path $InstallDir "claims.exe"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Copy-Item -Force $exe $target
            break
        }
        catch {
            if ($attempt -eq 3) { throw }
            Write-Warning "  Copy attempt $attempt failed, retrying in 3s: $_"
            Start-Sleep -Seconds 3
        }
    }
    Unblock-File -Path $target -ErrorAction SilentlyContinue

    $installed = Join-Path $InstallDir "claims.exe"
    if (-not (Test-Path $installed) -or (Get-Item $installed).Length -eq 0) {
        throw "claims.exe copy failed or file is empty at: $installed"
    }
    Write-Host "  Binary: $installed ($((Get-Item $installed).Length) bytes)"

    # Create shortcuts (all-users so they're visible regardless of which user profile loads)
    if (-not $NoShortcuts) {
        try {
            $wsh = New-Object -ComObject WScript.Shell

            # Desktop shortcut (primary name - matches CUA instructions)
            $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
            $deskLnk = Join-Path $desktop "Zava Claims Workstation.lnk"
            $shortcut = $wsh.CreateShortcut($deskLnk)
            $shortcut.TargetPath = $installed
            $shortcut.WorkingDirectory = $InstallDir
            $shortcut.IconLocation = "$installed,0"
            $shortcut.Description = "Zava Mutual Claims Workstation"
            $shortcut.Save()
            Write-Host "  Desktop shortcut: $deskLnk"

            # Desktop shortcut (alias for backward compat)
            $deskLnk2 = Join-Path $desktop "Zava Claims.lnk"
            $shortcut = $wsh.CreateShortcut($deskLnk2)
            $shortcut.TargetPath = $installed
            $shortcut.WorkingDirectory = $InstallDir
            $shortcut.IconLocation = "$installed,0"
            $shortcut.Description = "Zava Mutual Claims Workstation"
            $shortcut.Save()
            Write-Host "  Desktop shortcut (alias): $deskLnk2"

            # Start Menu shortcut (primary)
            $startMenu = [Environment]::GetFolderPath('CommonPrograms')
            $smLnk = Join-Path $startMenu "Zava Claims Workstation.lnk"
            $shortcut = $wsh.CreateShortcut($smLnk)
            $shortcut.TargetPath = $installed
            $shortcut.WorkingDirectory = $InstallDir
            $shortcut.IconLocation = "$installed,0"
            $shortcut.Description = "Zava Mutual Claims Workstation"
            $shortcut.Save()
            Write-Host "  Start Menu shortcut: $smLnk"

            # Start Menu shortcut (alias)
            $smLnk2 = Join-Path $startMenu "Zava Claims.lnk"
            $shortcut = $wsh.CreateShortcut($smLnk2)
            $shortcut.TargetPath = $installed
            $shortcut.WorkingDirectory = $InstallDir
            $shortcut.IconLocation = "$installed,0"
            $shortcut.Description = "Zava Mutual Claims Workstation"
            $shortcut.Save()
            Write-Host "  Start Menu shortcut (alias): $smLnk2"
        }
        catch {
            # Shortcut failure should NOT fail the install - the binary is what matters
            Write-Warning "  Shortcut creation failed (non-fatal): $_"
        }
    }

    # Copy the companion uninstaller (and detection script) next to the binary so the
    # registered Add/Remove Programs UninstallString has a script to run. These live
    # beside Install.ps1 in the Intune package; copy from $PSScriptRoot (not $Source,
    # which only points at claims.exe). Non-fatal if they aren't present.
    foreach ($companion in 'Uninstall.ps1', 'Detect.ps1') {
        $srcScript = Join-Path $PSScriptRoot $companion
        if (Test-Path $srcScript) {
            Copy-Item -Force $srcScript (Join-Path $InstallDir $companion)
            Write-Host "  Companion: $companion"
        }
    }

    # Register in Add/Remove Programs (HKLM Uninstall) so the app appears and removes
    # like a normal installed product. Non-fatal: requires admin (true under the Intune
    # SYSTEM install context); skipped with a warning otherwise (e.g. a non-elevated test).
    try {
        $uninstallScript = Join-Path $InstallDir "Uninstall.ps1"
        $version = try { (Get-Item $installed).VersionInfo.FileVersion } catch { $null }
        if (-not $version) { $version = "1.0.0.0" }
        $sizeKb = [int]((Get-Item $installed).Length / 1KB)
        $regKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ZavaClaimsWorkstation"
        $uninstallCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$uninstallScript`""
        New-Item -Path $regKey -Force | Out-Null
        New-ItemProperty -Path $regKey -Name "DisplayName"     -Value "Zava Claims Workstation" -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $regKey -Name "DisplayVersion"  -Value $version -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $regKey -Name "Publisher"       -Value "Zava (demo)" -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $regKey -Name "InstallLocation" -Value $InstallDir -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $regKey -Name "DisplayIcon"     -Value "$installed,0" -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $regKey -Name "UninstallString" -Value $uninstallCmd -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $regKey -Name "QuietUninstallString" -Value $uninstallCmd -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $regKey -Name "InstallDate"     -Value (Get-Date -Format 'yyyyMMdd') -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $regKey -Name "EstimatedSize"   -Value $sizeKb -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $regKey -Name "NoModify"        -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $regKey -Name "NoRepair"        -Value 1 -PropertyType DWord -Force | Out-Null
        Write-Host "  Registered Add/Remove Programs entry: $regKey"
    }
    catch {
        Write-Warning "  Add/Remove Programs registration failed (non-fatal): $_"
    }

    Write-Host "Install complete."
    exit 0
}
catch {
    Write-Error "FATAL: $_"
    exit 1
}
finally {
    if ($transcribing) { try { Stop-Transcript | Out-Null } catch { } }
}
