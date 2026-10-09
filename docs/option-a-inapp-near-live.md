# In-app near-live Computer Use view + full audit trail (Option A)

> **Design note, not install steps.** The supported install is [install page 4](install/05-mcs-path.md).
> Two statements below are superseded for this lab: the agent uses **Authenticate with Microsoft**
> (the *Authenticate manually* setting mentioned for Direct Line applies only to the retired Direct
> Line path and must not be applied here), and no trigger inside the agent is needed for the
> Activity history: the supported separate Power Automate flow (install section 4.4) produced
> native history with screenshots in the reference setup once the agent used Authenticate with
> Microsoft. Section 2 below describes an alternative, not a requirement.

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
- **`flowlogs`** — the Computer Use advanced logs, readable only through
  `flowsessions(<id>)/flowsession_flowlog_parentobjectid`. Each action row (type `100000401`)
  carries the model's own explanation (`actionContext.llmInstruction.output`), the action
  (`actionItems`), the application (`target.processName`), the time (`eventContext.timestamp`),
  the exact screenshot (`screenshot.flowSessionBinaryId`) and `sessionContext.conversationId`.
  Rows appear about a second after each action.
- The **claim id is not** in `flowsession.outputs` (it is null even on a run that filed a claim).
  It comes from the receipt the trigger flow saves on the original row, or, when that receipt
  has no reply yet, from the logged explanations of the conversation it names (see below).

The live progress feed shows only these logged explanations, actions and screenshots. If the
model logged no explanation for a step, the step says so; nothing is substituted. The same
record is in Copilot Studio **Activity → Session replay**.

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
| `crcce_handoffcontext`  | Nonempty serialized JSON handoff sent as the agent's run message |
| `crcce_handoffreceipt`  | Multiline text holding the trigger's result receipt when real-result mode is enabled |

Use your own publisher prefix if not `crcce`; set the orchestrator env vars below to match.

The writer preserves the incoming `callContext` fields, including the caller's task data
(`intent`, `summary`), identifiers, and any supplied task instruction. It sets `request_id`
to the same value as `crcce_correlationid` (including the existing generated fallback)
and adds a top-level `language`: `ja` when the request's `lang` is `ja`, otherwise `en`.
The field contains the JSON object serialized once as text, not a new wrapper or a
plain-text prompt. This follows the handoff fields in
[`call-context.schema.json`](../schemas/call-context.schema.json) and the run-message
instructions in
[`AGENT-INSTRUCTIONS.md`](../apps/legacy-claims-workstation/samples/foundry-agent/AGENT-INSTRUCTIONS.md).
The existing policy, summary, correlation, and language columns are still written.

For the inspected Power Automate flow, the trigger requires nonempty
`crcce_handoffcontext`. `Execute_Agent_and_wait` passes that field directly as
`body/message`; `json(triggerBody()?['crcce_handoffcontext'])?['language']` selects
`ja-JP` for `ja`, otherwise `en-US`. A populated row alone does not start the agent
while that flow is off; enabling it is a separate, approval-required operation.

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
| `CUA_REGION`                 | Optional region id, e.g. `au`; reject mismatched or missing app region before creating a row |
| `CUA_REQUIRE_REAL_RESULT`    | `1` to require the matching trigger receipt instead of a preset claim number |
| `CUA_RESULT_FIELD_RECEIPT`   | `crcce_handoffreceipt` |
| `CUA_TRIGGER_ENTITYSET`       | `crcce_claimrequests`                              |
| `CUA_TRIGGER_FIELD_POLICY`    | `crcce_policynumber`                               |
| `CUA_TRIGGER_FIELD_SUMMARY`   | `crcce_summary`                                    |
| `CUA_TRIGGER_FIELD_CORRELATION` | `crcce_correlationid`                            |
| `CUA_TRIGGER_FIELD_LANG`      | `crcce_lang`                                       |
| `CUA_TRIGGER_FIELD_HANDOFF_CONTEXT` | `crcce_handoffcontext`                       |
| `CUA_DEMO_CLAIM_ID`           | claim id to report on success (demo)               |
| `CUA_PROGRESS_MOCK`           | `1` to serve canned progress (no Dataverse needed) |

App (`apps/ccaas-agent-desktop`): set `VITE_CUA_RUN_BASE_URL` to the orchestrator's `/api` base. The
transfer directory then shows two AI agents: **Claims Automation Agent (Copilot Studio)** routes
through `runCuaViaTrigger` instead of Direct Line, and **Claims Automation Agent (Foundry)** goes
through the same service's Foundry relay (`/api/foundry-claims/*`, see
[the install guide](install/README.md)). You can also override per-session with
`?cuaRunBaseUrl=`.

For a region-bound rollout, first deploy the app version that sends its displayed
`regionId`. Then configure `CUA_REGION` alongside the matching Dataverse URL and
agent ID. Publish only regions that actually use their labelled environment; do
not point a US-labelled choice at an Australian service. An old browser tab or a
different selected region receives a refresh message and creates no request.
Keep the previous region file and service settings for rollback.

## Endpoints

- `POST /api/cua-run` — body `{ callContext, lang, regionId }`; writes the trigger row, returns `{ runId }`.
  `regionId` is required when `CUA_REGION` is set. A mismatch returns `409` with
  `code: "REGION_MISMATCH"` before creating a row.
- `GET /api/cua-run/{runId}/progress` — `{ status, claimId, activity, release, steps:[{ index,
  explanation, action, application, at, screenshotUrl }] }`. `status` is `queued` → `running` →
  `succeeded` (or `error`). `explanation` is the logged model text or `null`.
  - `activity.state`: `waiting`, `attributed` (the only Computer Use conversation since this
    request, with no other handoff pending), `unattributed` (another run is active, so nothing is
    shown), `verified` (the receipt's `conversation_id` matches), `mismatch` (withdrawn) or
    `unavailable`.
  - `release.state`: `pending`, `released` (the session record closed with the logged sign-out,
    `SessionHasLoggedOff`), `ended` (closed with no error and no recorded sign-out, so release is
    not confirmed) or `ended-with-error`.
    The claim and the release are separate facts; one does not imply the other.
- `GET /api/cua-run/{runId}/shot/{binId}` — authenticated image proxy for a `CuaScreenshot` (the
  Dataverse file endpoint needs the orchestrator's token, so the browser cannot load it directly).

Set `CUA_PROGRESS_MOCK=1` to demo the in-app UX end to end without any Dataverse grant. The mock
plays a fixed, labelled **simulated** narration and the demo claim id; it is never shown as the
agent's reasoning on the live path.

## Surfacing the real claim id

### Receipt-backed runs

Set `CUA_REQUIRE_REAL_RESULT=1` for a run that must return a real result. The
autonomous trigger must use **Execute Agent and wait**, then save this JSON
receipt to `crcce_handoffreceipt` on the **original trigger row**:

```json
{
  "definition_version": "2.0.0",
  "trigger_row_id": "<original row id>",
  "flow_run_id": "<this flow run id>",
  "conversation_id": "<Execute Agent and wait conversationId>",
  "responses": ["<Execute Agent and wait responses, unchanged>"]
}
```

The connector's documented `responses` value is an array of strings. Preserve
that array rather than creating a success message or copying a sample claim
number. The service waits for a receipt matching the exact request row.
Agent-wide machine-session history supplies the existing progress view, but
cannot finish or fail this request: an earlier session may appear there first.
It returns a claim number when the receipt contains one
distinct `CLM-YYYY-NNNNNN` number. **Execute Agent and wait** can return before a
Computer Use run ends, with `responses` still empty (seen live: 24 seconds into an
8-minute run). The receipt then only identifies the conversation, and the claim
number is taken from that verified conversation's own logged explanations: exactly
one distinct number succeeds, conflicting numbers fail, and a session that ends
without one fails. If the agent replies but no Computer Use session ever appears for
its conversation (seen live: it answered with a text summary instead of calling the
tool), the run is reported as not filed after a 3-minute grace
(`CUA_NO_ACTIVITY_GRACE_MS`). A missing receipt keeps polling; an invalid or ambiguous receipt,
lost request identity after a restart, or a read failure is reported as a failure
without automatically submitting another handoff.
If the trigger fails before writing its receipt, polling eventually times out;
inspect the original flow run rather than submitting a replacement.

This mode does not use the preset claim number or delayed transcript fallback.
The receipt is an agent-reported result, not independent proof that Claims
accepted it: verify the actual Claims confirmation, the same interaction's
result and the exact Cloud PC session release during live acceptance. Local
tests and service health do not prove those outcomes.

Reference: [Microsoft Copilot Studio connector, Execute Agent and wait](https://learn.microsoft.com/en-us/connectors/microsoftcopilotstudio/).

### Legacy demo-result mode

The following behavior is retained when `CUA_REQUIRE_REAL_RESULT` is not `1`.

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
- The Computer Use tool's instructions **do** end every run by signing out of Windows (now a single
  `shutdown /l` from the Run dialog). Project testing found the pool machine is only returned
  after a Windows sign-out, so the sign-out is deliberate. Exact text, history and rollback:
  [`mcs-computer-use-instructions.md`](./mcs-computer-use-instructions.md).

Because of this, the orchestrator never keys anything off `statuscode`. With
`CUA_REQUIRE_REAL_RESULT=1` the claim comes only from the receipt or the conversation it
verifies, and release is reported as
`released` only for `SessionHasLoggedOff`; a session that closes with no errorcode is reported as
`ended` (release not confirmed), and any other `errorcode` as `ended-with-error`.

To get a genuinely clean terminal status (only needed for production, not the demo):

- Use a **bring-your-own dedicated registered machine** instead of the pool, with **"Reuse sessions
  for unattended runs"** enabled, so the session persists between runs and is never torn down per run.
- Optionally remove any RDS session time limits via Intune (`MaxIdleTime=0`, `MaxConnectionTime=0`) on
  the pool devices, and report the pool teardown behaviour to `computeruse-feedback@microsoft.com`.

## Behaviour and limits

- The view is **near-live** (a few seconds behind), not a real-time socket.
- Each step shows the model's logged explanation with its own screenshot, only for the Computer
  Use session attributed to this handoff. If attribution is ambiguous the feed says so instead
  of guessing. Activity → Session replay holds the same record.
- The trigger path ignores the website's Direct Line prompt (`buildTriggerText`); the agent works
  from the trigger row and the Computer Use tool instructions.
- Runs end with `SessionHasLoggedOff` (see above); this is benign and is the evidence that the
  Cloud PC was released. Nothing is read from `statuscode`.
