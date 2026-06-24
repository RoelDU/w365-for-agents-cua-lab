# Prebuilt Intune packages (hand-off to the in-tenant admin workstation)

These `.intunewin` files are **prebuilt artifacts** committed to the repo so the
in-tenant admin workstation can deploy **without a build toolchain** (no MinGW C
compiler). They are normally git-ignored (`*.intunewin`); a `.gitignore`
exception tracks this folder specifically.

The demo ships exactly **one** Win32 app, the legacy Zava Claims Workstation. The
CCaaS agent desktop ("Zava Contact Center") is delivered as an Intune **managed
web link** to its centrally-hosted Azure Static Web App, not a Win32 package, so
there is intentionally no `CCaaSAgentDesktop.intunewin` here. See
`docs/intune-w365.md`.

| File | Contents |
| --- | --- |
| `ZavaClaims.intunewin` | Zava Claims Workstation (native Win32 `claims.exe`) |
| `PACKAGE-MANIFEST.txt` | SHA256 checksums + source commit for integrity verification |

## Deploy from the admin workstation

```powershell
# 1. Get the latest scripts + these packages:
git pull

# 2. (optional) verify integrity against the manifest:
Get-FileHash .\deploy\intune-packages\*.intunewin -Algorithm SHA256

# 3. Preview, then apply (sign in as a privileged tenant admin when prompted).
#    Point -PackageRoot at this folder; do NOT pass -BuildPackages.
.\scripts\Deploy-DemoEnvironment.ps1 -TenantId <your-tenant-id> `
    -PackageRoot .\deploy\intune-packages -WhatIf

.\scripts\Deploy-DemoEnvironment.ps1 -TenantId <your-tenant-id> `
    -PackageRoot .\deploy\intune-packages
```

### No working browser on the admin workstation? Use device-code sign-in

Add `-DeviceCode` to authenticate without launching a local browser. The script
prints a URL and a short code; open them on **any other device** (phone/laptop),
sign in as the admin, and the workstation picks up the token automatically. This
is the recommended path for headless/locked-down or Cloud PC admin hosts.

```powershell
.\scripts\Deploy-DemoEnvironment.ps1 -TenantId <your-tenant-id> `
    -PackageRoot .\deploy\intune-packages -DeviceCode -WhatIf
```

## Refreshing these packages

Rebuild on a build host that has MinGW (the C toolchain), then copy the output here:

```powershell
.\scripts\Build-IntunePackages.ps1 -CreateIntuneWin
Copy-Item out\intune\packages\*.intunewin deploy\intune-packages\ -Force
```

Regenerate `PACKAGE-MANIFEST.txt` (checksums) and commit.
