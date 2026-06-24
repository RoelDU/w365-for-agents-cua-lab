# In-app near-live Computer Use view + full audit trail (Option A)

This is how the CCaaS Agent Desktop shows the AI agent's Computer Use (CUA) run **inside the app,
in near-real-time**, while **keeping the full Copilot Studio audit trail** (Activity → Session
replay, with screenshots and reasoning).

## Why this design

There is a hard platform constraint: you cannot get **both** a real-time in-app Direct Line stream
**and** the Copilot Studio Activity audit trail from a single run.

- A custom canvas streaming over **Direct Line** needs the agent set to *Authenticate manually*, and
  Direct Line runs **never appear** in the Activity page, so there is no Session-replay audit.
- The Activity audit trail (screenshots + per-step reasoning, attributed to a real identity) is
  produced by runs that start from one of the logged channels: the **test pane**, **Teams/M365**,
  **SharePoint**, or an **autonomous trigger**. Those run in the background, so there is nothing to
  stream live to a custom app.

Option A bridges the two by **starting the run from an autonomous trigger** (so it is audited) and
having the app render a **near-live view** by polling Dataverse for the run's screenshots as they
are written (a few seconds behind real time, not a live socket).

```
 Agent Desktop                Orchestrator (Functions)         Dataverse / Copilot Studio
 ────────────                 ────────────────────────         ──────────────────────────
 Transfer to AI ─POST /cua-run─▶ create crcce_claimrequests row ─▶ "When a row is added"
                                                                    autonomous trigger
                                                                        │
                                 GET /cua-run/{id}/progress ◀──────────┤ CUA run executes
   poll ~2.5s  ◀── status + steps (reasoning + screenshotUrl) ─────────┤  • logs to Activity (audit)
                                 GET /cua-run/{id}/shot/{binId} ◀───────┤  • writes flowsessionbinaries
   render near-live desktop                                             ▼  (CuaScreenshot rows)
                                                                     Activity → Session replay
```

## Verified Dataverse schema (the run's data)

Confirmed live against the demo's Dataverse org (`https://<your-org>.crm.dynamics.com`):

- **`flowsessions`** — one row per Computer Use run. Find the agent's runs with
  `parentworkflowid eq <agent botId>`. Useful columns: `flowsessionid`, `statuscode`, `statecode`,
  `startedon`, `completedon`, `outputs`, `errorcode`, `errormessage`, `context`.
  - Completion is signalled by **`completedon` being non-null**, not by `statuscode`. Real runs
    finish with `statuscode = 8` (`SessionHasLoggedOff`) because the Cloud PC session logs off as
    the run ends; the claim is still filed and all screenshots are recorded.
- **`flowsessionbinaries`** — the screenshots. Filter
  `_flowsessionid_value eq <flowsessionid> and type eq 'CuaScreenshot'`. Each row has `createdon`
  (capture time — this is what makes near-live polling work) and the JPEG bytes at
  `flowsessionbinaries(<id>)/data/$value`.
- The **claim id is not** in `flowsession.outputs` (it is null even on a run that filed a claim), and
  the **per-step reasoning is not** stored in Dataverse binaries. The orchestrator therefore supplies
  the claim id and overlays scripted narration (English and Japanese) on the real screenshot
  timeline. The authoritative reasoning + screenshots live in **Activity → Session replay**.

## One-time setup

### 1. Create the trigger table

A custom table whose "row created" event starts the agent. In this repo it is `crcce_claimrequest`
(set name `crcce_claimrequests`) with text columns:

| Column (logical)        | Purpose                                   |
| ----------------------- | ----------------------------------------- |
| `crcce_name` (primary)  | Display name / free text                  |
| `crcce_policynumber`    | Policy to file the claim against          |
| `crcce_summary`         | Incident summary passed to the agent      |
| `crcce_correlationid`   | Correlates the app run with the row       |
| `crcce_lang`            | `en` or `ja`                              |

Use your own publisher prefix if not `crcce`; set the orchestrator env vars below to match.

### 2. Add the autonomous trigger to the agent

In Copilot Studio, open the agent → **Overview → Triggers → Add trigger →
"When a row is added, modified or deleted" (Microsoft Dataverse)**, then:

- **Change type:** `Added`
- **Table name:** your trigger table (e.g. *Claim Requests*)
- **Scope:** `Organization` (so rows created by the orchestrator's identity also fire it)
- **Additional instructions to the agent:** keep the `[Body]` dynamic content (passes the new row to
  the agent).

Then make sure the agent's main **Instructions** tell it to file the FNOL with the Computer use tool
when it receives a claim-request row (no clarifying questions), and **Publish** the agent.

> The trigger runs as its author, so publish it as a user who has the Computer Use / Windows 365 for
> Agents entitlement.

### 3. Grant the orchestrator a Dataverse application user

The orchestrator writes the trigger row and reads `flowsessions` / `flowsessionbinaries`. Add its
identity (the Function App's managed identity in Azure, or a service principal for local dev) as a
Dataverse **application user** (Power Platform admin center → *Settings → Users + permissions →
Application users → New app user*) with a role that can create the trigger-table rows and read the
flow-session tables.

### 4. Configure the orchestrator and app

Orchestrator (`apps/handoff-orchestrator`) app settings:

| Setting                       | Example                                            |
| ----------------------------- | -------------------------------------------------- |
| `DATAVERSE_ORG_URL`           | `https://<your-org>.crm.dynamics.com`              |
| `CUA_AGENT_BOTID`             | the agent's bot id (`parentworkflowid`)            |
| `CUA_TRIGGER_ENTITYSET`       | `crcce_claimrequests`                              |
| `CUA_TRIGGER_FIELD_POLICY`    | `crcce_policynumber`                               |
| `CUA_TRIGGER_FIELD_SUMMARY`   | `crcce_summary`                                    |
| `CUA_TRIGGER_FIELD_CORRELATION` | `crcce_correlationid`                            |
| `CUA_TRIGGER_FIELD_LANG`      | `crcce_lang`                                       |
| `CUA_DEMO_CLAIM_ID`           | claim id to report on success (demo)               |
| `CUA_PROGRESS_MOCK`           | `1` to serve canned progress (no Dataverse needed) |

App (`apps/ccaas-agent-desktop`): set `VITE_CUA_RUN_BASE_URL` to the orchestrator's `/api` base. The
"Transfer to AI Agent" button then routes through `runCuaViaTrigger` instead of Direct Line. You can
also override per-session with `?cuaRunBaseUrl=`.

## Endpoints

- `POST /api/cua-run` — body `{ callContext, lang }`; writes the trigger row, returns `{ runId }`.
- `GET /api/cua-run/{runId}/progress` — `{ status, steps:[{ index, reasoning, screenshotUrl,
  capturedOn }], claimId }`. `status` is `queued` → `running` → `succeeded` (or `error`).
- `GET /api/cua-run/{runId}/shot/{binId}` — authenticated image proxy for a `CuaScreenshot` (the
  Dataverse file endpoint needs the orchestrator's token, so the browser cannot load it directly).

Set `CUA_PROGRESS_MOCK=1` to demo the in-app UX end to end without any Dataverse grant; the mock
animates the same narration and reports the demo claim id.

## Surfacing the real claim id

The agent files a fresh, incrementing claim id each run (for example `CLM-2024-007005`), and that id
is **not** stored on the `flowsession` (its `outputs` is null). The orchestrator resolves the claim
id for a completed run in priority order (`resolveClaimId` in `cuaRun.js`):

1. **Agent write-back on the trigger row (`crcce_claimid`)** — the ideal near-real-time path, but it
   depends on giving the agent a Microsoft Dataverse **"Update a row"** action that can connect in the
   **autonomous (no signed-in user) run** context. In testing, the connector returned *"couldn't
   connect, verify your credentials"* during the unattended run, so this tier is **not active on the
   demo agent today** (the table ships with `crcce_claimid`/`crcce_status` columns and the orchestrator
   reads them, so it lights up automatically if/when an unattended connection reference is configured).
2. **Bot transcript (`conversationtranscript`)** — **the active real-id path.** The agent's final
   "Claim ID: ..." message is stored in the transcript `content` JSON, and the orchestrator matches the
   right transcript by the correlation id it wrote to the trigger row, then extracts `CLM-...`. This
   yields the **real** id, but the transcript is flushed only **~30 minutes after** the conversation
   goes idle, so it fills in *eventually* (great for audit/reconciliation, not instant). Reading
   transcripts needs the **Bot Transcript Viewer** role on the orchestrator's app user.
3. **Configured demo id (`CUA_DEMO_CLAIM_ID`)** — shown immediately so the in-app view is never blank
   on success; the real id replaces it once tier 2 (or a future tier 1) resolves.

Net effect today: the in-app view shows a claim id **immediately** (demo id) and the orchestrator
reconciles the **real** id from the transcript within ~30 minutes; the audit trail stays clean (no
failed connector step in Activity). Enabling tier 1 (an unattended Dataverse connection for the
agent's Update-a-row action) is the only thing needed to make the real id appear at completion time.

## About the `SessionHasLoggedOff` run status

Every Computer Use run on a **Cloud PC pool** machine currently ends with the `flowsession` row
stamped `statuscode = 8` (`Failed`) / `errorcode = SessionHasLoggedOff`, even though the work
completes. This is a **preview-feature artifact, not a real failure of the run**:

- At the level that matters for the demo and the audit story the run is **clean**: Copilot Studio
  **Activity shows it as Completed**, and the transcript's final `SessionInfo` trace reports
  `outcome: "Resolved", impliedSuccess: true`.
- The `SessionHasLoggedOff` comes from the **Cloud PC pool returning the machine to the pool**, which
  signs out the Windows session as the run ends. The desktop-flow agent observes that sign-off and
  records it on the `flowsession`, racing with (or overwriting) a clean "Succeeded" status. The
  [Cloud PC pool feature is explicitly preview / not for production](https://learn.microsoft.com/en-us/microsoft-copilot-studio/use-cloud-pc-pool).
- It is **not** self-induced: the agent's instructions do **not** tell it to sign out of Windows or
  close the session (the platform owns session lifecycle, so they must not).

Because of this, the orchestrator treats completion by **`completedon` being non-null** and ignores
the benign `SessionHasLoggedOff` error (only a *different* `errorcode` is surfaced as `error`). Do not
key success off `statuscode`.

To get a genuinely clean terminal status (only needed for production, not the demo):

- Use a **bring-your-own dedicated registered machine** instead of the pool, with **"Reuse sessions
  for unattended runs"** enabled, so the session persists between runs and is never torn down per run.
- Optionally remove any RDS session time limits via Intune (`MaxIdleTime=0`, `MaxConnectionTime=0`) on
  the pool devices, and report the pool teardown behaviour to `computeruse-feedback@microsoft.com`.

## Behaviour and limits

- The view is **near-live** (a few seconds behind), not a real-time socket.
- Narration is scripted and overlaid on the real screenshots; the authoritative per-step reasoning is
  in Activity → Session replay.
- Runs end with `SessionHasLoggedOff` (see above); this is benign and is why completion is read from
  `completedon`, not `statuscode`.
