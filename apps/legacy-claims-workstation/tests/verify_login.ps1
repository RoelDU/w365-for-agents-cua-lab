$ErrorActionPreference = "Stop"
$cl = Get-Process claims -ErrorAction SilentlyContinue
foreach ($c in $cl) { Stop-Process -Id $c.Id -Force }
Start-Sleep 1

# Ensure last_agent.txt has C1003 (Senior CSR R. Davis) so we can detect pre-population
$dataDir = "$env:ProgramData\ZavaClaims\data"
New-Item -ItemType Directory -Force $dataDir | Out-Null
"C1003" | Set-Content -NoNewline -Path "$dataDir\last_agent.txt"

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class L {
    [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern IntPtr FindWindowA(string c, string n);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
    [DllImport("user32.dll", CharSet=CharSet.Ansi, EntryPoint="SendMessageA")] public static extern IntPtr SendMsgGet(IntPtr h, int m, IntPtr w, StringBuilder s);
    [DllImport("user32.dll", CharSet=CharSet.Ansi, EntryPoint="SendMessageA")] public static extern IntPtr SendMsgPtr(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetWindowLongA(IntPtr h, int idx);
}
"@

$root = "C:\Dev\Work\CCaaSDemoApp\apps\legacy-claims-workstation"
Set-Location $root
# Launch WITHOUT --demo-pin so the interactive login dialog appears.
# Use --no-splash --skip-compliance so the login is the first visible UI.
$proc = Start-Process -PassThru -FilePath ".\claims.exe" -ArgumentList @(
    '--no-splash','--skip-compliance','--stable-host','--idle-timeout=0'
) -WorkingDirectory $root

# Wait for the login dialog (title "Zava Mutual - Agent Sign-On")
$dlg = [IntPtr]::Zero
for ($i = 0; $i -lt 50 -and $dlg -eq [IntPtr]::Zero; $i++) {
    $dlg = [L]::FindWindowA("#32770", "Zava Mutual - Agent Sign-On")
    Start-Sleep -Milliseconds 200
}
"login dialog: $dlg"

if ($dlg -ne [IntPtr]::Zero) {
    # IDC_LOGIN_AGENT_ID = 5200
    $agentEdit = [L]::GetDlgItem($dlg, 5200)
    $sb = New-Object Text.StringBuilder 32
    [L]::SendMsgGet($agentEdit, 0x000D, [IntPtr]::new(32), $sb) | Out-Null
    "Pre-populated Agent ID: '$($sb.ToString())'"
    "Bug 3a (pre-populate) PASS: $($sb.ToString() -eq 'C1003')"

    # Check that the field is read-only initially (EM_GETOPTIONS not portable; use style bit ES_READONLY=0x0800)
    $style = [L]::GetWindowLongA($agentEdit, -16)
    $isReadOnly = (($style -band 0x0800) -ne 0)
    "Initial read-only: $isReadOnly"
    "Bug 3b (read-only initial) PASS: $isReadOnly"

    # Click Switch agent... (IDC_LOGIN_SWITCH = 5207)
    $switchBtn = [L]::GetDlgItem($dlg, 5207)
    "Switch button: $switchBtn"
    [L]::SendMsgPtr($dlg, 0x0111, [IntPtr]::new(5207), $switchBtn) | Out-Null
    Start-Sleep -Milliseconds 200
    $style2 = [L]::GetWindowLongA($agentEdit, -16)
    $isStillReadOnly = (($style2 -band 0x0800) -ne 0)
    "After Switch, read-only: $isStillReadOnly"
    "Bug 3c (Switch unlocks) PASS: $(-not $isStillReadOnly)"

    # Type a different agent + matching PIN, then Connect
    # Type C1002 / PIN 2345 (M. Johnson)
    [L]::SendMsgPtr($agentEdit, 0x000C, [IntPtr]::Zero, [System.Runtime.InteropServices.Marshal]::StringToHGlobalAnsi("C1002")) | Out-Null
    $pinEdit = [L]::GetDlgItem($dlg, 5201)
    [L]::SendMsgPtr($pinEdit, 0x000C, [IntPtr]::Zero, [System.Runtime.InteropServices.Marshal]::StringToHGlobalAnsi("2345")) | Out-Null
    # Click Connect (5204)
    $conn = [L]::GetDlgItem($dlg, 5204)
    [L]::SendMsgPtr($dlg, 0x0111, [IntPtr]::new(5204), $conn) | Out-Null
}

# Wait for app to settle, then close.
Start-Sleep -Seconds 3
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$lastAgent = Get-Content "$dataDir\last_agent.txt" -Raw
"After login last_agent.txt = '$($lastAgent.Trim())'"
"Bug 3d (persist new agent) PASS: $($lastAgent.Trim() -eq 'C1002')"
