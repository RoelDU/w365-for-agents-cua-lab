<#
.SYNOPSIS
Builds and deploys the Zava Foundry hosted Claims agent in explicit steps.

.DESCRIPTION
Default use is safe and read-only: -Plan prints the operations and -RenderDefinition
writes a git-ignored local definition receipt. -BuildImage runs an Azure Container
Registry build and saves the image digest into the local config; -DeployVersion /
-ConfigureEndpoint call the Foundry SDK. Each of those three honours -WhatIf and -Confirm:
under -WhatIf nothing is built, Python is not started and Foundry is not changed.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigPath = ".\deploy\foundry\foundry-agent.local.json",
    [switch]$Plan,
    [switch]$BuildImage,
    [switch]$RenderDefinition,
    [switch]$DeployVersion,
    [switch]$ConfigureEndpoint,
    # With -ConfigureEndpoint: send all traffic to this version instead of @latest.
    [string]$PinVersion,
    [string]$Python = "python"
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Config not found: $ConfigPath. Copy deploy\foundry\foundry-agent.sample.json to deploy\foundry\foundry-agent.local.json first."
}

$configFull = (Resolve-Path -LiteralPath $ConfigPath).Path
$config = Get-Content -Raw -LiteralPath $configFull | ConvertFrom-Json

function Show-Plan {
    Write-Host "Foundry hosted Claims agent plan" -ForegroundColor White
    Write-Host "  Config              : $configFull"
    Write-Host "  Subscription        : $($config.subscriptionId)"
    Write-Host "  Resource group      : $($config.resourceGroup)"
    Write-Host "  Registry            : $($config.containerRegistryName).azurecr.io"
    Write-Host "  Image               : $($config.imageRepository):$($config.imageTag)"
    Write-Host "  Image digest        : $($config.imageDigest)"
    Write-Host "  Foundry project     : $($config.foundryProjectEndpoint)"
    Write-Host "  Agent               : $($config.agentName)"
    Write-Host "  Receipt             : $($config.outputReceiptPath)"
    Write-Host ""
    Write-Host "Mutating actions are opt-in only:" -ForegroundColor Yellow
    Write-Host "  -BuildImage         runs az acr build on a temporary copy of only the files the Dockerfile uses."
    Write-Host "  -DeployVersion      creates a new hosted-agent version."
    Write-Host "  -ConfigureEndpoint  updates the agent endpoint to Invocations + Entra auth."
    Write-Host "  -PinVersion N       (with -ConfigureEndpoint) all traffic to version N instead of @latest."
}

if ($Plan -or (-not ($BuildImage -or $RenderDefinition -or $DeployVersion -or $ConfigureEndpoint))) {
    Show-Plan
    if (-not ($BuildImage -or $RenderDefinition -or $DeployVersion -or $ConfigureEndpoint)) { return }
}

$imageDigest = [string]$config.imageDigest

function New-ImageBuildContext {
    # az acr build uploads its whole context folder, and its .dockerignore handling re-includes
    # everything under samples\ (including git-ignored .venv, .env and local run data). So the
    # context is a temporary folder with only the files the Dockerfile copies.
    $sample = 'samples\foundry-hosted-claims'
    $files = @("$sample\Dockerfile", "$sample\pyproject.toml",
        'schemas\call-context.schema.json', 'schemas\result.schema.json', 'schemas\error.schema.json')
    $files += Get-ChildItem -LiteralPath (Join-Path $repoRoot "$sample\hosted_claims") -File |
        Where-Object { $_.Extension -in '.py', '.html' } | ForEach-Object { "$sample\hosted_claims\$($_.Name)" }
    $stage = Join-Path ([IO.Path]::GetTempPath()) ('claims-w365-context-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    foreach ($file in $files) {
        $target = Join-Path $stage $file
        New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $target
    }
    foreach ($line in Get-Content -LiteralPath (Join-Path $stage "$sample\Dockerfile")) {
        if ($line -match '^\s*COPY\s+(.+)\s+\S+\s*$') {
            foreach ($source in $Matches[1] -split '\s+') {
                if (-not (Test-Path -LiteralPath (Join-Path $stage $source))) {
                    Remove-Item -Recurse -Force $stage
                    throw "The Dockerfile copies '$source', which the build context does not include. Update New-ImageBuildContext."
                }
            }
        }
    }
    return $stage
}

if ($BuildImage) {
    $registry = [string]$config.containerRegistryName
    $repository = [string]$config.imageRepository
    $tag = [string]$config.imageTag
    if ([string]::IsNullOrWhiteSpace($registry) -or [string]::IsNullOrWhiteSpace($repository) -or [string]::IsNullOrWhiteSpace($tag)) {
        throw "containerRegistryName, imageRepository, and imageTag are required for -BuildImage."
    }
    if ($PSCmdlet.ShouldProcess("${registry}/${repository}:${tag}", "Build container image in Azure Container Registry")) {
        if ($config.subscriptionId) { az account set --subscription $config.subscriptionId | Out-Null }
        $context = New-ImageBuildContext
        try {
            Write-Host "Build context: $((Get-ChildItem -Recurse -File $context).Count) files staged in $context"
            az acr build --registry $registry --image "$repository`:$tag" --file "samples/foundry-hosted-claims/Dockerfile" --platform linux/amd64 $context
            if ($LASTEXITCODE -ne 0) { throw "az acr build failed." }
        }
        finally {
            Remove-Item -Recurse -Force -LiteralPath $context -ErrorAction SilentlyContinue
        }
        $imageDigest = (az acr repository show-manifests --name $registry --repository $repository --query "[?tags[?@=='$tag']].digest | [0]" -o tsv 2>$null)
        if ([string]::IsNullOrWhiteSpace($imageDigest)) {
            throw "Build finished but the digest could not be read. Paste the digest into foundry-agent.local.json and rerun -RenderDefinition."
        }
        Write-Host "Built image digest: $imageDigest" -ForegroundColor Green
        # Save the digest in the local config so the later, separate -RenderDefinition and
        # -DeployVersion commands use exactly this immutable image.
        $saved = Get-Content -Raw -LiteralPath $configFull | ConvertFrom-Json
        $saved.imageDigest = $imageDigest
        $saved | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $configFull -Encoding utf8
        Write-Host "Saved imageDigest to $configFull" -ForegroundColor Green
    }
}

# -DeployVersion and -ConfigureEndpoint change Foundry. Under -WhatIf (or a declined -Confirm)
# they are dropped before Python runs, so only the read-only definition render remains.
if ($DeployVersion -and -not $PSCmdlet.ShouldProcess("agent '$($config.agentName)' in $($config.foundryProjectEndpoint)", "Create a new hosted agent version")) {
    $DeployVersion = $false
    Write-Host "Not creating a hosted agent version (preview or declined)." -ForegroundColor Yellow
}
if ($PinVersion -and -not $ConfigureEndpoint) { throw "-PinVersion needs -ConfigureEndpoint." }
$endpointAction = if ($PinVersion) { "Set the agent endpoint to Invocations with Entra authorization, all traffic to version $PinVersion" } else { "Set the agent endpoint to Invocations with Entra authorization" }
if ($ConfigureEndpoint -and -not $PSCmdlet.ShouldProcess("agent '$($config.agentName)' in $($config.foundryProjectEndpoint)", $endpointAction)) {
    $ConfigureEndpoint = $false
    Write-Host "Not changing the agent endpoint (preview or declined)." -ForegroundColor Yellow
}

if ($RenderDefinition -or $DeployVersion -or $ConfigureEndpoint -or $BuildImage) {
    if (-not $imageDigest) {
        if ($BuildImage -and -not ($RenderDefinition -or $DeployVersion -or $ConfigureEndpoint)) { return }
        throw "imageDigest is empty in $configFull. Run -BuildImage first (it saves the digest there), or paste the sha256: digest of the image you built."
    }
    $pyArgs = @("deploy\foundry\deploy_foundry_agent.py", "--config", $configFull, "--image-digest", $imageDigest)
    if ($DeployVersion) { $pyArgs += "--deploy-version" }
    if ($ConfigureEndpoint) { $pyArgs += "--configure-endpoint" }
    if ($ConfigureEndpoint -and $PinVersion) { $pyArgs += @("--pin-version", $PinVersion) }
    & $Python @pyArgs
    if ($LASTEXITCODE -ne 0) { throw "Foundry deployment helper failed." }
}
