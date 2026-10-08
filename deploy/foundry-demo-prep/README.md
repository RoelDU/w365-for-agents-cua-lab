# Zava Foundry demo preparation script (optional operator tool)

The source is in [`scripts/foundry-demo-prep`](../../scripts/foundry-demo-prep/). A maintainer
can package it as `zava-foundry-demo-prep-<version>.zip` with
`scripts\Build-FoundryDemoPrepPackage.ps1`, which writes the ZIP and a `PACKAGE-MANIFEST.txt`
into this folder. **No built ZIP is committed**; build it from the source when you need one.
Using the ZIP needs **no repository checkout, Git, Node, Python or build**: extract it anywhere
and follow `START-HERE.txt` inside it.

| File (after a build) | Contents |
| --- | --- |
| `zava-foundry-demo-prep-<version>.zip` | `START-HERE.txt`, `Prepare-FoundryDemo.cmd` / `.ps1`, `foundry-demo.config.template.json`, `PACKAGE-INFO.txt` |
| `PACKAGE-MANIFEST.txt` | SHA256 of the ZIP and of each file inside, plus the source commit |

The package contains **no environment configuration, credentials or tokens**. Each
environment's filled-in `foundry-demo.config.json` is supplied separately by its
administrator and kept out of this repository (git-ignored, never packaged).

## Who uses it

- **Environment operator:** runs it about 30 minutes before a demo and again 2-5 minutes
  before. Needs Windows PowerShell 5.1 or PowerShell 7, the Azure CLI and two read-only
  sign-ins (Foundry User on the Foundry project; an app sign-in with Microsoft Graph
  `CloudPC.Read.All` for the pool). Details in `START-HERE.txt`.
- **Presenter:** does not need this package. Open the Zava address, sign in with the
  presenting account and do the browser check in
  [presenting guide](../../docs/install/presenting.md).

## Verify and rebuild

```powershell
Get-FileHash .\zava-foundry-demo-prep-*.zip -Algorithm SHA256   # compare with PACKAGE-MANIFEST.txt
```

Maintainers change the source in `scripts/foundry-demo-prep/`, raise `$PackageVersion` in
`Prepare-FoundryDemo.ps1`, then run `scripts\Build-FoundryDemoPrepPackage.ps1`. The build
stops if a packaged file names a developer path or session folder, or if the template holds
real values.
