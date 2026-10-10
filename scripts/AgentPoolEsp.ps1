# Helpers for Set-AgentPoolEspSkip.ps1. All Graph calls go through
# Invoke-AgentPoolGraph so tests can replace it.
#
# Windows 365 enrolls each new Cloud PC in Intune and shows the Enrollment Status
# Page (ESP) "Account setup" phase at the first user sign-in. In the pool this was
# written for, each session was observed to get a newly provisioned Cloud PC, so
# the agent user signed in for the first time on every session. The only
# supported way to change ESP for one set of Cloud PCs is a custom ESP profile
# assigned to All devices with an include filter on enrollmentProfileName:
# https://learn.microsoft.com/windows-365/enterprise/enrollment-status-page
# That pool's Cloud PCs were observed to enroll with the pool display name as
# that value, so the filter is an exact match on the pool name, never a prefix.
# The Intune filter preview must show it reaches only that pool's Cloud PCs at
# the time of Apply; it does not stop a later device from reusing the name.
#
# Objects are created only, never adopted by name. Their IDs go into a local
# receipt bound to tenant and pool, and -Remove deletes only those IDs.
#
# Keep this file ASCII-only (Windows PowerShell 5.1 reads non-BOM UTF-8 as ANSI).

$script:AgentPoolModel = 'Cloud PC for Agents'
$script:AgentPoolPreviewTop = 50

function Assert-AgentPoolName {
    param([string]$PoolName)
    if ([string]::IsNullOrWhiteSpace($PoolName) -or $PoolName.Trim() -ne $PoolName) {
        throw "Pool name must be the exact, non-empty pool display name."
    }
    if ($PoolName -match '["\\]') {
        throw "Pool name contains a quote or backslash; refusing to build a filter rule from it."
    }
}

function Get-AgentPoolEspNames {
    param([Parameter(Mandatory = $true)][string]$PoolName)
    Assert-AgentPoolName -PoolName $PoolName
    [pscustomobject]@{
        Filter = "$PoolName - agent Cloud PCs"
        Esp    = "$PoolName - no account setup screen"
    }
}

function New-AgentPoolFilterRule {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$PoolName)
    Assert-AgentPoolName -PoolName $PoolName
    "(device.enrollmentProfileName -eq `"$PoolName`")"
}

function New-AgentPoolFilterBody {
    param([Parameter(Mandatory = $true)][string]$PoolName)
    [ordered]@{
        displayName    = (Get-AgentPoolEspNames -PoolName $PoolName).Filter
        description    = "Windows 365 for Agents Cloud PCs enrolled by pool '$PoolName'. Used only by its custom ESP."
        platform       = 'windows10AndLater'
        rule           = New-AgentPoolFilterRule -PoolName $PoolName
        roleScopeTags  = @('0')
    }
}

function New-AgentPoolEspBody {
    param([Parameter(Mandatory = $true)][string]$PoolName, [int]$Priority = 1)
    # Graph rejects a sparse custom ESP with a bare 400, so every setting is explicit.
    # Values match the tenant default ESP except showInstallationProgress; with the page
    # hidden, the install/failure settings do not gate the desktop.
    [ordered]@{
        '@odata.type'                           = '#microsoft.graph.windows10EnrollmentCompletionPageConfiguration'
        displayName                             = (Get-AgentPoolEspNames -PoolName $PoolName).Esp
        description                             = "Hides Windows account setup at the agent user's first sign-in on pool '$PoolName'. Policies and apps still apply in the background."
        priority                                = $Priority
        showInstallationProgress                = $false
        blockDeviceSetupRetryByUser             = $false
        allowDeviceResetOnInstallFailure        = $true
        allowLogCollectionOnInstallFailure      = $true
        customErrorMessage                      = ''
        installProgressTimeoutInMinutes         = 60
        allowDeviceUseOnInstallFailure          = $true
        selectedMobileAppIds                    = @()
        allowNonBlockingAppInstallation         = $false
        installQualityUpdates                   = $false
        trackInstallProgressForAutopilotOnly    = $false
        disableUserStatusTrackingAfterFirstUser = $false
        roleScopeTagIds                         = @('0')
    }
}

function New-AgentPoolEspAssignBody {
    param([Parameter(Mandatory = $true)][string]$FilterId)
    @{
        enrollmentConfigurationAssignments = @(
            @{
                target = @{
                    '@odata.type'                              = '#microsoft.graph.allDevicesAssignmentTarget'
                    deviceAndAppManagementAssignmentFilterId   = $FilterId
                    deviceAndAppManagementAssignmentFilterType = 'include'
                }
            }
        )
    }
}

function New-AgentPoolPreviewBody {
    param([Parameter(Mandatory = $true)][string]$PoolName)
    @{
        data = @{
            platform = 'windows10AndLater'
            rule     = New-AgentPoolFilterRule -PoolName $PoolName
            top      = $script:AgentPoolPreviewTop
            skip     = 0
            orderBy  = @()
            search   = ''
        }
    }
}

# evaluateAssignmentFilter returns { TotalRowCount, Columns[{Name}], Values[[...]] }.
function ConvertFrom-AgentPoolPreview {
    param([Parameter(Mandatory = $true)]$Preview)
    $names = @($Preview.Columns | ForEach-Object { $_.Name })
    foreach ($values in @($Preview.Values)) {
        $row = [ordered]@{}
        for ($i = 0; $i -lt $names.Count; $i++) { $row[$names[$i]] = $values[$i] }
        [pscustomobject]$row
    }
}

# Refuse unless Intune's own filter preview proves the rule reaches at least one
# Cloud PC of this pool and nothing else.
function Test-AgentPoolFilterMatch {
    param(
        [Parameter(Mandatory = $true)]$Preview,
        [Parameter(Mandatory = $true)][string]$PoolName
    )
    $rows = @(ConvertFrom-AgentPoolPreview -Preview $Preview)
    $fail = { param($reason) [pscustomobject]@{ Ok = $false; Reason = $reason; Devices = @() } }
    if ([int]$Preview.TotalRowCount -ne $rows.Count) {
        return & $fail "Filter preview returned $($rows.Count) of $($Preview.TotalRowCount) devices; refusing to assume the rest."
    }
    if ($rows.Count -eq 0) {
        return & $fail "Filter preview found no device of pool '$PoolName'; the match is unproven. Retry after the pool has an enrolled Cloud PC."
    }
    $outside = @($rows | Where-Object { $_.model -ne $script:AgentPoolModel -or $_.enrollmentProfileName -ne $PoolName })
    if ($outside.Count -gt 0) {
        $names = ($outside | ForEach-Object { "$($_.deviceName) ($($_.model))" }) -join ', '
        return & $fail "Filter would also reach devices outside the pool: $names"
    }
    [pscustomobject]@{ Ok = $true; Reason = ''; Devices = @($rows | ForEach-Object { $_.deviceName }) }
}

$script:AgentPoolGraphBase = 'https://graph.microsoft.com/beta/deviceManagement'
$script:EspType = '#microsoft.graph.windows10EnrollmentCompletionPageConfiguration'

# The only function that talks to Graph. -AllowNotFound returns $null on 404.
# -JsonAsFile: evaluateAssignmentFilter labels its JSON body application/octet-stream,
# which Invoke-MgGraphRequest (2.37) refuses unless the body is written to a file.
function Invoke-AgentPoolGraph {
    param([string]$Method, [string]$Uri, $Body, [switch]$AllowNotFound, [switch]$JsonAsFile)
    $request = @{ Method = $Method; Uri = $Uri; OutputType = 'PSObject' }
    if ($null -ne $Body) {
        $request['Body'] = $Body | ConvertTo-Json -Depth 8
        $request['ContentType'] = 'application/json'
    }
    $file = $null
    if ($JsonAsFile) {
        $file = [IO.Path]::GetTempFileName()
        $request.Remove('OutputType')
        $request['OutputFilePath'] = $file
    }
    try {
        $response = Invoke-MgGraphRequest @request
        if ($JsonAsFile) { Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } else { $response }
    }
    catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($AllowNotFound -and $status -eq 404) { return $null }
        throw
    }
    finally {
        if ($file) { Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue }
    }
}

function Get-AgentPoolGraphAll([string]$Uri) {
    while ($Uri) {
        $page = Invoke-AgentPoolGraph -Method GET -Uri $Uri
        @($page.value)
        $Uri = $page.'@odata.nextLink'
    }
}

function Get-AgentPoolOne([string]$PoolName) {
    $pools = @(Get-AgentPoolGraphAll "$script:AgentPoolGraphBase/virtualEndpoint/cloudPcPools" |
            Where-Object { $_.displayName -ceq $PoolName -and $_.'@odata.type' -eq '#microsoft.graph.cloudPcAgentPool' })
    if ($pools.Count -ne 1) {
        throw "Expected exactly one Windows 365 for Agents pool named '$PoolName'; found $($pools.Count)."
    }
    $pools[0]
}

# Every existing filter or ESP that carries this script's names. Without a
# receipt naming its ID, such an object is someone else's and is never reused.
function Find-AgentPoolEspNamedObjects([string]$PoolName) {
    $names = Get-AgentPoolEspNames -PoolName $PoolName
    foreach ($f in @(Get-AgentPoolGraphAll "$script:AgentPoolGraphBase/assignmentFilters")) {
        if ($f.displayName -eq $names.Filter) { [pscustomobject]@{ Kind = 'filter'; Id = $f.id } }
    }
    foreach ($e in @(Get-AgentPoolGraphAll "$script:AgentPoolGraphBase/deviceEnrollmentConfigurations")) {
        if ($e.displayName -eq $names.Esp) { [pscustomobject]@{ Kind = 'ESP'; Id = $e.id } }
    }
}

function Get-AgentPoolFilterPreview([string]$PoolName) {
    $preview = Invoke-AgentPoolGraph -Method POST -Uri "$script:AgentPoolGraphBase/evaluateAssignmentFilter" `
        -Body (New-AgentPoolPreviewBody -PoolName $PoolName) -JsonAsFile
    Test-AgentPoolFilterMatch -Preview $preview -PoolName $PoolName
}

function Test-AgentPoolFilterObject($Filter, [string]$PoolName) {
    $null -ne $Filter -and
    $Filter.displayName -ceq (Get-AgentPoolEspNames -PoolName $PoolName).Filter -and
    $Filter.platform -eq 'windows10AndLater' -and
    $Filter.rule -ceq (New-AgentPoolFilterRule -PoolName $PoolName)
}

# Unassigned, or exactly one All devices assignment with the recorded include filter.
function Test-AgentPoolEspObject($Esp, $Assignments, [string]$PoolName, [string]$FilterId) {
    if ($null -eq $Esp -or $Esp.'@odata.type' -ne $script:EspType -or
        $Esp.displayName -cne (Get-AgentPoolEspNames -PoolName $PoolName).Esp -or
        $Esp.showInstallationProgress -ne $false) { return $false }
    $list = @($Assignments | Where-Object { $null -ne $_ })
    if ($list.Count -eq 0) { return $true }
    if ($list.Count -ne 1) { return $false }
    $t = $list[0].target
    $t.'@odata.type' -eq '#microsoft.graph.allDevicesAssignmentTarget' -and
    $t.deviceAndAppManagementAssignmentFilterId -eq $FilterId -and
    $t.deviceAndAppManagementAssignmentFilterType -eq 'include'
}

function Read-AgentPoolEspReceipt([string]$Path) {
    if (Test-Path $Path) { Get-Content $Path -Raw | ConvertFrom-Json }
}

function Save-AgentPoolEspReceipt([string]$Path, $Receipt) {
    $Receipt.updatedUtc = [DateTime]::UtcNow.ToString('o')
    $Receipt | ConvertTo-Json | Set-Content -Path $Path -Encoding ASCII
}

function Assert-AgentPoolEspReceiptFor($Receipt, [string]$TenantId, [string]$PoolName, [string]$Path) {
    if ($Receipt.tenantId -ne $TenantId -or $Receipt.poolName -cne $PoolName) {
        throw "Receipt $Path was recorded for another tenant or pool ($($Receipt.tenantId), '$($Receipt.poolName)'); refusing."
    }
}

function Get-AgentPoolEspById([string]$Id) {
    $esp = Invoke-AgentPoolGraph -Method GET -Uri "$script:AgentPoolGraphBase/deviceEnrollmentConfigurations/$Id" -AllowNotFound
    if ($null -eq $esp) { return $null }
    $assigned = Invoke-AgentPoolGraph -Method GET -Uri "$script:AgentPoolGraphBase/deviceEnrollmentConfigurations/$Id/assignments"
    [pscustomobject]@{ Esp = $esp; Assignments = @($assigned.value) }
}

function Invoke-AgentPoolEspPlan {
    param([string]$PoolName, [string]$TenantId, [string]$ReceiptPath)
    $pool = Get-AgentPoolOne -PoolName $PoolName
    $receipt = Read-AgentPoolEspReceipt -Path $ReceiptPath
    $owned = @()
    if ($receipt) {
        Assert-AgentPoolEspReceiptFor $receipt $TenantId $PoolName $ReceiptPath
        $owned = @($receipt.filterId, $receipt.espId) | Where-Object { $_ }
    }
    $conflicts = @(Find-AgentPoolEspNamedObjects -PoolName $PoolName | Where-Object { $owned -notcontains $_.Id } |
            ForEach-Object { "$($_.Kind) $($_.Id)" })
    $match = Get-AgentPoolFilterPreview -PoolName $PoolName
    [pscustomobject]@{
        PoolId       = $pool.id
        Rule         = New-AgentPoolFilterRule -PoolName $PoolName
        Devices      = $match.Devices
        PreviewOk    = $match.Ok
        PreviewNote  = $match.Reason
        Conflicts    = $conflicts
        Receipt      = $(if ($receipt) { "$($receipt.state): filter $($receipt.filterId), ESP $($receipt.espId)" } else { 'none' })
        ReadyToApply = ($match.Ok -and $conflicts.Count -eq 0 -and -not $receipt)
    }
}

function Invoke-AgentPoolEspApply {
    param([string]$PoolName, [string]$TenantId, [string]$ReceiptPath)
    $existing = Read-AgentPoolEspReceipt -Path $ReceiptPath
    if ($existing) {
        throw "A receipt from an earlier Apply exists at $ReceiptPath (state $($existing.state)). Run -Remove first; Apply only creates new objects."
    }
    $pool = Get-AgentPoolOne -PoolName $PoolName
    $named = @(Find-AgentPoolEspNamedObjects -PoolName $PoolName)
    if ($named.Count -gt 0) {
        $list = ($named | ForEach-Object { "$($_.Kind) $($_.Id)" }) -join ', '
        throw "Objects already use this script's names and were not created by this script: $list. Refusing to reuse or overwrite them."
    }
    $match = Get-AgentPoolFilterPreview -PoolName $PoolName
    if (-not $match.Ok) { throw $match.Reason }
    # Graph rejects a custom ESP without a priority; take the next free one after existing ESPs
    # (the default ESP is 0 and always lowest). Other enrollment configuration types are ignored.
    $priorities = @(Get-AgentPoolGraphAll "$script:AgentPoolGraphBase/deviceEnrollmentConfigurations" |
            Where-Object { $_.'@odata.type' -eq $script:EspType } | ForEach-Object { [int]$_.priority })
    $priority = 1 + [int]($priorities + 0 | Measure-Object -Maximum).Maximum

    $receipt = [ordered]@{
        schema = 1; tenantId = $TenantId; poolName = $PoolName; poolId = $pool.id
        filterId = $null; espId = $null; state = 'creating'; updatedUtc = $null
    }
    Save-AgentPoolEspReceipt -Path $ReceiptPath -Receipt $receipt

    $filter = Invoke-AgentPoolGraph -Method POST -Uri "$script:AgentPoolGraphBase/assignmentFilters" -Body (New-AgentPoolFilterBody -PoolName $PoolName)
    $receipt.filterId = $filter.id
    Save-AgentPoolEspReceipt -Path $ReceiptPath -Receipt $receipt
    # Graph rejects a custom ESP created with progress already hidden (bare 400, live 3 Oct 2026)
    # but accepts the same ESP created shown and then patched. It stays unassigned until the
    # hidden setting reads back, so no device ever receives the shown variant.
    $create = New-AgentPoolEspBody -PoolName $PoolName -Priority $priority
    $create.showInstallationProgress = $true
    $esp = Invoke-AgentPoolGraph -Method POST -Uri "$script:AgentPoolGraphBase/deviceEnrollmentConfigurations" -Body $create
    $receipt.espId = $esp.id
    Save-AgentPoolEspReceipt -Path $ReceiptPath -Receipt $receipt
    Invoke-AgentPoolGraph -Method PATCH -Uri "$script:AgentPoolGraphBase/deviceEnrollmentConfigurations/$($receipt.espId)" `
        -Body ([ordered]@{ '@odata.type' = $script:EspType; showInstallationProgress = $false }) | Out-Null

    $readFilter = Invoke-AgentPoolGraph -Method GET -Uri "$script:AgentPoolGraphBase/assignmentFilters/$($receipt.filterId)" -AllowNotFound
    if (-not (Test-AgentPoolFilterObject $readFilter $PoolName)) {
        throw "The created filter $($receipt.filterId) does not read back with the expected name, platform and rule; not assigning. Run -Remove."
    }
    $readEsp = Get-AgentPoolEspById -Id $receipt.espId
    if (-not $readEsp -or $readEsp.Assignments.Count -ne 0 -or
        -not (Test-AgentPoolEspObject $readEsp.Esp $readEsp.Assignments $PoolName $receipt.filterId)) {
        throw "The created ESP $($receipt.espId) does not read back as expected; not assigning. Run -Remove."
    }
    Invoke-AgentPoolGraph -Method POST -Uri "$script:AgentPoolGraphBase/deviceEnrollmentConfigurations/$($receipt.espId)/assign" `
        -Body (New-AgentPoolEspAssignBody -FilterId $receipt.filterId) | Out-Null
    $readEsp = Get-AgentPoolEspById -Id $receipt.espId
    if (-not $readEsp -or $readEsp.Assignments.Count -ne 1 -or
        -not (Test-AgentPoolEspObject $readEsp.Esp $readEsp.Assignments $PoolName $receipt.filterId)) {
        throw "The ESP $($receipt.espId) assignment does not read back as All devices + include filter $($receipt.filterId). Run -Remove."
    }
    $receipt.state = 'applied'
    Save-AgentPoolEspReceipt -Path $ReceiptPath -Receipt $receipt
    [pscustomobject]$receipt
}

function Invoke-AgentPoolEspRemove {
    param([string]$PoolName, [string]$TenantId, [string]$ReceiptPath)
    $receipt = Read-AgentPoolEspReceipt -Path $ReceiptPath
    if (-not $receipt) {
        throw "No receipt at $ReceiptPath. Nothing is recorded as created by this script; refusing to delete by name."
    }
    Assert-AgentPoolEspReceiptFor $receipt $TenantId $PoolName $ReceiptPath

    # Check both recorded objects before deleting either.
    $esp = $null; $filter = $null
    if ($receipt.espId) {
        $esp = Get-AgentPoolEspById -Id $receipt.espId
        # An Apply interrupted before the hide patch leaves our ESP shown but never assigned.
        $createdShown = $esp -and $receipt.state -eq 'creating' -and
            @($esp.Assignments | Where-Object { $null -ne $_ }).Count -eq 0 -and
            $esp.Esp.'@odata.type' -eq $script:EspType -and
            $esp.Esp.displayName -ceq (Get-AgentPoolEspNames -PoolName $PoolName).Esp -and
            $esp.Esp.showInstallationProgress -eq $true
        if ($esp -and -not $createdShown -and -not (Test-AgentPoolEspObject $esp.Esp $esp.Assignments $PoolName $receipt.filterId)) {
            throw "ESP $($receipt.espId) has changed since Apply (settings or assignments); refusing to delete it."
        }
    }
    if ($receipt.filterId) {
        $filter = Invoke-AgentPoolGraph -Method GET -Uri "$script:AgentPoolGraphBase/assignmentFilters/$($receipt.filterId)" -AllowNotFound
        if ($filter -and -not (Test-AgentPoolFilterObject $filter $PoolName)) {
            throw "Filter $($receipt.filterId) has changed since Apply; refusing to delete it."
        }
    }
    if ($esp) {
        Invoke-AgentPoolGraph -Method DELETE -Uri "$script:AgentPoolGraphBase/deviceEnrollmentConfigurations/$($receipt.espId)" | Out-Null
    }
    $receipt.espId = $null
    $receipt.state = 'removing'
    Save-AgentPoolEspReceipt -Path $ReceiptPath -Receipt $receipt
    if ($filter) {
        Invoke-AgentPoolGraph -Method DELETE -Uri "$script:AgentPoolGraphBase/assignmentFilters/$($receipt.filterId)" | Out-Null
    }
    Remove-Item -Path $ReceiptPath
    "Removed ESP and filter recorded in $ReceiptPath."
}
