@echo off
REM Zava Mutual Claims Workstation — Windows build (MinGW-w64).
REM
REM Produces claims.exe in this directory. Requires gcc + windres on PATH.

setlocal
pushd "%~dp0"

set CC=gcc
set WINDRES=windres
set CFLAGS=-std=c99 -O2 -Wall -Wextra -Wno-unused-parameter -Wno-format-truncation -DUNICODE=0 -D_UNICODE=0 -D_WIN32_WINNT=0x0501 -DWINVER=0x0501
set LDFLAGS=-mwindows -static -lcomctl32 -lcomdlg32 -lshell32 -lole32 -luuid -luser32 -lgdi32 -ladvapi32 -lwinmm

set SRC=src\main.c src\util.c src\log.c src\csv.c src\json.c src\data.c src\seed.c src\handoff.c src\test.c src\setup.c src\ui_login.c src\ui_main.c src\ui_fnol.c

if not exist res\claims.res (
  echo [windres] res\claims.rc
  %WINDRES% -O coff -I src -i res\claims.rc -o res\claims.res || goto :fail
)

echo [gcc] %SRC%
%CC% %CFLAGS% -Isrc -o claims.exe %SRC% res\claims.res %LDFLAGS%
if errorlevel 1 goto :fail

echo Built claims.exe

REM ---- Optional Authenticode signing (durable fix for #114) ----
REM Defender quarantines the UNSIGNED demo binary as a "Severe threat" on the
REM managed agent Cloud PC. Code-signing is the durable fix. This step is a no-op
REM unless a cert is supplied via environment (NEVER commit a cert/password):
REM   CLAIMS_SIGN_PFX        path to a .pfx code-signing cert, plus
REM   CLAIMS_SIGN_PASSWORD   its password
REM   - or -
REM   CLAIMS_SIGN_THUMBPRINT SHA1 thumbprint of a cert already in a cert store
REM   CLAIMS_SIGN_TIMESTAMP  RFC-3161 timestamp URL (default: DigiCert)
if not defined CLAIMS_SIGN_PFX if not defined CLAIMS_SIGN_THUMBPRINT (
  echo [sign] skipped ^(no CLAIMS_SIGN_PFX/CLAIMS_SIGN_THUMBPRINT set^) - binary is UNSIGNED ^(#114^)
  goto :done
)
where signtool >nul 2>&1 || (
  echo [sign] WARNING: signtool not found on PATH; binary is UNSIGNED. Install the Windows SDK to sign.
  goto :done
)
if not defined CLAIMS_SIGN_TIMESTAMP set CLAIMS_SIGN_TIMESTAMP=http://timestamp.digicert.com
if defined CLAIMS_SIGN_PFX (
  echo [sign] signtool /f "%CLAIMS_SIGN_PFX%"
  signtool sign /f "%CLAIMS_SIGN_PFX%" /p "%CLAIMS_SIGN_PASSWORD%" /fd SHA256 /tr "%CLAIMS_SIGN_TIMESTAMP%" /td SHA256 claims.exe || goto :fail
) else (
  echo [sign] signtool /sha1 %CLAIMS_SIGN_THUMBPRINT%
  signtool sign /sha1 %CLAIMS_SIGN_THUMBPRINT% /fd SHA256 /tr "%CLAIMS_SIGN_TIMESTAMP%" /td SHA256 claims.exe || goto :fail
)
signtool verify /pa claims.exe || goto :fail
echo [sign] claims.exe signed and verified

:done
popd
exit /b 0

:fail
echo BUILD FAILED
popd
exit /b 1
