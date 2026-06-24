# Legacy Claims Workstation — Zava Mutual

This is **one of two apps** in the [`RoelDU/w365-for-agents-cua-lab`](../../) monorepo.

A native Windows desktop demo app — a deliberately legacy-styled **insurance
claims workstation** designed to be driven by Microsoft's **Computer Use
Agent (CUA)** running inside a **Windows 365 Agentic (W365A) Cloud PC**,
provisioned and orchestrated by **Agent365**, in response to a call handoff
initiated from the sibling **[CCaaS Agent Desktop](../ccaas-agent-desktop/)**.

Modeled on [shannonfritz/throwback-banker](https://github.com/shannonfritz/throwback-banker) — same Win32/C tech, same install pattern, same look-and-feel — but the workflow is **contact-center First Notice of Loss (FNOL)** instead of bank-teller transactions.

## Status

✅ **Built and demo-ready.** `build.bat` produces `claims.exe`,
`claims.exe --test` runs 109 deterministic tests (target 40+, all pass),
and the end-to-end CCaaS handoff (prefill → ready → result) is verified by
the smoke driver in [`tests/`](./tests/). See [`PROMPT.md`](./PROMPT.md)
for the full build brief that produced this app and
[`WORKFLOWS.md`](./WORKFLOWS.md) for live-demo scripts.

## The app at a glance

- **Zava Mutual — Claims Workstation v1.0** (Microsoft fictional brand)
- Single `claims.exe`, native Win32 / C99, no runtime dependencies
- Runs on a stock **Entra-joined or workgroup** W365A Cloud PC — no on-prem
  AD / DC / Kerberos / LDAP / GPO required, and no MSAL / Entra ID calls from
  the app either. Auth is intentionally faked entirely in-app.
- Split-pane single window: search panel + tabbed detail (Policy, Coverage,
  Claims, New FNOL, Notes). **No PropertySheet wizards, no modeless child
  windows** — single top-level window throughout the primary CUA path
- 5-step in-window New FNOL wizard
- ~100 customers, 140 policies, 220 claims of plausible 1998-era seed data,
  plus three fixed **hero records** (Jordan Smith / Morgan Lee / fraud
  pattern) shared with the CCaaS Agent Desktop
- **Visually realistic** late-1990s claims workstation: dense layout,
  insurance terminology, cryptic status codes (`PEND-REVW`, `CLSD-PAID`),
  multi-zone status bar, faux mainframe "HOST: LINKED" status, adjuster-
  shorthand claim narratives, classic Windows 98 grey-3D look
- **Simulated legacy authentication flow** — compliance banner, staged
  "Establishing host link… Validating credentials…", message-of-the-day,
  pre-shift ready-to-accept-calls gate, idle re-auth, failed-attempt
  lockout warnings, host-link flutter — all faked in-process
- **File-based handoff** via `%ProgramData%\ZavaClaims\handoff\` with
  atomic JSON writes (`prefill → ready → result/error`) — schemas live in
  the monorepo's [`schemas/`](../../schemas/) folder
- CLI flags: `--prefill`, `--handoff-dir`, `--result`, `--ready-file`,
  `--no-splash`, `--demo-pin`, `--reset-data`, `--prepare-demo-data`,
  `--test`, plus auth-flow overrides (`--fast-auth`, `--skip-compliance`,
  `--skip-motd`, `--skip-ready-gate`, `--idle-timeout`, `--stable-host`)
- **Portable-first deployment** with optional `Install.ps1` and `.intunewin`
  paths for image bake / Intune
- `samples/foundry-agent/` ships starter instructions + tool definitions
  for an Azure AI Foundry agent managed by Agent365
- `samples/agent365-handoff/` ships a local PowerShell handoff simulator
  for testing without a real CCaaS/Agent365 environment

## Compatible agent platforms

The handoff contract is agent-platform-agnostic. The same `claims.exe` works
with:

- **Azure AI Foundry agent + Computer Use, managed by Agent365** (primary
  demo target)
- **Copilot Studio agent + Computer Use, managed by Agent365**
- **Any custom agent** (Python, Node, .NET) using the same handoff folder
  contract
- **The bundled PowerShell simulator** (`Invoke-ZavaHandoff.ps1`) for
  local testing with no real agent platform

## How partners react (the goal)

> *"Oh — so I could put this in front of any of my customers' Siebel /
> Guidewire / mainframe screens and the agent just… drives it? And I don't
> have to integrate anything? Where do I sign?"*

That's the conversation this demo is built to provoke.

## License

MIT — see [`LICENSE`](./LICENSE).

## Build, install, run

```cmd
build.bat                                  REM produces claims.exe
claims.exe --test                          REM runs the embedded test suite
claims.exe --prepare-demo-data --reset-data   REM writes seed CSVs
claims.exe                                  REM launches the GUI (full legacy auth)
claims.exe --fast-auth --demo-pin=1234     REM CUA-friendly fast launch
```

Install to `%ProgramFiles%\Business Applications\Zava Claims Workstation\` and create shortcuts:

```powershell
PowerShell -ExecutionPolicy Bypass -File installer\Install.ps1
```

Uninstall:

```powershell
PowerShell -ExecutionPolicy Bypass -File installer\Uninstall.ps1
```

## Login PINs

| PIN  | Name        | Role             | Agent ID |
|------|-------------|------------------|----------|
| 1234 | A. Carter   | CSR              | C1001    |
| 2345 | M. Johnson  | CSR              | C1002    |
| 3456 | R. Davis    | Senior CSR       | C1003    |
| 9999 | A. Morgan   | Claims Manager   | M2001    |

## Documentation map

| File                     | What it covers                                              |
|--------------------------|-------------------------------------------------------------|
| [`PROMPT.md`](./PROMPT.md) | Original build brief                                      |
| [`WORKFLOWS.md`](./WORKFLOWS.md) | Six scripted demo workflows                        |
| [`INTEGRATION.md`](./INTEGRATION.md) | CCaaS handoff contract + deployment paths     |
| [`ACCESSIBILITY.md`](./ACCESSIBILITY.md) | Tab order and stable control IDs           |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Build / code style notes                     |
| [`samples/agent365-handoff/`](./samples/agent365-handoff/) | PowerShell handoff simulator |
| [`samples/foundry-agent/`](./samples/foundry-agent/) | Foundry / Copilot Studio agent starter |

## Tech stack

* C99, native Win32 + Common Controls only
* MinGW-w64 / LLVM MinGW (GCC 16) build
* No runtime dependencies, no .NET, no MSAL, no AD/DC requirements
* Deterministic seed data: 100 customers, 140 policies, 220 claims, ~900 activities
* Atomic-write file handoff (`prefill → ready → result/error`) per the
  monorepo's [`schemas/`](../../schemas/) folder.

## Release history

* **v1.0** — initial build. 109 passing tests. End-to-end CUA-driven FNOL
  submission verified.
