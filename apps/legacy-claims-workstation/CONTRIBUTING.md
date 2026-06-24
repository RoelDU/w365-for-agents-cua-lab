# Contributing

This is a demonstration app inside the
[`RoelDU/w365-for-agents-cua-lab`](https://github.com/RoelDU/w365-for-agents-cua-lab) monorepo.

## Building

Windows (MinGW-w64 / GCC):

```
build.bat
```

Linux (cross-compile via MinGW-w64):

```
./build.sh
```

Run the embedded tests:

```
claims.exe --test
```

## Code-style notes

* C99, no third-party dependencies, no C++.
* Win32 + Common Controls only. No manifest (classic comctl theme).
* All interactive controls have a stable resource ID in `src/resource.h`.
  Do not renumber IDs — they are part of the CUA contract.
* Atomic-write contract on any file the app produces in the handoff folder.

## Pull requests

* Keep PRs small and focused. New controls require a new resource ID and a
  documentation update in `ACCESSIBILITY.md`.
* Run `claims.exe --test` and the smoke driver in `tests\drive_fnol2.ps1`
  before submitting.
