# New-AgentLaunchShortcut.ps1 - build the "Zava Claims Agent Launch" shortcut file that the
# separate MCS-only Intune app copies to the Public Desktop of the Copilot Studio Cloud PCs.
#
# The normal Claims shortcuts (created by claims.exe --install) start the app without options,
# so Computer Use had to open Run and type the full command. This shortcut carries the exact
# launch options from docs\mcs-computer-use-instructions.md, so the agent can start the same
# app with one double-click. The normal shortcuts and the Claims app are not touched.
#
# Runs on the PACKAGING machine only. On the Cloud PC the install is a plain "cmd.exe /c copy"
# of this file. The tracking block Windows adds to every new shortcut (it holds the packaging
# machine's name) is removed before the file is shipped.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'AgentShortcut.Settings.ps1')

$dir = Split-Path -Parent $OutputPath
if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
if (Test-Path -LiteralPath $OutputPath) { Remove-Item -Force -LiteralPath $OutputPath }

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($OutputPath)
$lnk.TargetPath = $AgentShortcutTarget
$lnk.Arguments = $AgentShortcutArguments
$lnk.WorkingDirectory = $AgentShortcutWorkingDirectory
$lnk.IconLocation = "$AgentShortcutTarget,0"
$lnk.Description = $AgentShortcutDescription
$lnk.WindowStyle = 1
$lnk.Save()

# Drop the TrackerDataBlock (signature 0xA0000003, MS-SHLLINK 2.5.10). It records the
# packaging machine's NetBIOS name and IDs; Windows only uses it to find a moved target.
$bytes = [IO.File]::ReadAllBytes($OutputPath)
$flags = [BitConverter]::ToUInt32($bytes, 0x14)
$pos = 0x4C
if ($flags -band 0x1) { $pos += 2 + [BitConverter]::ToUInt16($bytes, $pos) }
if ($flags -band 0x2) { $pos += [BitConverter]::ToUInt32($bytes, $pos) }
$charSize = if ($flags -band 0x80) { 2 } else { 1 }
foreach ($bit in 0x4, 0x8, 0x10, 0x20, 0x40) {
    if ($flags -band $bit) { $pos += 2 + $charSize * [BitConverter]::ToUInt16($bytes, $pos) }
}

$out = New-Object System.Collections.Generic.List[byte]
$out.AddRange([byte[]]$bytes[0..($pos - 1)])
$removed = $false
while ($pos + 4 -le $bytes.Length) {
    $size = [BitConverter]::ToUInt32($bytes, $pos)
    if ($size -lt 4) { break }
    $sig = [BitConverter]::ToUInt32($bytes, $pos + 4)
    if ($sig -eq [uint32]2684354563) { $removed = $true }  # 0xA0000003 (a bare hex literal is a negative Int32)
    else { $out.AddRange([byte[]]$bytes[$pos..($pos + $size - 1)]) }
    $pos += $size
}
$out.AddRange([byte[]](0, 0, 0, 0))
[IO.File]::WriteAllBytes($OutputPath, $out.ToArray())

$check = $wsh.CreateShortcut($OutputPath)
if ($check.TargetPath -ne $AgentShortcutTarget -or $check.Arguments -ne $AgentShortcutArguments) {
    throw "Shortcut check failed: '$($check.TargetPath)' '$($check.Arguments)'"
}
Write-Host "Agent launch shortcut: $OutputPath (tracking block removed: $removed)"
