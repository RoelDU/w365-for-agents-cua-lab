@echo off
REM Start the Foundry + Windows 365 for Agents runner (e.g. on the agent Cloud PC).
REM Installs dependencies and builds on first run, then launches the runner.
REM Configure via .env (copy .env.example) or environment variables.

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [runner] Node.js 20+ is required but was not found on PATH.
  echo [runner] Install it from https://nodejs.org/ and re-run this script.
  exit /b 1
)

if not exist "node_modules" (
  echo [runner] Installing dependencies...
  call npm install || exit /b 1
)

if not exist "dist\index.js" (
  echo [runner] Building...
  call npm run build || exit /b 1
)

echo [runner] Starting...
call npm run start
