# CCaaS agent-desktop API (Azure Static Web Apps managed Functions)

This is the **server-side handoff seam (#1)** for the demo: the endpoint the
CCaaS desktop calls when a CSR transfers a First Notice of Loss task to the AI
agent. It is the realistic stand-in for how Genesys / Five9 / NICE POST a JSON
context envelope at the transfer point.

It does **not** touch the legacy app. The agent drives the legacy Win32 app
**purely on screen** (seam #2) on a Windows 365 Cloud PC; the claim ID returns
only in the agent's final natural-language message, which the status endpoint
parses.

## Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/handoff` | Validate a `CallContext`, start an Azure AI Foundry agent run (fire-and-forget), return `202` with `thread_id` + `run_id` + `status_url`. |
| `GET`  | `/api/handoff/{requestId}/status?thread_id=&run_id=` | Poll the Foundry run + last assistant message; return a `HandoffStatusPayload`. |

### Why fire-and-forget + polling

SWA managed Functions have **no managed identity** and a **~45-second** execution
cap, and there is **no shared state** across instances. So:

- `POST /api/handoff` only *starts* the run and returns immediately (`202`).
- It returns `thread_id` and `run_id`; the SPA keeps them and passes them back on
  every status poll. The status endpoint is therefore **stateless** — any
  instance can answer. (No SSE inside the Function.)

### Status mapping

Foundry `run.status` → desktop `HandoffStatus`:

| Foundry run | Desktop status | Notes |
|-------------|----------------|-------|
| `queued` | `queued` | run accepted |
| `in_progress`, `requires_action` | `ready` | agent is driving the legacy app |
| `completed` + claim id in final message | `submitted` | `claim_id` parsed from the agent's reply |
| `completed` without a claim id | `error` | agent reported a handled failure (e.g. `POLICY_NOT_FOUND`) |
| `failed`, `cancelled`, `expired` | `error` | `message` from `last_error` |

## Configuration (SWA **Application settings** — never commit secrets)

| Setting | Example | Notes |
|---------|---------|-------|
| `FOUNDRY_PROJECT_ENDPOINT` | `https://<res>.services.ai.azure.com/api/projects/<project>` | Same value `Deploy-Agent.ps1` uses |
| `FOUNDRY_AGENT_ID` | `asst_…` | The assistant/agent id created by `Deploy-Agent.ps1` |
| `FOUNDRY_API_VERSION` | `2025-05-15-preview` | Foundry data-plane api-version |
| `FOUNDRY_TOKEN_AUDIENCE` | `https://ai.azure.com` | Token audience |
| `AZURE_TENANT_ID` | GUID | App registration tenant |
| `AZURE_CLIENT_ID` | GUID | App reg `W365-Demo-Automation` |
| `AZURE_CLIENT_SECRET` | secret | **SWA app settings / GH secret only** |

The Function authenticates to Foundry with **client credentials** on the reused
app registration. The app reg must have access to the Foundry project (e.g.
`Azure AI Developer`).

## Local development

```bash
cp local.settings.sample.json local.settings.json   # fill in real values (git-ignored)
npm install
npm test          # runs the pure-logic unit tests (no Azure needed)
npm start         # requires Azure Functions Core Tools (func)
```

`local.settings.json` and any `*.local.json` are git-ignored.
