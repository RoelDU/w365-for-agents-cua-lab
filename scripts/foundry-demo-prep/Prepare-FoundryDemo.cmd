@echo off
rem Runs Prepare-FoundryDemo.ps1 from this folder. Uses PowerShell 7 if installed,
rem otherwise the Windows PowerShell built into Windows. Passes any options through,
rem for example:  Prepare-FoundryDemo.cmd -WaitForCloudPcMinutes 20
setlocal
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Prepare-FoundryDemo.ps1" %*
set "RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RC%