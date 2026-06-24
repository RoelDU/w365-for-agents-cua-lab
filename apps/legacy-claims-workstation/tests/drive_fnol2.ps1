$ErrorActionPreference = "Stop"
$cl = Get-Process claims -ErrorAction SilentlyContinue
foreach ($c in $cl) { Stop-Process -Id $c.Id -Force }
Start-Sleep 1
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class WG {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern int GetClassNameA(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Ansi, EntryPoint="SendMessageA")] public static extern IntPtr SendMessageGet(IntPtr h, int m, IntPtr w, StringBuilder s);
    [DllImport("user32.dll", CharSet=CharSet.Ansi, EntryPoint="SendMessageA")] public static extern IntPtr SendMessageW(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
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
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline -and -not (Test-Path "$root\out\ready.json")) { Start-Sleep -Milliseconds 200 }
Start-Sleep -Milliseconds 800
# Find main
$script:main = [IntPtr]::Zero
[WG]::EnumWindows([WG+EnumProc]{ param($h, $l)
    $sb = New-Object Text.StringBuilder 64
    [WG]::GetClassNameA($h, $sb, 64) | Out-Null
    if ($sb.ToString() -eq "WgmMainWindow") { $script:main = $h; return $false }
    return $true
}, [IntPtr]::Zero) | Out-Null
"main: $($script:main)"
# Find Next button
$script:next = [IntPtr]::Zero
[WG]::EnumChildWindows($script:main, [WG+EnumProc]{ param($h, $l)
    if ([WG]::GetDlgCtrlID($h) -eq 7602) { $script:next = $h; return $false }
    return $true
}, [IntPtr]::Zero) | Out-Null
$fnolPane = [WG]::GetParent($script:next)
# Click Next 4 times
for ($i = 0; $i -lt 4; $i++) {
    $btn = [WG]::GetDlgItem($fnolPane, 7602)
    [WG]::SendMessageW($fnolPane, 0x0111, [IntPtr]::new(7602), $btn) | Out-Null
    Start-Sleep -Milliseconds 250
}
# Set up modal-dismisser
$dismissJob = Start-Job -ScriptBlock {
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class CC {
    [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern IntPtr FindWindowA(string c, string n);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
    [DllImport("user32.dll", CharSet=CharSet.Ansi, EntryPoint="SendMessageA")] public static extern IntPtr SendMessageW(IntPtr h, int m, IntPtr w, IntPtr l);
}
"@
    for ($i = 0; $i -lt 60; $i++) {
        $c = [CC]::FindWindowA("#32770", "FNOL Submitted")
        if ($c -ne [IntPtr]::Zero) {
            $ok = [CC]::GetDlgItem($c, 5902)
            [CC]::SendMessageW($c, 0x0111, [IntPtr]::new(5902), $ok) | Out-Null
            return "dismissed"
        }
        Start-Sleep -Milliseconds 200
    }
    return "never"
}
# Submit
$btn = [WG]::GetDlgItem($fnolPane, 7604)
[WG]::SendMessageW($fnolPane, 0x0111, [IntPtr]::new(7604), $btn) | Out-Null
Start-Sleep -Seconds 3
Receive-Job $dismissJob -Wait | Out-Host
Remove-Job $dismissJob -Force

# Find IDC_FNOL_RESULT_CLAIMID via deep enumeration
$script:res = [IntPtr]::Zero
function DeepEnum($p) {
    [WG]::EnumChildWindows($p, [WG+EnumProc]{ param($h, $l)
        if ([WG]::GetDlgCtrlID($h) -eq 7651) { $script:res = $h; return $false }
        DeepEnum $h
        if ($script:res -ne [IntPtr]::Zero) { return $false }
        return $true
    }, [IntPtr]::Zero) | Out-Null
}
DeepEnum $script:main
"IDC_FNOL_RESULT_CLAIMID hwnd: $($script:res)"
$sb = New-Object Text.StringBuilder 64
$WM_GETTEXT = 0x000D
[WG]::SendMessageGet($script:res, $WM_GETTEXT, [IntPtr]::new(64), $sb) | Out-Null
"UI ClaimID via WM_GETTEXT = '$($sb.ToString())'"
"Result JSON:"; Get-Content "$root\out\result.json"
"Clipboard = '$(Get-Clipboard)'"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
