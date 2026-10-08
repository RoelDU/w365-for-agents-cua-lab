# AgentShortcut.Settings.ps1 - the one definition of the MCS agent launch shortcut.
# Dot-sourced by New-AgentLaunchShortcut.ps1 and scripts\Deploy-McsAgentShortcut.ps1.
# Detect-AgentShortcut.ps1 repeats these values because Intune uploads it on its own;
# tests\Test-AgentShortcut.ps1 checks that all copies, and the launch command in
# docs\mcs-computer-use-instructions.md, stay identical.

$AgentShortcutName = 'Zava Claims Agent Launch'
$AgentShortcutFileName = "$AgentShortcutName.lnk"
$AgentShortcutTarget = 'C:\Program Files\Business Applications\Zava Claims Workstation\claims.exe'
$AgentShortcutArguments = '--no-splash --fast-auth --stable-host --idle-timeout=0 --demo-pin=1234'
$AgentShortcutWorkingDirectory = 'C:\Program Files\Business Applications\Zava Claims Workstation'
$AgentShortcutDescription = 'For the Copilot Studio agent: opens Zava Claims signed in as agent C1001'

# Intune Win32 command lines. Plain cmd built-ins: the agent Cloud PCs rejected a
# powershell.exe install command before (#132), and no new executable is shipped.
$AgentShortcutInstallCommand = "cmd.exe /c copy /y `"$AgentShortcutFileName`" `"%PUBLIC%\Desktop\$AgentShortcutFileName`""
$AgentShortcutUninstallCommand = "cmd.exe /c del /f /q `"%PUBLIC%\Desktop\$AgentShortcutFileName`""
