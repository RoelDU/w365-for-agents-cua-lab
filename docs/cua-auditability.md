# Computer Use (CUA) auditability — show the screenshots and reasoning after a run

This is how you make the AI agent's Computer Use run **auditable** and **demoable after the
fact**: after the agent has driven `claims.exe` on the Windows 365 for Agents pool, you can open
the run and show, step by step, **the screenshots the agent saw** and **the reasoning and actions
it took**, plus a full identity audit trail.

This works today on **Microsoft Copilot Studio (GA)**. You do not need Azure AI Foundry or any
limited-access preview to get the audit trail. (Foundry remains an optional alternative backend;
see [the note at the end](#optional-alternative-backend-azure-ai-foundry).)

> **Works out of the box — no admin toggle required for the core demo.** The **Activity → Transcript**
> view already shows the agent's **screenshots and reasoning for each action** with no configuration.
> Per Microsoft's docs, the advanced settings in section 2 *"don't affect how agent transcripts
> (including any computer use logs) are stored. Transcripts continue to include basic computer use
> logs, screenshots, and all other agent and tool logs, regardless of the configuration."* So you can
> demo the "show me what the agent saw and why" story immediately. Section 2's settings are
> **enhancements** (the richer Session-replay side panel, longer retention, Purview export) and need a
> one-time Power Platform admin toggle — do them when convenient, but the demo does not depend on them.

> **The one prerequisite: the agent must require authentication.** Computer Use is disabled for
> unauthenticated agents, and an unauthenticated agent produces run logs with **no identity
> attribution**. Requiring **manual Entra authentication** (Settings → Security → Authentication →
> *Authenticate manually*) is what both enables Computer Use **and** gives you the full, attributed
> audit trail described below. This is also why the CCaaS Agent Desktop ships as Entra-only sign-in
> (see [`apps/ccaas-agent-desktop/docs/auth.md`](../apps/ccaas-agent-desktop/docs/auth.md)).

---

## 1. What you can show after a run

In Copilot Studio, open your agent → **Activity** → select the run. On the run details page switch
between **Activity map** and **Transcript**.

- **Transcript view** gives *"a step-by-step log with reasoning messages and screenshots for each
  action,"* i.e. exactly the "what did the agent think, and what did it see" narrative you want for
  a partner audience.
- **Activity map** plots the run; selecting the Computer Use action opens the **Advanced computer
  use activity** side panel with:

| Panel section | What it shows |
|---|---|
| **Session replay** | The series of screenshots captured during the run, with navigation controls (step forward/back through what the agent saw) |
| **Activity** | Action types, action coordinates, the user context used, action timestamps, and the screenshot for each step |
| **Summary** | Instruction text, inputs, duration, number of actions, average time per action, number of screenshots, human-escalation count, machine name and link, machine user login |
| **Websites & applications** | Apps and sites the agent touched (for this demo: the legacy claims app) |
| **Credentials used** | Which credentials were used to act on the machine |
| **Export session logs** | One click to export the session log for **offline review** — ideal for showing the run later, after the demo, with no live portal needed |

Source: [Monitor computer use activity](https://learn.microsoft.com/en-us/microsoft-copilot-studio/monitor-computer-use).

---

## 2. Optional: enhanced logging (admin toggle — not needed for the core demo)

> Skip this for a basic demo — the Transcript view in section 1 already shows screenshots and
> reasoning. These settings add the **Advanced computer use activity** side panel (Session replay,
> per-step coordinates, credentials used, Export session logs) and control how long old runs are kept.
> They are environment-wide and require a **one-time Power Platform admin** change.

The advanced screenshots-and-reasoning side panel is controlled by a few environment settings. The
defaults are *mostly* right, but **the default log retention is only 7 days**, which is the single
most common reason an *advanced-panel* replay of an older run looks empty when you go back to it
later. (The basic Transcript view is unaffected by retention in the same way; set retention to
keep-forever if you want the advanced replay of old runs available indefinitely.)

In the [Power Platform admin center](https://admin.powerplatform.microsoft.com/): **Manage** →
**Environments** → *(your demo environment)* → **Settings** → **Products** → **Features**, then:

1. Under **Copilot Studio agents**, check **"Allow conversation transcripts and their associated
   metadata to be saved in Dataverse (required for enhanced reporting)."**
2. Scroll to **Computer Use** and confirm **Store logs in Dataverse** is **On** (default). If this
   is off, only default activity logs appear (no advanced panel).
3. Set **Computer use logs verbosity** to **All data** (the default). The other options
   (*Data without screenshots*, *Minimal*) deliberately drop the screenshots.
4. Set **Log retention time** to **forever**: enter **0** or **-1** as a custom value (default is
   7 days / 10,080 minutes). **This is the fix for "Could not retrieve the session screenshots"
   on an older run.**
5. *(Optional, recommended for the governance story)* Turn on **Send audit logs to Microsoft
   Purview**. Computer Use run logs then appear in Purview under the activity term **`CUAOperation`**,
   independent of the settings above.

> Storing these logs consumes Dataverse capacity (database, log, and file storage for the
> screenshots). For a demo environment that is negligible; for production, size retention to your
> data-retention policy.

Source: [Monitor computer use activity → Configure advanced computer use logging](https://learn.microsoft.com/en-us/microsoft-copilot-studio/monitor-computer-use).

---

## 3. The identity audit trail (Entra Agent ID + Agent 365)

Because the agent authenticates, every run is an **authenticated, attributable actor**, not an
anonymous bot. That gives you three additional, admin-grade audit surfaces to show alongside the
in-product replay:

- **Microsoft Entra Agent ID (GA).** The agent has a first-class Entra identity; *"all agent
  authentication and activity is logged for compliance and audit."* Agent sign-ins appear in the
  Entra **Sign-in logs** as the `agentSignIn` event type, and agent activity appears in the Entra
  **Audit logs** keyed by the `agentType` property (application / service principal / user events
  depending on the agent identity type).
  [What is Microsoft Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id) ·
  [Sign-in and audit logs for agents](https://learn.microsoft.com/en-us/entra/agent-id/sign-in-audit-logs-agents)
- **Microsoft Agent 365 (GA, May 1 2026).** The Agent 365 registry (in the Microsoft 365 admin
  center, Entra, and Purview) gives a centralized **Observe / Govern / Secure** view of the agent:
  adoption, activity, health, plus Purview information protection and Defender threat detection.
  [Agent 365 overview](https://learn.microsoft.com/en-us/microsoft-agent-365/overview)
- **Microsoft Purview.** Copilot Studio admin/usage events are audited by default and cannot be
  disabled; with the Purview toggle from step 5 above, Computer Use runs land as `CUAOperation`
  entries you can surface in the Purview audit search.
  [Audit logs for Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-logging-copilot-studio)

This is the "secure by design / auditable agent" narrative Microsoft recommends for autonomous
agents: an authenticated Entra identity, governed in Agent 365, with full run-level screenshots and
reasoning retained in Dataverse and optionally mirrored to Purview.

---

## 4. Demo it — quick path

Set up once (sections 2 and 3 above), then in the live demo:

1. Run the handoff as usual (CCaaS desktop → **Hand off to AI** → the agent files the claim on the
   W365A pool). Narrate the **live** desktop streaming in the Copilot Studio test/conversation pane.
2. After the claim is filed, switch to **Activity** → open the run → **Transcript**. Walk the
   audience through two or three steps: *"here's the screen the agent saw, here's its reasoning,
   here's the click it chose."*
3. Open the **Activity map** → select the Computer Use action → **Session replay** and scrub the
   screenshots. Show the **Summary** (duration, number of actions, machine name) for the "this was a
   real, governed machine" point.
4. *(Optional governance beat)* Show the agent's **Entra sign-in log** entry and the **Agent 365**
   registry tile to make the "authenticated, auditable actor" point, and/or the Purview
   `CUAOperation` entry.
5. *(To present later, offline)* Use **Export session logs** to save the run and show it after the
   demo with no portal dependency.

A prior, already-completed run works for steps 2–5, so you can show the audit trail even without
running live, as long as retention (section 2, step 4) has not purged it.

---

## 5. Troubleshooting: "Could not retrieve the session screenshots" / empty replay

Work down this list — the first item is by far the most common:

| Symptom | Cause | Fix |
|---|---|---|
| Replay empty on an older run | **Retention expired** (default 7 days) | Section 2, step 4: set retention to `0`/`-1` and re-run; older runs cannot be recovered |
| No screenshots in the panel, but actions are listed | Verbosity = *Data without screenshots* or *Minimal* | Section 2, step 3: set to **All data** |
| No advanced panel at all | **Store logs in Dataverse** off, or transcript saving unchecked | Section 2, steps 1–2 |
| Run shows 0 actions / pool shows 0 runs ever | Agent is set to **No authentication** (Computer Use disabled for unauthenticated agents) | Settings → Security → Authentication → **Authenticate manually**, then re-publish |
| Nothing in Purview | Purview toggle independent of Dataverse logging | Section 2, step 5 |

---

## Optional alternative backend: Azure AI Foundry

The repo also ships a Foundry-based runner ([`samples/foundry-w365a-runner`](../samples/foundry-w365a-runner))
as an alternative AI backend. Foundry's Computer Use model is currently **limited-access / gated**
(registration at <https://aka.ms/OAI/gpt54access>; there is no self-service entitlement check — the
practical test is whether the model appears in your deployment catalog). If you go that route, the
Responses API returns every screenshot and the model's reasoning per step, so a developer can
persist and replay them, but **you own the capture and storage**. For the supported, no-gate audit
trail, prefer the Copilot Studio path above.

---

## References

- [Monitor computer use activity (Copilot Studio)](https://learn.microsoft.com/en-us/microsoft-copilot-studio/monitor-computer-use)
- [Computer use in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/computer-use)
- [Human supervision for computer use](https://learn.microsoft.com/en-us/microsoft-copilot-studio/human-supervision-computer-use)
- [Audit logs for Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-logging-copilot-studio)
- [What is Microsoft Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id)
- [Sign-in and audit logs for agents (Entra)](https://learn.microsoft.com/en-us/entra/agent-id/sign-in-audit-logs-agents)
- [Microsoft Agent 365 overview](https://learn.microsoft.com/en-us/microsoft-agent-365/overview)
- [Configure end-user authentication (Copilot Studio)](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configuration-end-user-authentication)
