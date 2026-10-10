<#
.SYNOPSIS
Plans or creates the Dataverse trigger table used by the MCS Computer Use path.

.DESCRIPTION
Default mode is plan-only. It prints the Dataverse Web API metadata payload and
checks whether the table already exists. Use -Apply to create the table. The
script never stores tokens; it obtains an access token with Azure CLI for the
Dataverse organization URL you pass.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$OrgUrl,

    [string]$PublisherPrefix = 'crcce',
    [string]$TableDisplayName = 'Claim Request',
    [string]$TableCollectionDisplayName = 'Claim Requests',
    [string]$TableSchemaSuffix = 'ClaimRequest',
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'

function New-Label([string]$Text) {
    @{ LocalizedLabels = @(@{ Label = $Text; LanguageCode = 1033 }) }
}

function New-RequiredNone {
    @{ Value = 'None'; CanBeChanged = $true; ManagedPropertyLogicalName = 'canmodifyrequirementlevelsettings' }
}

function New-StringAttribute([string]$SchemaName, [string]$DisplayName, [int]$MaxLength) {
    [ordered]@{
        '@odata.type' = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
        SchemaName    = $SchemaName
        DisplayName   = New-Label $DisplayName
        Description   = New-Label $DisplayName
        RequiredLevel = New-RequiredNone
        MaxLength     = $MaxLength
        FormatName    = @{ Value = 'Text' }
    }
}

function New-MemoAttribute([string]$SchemaName, [string]$DisplayName) {
    [ordered]@{
        '@odata.type' = 'Microsoft.Dynamics.CRM.MemoAttributeMetadata'
        SchemaName    = $SchemaName
        DisplayName   = New-Label $DisplayName
        Description   = New-Label $DisplayName
        RequiredLevel = New-RequiredNone
        MaxLength     = 1048576
        FormatName    = @{ Value = 'TextArea' }
    }
}

$org = $OrgUrl.TrimEnd('/')
$prefix = $PublisherPrefix.TrimEnd('_')
$tableSchema = "${prefix}_$TableSchemaSuffix"
$tableLogical = $tableSchema.ToLowerInvariant()
$entitySet = "${tableLogical}s"

$attributes = @(
    (New-StringAttribute "${prefix}_Name" 'Name' 200),
    (New-StringAttribute "${prefix}_Policynumber" 'Policy Number' 100),
    (New-StringAttribute "${prefix}_Summary" 'Summary' 4000),
    (New-StringAttribute "${prefix}_Correlationid" 'Correlation ID' 100),
    (New-StringAttribute "${prefix}_Lang" 'Language' 10),
    (New-MemoAttribute "${prefix}_handoffcontext" 'Handoff Context JSON'),
    (New-StringAttribute "${prefix}_Claimid" 'Claim ID' 50),
    (New-MemoAttribute "${prefix}_handoffreceipt" 'Handoff Receipt JSON'),
    (New-StringAttribute "${prefix}_Status" 'Status' 50)
)
# Dataverse requires exactly one primary-name text column in the create request.
$attributes[0]['IsPrimaryName'] = $true

$body = [ordered]@{
    '@odata.type'          = 'Microsoft.Dynamics.CRM.EntityMetadata'
    SchemaName             = $tableSchema
    DisplayName            = New-Label $TableDisplayName
    DisplayCollectionName  = New-Label $TableCollectionDisplayName
    Description            = New-Label 'Trigger rows for Zava MCS Computer Use handoffs.'
    OwnershipType          = 'UserOwned'
    IsActivity             = $false
    HasActivities          = $false
    HasNotes               = $false
    Attributes             = $attributes
}

Write-Host "Dataverse organization : $org"
Write-Host "Table logical name     : $tableLogical"
Write-Host "Expected entity set    : $entitySet"
Write-Host "Primary name column    : ${prefix}_name (text, 200)"
Write-Host "Ownership             : User/team owned"
Write-Host ""
Write-Host "Columns to create:"
$attributes | ForEach-Object {
    $kind = if ($_.'@odata.type' -like '*Memo*') { 'Multiline text' } else { 'Text' }
    [pscustomobject]@{ SchemaName = $_.SchemaName; Type = $kind; MaxLength = $_.MaxLength }
} | Format-Table -AutoSize | Out-Host

$payload = $body | ConvertTo-Json -Depth 20
if (-not $Apply) {
    Write-Host "Plan only. Re-run with -Apply to create the table. Payload:" -ForegroundColor Yellow
    $payload
    return
}

$token = az account get-access-token --resource $org --query accessToken -o tsv
if ([string]::IsNullOrWhiteSpace($token)) { throw 'Azure CLI did not return a Dataverse access token.' }
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/json'; 'Content-Type' = 'application/json' }

$existingUrl = "$org/api/data/v9.2/EntityDefinitions(LogicalName='$tableLogical')?`$select=LogicalName"
try {
    Invoke-RestMethod -Headers $headers -Uri $existingUrl -Method Get | Out-Null
    Write-Host "Table '$tableLogical' already exists; no create was sent." -ForegroundColor Green
    return
}
catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -ne 404) { throw }
}

if ($PSCmdlet.ShouldProcess($tableLogical, 'Create Dataverse trigger table')) {
    Invoke-RestMethod -Headers $headers -Uri "$org/api/data/v9.2/EntityDefinitions" -Method Post -Body $payload | Out-Null
    Write-Host "Created table '$tableLogical'. Publish customizations in Power Apps before using it." -ForegroundColor Green
}
