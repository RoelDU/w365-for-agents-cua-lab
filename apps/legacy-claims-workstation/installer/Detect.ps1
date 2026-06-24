# Detect.ps1 - Intune Win32 detection script (bitness-independent, #132).
# Exit 0 + stdout = installed; else missing.
#
# VERSION-AWARE (bigger-font release): detection requires the EXPECTED version so a
# stale older install fails detection and Intune reinstalls the new content. Without
# this, the old binary already "exists" and Intune would never push an updated exe.
# Bump $expected here AND the VERSIONINFO in res\claims.rc together each release.
#
# claims.exe --install (setup.c) writes 64-bit locations:
#   - Add/Remove Programs key: 64-bit HKLM\...\Uninstall\ZavaClaimsWorkstation
#   - Binary: %ProgramFiles%\Business Applications\Zava Claims Workstation\claims.exe
# Intune may run this detection script as a 32-bit process on 64-bit clients, where
# the registry redirects to WOW6432Node and $env:ProgramFiles = "...\Program Files (x86)".
# So read the 64-bit registry view explicitly and check the real (64-bit) Program Files
# via $env:ProgramW6432 -- detection then passes regardless of host bitness or the
# "Run script as 32-bit" toggle. Legacy C:\ZavaClaims path kept for older installs.

$ErrorActionPreference = 'SilentlyContinue'

# The version this package delivers. Must match res\claims.rc FILEVERSION / FileVersion.
$expected = '1.1.1.0'

function Test-ExpectedVersion {
    param([string]$Value)
    if (-not $Value) { return $false }
    # Normalize "1.1.0.0+meta" / whitespace, compare leading dotted-quad.
    return (($Value -split '\+')[0].Trim() -eq $expected)
}

# 1) 64-bit registry view (works from a 32-bit or 64-bit host).
try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::LocalMachine,
        [Microsoft.Win32.RegistryView]::Registry64)
    $k = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ZavaClaimsWorkstation')
    if ($k) {
        $dn = $k.GetValue('DisplayName')
        $dv = [string]$k.GetValue('DisplayVersion')
        if ($dn -eq 'Zava Claims Workstation' -and (Test-ExpectedVersion $dv)) {
            Write-Host "Detected: $dn $dv (registry64)"
            exit 0
        }
    }
} catch { }

# 2) Binary fallback. $env:ProgramW6432 is always C:\Program Files, even in a 32-bit host.
# Require the binary's own version resource to match so an older exe does NOT satisfy detection.
$roots = @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ } | Select-Object -Unique
$candidates = @()
foreach ($r in $roots) { $candidates += (Join-Path $r 'Business Applications\Zava Claims Workstation\claims.exe') }
$candidates += 'C:\ZavaClaims\claims.exe'
foreach ($exe in ($candidates | Select-Object -Unique)) {
    if (Test-Path $exe) {
        $info = Get-Item $exe
        $fv = $info.VersionInfo.FileVersion
        if ($info.Length -gt 100KB -and (Test-ExpectedVersion $fv)) {
            Write-Host "Detected: $($info.FullName) v$fv ($($info.Length) bytes)"
            exit 0
        }
        Write-Host "Found $($info.FullName) v$fv ($($info.Length) bytes) - not the expected v$expected; treating as not installed"
    }
}
exit 1

