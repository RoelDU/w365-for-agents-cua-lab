# Regression tests for Assert-Prerequisite (see issue #37).
#
# A tool that is on PATH (a shim exists) but is broken - e.g. an npm-installed
# Azure Functions Core Tools shim whose target binary is missing, so
# 'func --version' exits non-zero with "spawn ...\bin/func ENOENT" - must NOT be
# reported as OK. The check must require a zero exit code and (when a pattern is
# given) a sane version string.
#
# Run with: Invoke-Pester -Path .\scripts\tests\Prerequisite.Tests.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here '..\DemoCommon.ps1')

function New-FakeToolOnPath {
    # Writes a <Name>.cmd that echoes $Output and exits $ExitCode, into a fresh
    # temp dir that is prepended to PATH. Returns the temp dir path.
    param([string]$Name, [string]$Output, [int]$ExitCode)
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("prereq-test-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    @('@echo off', "echo $Output", "exit /b $ExitCode") |
        Set-Content -Path (Join-Path $dir "$Name.cmd") -Encoding ASCII
    $env:Path = "$dir;$env:Path"
    return $dir
}

Describe 'Assert-Prerequisite' {
    It 'rejects an on-PATH tool whose --version exits non-zero (broken shim)' {
        $name = "brokenfunc" + [guid]::NewGuid().ToString('N')
        $dir = New-FakeToolOnPath -Name $name -Output 'spawn ENOENT' -ExitCode 1
        $threw = $false
        try { Assert-Prerequisite -Name $name -VersionPattern '^\d+\.\d+' -InstallHint 'reinstall' }
        catch { $threw = $true }
        $threw | Should Be $true
        Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'rejects an on-PATH tool whose --version output does not match the version pattern' {
        $name = "junkfunc" + [guid]::NewGuid().ToString('N')
        $dir = New-FakeToolOnPath -Name $name -Output 'not-a-version' -ExitCode 0
        $threw = $false
        try { Assert-Prerequisite -Name $name -VersionPattern '^\d+\.\d+' -InstallHint 'reinstall' }
        catch { $threw = $true }
        $threw | Should Be $true
        Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'accepts a working tool that exits 0 with a sane version string' {
        $name = "goodfunc" + [guid]::NewGuid().ToString('N')
        $dir = New-FakeToolOnPath -Name $name -Output '4.0.5530' -ExitCode 0
        $threw = $false
        try { Assert-Prerequisite -Name $name -VersionPattern '^\d+\.\d+' -InstallHint 'reinstall' }
        catch { $threw = $true }
        $threw | Should Be $false
        Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'only warns for a broken optional tool instead of throwing' {
        $name = "optfunc" + [guid]::NewGuid().ToString('N')
        $dir = New-FakeToolOnPath -Name $name -Output 'ENOENT' -ExitCode 1
        $threw = $false
        try { Assert-Prerequisite -Name $name -VersionPattern '^\d+\.\d+' -InstallHint 'reinstall' -Optional -WarningAction SilentlyContinue }
        catch { $threw = $true }
        $threw | Should Be $false
        Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
