@echo off
REM Start the CCaaS Local Orchestrator on Windows (e.g. inside the W365A Cloud PC).
REM Installs dependencies and builds on first run, then launches the server.

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [orchestrator] Node.js 20+ is required but was not found on PATH.
  echo [orchestrator] Install it from https://nodejs.org/ and re-run this script.
  exit /b 1
)

if not exist "node_modules" (
  echo [orchestrator] Installing dependencies...
  call npm install || exit /b 1
)

if not exist "dist\index.js" (
  echo [orchestrator] Building...
  call npm run build || exit /b 1
)

echo [orchestrator] Starting...
call npm run start
