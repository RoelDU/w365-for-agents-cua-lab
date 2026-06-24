$ErrorActionPreference = "Stop"
$cl = Get-Process claims -ErrorAction SilentlyContinue
foreach ($c in $cl) { Stop-Process -Id $c.Id -Force }
Start-Sleep 1

# Clear last_agent.txt so we start fresh
Remove-Item -Force "$env:ProgramData\ZavaClaims\data\last_agent.txt" -ErrorAction SilentlyContinue

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class V {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern int GetClassNameA(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern int GetWindowTextA(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Ansi, EntryPoint="SendMessageA")] public static extern IntPtr SendMsgGet(IntPtr h, int m, IntPtr w, StringBuilder s);
    [DllImport("user32.dll", CharSet=CharSet.Ansi, EntryPoint="SendMessageA")] public static extern IntPtr SendMsgPtr(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
    [DllImport("user32.dll")] public static extern int GetWindowLongA(IntPtr h, int idx);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
}
"@

$root = "C:\Dev\Work\CCaaSDemoApp\apps\legacy-claims-workstation"
Set-Location $root
Remove-Item -Recurse -Force "$root\out" -ErrorAction SilentlyContinue
New-Item -ItemType Directory "$root\out" | Out-Null

$proc = Start-Process -PassThru -FilePath ".\claims.exe" -ArgumentList @(
    '--prefill=samples\agent365-handoff\sample-request.json',
    '--result=out\result.json','--ready-file=out\ready.json',
    '--no-splash','--demo-pin=1234','--fast-auth','--stable-host','--idle-timeout=0'
) -WorkingDirectory $root
$dl = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $dl -and -not (Test-Path "$root\out\ready.json")) { Start-Sleep -Milliseconds 200 }
Start-Sleep -Milliseconds 800

# --- Bug 1: verify main window title is pure ASCII ---
$script:main = [IntPtr]::Zero
[V]::EnumWindows([V+EnumProc]{ param($h, $l)
    $sb = New-Object Text.StringBuilder 64
    [V]::GetClassNameA($h, $sb, 64) | Out-Null
    if ($sb.ToString() -eq "WgmMainWindow") { $script:main = $h; return $false }
    return $true
}, [IntPtr]::Zero) | Out-Null
$titleSb = New-Object Text.StringBuilder 256
[V]::GetWindowTextA($script:main, $titleSb, 256) | Out-Null
$title = $titleSb.ToString()
"TITLE: '$title'"
$nonAscii = $title.ToCharArray() | Where-Object { [int]$_ -gt 127 }
"Bug 1 (ASCII title) PASS: $($nonAscii.Count -eq 0)"

# --- Bug 2: switch to FNOL, advance to step 2, find IDC_FNOL_VEH_ADD (7621), check it sends a click ---
function FindDeep([IntPtr]$root, [int]$id) {
    $script:hit = [IntPtr]::Zero
    function Recurse([IntPtr]$p) {
        if ($script:hit -ne [IntPtr]::Zero) { return }
        [V]::EnumChildWindows($p, [V+EnumProc]{ param($h, $l)
            if ([V]::GetDlgCtrlID($h) -eq $id) { $script:hit = $h; return $false }
            Recurse $h
            if ($script:hit -ne [IntPtr]::Zero) { return $false }
            return $true
        }, [IntPtr]::Zero) | Out-Null
    }
    Recurse $root
    return $script:hit
}

# Switch to FNOL tab
$tabs = FindDeep $script:main 7100  # IDC_DETAIL_TABS
[V]::SendMsgPtr($tabs, 0x1330, [IntPtr]::new(3), [IntPtr]::Zero) | Out-Null  # TCM_SETCURSEL=0x1330
# Notify parent of selection change
[V]::SendMsgPtr($script:main, 0x4E, [IntPtr]::new(7100),
    [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 300

# Click Next once to reach step 2 (Vehicles)
$next = FindDeep $script:main 7602
$fnolPane = [V]::GetParent($next)
[V]::SendMsgPtr($fnolPane, 0x0111, [IntPtr]::new(7602), $next) | Out-Null
Start-Sleep -Milliseconds 300

# Check that IDC_FNOL_VEH_ADD exists and is visible
$vehAdd = FindDeep $script:main 7621
"VEH_ADD hwnd: $vehAdd"
$vehAddStyle = [V]::GetWindowLongA($vehAdd, -16)  # GWL_STYLE
$isVisible = (($vehAddStyle -band 0x10000000) -ne 0)  # WS_VISIBLE
"VEH_ADD visible: $isVisible"
$vehAddText = New-Object Text.StringBuilder 32
[V]::SendMsgGet($vehAdd, 0x000D, [IntPtr]::new(32), $vehAddText) | Out-Null
"VEH_ADD text: '$($vehAddText.ToString())'"

# Send a click. Since the Add Vehicle dialog is modal, we need a background job to dismiss it.
$dismissJob = Start-Job -ScriptBlock {
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class K {
    [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern IntPtr FindWindowA(string c, string n);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
    [DllImport("user32.dll", CharSet=CharSet.Ansi, EntryPoint="SetWindowTextA")] public static extern bool SetText(IntPtr h, string s);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageA(IntPtr h, int m, IntPtr w, IntPtr l);
}
"@
    for ($i = 0; $i -lt 40; $i++) {
        $d = [K]::FindWindowA("#32770", "Add Vehicle / Property")
        if ($d -ne [IntPtr]::Zero) {
            # Fill the year=2024 (already default), make=Ford, model=Taurus, vin=1FALP52U3SA178291, damage=Rear bumper crushed
            [K]::SetText([K]::GetDlgItem($d, 6101), "Ford") | Out-Null
            [K]::SetText([K]::GetDlgItem($d, 6102), "Taurus") | Out-Null
            [K]::SetText([K]::GetDlgItem($d, 6103), "1FALP52U3SA178291") | Out-Null
            [K]::SetText([K]::GetDlgItem($d, 6104), "Rear bumper crushed") | Out-Null
            $ok = [K]::GetDlgItem($d, 1)
            [K]::SendMessageA($d, 0x0111, [IntPtr]::new(1), $ok) | Out-Null
            return "vehicle-added"
        }
        Start-Sleep -Milliseconds 200
    }
    return "no-dialog"
}
[V]::SendMsgPtr($fnolPane, 0x0111, [IntPtr]::new(7621), $vehAdd) | Out-Null
Start-Sleep -Seconds 3
$dr = Receive-Job $dismissJob -Wait
"dismiss result: $dr"
Remove-Job $dismissJob -Force

# Verify vehicle list now has 1 row
$lv = FindDeep $script:main 7620
$cnt = [V]::SendMsgPtr($lv, 0x1004, [IntPtr]::Zero, [IntPtr]::Zero)  # LVM_GETITEMCOUNT
"Vehicles list count: $cnt"
"Bug 2 (Add Vehicle wires up) PASS: $(if ($cnt.ToInt64() -ge 1) {'True'} else {'False'})"

# Close app and verify last_agent.txt persisted
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$lastFile = "$env:ProgramData\ZavaClaims\data\last_agent.txt"
if (Test-Path $lastFile) {
    $last = Get-Content $lastFile -Raw
    "last_agent.txt = '$last'"
    "Bug 3 (last_agent.txt written) PASS: $($last.Trim() -eq 'C1001')"
} else {
    "NO last_agent.txt"
    "Bug 3 PARTIAL: file not written"
}
