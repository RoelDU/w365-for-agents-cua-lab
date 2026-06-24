# Orchestrator contract

> **Architecture note:** In the standard deployment the CCaaS desktop is hosted
> centrally on **Azure Static Web Apps**, and the **same SWA hosts the `/api`
> handoff endpoint** (managed Functions) - that `/api` is the primary handoff
> path (seam #1). The **local orchestrator** described below is the optional
> **local-only alternative** (offline labs without the SWA). Both speak the same
> HTTP contract, so the app code is identical either way - only the configured
> base URL differs.

This app talks to the local orchestrator (at
`../../samples/local-orchestrator/`, or a deployed equivalent - e.g. the SWA
`/api`) using a tiny HTTP + (optional) SSE protocol. All payloads conform to the
shared JSON Schemas at `../../schemas/`. The orchestrator is the **seam** between
the CCaaS Agent Desktop and the W365A-hosted legacy claims workstation;
this app is intentionally unaware of Foundry, Computer Use, or Agent365.

## Base URL

Configurable at runtime via the Settings page (lives in `localStorage` as
`ccaas:settings.orchestratorUrl`), seeded from the `VITE_ORCHESTRATOR_URL`
env var. Default: `http://localhost:4000`.

## Endpoints

### `GET /health`

Used by the footer status indicator. Should return `200 OK` with any
JSON body when the orchestrator is reachable. Used only for the green/red
dot — a 4xx or 5xx response is treated as "unreachable" for fall-back
purposes.

### `POST /handoff`

Body: a [`CallContext`](../../schemas/call-context.schema.json) JSON payload.

```json
{
  "request_id": "REQ-2024-0042",
  "caller_phone": "(555) 123-4567",
  "policy_number": "POL-2024-008341",
  "intent": "auto_collision",
  "summary": "Rear-ended at intersection of 5th and Main, no injuries.",
  "transcript_excerpt": "Caller: I was stopped at the light…",
  "requested_by": {
    "agent_id": "csr-acarter",
    "display_name": "A. Carter",
    "email": "acarter@zavamutual.demo"
  },
  "timestamp": "2024-04-15T18:32:11Z"
}
```

Expected response:

```json
{ "request_id": "REQ-2024-0042", "status": "queued" }
```

A non-2xx response (or a network failure) causes this app to:

- Toast a warning to the user.
- Automatically fall through to **file mode** — download
  `prefill-REQ-YYYY-NNNN.json` (the Prefill projection of the same
  CallContext) so the user can drop it into the Cloud PC handoff folder
  manually.

### `GET /handoff/:request_id/status`

Returns the current state for the given request:

```json
{
  "request_id": "REQ-2024-0042",
  "status": "queued | prefilled | ready | submitted | error",
  "window_title": "Zava Mutual — Claims Workstation v1.0",
  "matched_policy_number": "POL-2024-008341",
  "matched_customer_name": "Jordan Smith",
  "claim_id": "CLM-2024-000123",
  "policy_number": "POL-2024-008341",
  "agent_id": "C1001",
  "reserve_amount": 4200,
  "error_code": "POLICY_NOT_FOUND",
  "message": "No matching policy."
}
```

Optional fields are populated as the state progresses. Terminal states are
`submitted` and `error`. After a terminal state, this app stops polling.

### `GET /handoff/:request_id/stream` (optional, SSE)

If the orchestrator supports Server-Sent Events, this endpoint streams the
same status payloads as JSON `data:` frames. This app auto-detects support:

- If `EventSource` is available **and** the URL connects, the app uses SSE
  and shows `sse` in the AI Agent Status card badge.
- On the first SSE error (`onerror`), the app closes the EventSource and
  falls back to polling `GET /handoff/:id/status` at 1500 ms (or 500 ms
  under `?cua=true`). The badge updates to `polling`.

## Polling cadence

- Default: 1500 ms (per PROMPT.md §AI Agent Status card).
- Under `?cua=true` or the Settings *CUA-friendly mode* toggle: 500 ms.
- Polling stops as soon as a terminal status arrives.

## Schemas referenced

| Direction | Endpoint | Schema |
| --- | --- | --- |
| App → Orchestrator | `POST /handoff` | [`call-context.schema.json`](../../schemas/call-context.schema.json) |
| Orchestrator → Legacy app (file) | (out-of-band) | [`prefill.schema.json`](../../schemas/prefill.schema.json) |
| Legacy app → Orchestrator | (out-of-band) | [`ready.schema.json`](../../schemas/ready.schema.json), [`result.schema.json`](../../schemas/result.schema.json), [`error.schema.json`](../../schemas/error.schema.json) |
| Orchestrator → App | `GET /handoff/:id/status` (+ SSE) | union of the above response fields |

## File-mode fallback

When the orchestrator is unreachable, or the user explicitly enables File
Mode in Settings, the same handoff button:

1. Builds the `CallContext` payload (and validates it locally).
2. Projects it to a `Prefill` (per `prefill.schema.json`).
3. Triggers a browser download of `prefill-REQ-YYYY-NNNN.json`.

The expected drop location on the Cloud PC is
`%ProgramData%\ZavaClaims\handoff\in\` (see the legacy app's README).

In File Mode the AI Agent Status card switches to a "Watching for result…"
state and lets the user upload the `result.json` the legacy app produces
or enter the claim ID manually.

## Quick test against the mock

```powershell
# In another terminal, start the local orchestrator (if you have one):
#   cd ..\..\samples\local-orchestrator
#   npm run dev
#
# Or, just run the file-mode flow with the orchestrator URL pointed at
# a deliberately invalid host:
#
#   VITE_ORCHESTRATOR_URL=http://no.such.host.local npm run dev
```

The bundled Vitest E2E tests (`tests/handoff.e2e.test.tsx`) exercise the
full SSE-fallback-to-polling flow against an MSW mock in
`tests/mockOrchestrator.ts` — that file is the most concrete example of
the orchestrator contract.
