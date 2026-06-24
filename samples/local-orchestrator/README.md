# Local Orchestrator — browser ↔ Cloud PC bridge

A small local process that bridges the **CCaaS Agent Desktop** (browser app
that POSTs handoff webhooks) and the **Legacy Claims Workstation** (Win32 app
that reads JSON from a handoff folder inside a W365A Cloud PC).

In production, Agent365 would own this seam end-to-end. For the demo we ship a
tiny stand-in so the full flow can be wired up in a single tenant without
needing the full Agent365 production wiring.

## Status

✅ **Implemented.** Node 20 + Express + TypeScript, validated against the
shared `schemas/`. All four endpoints below are live, with single-flight
concurrency control, atomic prefill writes, a `chokidar` watcher on the
`out\` folder, monotonic (non-regressing) status transitions, and SSE +
polling support. 23 unit/integration tests pass (`npm test`).

You can still **skip** the orchestrator if the demo runs inside a single
W365A Cloud PC with the CCaaS desktop and the legacy app side by side and you
move the prefill file by hand — but running it gives you the seamless webhook
handoff and live status relay back to the desktop.

## Run it

```powershell
# From this folder (samples/local-orchestrator), e.g. inside the W365A Cloud PC:
.\start-orchestrator.bat
# -> installs deps + builds on first run, then prints:
#    Orchestrator listening on http://localhost:4000
```

Or manually:

```powershell
npm install
npm run build
npm start          # node dist/index.js
# or, for live-reload during development:
npm run dev
```

Configure via environment variables (see [`.env.example`](./.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Port the desktop POSTs to (`VITE_ORCHESTRATOR_URL`). |
| `HANDOFF_DIR` | `%ProgramData%\ZavaClaims\handoff` | MUST match the legacy app's `--handoff-dir`. Orchestrator writes `in\prefill.json` and watches `out\`. |
| `ALLOWED_ORIGINS` | `*` | CSV allow-list, or `*` to reflect any origin. `Origin: null` (file://) is always permitted. |

In the CCaaS desktop's **Settings**, point the orchestrator URL at
`http://localhost:4000` (or wherever this runs) and confirm the green status
dot in the footer.

## Test it

```powershell
npm test           # vitest: schema validation, prefill projection,
                   # state machine, routes, and end-to-end watcher relay
```

## Behavior notes

- **Single-flight:** because the legacy app reads a fixed-name
  `in\prefill.json`, only one handoff may be in flight at a time. A `POST`
  for a *different* `request_id` while one is active returns `409` with the
  active id. Re-posting the *same* id is idempotent. A new handoff is
  accepted once the previous one reaches `submitted` or `error`.
- **Atomic writes:** prefill is written to `<file>.<uuid>.tmp` then renamed,
  matching the legacy app's atomic-write contract. A per-request archival
  copy `in\prefill-<request_id>.json` is also written for diagnostics.
- **Non-regressing status:** `idle < queued < prefilled < ready <
  submitted/error`. A late `ready` can never overwrite a terminal
  `submitted`/`error`, and duplicate watcher events are no-ops.
- **Recovery:** on boot the orchestrator reconciles any existing `out\`
  files so a restart mid-handoff doesn't strand the desktop.
- **Invalid legacy output:** if an `out\` file is valid JSON but fails its
  schema and its `request_id` is known, the request is marked
  `error`/`UNKNOWN` so the desktop isn't left waiting.

## What it does

```
CCaaS Agent Desktop (browser)
   │
   │  HTTP POST /handoff   with CallContext JSON
   ▼
Local Orchestrator (this folder)
   │
   │  validates against schemas/call-context.schema.json
   │  rewrites as Prefill (schemas/prefill.schema.json)
   │  writes atomically to %ProgramData%\ZavaClaims\handoff\in\
   │  (or to a configurable path, e.g., an SMB share mounted from the Cloud PC)
   │
   │  watches %ProgramData%\ZavaClaims\handoff\out\ for matching
   │  request_id in ready.json / result.json / error.json
   │
   │  HTTP GET /handoff/:request_id/status   → returns latest state
   ▼
CCaaS Agent Desktop polls or subscribes (SSE) for status
```

## Required endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/handoff` | `CallContext` JSON | `202 Accepted` with `{ request_id, handoff_id, status, status_url }` (`handoff_id` equals `request_id` — it is the durable id the desktop polls on) |
| `GET`  | `/handoff/:request_id/status` | — | latest state: `queued` / `prefilled` / `ready` / `submitted` / `error` plus payload |
| `GET`  | `/handoff/:request_id/stream` | — | Server-Sent Events stream of state changes for the same request |
| `GET`  | `/health` | — | `{ ok: true, handoff_dir: "...", listening_since: "..." }` |

## Recommended implementation

- **Node 20+ / Express / chokidar** for file watching
- TypeScript optional but encouraged for schema alignment
- Reads schemas from `../../schemas/` and validates incoming/outgoing payloads
  with `ajv`
- Configurable handoff dir via env: `HANDOFF_DIR=C:\ProgramData\ZavaClaims\handoff`
- Configurable port: `PORT=4000`
- CORS enabled for the CCaaS desktop's dev origin (`http://localhost:5173`)
  and any deployed origin via env: `ALLOWED_ORIGINS=https://...,http://localhost:5173`

## Out of scope

- Real Agent365 integration (this is the stand-in for it)
- Authentication on the orchestrator endpoints (demo-only; never expose this on the public internet)
- Multi-tenant or multi-call concurrency beyond a small queue
- Audit logging beyond a console + `orchestrator.log`

## Build it when

Both apps are functional and you want to wire them together for the full
end-to-end demo. If you only need to demo each half independently, skip the
orchestrator and:

- For the legacy app: use `samples/agent365-handoff/Invoke-ZavaHandoff.ps1`
- For the CCaaS desktop: enable its **fallback file-download mode** — the
  agent clicks "Hand off" and the browser downloads `prefill-REQ-….json`
  which you manually drop into the Cloud PC's handoff folder
