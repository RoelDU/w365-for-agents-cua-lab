# End-to-end demo flow - narrated walkthrough

Reference notes for the live partner demo. The current deployment has a
centrally hosted CCaaS desktop on Azure Static Web Apps, with the same SWA
hosting the `/api` handoff endpoint.

> This is the tight 2-minute outcome story. For a backend deep dive (Intune,
> Copilot Studio, Agent 365) and for replaying the agent's screenshots and
> reasoning after a run, see [`demo-backend-walkthrough.md`](./demo-backend-walkthrough.md)
> and [`cua-auditability.md`](./cua-auditability.md).

## Setup checklist (before the demo)

- [ ] `scripts\Build-DemoFromScratch.ps1` has completed for the target config.
- [ ] The Azure Static Web App URL opens the CCaaS Agent Desktop.
- [ ] The handoff endpoint settings point to the configured AI agent
      (Copilot Studio over Direct Line) and Computer Use is enabled.
- [ ] An existing Windows 365 Cloud PC or Flex/Shared user has been added to the
      configured Entra group.
- [ ] The Cloud PC has the **Zava Claims Workstation** Win32 app installed.
- [ ] The **Zava Contact Center** managed web link opens the SWA URL in Edge.
- [ ] The AI agent (Copilot Studio) is configured with Computer Use enabled.
- [ ] **Refresh the Windows 365 / Computer Use connection in the agent platform's
      Settings -> Connections.** The token can expire when the Cloud PC session
      disconnects or restarts.
- [ ] **Disable web search on the agent.** It adds latency and can inject
      irrelevant context into a regulated-industry demo narrative.
- [ ] Hero record verified: Jordan Smith, `(555) 123-4567`, `POL-2024-008341`.
- [ ] Legacy app data reset for the hero scenario.
- [ ] Backup recorded video ready.

## The narrative (2 minutes)

### Beat 1 - "Here's where your contact-center agent sits today." (15s)

Open the **Zava Contact Center** managed web link. Status bar shows the agent as
**READY** in the **Auto Claims** queue. Real-time queue indicator shows calls
waiting. It looks like a familiar Genesys / Five9 / NICE-style desktop, but it is
only a reference widget.

### Beat 2 - "A call comes in." (10s)

Click **Simulate Inbound Call**. Caller info pops based on `(555) 123-4567`.
Customer 360 shows Jordan Smith, AUTO policy `POL-2024-008341`, premium current.
Live transcript starts streaming:

> "Hi, yeah, I was rear-ended at the intersection of 5th and Main around 2:30
> this afternoon. A Honda Civic rear-ended me. No one was hurt. Both cars are
> still drivable. I'd like to file a claim."

### Beat 3 - "Today the agent would alt-tab through Siebel, the mainframe, and the FNOL form for ~7 minutes." (10s)

Say this; do not spend demo time showing it.

### Beat 4 - "Watch what we can do now." (5s)

Click **Transfer**, choose the AI destination, and confirm the handoff. The
desktop posts the `CallContext` JSON to the SWA `/api/handoff` endpoint.

### Beat 5 - "Behind the scenes." (30s)

Switch to the Windows 365 Cloud PC. The AI agent's Computer Use is driving
the legacy claims workstation on screen. It has:

- Received the structured call context through the handoff endpoint, which
  invoked the AI agent run.
- Launched or focused `claims.exe`.
- Acknowledged the compliance banner, MOTD, and ready gate.
- Searched by phone, opened Jordan Smith's policy.
- Started the New FNOL wizard, filled Incident, advanced through Vehicles /
  Parties / Coverage, and is now on the Review page.

Click **Submit Claim** or let CUA do it, depending on the cadence you want.
Claim ID appears: `CLM-2024-000123`.

### Beat 6 - "Result returned to the human agent." (15s)

Switch back to the CCaaS Agent Desktop. The status card now shows:

> **Claim filed by AI Agent**
> **Claim number:** CLM-2024-000123
> **Reserve set:** $4,200.00
> **Adjuster assigned:** ADJ-NA-0142

Voice agent says to caller: "Your claim number is CLM-2024-000123. You'll get an
SMS confirmation. Anything else?"

### Beat 7 - "The whole call was about 90 seconds." (10s)

The legacy system was driven by an agent through the UI. No legacy API was used,
no legacy system was modified, and the CCaaS -> AI handoff was a realistic JSON
POST over HTTPS.

### Beat 8 - "What this unlocks for you." (15s)

> "Which of your customers' workflows look like this - automatable on the screen,
> blocked by no-API systems? Which 2-3 would you co-build with us as a packaged
> offering? What's the smallest joint pilot we could stand up in 6 weeks?"

### Beat 9 - "And it's fully auditable." (15s)

Open the agent's **Activity** in Copilot Studio and show the **Transcript** and **Session
replay** for the run you just did (or a prior one): the screenshots the agent saw and its
reasoning, step by step, plus the run summary. This is the "no black box" proof. Full steps:
[`cua-auditability.md`](./cua-auditability.md).

## What to do if something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| CCaaS web link does not open | Intune web-link assignment has not arrived or URL is wrong | Open the SWA URL directly, then verify the managed web link and group assignment after the demo. |
| Handoff POST fails | Handoff endpoint setting missing, agent/Direct Line auth failure, or network issue | Check the handoff endpoint app settings and the browser network trace. Use the app's error toast as the demo explanation and move to backup if needed. |
| Status card never completes | The agent run is still in progress or the agent's final message did not include a claim id | Show the Cloud PC screen and narrate the agent progress; later inspect the handoff status endpoint with the returned run identifiers. |
| CUA stuck on a screen | Modal or host prompt appeared that was not expected | Narrate over it, then recover manually or cut to backup video. |
| Legacy app shows wrong customer | Hero records were not reset | Reset/reseed legacy app data and rerun. |
| Whole flow fails | Tenant, network, or Cloud PC issue | Cut to the backup recorded video and continue the narrative. |
| Session replay / run summary looks empty | Almost always a logging/retention setting, not a platform bug: the default log retention is only 7 days, or verbosity is set to "Data without screenshots", or Dataverse logging is off | Configure per [`cua-auditability.md`](./cua-auditability.md) (retention = forever, verbosity = All data, Store logs in Dataverse on). For a live run you can also narrate the streaming desktop in the Copilot Studio test/conversation pane. |

## Cadence variants

- **30-second wow cut:** skip Beat 3 and use the fastest legacy-app path.
- **5-minute depth version:** show the legacy auth/compliance flow visibly so
  partners recognize the process friction.
- **15-minute architecture deep-dive:** open the schemas, the SWA `/api` README,
  and the AI agent instructions; explain how the JSON handoff maps to real
  CCaaS transfer webhooks and how Computer Use covers no-API legacy systems.
