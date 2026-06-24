# Starts the local static server on demand, then opens the app in Edge app mode.

[CmdletBinding()]
param(
    [int]$Port = 5173
)

$ErrorActionPreference = "Stop"

$installDir = $PSScriptRoot
$root = Join-Path $installDir "dist"
$serverScript = Join-Path $installDir "Serve-Static.ps1"
$url = "http://127.0.0.1:$Port/"

function Test-AppServer {
    param([string]$Uri)
    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

if (-not (Test-AppServer -Uri $url)) {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-WindowStyle", "Hidden",
            "-File", $serverScript,
            "-Root", $root,
            "-Port", $Port
        ) `
        -WindowStyle Hidden | Out-Null

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        if (Test-AppServer -Uri $url) {
            break
        }
        Start-Sleep -Milliseconds 250
    }
}

$edgeCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edge) {
    Start-Process -FilePath $edge -ArgumentList @("--app=$url")
} else {
    Start-Process $url
}
