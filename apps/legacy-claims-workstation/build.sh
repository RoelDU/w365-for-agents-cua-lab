#!/bin/sh
# build.sh — best-effort Linux/Wine build (uses MinGW cross compiler).
#
# Usage:
#   ./build.sh                       — cross-compile to claims.exe
#   ./build.sh test                  — additionally invoke claims.exe --test under wine
#
# Requires either x86_64-w64-mingw32-gcc or mingw-w64 installed.
set -e
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"

CC=${CC:-x86_64-w64-mingw32-gcc}
WINDRES=${WINDRES:-x86_64-w64-mingw32-windres}

if ! command -v "$CC" >/dev/null 2>&1; then
  echo "ERROR: $CC not found on PATH. Install mingw-w64." >&2
  exit 2
fi
if ! command -v "$WINDRES" >/dev/null 2>&1; then
  echo "ERROR: $WINDRES not found on PATH. Install mingw-w64." >&2
  exit 2
fi

CFLAGS="-std=c99 -O2 -Wall -Wextra -Wno-unused-parameter -Wno-format-truncation -DUNICODE=0 -D_UNICODE=0 -D_WIN32_WINNT=0x0501 -DWINVER=0x0501"
LDFLAGS="-mwindows -static -lcomctl32 -lcomdlg32 -lshell32 -lole32 -luuid -luser32 -lgdi32 -ladvapi32 -lwinmm"

SRC="src/main.c src/util.c src/log.c src/csv.c src/json.c src/data.c src/seed.c src/handoff.c src/test.c src/setup.c src/ui_login.c src/ui_main.c src/ui_fnol.c"

echo "[windres] res/claims.rc"
"$WINDRES" -O coff -I src -i res/claims.rc -o res/claims.res

echo "[gcc] $SRC"
$CC $CFLAGS -Isrc -o claims.exe $SRC res/claims.res $LDFLAGS

echo "Built claims.exe"

# ---- Optional Authenticode signing (durable fix for #114) ----
# Defender quarantines the UNSIGNED demo binary as a "Severe threat" on the
# managed agent Cloud PC; code-signing is the durable fix. No-op unless a cert is
# supplied via environment (NEVER commit a cert/password):
#   CLAIMS_SIGN_PFX       path to a .pfx code-signing cert
#   CLAIMS_SIGN_PASSWORD  its password
#   CLAIMS_SIGN_TIMESTAMP RFC-3161 timestamp URL (default: DigiCert)
# Uses osslsigncode, the cross-platform Authenticode signer (apt: osslsigncode).
if [ -n "${CLAIMS_SIGN_PFX:-}" ]; then
  if command -v osslsigncode >/dev/null 2>&1; then
    TS=${CLAIMS_SIGN_TIMESTAMP:-http://timestamp.digicert.com}
    echo "[sign] osslsigncode -pkcs12 $CLAIMS_SIGN_PFX"
    osslsigncode sign -pkcs12 "$CLAIMS_SIGN_PFX" -pass "${CLAIMS_SIGN_PASSWORD:-}" \
      -h sha256 -ts "$TS" -in claims.exe -out claims-signed.exe
    mv -f claims-signed.exe claims.exe
    echo "[sign] claims.exe signed"
  else
    echo "[sign] WARNING: osslsigncode not found; binary is UNSIGNED. 'apt-get install osslsigncode' to sign on Linux."
  fi
else
  echo "[sign] skipped (no CLAIMS_SIGN_PFX set) - binary is UNSIGNED (#114)"
fi

if [ "$1" = "test" ]; then
  if command -v wine >/dev/null 2>&1; then
    echo "[wine] claims.exe --test"
    wine claims.exe --test
  else
    echo "wine not installed; skipping --test"
  fi
fi
