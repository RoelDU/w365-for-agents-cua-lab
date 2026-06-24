# INTEGRATION — Wiring the Claims Workstation into a CCaaS demo

This document explains the handoff seam, the CLI flag reference, the
JSON contracts, deployment options, and a CUA stable-control-ID
appendix that the agent author can paste straight into their CUA tool
instructions.

## Handoff folder convention

```
%ProgramData%\ZavaClaims\handoff\
  in\
    prefill.json          # Agent365 / orchestrator writes this
  out\
    ready.json            # claims.exe writes when UI is primed for CUA
    result.json           # claims.exe writes after Submit Claim succeeds
    error.json            # claims.exe writes on unrecoverable failure
```

Atomic-write contract: writers must write `<file>.tmp` first, flush, then
rename to the final name. The legacy app does this; orchestrators should do
the same.

Override the root with `--handoff-dir=<path>`. Override individual files with
`--prefill=<path>` / `--result=<path>` / `--ready-file=<path>`.

## CLI flag reference

| Flag                          | Effect                                                                 |
|-------------------------------|------------------------------------------------------------------------|
| `--prefill=<path>`            | Load this prefill JSON before showing the UI.                          |
| `--handoff-dir=<path>`        | Use this folder (must contain `in\` and `out\`) for the contract.      |
| `--result=<path>`             | Write the final result JSON to this exact path.                        |
| `--ready-file=<path>`         | Write the ready JSON to this exact path after the UI is primed.        |
| `--no-splash`                 | Skip the startup splash.                                               |
| `--demo-pin=<pin>`            | Auto-login with the given PIN, skipping the login dialog.              |
| `--skip-compliance`           | Skip the simulated compliance banner.                                  |
| `--skip-motd`                 | Skip the simulated Message of the Day.                                 |
| `--skip-ready-gate`           | Skip the pre-shift ready-to-accept-calls modal.                        |
| `--fast-auth`                 | Composite: skip all three above plus shorten staged auth to 200 ms.    |
| `--idle-timeout=<sec>`        | Idle re-auth timeout (default `900`; `0` disables).                    |
| `--stable-host`               | Disable host-link flutter and other periodic UI changes.               |
| `--reset-data`                | Delete and re-seed local data deterministically.                       |
| `--prepare-demo-data`         | Seed/export data without showing the UI.                               |
| `--test`                      | Run the embedded data-layer test suite (exit 0 on success).            |

`--no-splash` does not suppress the simulated legacy-auth modals. Combine
with `--fast-auth` for an unattended CUA run.

## JSON schemas

The authoritative schemas live in the monorepo's
[`schemas/`](../../schemas/) folder. The app consumes `prefill` and produces
`ready` / `result` / `error`. The `call-context` schema is consumed upstream
by the orchestrator, not by this app.

### Prefill (input)

```json
{
  "request_id": "REQ-2024-0042",
  "caller_phone": "(555) 123-4567",
  "policy_number": "POL-2024-008341",
  "intent": "auto_collision",
  "summary": "Rear-ended at 5th and Main; no injuries reported.",
  "requested_by": "ccaas-demo:csr-acarter"
}
```

### Ready (output)

```json
{
  "request_id": "REQ-2024-0042",
  "status": "ready",
  "window_title": "Zava Mutual — Claims Workstation v1.0",
  "matched_policy_number": "POL-2024-008341",
  "matched_customer_name": "Jordan Smith",
  "timestamp": "2024-04-15T18:32:34Z"
}
```

### Result (output)

```json
{
  "request_id": "REQ-2024-0042",
  "status": "submitted",
  "claim_id": "CLM-2024-000123",
  "policy_number": "POL-2024-008341",
  "agent_id": "C1001",
  "reserve_amount": 0.00,
  "timestamp": "2024-04-15T18:36:02Z"
}
```

### Error (output)

```json
{
  "request_id": "REQ-2024-0042",
  "status": "error",
  "error_code": "POLICY_NOT_FOUND",
  "message": "No matching policy found for caller_phone or policy_number.",
  "timestamp": "2024-04-15T18:32:35Z"
}
```

`error_code` is one of:
`POLICY_NOT_FOUND`, `PREFILL_INVALID`, `HOST_LINK_DOWN`,
`COVERAGE_NOT_APPLICABLE`, `SUBMISSION_REJECTED`, `USER_CANCELLED`, `UNKNOWN`.

## Sample Agent365 webhook payload

A hypothetical Agent365 webhook receives a `call-context` payload, derives
the `prefill`, drops it into `handoff\in\prefill.json`, then launches
`claims.exe`. A minimal example:

```jsonc
// inbound webhook (call-context.schema.json)
{
  "request_id": "REQ-2024-0042",
  "caller_phone": "(555) 123-4567",
  "policy_number": "POL-2024-008341",
  "intent": "auto_collision",
  "summary": "Rear-ended at 5th and Main, no injuries.",
  "transcript_excerpt": "...",
  "requested_by": { "agent_id": "csr-acarter", "display_name": "A. Carter" },
  "timestamp": "2024-04-15T18:32:11Z"
}
```

The local orchestrator strips `transcript_excerpt`, `requested_by` becomes
the string `"ccaas-desktop:<agent_id>"`, and the result is written to
`prefill.json`.

## Deployment paths

The app is portable — there is exactly one executable, no runtime
dependencies, and no first-run wizard. Pick the option that fits your
environment.

### 1. Portable copy into a prepared Cloud PC or golden image

```
xcopy claims.exe "%ProgramFiles%\Business Applications\Zava Claims Workstation\" /Y
```

Done. Optionally pin a Desktop / Start Menu shortcut via
`installer\Install.ps1`.

### 2. `Install.ps1` during image bake / provisioning

```
PowerShell -ExecutionPolicy Bypass -File installer\Install.ps1
```

Copies `claims.exe` to `%ProgramFiles%\Business Applications\Zava Claims Workstation\`,
registers it in Add/Remove Programs, and creates all-users shortcuts.
Does not require network access. Run elevated.

### 3. Intune Win32 app

Build a `ZavaClaims.intunewin` package using the
[Microsoft Win32 Content Prep Tool](https://learn.microsoft.com/intune/intune-service/apps/apps-win32-prepare).

* **Install command:** `PowerShell -ExecutionPolicy Bypass -File Install.ps1`
* **Uninstall command:** `PowerShell -ExecutionPolicy Bypass -File Uninstall.ps1`
* **Detection rule:** `PowerShell -ExecutionPolicy Bypass -File Detect.ps1`

The Intune packaging step is optional and will not block local build / test
success if the Content Prep Tool isn't on the build agent.

## Recommended W365A image-bake steps

1. Provision a stock Windows 365 Agentic image (Entra-joined or workgroup).
2. Run `installer\Install.ps1` to drop `claims.exe` in
   `%ProgramFiles%\Business Applications\Zava Claims Workstation\`.
3. Pre-seed deterministic local data: `claims.exe --prepare-demo-data --reset-data`.
4. Verify with `claims.exe --test`.
5. Create the handoff folders:
   `mkdir %ProgramData%\ZavaClaims\handoff\in`
   `mkdir %ProgramData%\ZavaClaims\handoff\out`
6. Snapshot the image.

## CUA selector reference

See [`samples/foundry-agent/CUA-TOOL-INSTRUCTIONS.md`](samples/foundry-agent/CUA-TOOL-INSTRUCTIONS.md)
for the full table of stable control IDs and the FNOL wizard step-by-step.
The control IDs are guaranteed stable across builds; renaming them would be a
breaking change.

The window class is `WgmMainWindow`. The title is
`Zava Mutual — Claims Workstation v1.0` (note the em-dash, not a hyphen).
