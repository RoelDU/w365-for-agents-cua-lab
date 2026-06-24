# Builds and stages the Intune Win32 package source for the demo's ONLY Win32
# app: the legacy Zava Claims Workstation. The CCaaS desktop is delivered as an
# Intune managed web link (centrally hosted on Azure Static Web Apps), so it is
# intentionally NOT packaged as a Win32 app here - see docs/intune-w365.md.
#
# Default output:
#   out\intune\source\ZavaClaims\
#
# Add -CreateIntuneWin to produce the .intunewin file. If IntuneWinAppUtil.exe is
# not supplied, the script downloads Microsoft's content prep tool to out\tools.

[CmdletBinding()]
param(
    [string]$OutputRoot,
    [string]$IntuneWinAppUtilPath,
    [switch]$CreateIntuneWin,
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"

# Resolve the script directory reliably. Windows PowerShell 5.1 can leave
# $PSScriptRoot empty when evaluating param() DEFAULT expressions (it is populated
# in the body), so compute the default here, with a $MyInvocation fallback.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
if (-not $OutputRoot) { $OutputRoot = Join-Path $scriptDir "..\out\intune" }

$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$legacyRoot = Join-Path $repoRoot "apps\legacy-claims-workstation"
$sourceRoot = Join-Path $OutputRoot "source"
$packageRoot = Join-Path $OutputRoot "packages"
$toolsRoot = Join-Path $repoRoot "out\tools"

function Invoke-Logged {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory = $repoRoot
    )

    $safeArguments = if ($Arguments) { $Arguments } else { @() }
    Write-Host ">> $FilePath $($safeArguments -join ' ')"
    $startArgs = @{
        FilePath = $FilePath
        WorkingDirectory = $WorkingDirectory
        Wait = $true
        PassThru = $true
        NoNewWindow = $true
    }
    if ($safeArguments.Count -gt 0) {
        # Start-Process -ArgumentList does NOT quote array items that contain
        # whitespace, so a path under e.g. "OneDrive - Microsoft" is split and the
        # child process receives broken arguments. IntuneWinAppUtil reports this as
        # "The setup file you specified cannot be accessed." because its -c content
        # path arrives truncated. Build a single, explicitly-quoted command line so
        # space-bearing paths survive intact.
        $quoted = foreach ($a in $safeArguments) {
            if ($a -match '\s') { '"' + $a + '"' } else { $a }
        }
        $startArgs.ArgumentList = ($quoted -join ' ')
    }
    $process = Start-Process @startArgs
    if ($process.ExitCode -ne 0) {
        throw "$FilePath failed with exit code $($process.ExitCode)."
    }
}

function New-IntuneWinPackage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDirectory,
        [Parameter(Mandatory = $true)]
        [string]$PackageName
    )

    $defaultOutput = Join-Path $packageRoot "claims.intunewin"
    $namedOutput = Join-Path $packageRoot "$PackageName.intunewin"
    Remove-Item -Force $defaultOutput, $namedOutput -ErrorAction SilentlyContinue
    # IntuneWinAppUtil resolves -s relative to -c. The native compiled installer
    # (claims.exe --install) is the setup file - no PowerShell at install time (#132).
    $setupFile = Join-Path $SourceDirectory "claims.exe"
    if (-not (Test-Path -LiteralPath $setupFile)) {
        throw "Setup file not found for the $PackageName package: $setupFile"
    }
    Write-Host "  Packaging $PackageName from '$SourceDirectory' (setup: claims.exe) -> '$packageRoot'"
    Invoke-Logged -FilePath $IntuneWinAppUtilPath -Arguments @("-c", $SourceDirectory, "-s", "claims.exe", "-o", $packageRoot, "-q") -WorkingDirectory $repoRoot
    if (-not (Test-Path $defaultOutput)) {
        throw "Expected IntuneWinAppUtil output was not created: $defaultOutput"
    }
    Move-Item -Force $defaultOutput $namedOutput
}

Write-Host "Building Zava Claims Workstation..."
$claimsExe = Join-Path $legacyRoot "claims.exe"
$runningClaims = Get-Process -Name "claims" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $claimsExe }
if ($runningClaims) {
    $pids = ($runningClaims | Select-Object -ExpandProperty Id) -join ", "
    throw "Close the running Zava Claims Workstation before packaging. Locked process ID(s): $pids."
}
Invoke-Logged -FilePath (Join-Path $legacyRoot "build.bat") -WorkingDirectory $legacyRoot
if (-not $SkipTests) {
    Invoke-Logged -FilePath (Join-Path $legacyRoot "claims.exe") -Arguments @("--test") -WorkingDirectory $legacyRoot
}

New-Item -ItemType Directory -Force -Path $sourceRoot, $packageRoot | Out-Null

$claimsSource = Join-Path $sourceRoot "ZavaClaims"
New-Item -ItemType Directory -Force -Path $claimsSource | Out-Null
Remove-Item -Recurse -Force $claimsSource
New-Item -ItemType Directory -Force -Path $claimsSource | Out-Null

Write-Host "Staging Zava Claims package source..."
Copy-Item -Force (Join-Path $legacyRoot "claims.exe") $claimsSource
Copy-Item -Force (Join-Path $legacyRoot "installer\Install.ps1") $claimsSource
Copy-Item -Force (Join-Path $legacyRoot "installer\Uninstall.ps1") $claimsSource
Copy-Item -Force (Join-Path $legacyRoot "installer\Detect.ps1") $claimsSource

if ($CreateIntuneWin) {
    if (-not $IntuneWinAppUtilPath) {
        New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
        $IntuneWinAppUtilPath = Join-Path $toolsRoot "IntuneWinAppUtil.exe"
        if (-not (Test-Path $IntuneWinAppUtilPath)) {
            Write-Host "Downloading IntuneWinAppUtil.exe..."
            Invoke-WebRequest -Uri "https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool/raw/master/IntuneWinAppUtil.exe" -OutFile $IntuneWinAppUtilPath
        }
    }

    if (-not (Test-Path $IntuneWinAppUtilPath)) {
        throw "IntuneWinAppUtil.exe not found at $IntuneWinAppUtilPath."
    }

    New-IntuneWinPackage -SourceDirectory $claimsSource -PackageName "ZavaClaims"
}

Write-Host ""
Write-Host "Intune package source is ready:"
Write-Host "  $claimsSource"
if ($CreateIntuneWin) {
    Write-Host "Intune package:"
    Get-ChildItem -Path $packageRoot -Filter "*.intunewin" | ForEach-Object { Write-Host "  $($_.FullName)" }
}

Write-Host ""
Write-Host "Intune commands (native installer - no PowerShell at install time):"
Write-Host "  Zava Claims install:   claims.exe --install"
Write-Host "  Zava Claims uninstall: `"%ProgramFiles%\Business Applications\Zava Claims Workstation\claims.exe`" --uninstall"
Write-Host "  Detection: use the included Detect.ps1 script (registry + binary)."

