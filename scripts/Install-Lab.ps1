<#
.SYNOPSIS
    Guided installation of the Windows 365 for Agents lab (Copilot Studio and Foundry paths).

.DESCRIPTION
    Start here: docs\install\README.md.

    Checks the tools on this computer, asks your choices once (tenant, subscription, region,
    agent paths, Power Platform environment, names), shows the destination and a plan read from
    your tenant, then works through the installation in order. It reuses the repository's
    existing helper scripts. Steps that only a portal can do are shown as exact instructions;
    setup waits, checks the result and continues.

    Run it again at any time: every step is checked against your tenant first, finished steps
    are not repeated, and it continues where it stopped.

    Your answers and the IDs setup finds are kept in scripts\lab-setup.local.json on this
    computer (git-ignored). It holds no passwords, keys or tokens.

.PARAMETER Preview
    Sign in, read and show the plan. Changes nothing in your tenant or subscription.

.PARAMETER AgentBackend
    both, mcs (Copilot Studio only) or foundry (Foundry only). Asked if not given.

.PARAMETER ChooseAgain
    Ask the choices again (your earlier answers are offered where they still apply).

.PARAMETER DeviceCode
    Sign in with a device code instead of a browser window (for example on a server).

.EXAMPLE
    pwsh -File .\scripts\Install-Lab.ps1 -Preview
.EXAMPLE
    pwsh -File .\scripts\Install-Lab.ps1
#>
[CmdletBinding()]
param(
    [switch]$Preview,
    [ValidateSet('both', 'mcs', 'foundry')]
    [string]$AgentBackend,
    [switch]$ChooseAgain,
    [switch]$DeviceCode,
    [string]$StatePath
)

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host 'This setup needs PowerShell 7.'
    Write-Host 'Install it with:  winget install --exact --id Microsoft.PowerShell'
    Write-Host 'Then open "PowerShell 7" from the Start menu, go to this folder and run:  .\scripts\Install-Lab.ps1'
    exit 1
}

$ErrorActionPreference = 'Stop'
foreach ($part in 'LabCore', 'LabChoices', 'LabStagesShared', 'LabStagesMcs', 'LabStagesFoundry', 'LabRunner') {
    . (Join-Path $PSScriptRoot "lab\$part.ps1")
}

try {
    $result = Invoke-LabSetup -StatePath $StatePath -Preview:$Preview -AgentBackend $AgentBackend -ChooseAgain:$ChooseAgain -DeviceCode:$DeviceCode
}
catch {
    Write-Host ''
    Write-Host "Setup stopped before it reached the installation steps: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Nothing after this point was changed. Fix the cause above and run the same command again.'
    exit 1
}
if ($result.Status -in @('Ready', 'ReadyUnverified', 'Preview', 'Waiting')) { exit 0 }
exit 1
