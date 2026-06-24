# Agent365 handoff simulator (PowerShell)

This folder will be populated by the coding agent that builds the legacy
claims workstation per
[`../../PROMPT.md`](../../PROMPT.md).

## What lives here

- [`Invoke-ZavaHandoff.ps1`](./Invoke-ZavaHandoff.ps1) — small
  PowerShell script that simulates what Agent365 would do at production: write
  a prefill JSON file into the handoff `in\` folder, launch `claims.exe` with
  the right CLI flags, wait for `ready.json`, and (after the user or CUA
  submits the FNOL) read `result.json` and print the claim ID to the console.
- [`sample-request.json`](./sample-request.json) — example prefill payload
  (hero-record auto collision call from Jordan Smith, `(555) 123-4567`).
- This `README.md` with usage examples.

## Why this exists

It lets you test the legacy app's handoff seam **without** standing up the
local orchestrator or a real Agent365 webhook. Useful for:

- Smoke-testing a freshly built `claims.exe`
- Reproducing a handoff bug in isolation
- Demoing the legacy app's CUA path on a machine that doesn't have the
  full demo environment

## Usage

```powershell
.\Invoke-ZavaHandoff.ps1 -ScenarioFile .\sample-request.json
```

For the production demo flow (CCaaS desktop → orchestrator → legacy app),
use the top-level [`samples/local-orchestrator/`](../../../../samples/local-orchestrator/)
instead.
