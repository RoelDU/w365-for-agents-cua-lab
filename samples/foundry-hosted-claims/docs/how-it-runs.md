# How the Foundry Claims agent runs

Reference for people who want to know exactly what the agent does during a run and which
safeguards apply. You do not need this page to install or present the lab; start with the
[sample overview](../README.md).

## Contents

- [Identity and tool discovery](#identity-and-tool-discovery)
- [Start of every run: getting a Cloud PC](#start-of-every-run-getting-a-cloud-pc)
- [Opening Claims](#opening-claims)
- [When Windows 365 rejects a tool call](#when-windows-365-rejects-a-tool-call)
- [Filing a claim](#filing-a-claim)
- [What the model can and cannot do](#what-the-model-can-and-cannot-do)
- [The live view](#the-live-view)
- [Failure, recovery and retention](#failure-recovery-and-retention)
- [Lessons from earlier runs](#lessons-from-earlier-runs)

## Identity and tool discovery

- Microsoft's `InvocationAgentServerHost` accepts the same handoff that the Copilot Studio
  path receives.
- The agent finds its Windows 365 tools through the Agent 365 tooling SDK, with the **agent
  user's** delegated token from the Microsoft Agents SDK autonomous flow. The person who
  transferred the call never chooses or lends the runtime identity.
- The Microsoft MCP client opens the discovered `mcp_W365ComputerUse` server and uses its live
  tool schemas. The first catalogue contains only lifecycle tools.
- Before the first desktop action, the agent lists the desktop tools of the Cloud PC session it
  acquired, using `params._meta.sessionId` and reading every page. Each later call carries that
  same `sessionId` in the Windows 365 envelope, even when a tool's input schema omits it. The MCP
  transport-session header is not used instead of the Cloud PC session ID.
- If this session-scoped discovery fails, the Cloud PC that was acquired is still released.

## Start of every run: getting a Cloud PC

Both operations, `smoke` and `claims`, start the same way:

1. **Acquire** a Cloud PC with Start Session.
2. **Confirm the session.** Get Session Details must name the same session. Microsoft documents
   no status values for that reply, so only its field names are recorded.
3. **Wait until it is ready.** The Cloud PC counts as ready once the documented lightweight
   `get_screen_size` call answers.
4. **Wait for the viewer.** The separate live view must report that it is connected.
5. **Read the screen** in the foreground.

If Windows account setup ("Setting up for work or school", the Enrollment Status Page) is in
front, the agent waits up to 30 seconds. If setup is still there, the run stops with a named
setup error and Claims is not opened. That wait counts against the Claims time budget. An
unreadable screen is reported as unreadable, not as account setup.

If Windows 365 rejects a screen read during this check, the rejection is shown and the read is
retried within the same 30 seconds. If every read is rejected, the run stops before Claims is
opened, with the service's reason (redacted as described below).

## Opening Claims

- The agent opens the installed Claims Workstation.
- If another window is in front (for example a browser window opened at first sign-in), it asks
  once for the Claims window to be activated. It retries only while the service reports that
  the window is not found yet.
- Activation alone is not success: Claims must then appear in the foreground accessibility tree.
- If activation needs approval or is rejected, the run stops and releases the Cloud PC.
- If Claims is not seen in the foreground, the error says so. The only diagnostics are yes/no
  values, including whether `list_windows` shows a Claims window.
- The `smoke` operation then reads the Claims accessibility tree and releases the Cloud PC. It
  never files a claim.

## When Windows 365 rejects a tool call

When a tool call returns `isError`, the run stops and releases the Cloud PC. The error names the
tool and the step.

From the service's reply the agent keeps only:

- a short code and status,
- a GUID or short correlation ID,
- a message of at most 300 characters.

Before anything is kept, secret-named values (quoted or not), tokens, URLs and long opaque values
are removed, and codes or IDs that look like keys are dropped. A structured reply without a safe
message field is never copied; it is recorded as `service_message_withheld` with its length.

Every error event also carries `context`: the step, the last tool started, and whether Submit
Claim had been sent. After a Submit was sent, the message says the claim may have been filed and
must not be repeated.

## Filing a claim

The `claims` operation adds a bounded loop in which the model chooses actions and this code
checks and performs them.

### What the model sees

- Each screen description gives every element a centre click point (`clickX`, `clickY`).
- The model gets a compact copy of each screen: every element's role, label, value,
  automationId, bounds, click point and any flag that is true. Null values, empty labels, false
  flags and the service's CorrelationId line are left out. Values are never shortened.
- Only the newest screen is sent in full. Each earlier screen is replaced in place by a one-line
  note, so every tool call keeps its paired result and check messages.
- The raw screens stay in the activity record, and every application check reads those.
- Each turn may produce at most 1024 tokens plus the JSON-escaped length of the supplied summary
  (at least one byte per token), so the longest permitted narrative always fits. A reply that
  still reaches the limit is refused, and nothing from it is sent to the Cloud PC.

### How actions are run

- Every model turn must call at least one tool. The model stops through `finish_claim` (for
  example `POLICY_NOT_FOUND`), never with text only.
- A turn may hold **up to six** actions when the next steps are certain from the latest screen,
  for example: choose "Policy #", type the policy number, Search, open New FNOL.
- The actions run **one at a time, in order**, and the screen is read again after each one.
- The rest of the turn is skipped, and the model is told why, if an action is refused, if a later
  click would no longer land on the same named control, or if a later typed field was not on the
  screen the model saw.
- Submit Claim and `finish_claim` are always alone in their turn. A turn with more than six
  actions is not run at all.
- After every click, key press, typing, scroll or window activation the loop reads the screen
  again and gives that fresh layout to the model. If that read fails, the run stops instead of
  acting on an old view.
- Three identical actions in a row that leave the screen unchanged stop the run. The status-bar
  clock and correlation IDs are ignored in that comparison; Tab is not counted, because focus is
  not shown.
- A second Submit attempt (Alt+U, a click on Submit, or Enter while Submit is shown) is refused
  and never sent.

### Typing and searching

- Typing must name its target field (`field`, the automationId from the latest screen). The loop
  clicks that field's centre, types, reads the screen again, and stops the run unless the field
  then shows exactly the typed text.
- It never types into a field that already holds other text.
- New FNOL is not opened until the Policy tab shows the requested policy (or caller phone).
- Until then, the newest screen (and any refused New FNOL) carries a short application check:
  - what the Policy tab's own field shows;
  - that text in the unlabelled search box is only search text and does not select a policy;
  - the real number of result rows;
  - when Search has not been clicked since that text was typed, the Search button's click point
    from that screen.
- Once the Policy tab shows the policy, the check says it is selected. The check only reports;
  the model still takes every step.
- Before any search, the check also says that no search has run, so an empty list does not mean
  the policy is missing, and names the next step.
- A `POLICY_NOT_FOUND` stop is accepted only after a Search for the requested policy (or phone).
  Otherwise it is refused; a second unsearched one ends the run as unverified.
- The optional Add... vehicle and party dialogs are not opened.

### Submitting and recognising the claim

Submit is sent only when the on-screen review shows:

- the requested policy (or caller phone),
- the loss type for the call's intent,
- a non-empty loss location that appears word for word in the summary or transcript,
- the supplied summary as the narrative. Because the Windows 365 tree cuts the review at 256
  characters, the narrative is confirmed when it is typed.

A second attempt that still does not match stops the run without filing.

A confirmation that is already open when the task starts is rejected. Success must come from the
foreground **FNOL Submitted** dialog, with its fixed label, single read-only claim-ID field and OK
button, after an action in this run. Matching words inside a narrative field do not prove
submission.

## What the model can and cannot do

- No shell, arbitrary program launch, browser automation, clipboard, lifecycle tool or
  unrestricted keyboard shortcut is offered to the model.
- Tool calls that need approval, and model refusals, stop the task. The agent cannot approve
  them itself.
- The instruction to use only Claims is not an operating-system security boundary. Use a
  dedicated, low-privilege demo Cloud PC and synthetic claims, never production data.

## The live view

- The viewer shows **Plan / Computer / Activity / Outcome**. Plans are labelled as application
  text. Explanations are the assistant's actual text or an available model summary, not private
  reasoning.
- The screen uses Microsoft's screen-share SDK in `viewOnly` mode (`Computer.See` only; no
  `Computer.Control`).
- `computerUrl` comes from this exact acquisition's `screenShareUrl`, removing only the final
  `/screenshare` path segment and keeping the service-issued `api-version` and the rest of the
  query unchanged.
- The SDK receives that `computerUrl` and the versioned `viewerUrl`, as in Microsoft's Playground
  implementation (not the overview's older `sessionLink` constructor). Missing or malformed screen
  URLs are rejected before a viewing token is requested.
- There is no recording, alternate desktop, RDP sign-in or simulated success path. Tests replace
  external services with labelled fixtures.

## Failure, recovery and retention

- Work stops on a refusal, a request for more approval, a failed tool, a timeout or a
  cancellation.
- An independent, time-limited release is attempted for every known session ID. Outcome and
  release are separate: a submitted claim can still need cleanup.
- Repeated cancellation requests are harmless and cannot cancel that release attempt.
- A per-session SQLite store remembers requests and events across supported sandbox suspension.
  Replaying the same request does not run it again; a changed payload is rejected. Refreshing the
  browser does not restart the task.
- Runs are background tasks, not a durable job engine: if the process is lost, the run is
  reported as interrupted and never resumed automatically.
- Use **Cancel and release**, then **Retry release only** for a recorded session whose release
  failed. Recovery calls only End Session; it never acquires a Cloud PC or repeats a submission.
- If the acquisition reply was lost and no session ID was recorded, an administrator must
  investigate. Never invent an ID, reset the pool, or assume nothing was allocated.
- If hosted session storage is deleted, request history and replay protection are lost: archive
  the evidence first, never reuse that request ID, and check the Claims app.
- Tokens stay in memory and view responses are `no-store`. Handoffs, screen text, tool arguments
  and outcomes can contain personal data, so use synthetic inputs. The session's SQLite file is
  real retained data: delete only approved, completed hosted sessions under your retention
  policy, after cleanup and evidence review.

**Release is not the same as capacity.** The agent ends its Windows 365 session itself when a run
finishes, fails or is cancelled. The pool then resets that Cloud PC before it can be handed out
again: about 15-17 minutes in the reference one-PC pool. The optional availability check (install
step 6.2a) greys out the Foundry choice in Zava until the pool reports a free Cloud PC. It reads a
Microsoft Graph **beta** field (`sessionUsage.availableSessionsCount`), which can change without
notice, so it is a demo dependency that fails closed ("Unable to check").

## Lessons from earlier runs

Several safeguards above exist because of specific runs in the reference environment:

| What happened | Safeguard that followed |
| --- | --- |
| In REQ-2026-576139834574 a tool call was rejected seconds after Start Session. From the timing it was inferred, not proven, to be the first screen read after readiness. | Screen reads rejected during the start-up check are shown and retried within the same 30 seconds. |
| Typing without a named field landed in the hidden FNOL narrative, and the search ran empty. | Typing must name its field, is checked afterwards, and never goes into a field holding other text. |
| The model took its typed search text for a selected policy, tried New FNOL five times and clicked an empty result list twice before pressing Search. | The Policy tab application check, and New FNOL refused until the policy is shown. |
| A run reported "not found" from the empty start screen. | `POLICY_NOT_FOUND` is accepted only after a Search for the requested policy or phone. |
