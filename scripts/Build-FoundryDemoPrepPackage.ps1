<#
.SYNOPSIS
    Builds the standalone Zava Foundry demo preparation package (a versioned ZIP).

.DESCRIPTION
    Packs scripts\foundry-demo-prep\ into deploy\foundry-demo-prep\zava-foundry-demo-prep-<version>.zip
    and writes PACKAGE-MANIFEST.txt (SHA256 + source commit) beside it, like
    deploy\intune-packages. The version comes from $PackageVersion in Prepare-FoundryDemo.ps1.

    The package must stay environment-neutral: the build stops if a packaged file names a
    developer path or session folder, or if the template holds real values. A filled-in
    foundry-demo.config.json is never packaged; give environment configuration separately.
#>
[CmdletBinding()]
param(
    [string]$OutputDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy\foundry-demo-prep')
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'foundry-demo-prep'
$files = 'START-HERE.txt', 'Prepare-FoundryDemo.cmd', 'Prepare-FoundryDemo.ps1', 'foundry-demo.config.template.json'

$scriptText = Get-Content (Join-Path $source 'Prepare-FoundryDemo.ps1') -Raw
$version = [regex]::Match($scriptText, "\`$PackageVersion\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'").Groups[1].Value
if (-not $version) { throw 'Could not read $PackageVersion from Prepare-FoundryDemo.ps1.' }

$forbidden = 'C:\\DEV', '\.scratch', 'session-state', '\.local\.json', 'Bearer [A-Za-z0-9\-_]{20,}'
foreach ($name in $files) {
    $path = Join-Path $source $name
    if (-not (Test-Path $path)) { throw "Missing package file $path" }
    $text = Get-Content $path -Raw
    foreach ($pattern in $forbidden) {
        if ($text -match $pattern) { throw "$name contains '$($Matches[0])'; the package must not depend on or reveal developer files." }
    }
    if ($text -match '[^\x00-\x7F]') { throw "$name contains non-ASCII characters; Windows PowerShell 5.1 may misread them." }
}
$template = Get-Content (Join-Path $source 'foundry-demo.config.template.json') -Raw | ConvertFrom-Json
foreach ($key in 'zavaUrl', 'relayUrl', 'foundryAgentUrl', 'cloudPcPoolId', 'tenantId') {
    if ([string]$template.$key -notmatch '<[^>]+>') { throw "Template value '$key' must stay a <placeholder>." }
}

$commit = 'unknown (git not available)'
if (Get-Command git -ErrorAction SilentlyContinue) {
    $commit = (git -C $PSScriptRoot rev-parse --short HEAD).Trim()
    if (git -C $PSScriptRoot status --porcelain -- $source) { $commit += ' + uncommitted package-source changes' }
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ("foundry-demo-prep-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $stage | Out-Null
try {
    $lines = @(
        "Zava Foundry demo preparation package",
        "Version: $version",
        "Built: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm')) UTC",
        "Source commit: $commit",
        "Start with START-HERE.txt. Contains no environment configuration, credentials or tokens.",
        "",
        "Files (SHA256):"
    )
    foreach ($name in $files) {
        Copy-Item (Join-Path $source $name) (Join-Path $stage $name)
        $lines += "  {0}  {1}" -f (Get-FileHash (Join-Path $stage $name) -Algorithm SHA256).Hash, $name
    }
    Set-Content -Path (Join-Path $stage 'PACKAGE-INFO.txt') -Value $lines -Encoding ascii

    New-Item -ItemType Directory -Force $OutputDir | Out-Null
    $zipName = "zava-foundry-demo-prep-$version.zip"
    $zip = Join-Path $OutputDir $zipName
    if (Test-Path $zip) { Remove-Item $zip }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash
    $manifest = @(
        "Zava Foundry demo preparation - package manifest",
        "Package: $zipName ($((Get-Item $zip).Length) bytes)",
        "  SHA256: $hash",
        "Version: $version",
        "Source: scripts\foundry-demo-prep at commit $commit",
        "Built with: scripts\Build-FoundryDemoPrepPackage.ps1"
    ) + $lines[5..($lines.Count - 1)]
    Set-Content -Path (Join-Path $OutputDir 'PACKAGE-MANIFEST.txt') -Value $manifest -Encoding ascii
    Write-Host "Built $zip"
    Write-Host "SHA256 $hash"
} finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
