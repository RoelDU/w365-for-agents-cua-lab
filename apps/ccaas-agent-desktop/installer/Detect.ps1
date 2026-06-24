# Detect.ps1 - Intune Win32 detection script.
# Exit code 0 + non-empty stdout = installed; otherwise considered missing.

$installDir = "C:\Program Files\Zava\CCaaSAgentDesktop"
$index = Join-Path $installDir "dist\index.html"
$launcher = Join-Path $installDir "Start-CCaaSAgentDesktop.ps1"

if ((Test-Path $index) -and (Test-Path $launcher)) {
    $version = Join-Path $installDir "version.txt"
    if (Test-Path $version) {
        Write-Host "Detected Zava Contact Center version $(Get-Content -Raw $version)"
    } else {
        Write-Host "Detected Zava Contact Center at $installDir"
    }
    exit 0
}

exit 1
