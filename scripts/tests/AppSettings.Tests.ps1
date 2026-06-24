# Regression tests for Write-AppSettingsFile (see issue #35).
#
# On Windows, 'az' is a batch wrapper (az.cmd) that re-parses arguments through
# cmd.exe. Passing inline 'KEY=VALUE' app settings breaks when a value contains
# cmd metacharacters such as the '(' ';' ')' in a Key Vault reference like
# '@Microsoft.KeyVault(VaultName=...;SecretName=...)'. We route the values through
# an '@file' instead. These tests assert the file round-trips such values intact.
#
# Run with: Invoke-Pester -Path .\scripts\tests\AppSettings.Tests.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here '..\DemoCommon.ps1')

Describe 'Write-AppSettingsFile' {
    It 'preserves Key Vault reference values containing parentheses and semicolons' {
        $kv = 'zava-handoff-kv-sample'
        $settings = [ordered]@{
            HANDOFF_CHANNEL           = 'directline'
            HANDOFF_CALLBACK_KEY      = "@Microsoft.KeyVault(VaultName=$kv;SecretName=HandoffCallbackKey)"
            DIRECTLINE_TOKEN_ENDPOINT = "@Microsoft.KeyVault(VaultName=$kv;SecretName=DirectLineTokenEndpoint)"
        }

        $path = Write-AppSettingsFile -Settings $settings
        try {
            Test-Path $path | Should Be $true
            $obj = (Get-Content -Raw $path) | ConvertFrom-Json
            $obj.HANDOFF_CHANNEL | Should Be 'directline'
            $obj.HANDOFF_CALLBACK_KEY | Should Be "@Microsoft.KeyVault(VaultName=$kv;SecretName=HandoffCallbackKey)"
            $obj.DIRECTLINE_TOKEN_ENDPOINT | Should Be "@Microsoft.KeyVault(VaultName=$kv;SecretName=DirectLineTokenEndpoint)"
        }
        finally {
            Remove-Item -Path $path -ErrorAction SilentlyContinue
        }
    }

    It 'preserves engine (Direct-to-Engine) settings incl. Key Vault references' {
        $kv = 'zava-handoff-kv-sample'
        $url = 'https://env.environment.api.powerplatform.com/powervirtualagents/botsbyschema/zava_agent/conversations?api-version=2022-03-01-preview'
        $settings = [ordered]@{
            HANDOFF_CHANNEL          = 'engine'
            ENGINE_CONVERSATIONS_URL = $url
            ENGINE_CLIENT_SECRET     = "@Microsoft.KeyVault(VaultName=$kv;SecretName=EngineClientSecret)"
        }
        $path = Write-AppSettingsFile -Settings $settings
        try {
            $obj = (Get-Content -Raw $path) | ConvertFrom-Json
            $obj.HANDOFF_CHANNEL | Should Be 'engine'
            $obj.ENGINE_CONVERSATIONS_URL | Should Be $url
            $obj.ENGINE_CLIENT_SECRET | Should Be "@Microsoft.KeyVault(VaultName=$kv;SecretName=EngineClientSecret)"
        }
        finally {
            Remove-Item -Path $path -ErrorAction SilentlyContinue
        }
    }

    It 'writes a JSON object (not an array), which az appsettings set accepts via @file' {
        $settings = [ordered]@{ FOO = 'bar' }
        $path = Write-AppSettingsFile -Settings $settings
        try {
            $raw = (Get-Content -Raw $path).Trim()
            $raw.StartsWith('{') | Should Be $true
            $raw.StartsWith('[') | Should Be $false
        }
        finally {
            Remove-Item -Path $path -ErrorAction SilentlyContinue
        }
    }
}
