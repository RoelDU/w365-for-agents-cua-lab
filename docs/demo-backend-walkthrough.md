# Backend walkthrough — demo the machinery, not just the app

[`demo-flow.md`](./demo-flow.md) is the tight, 2-minute **outcome** story (a call comes in, the human
hands off to AI, the claim gets filed). This guide is the **"show me how it actually works"**
companion for a technical audience: it walks the backend tools behind the demo so partners see this
is a real, governed Microsoft Agent solution, not a canned screen recording.

Use this when the audience asks *"okay, but what's under the hood?"* or for a 15–20 minute deep dive.
The emphasis is the **Computer Use agent on Windows 365 for Agents**, and the platform around it:
**Intune**, **Copilot Studio**, and **Agent 365 / Entra Agent ID**, finishing with the **post-run
audit replay** of the agent's screenshots and reasoning.

> Run order: you can either run a fresh handoff during this walkthrough (Part D) or present a
> **previously completed run** (Part E works on a past run). For a reliable session, do at least one
> warm run before the audience arrives and keep that run available to fall back on.

---

## Pre-demo setup (once)

- The full environment is stood up per [`demo-environment-setup.md`](./demo-environment-setup.md).
- **Auditability is configured** per [`cua-auditability.md`](./cua-auditability.md) — in particular
  log retention set to **forever** so a prior run still has its screenshots. Do this first; it is the
  most common thing people miss.
- Open these tabs ahead of time and sign in, so you are not fumbling logins on stage:
  1. The **CCaaS Agent Desktop** (on, or as if on, the human agent's Windows 365 Cloud PC).
  2. **Intune admin center** (`intune.microsoft.com`).
  3. **Copilot Studio** (`copilotstudio.microsoft.com`) on your agent.
  4. **Entra admin center** (`entra.microsoft.com`) and the **Microsoft 365 admin center** Agent 365
     registry, if you are showing the governance beat.

---

## Part A — the Windows 365 endpoint (where the human sits)

Goal: establish that the human agent works from a managed **Windows 365 Cloud PC**, and the CCaaS
desktop is delivered there as a managed app, not a random browser tab.

1. Open the **CCaaS Agent Desktop** from its desktop icon. Point out it launches as an **Edge
   force-installed web app (PWA)** with its own icon, delivered by policy, signed in with **Microsoft
   Entra ID** (the app is Entra-only; see
   [`apps/ccaas-agent-desktop/docs/auth.md`](../apps/ccaas-agent-desktop/docs/auth.md)).
2. Note the two-Cloud-PC model out loud: **this** workstation is where the human signs in; a
   **separate Windows 365 for Agents pool** Cloud PC is where the AI agent runs `claims.exe`. No human
   ever signs into the agent pool. See [`w365a-pool.md`](./w365a-pool.md) and the table in the
   top-level [`README.md`](../README.md#how-it-works).

---

## Part B — Intune (how the apps reach both machines)

Goal: show the app delivery is real MDM, the same way an enterprise would ship a line-of-business app.

In the **Intune admin center**:

1. **Apps → All apps.** Show the **Zava Claims Workstation** Win32 app (the legacy `claims.exe`). Open
   it → **Properties → Assignments**: it targets the **agent pool device group** (the dynamic
   `CPCPool_*` group, or your assigned pool group). This is what pre-installs `claims.exe` on the
   W365A pool so the agent can just launch it. See [`intune-w365.md`](./intune-w365.md).
2. Open the same app → **Device install status**: show it **Installed** on the pool Cloud PC. This is
   the "the app was already there before the agent started" proof.
3. **Apps → All apps**, show the **Zava Contact Center** managed Edge web app (PWA) targeting the
   **human agent user group**: that is what put the desktop icon on the human's workstation.
4. *(Optional)* **Devices → All Cloud PCs**: show the agent Cloud PC whose **enrollment profile name
   begins `CPCPool_`** — that is the Windows 365 for Agents pool machine, Entra-joined and
   Intune-enrolled per GA design.

Talking point: no API into the legacy system, and no special packaging magic. Intune delivers a plain
Win32 app to a normal, governed Cloud PC; the agent drives it by sight.

---

## Part C — Copilot Studio (the agent itself)

Goal: show the agent is a configured, governed Copilot Studio agent with Computer Use pointed at the
pool, and that it **requires authentication**.

In **Copilot Studio**, open your agent:

1. **Overview / topics**: show the handoff topic that receives the call context and triggers the work.
   See [`build-the-agent.md`](./build-the-agent.md).
2. **Generative orchestration** is on (Computer Use requires it).
3. **Tools → the Computer Use tool**: open it and show it is pointed at your **Windows 365 for Agents
   Cloud PC pool**, with the launch instruction for `claims.exe`.
4. **Settings → Security → Authentication**: show it is set to **Authenticate manually** (a custom
   Entra app registration). Call out *why*: Computer Use is disabled for unauthenticated agents, and
   authentication is what produces the **attributed audit trail** you will show in Part F. This is the
   reason the whole solution is built on modern Entra auth end to end.
5. **Channels**: show the agent is published to **Direct Line / Web app**, which is the channel the
   handoff orchestrator calls.

---

## Part D — run the handoff (optional live run)

Run the outcome story from [`demo-flow.md`](./demo-flow.md): take the sample call on the CCaaS desktop,
click **Hand off to AI**, and switch to the Copilot Studio **test/conversation pane** to narrate the
**live** desktop streaming as the agent opens `claims.exe`, searches the policy, fills the FNOL wizard,
and reads back the claim ID. Then the result returns to the CCaaS desktop.

If you would rather not run live, skip to Part E and present a previously completed run.

---

## Part E — replay the run: screenshots + reasoning (the audit)

Goal: after the run, show **what the agent saw and why it acted** — the heart of "auditable."

Full detail is in [`cua-auditability.md`](./cua-auditability.md). On stage:

1. In Copilot Studio open your agent → **Activity** → select the run (a prior completed run is fine).
2. **Transcript** view: walk two or three steps — *the screenshot the agent saw, its reasoning
   message, the action it chose.*
3. **Activity map** → select the **Computer Use** action → **Session replay**: scrub the captured
   screenshots with the navigation controls. Show the **Summary** (duration, number of actions,
   machine name, number of screenshots).
4. *(Present-later option)* **Export session logs** to show the run offline after the demo.

This is the moment that lands the "no black box" message: every click the autonomous agent made is
recorded, screenshot by screenshot, with the reasoning behind it.

---

## Part F — Agent 365 / Entra Agent ID (governance)

Goal: the agent is an authenticated, governed identity, not an anonymous bot.

1. **Entra admin center → Sign-in logs**, filter to agent identities: show the agent's `agentSignIn`
   events. Each run is an authenticated actor.
2. **Microsoft 365 admin center → Agent 365 registry**: show the agent listed with its activity and
   health (the **Observe / Govern / Secure** view).
3. *(If enabled)* **Microsoft Purview → Audit**: search for **`CUAOperation`** to show Computer Use runs
   in the compliance audit trail.

See [`cua-auditability.md` → identity audit trail](./cua-auditability.md#3-the-identity-audit-trail-entra-agent-id--agent-365)
for the references.

---

## Cadence variants

- **10-minute "machinery" cut:** Part A (1 min) → Part B steps 1–2 (2 min) → Part C steps 3–4 (2 min)
  → Part E on a prior run (4 min). Skip Part D's live run and Part F.
- **20-minute deep dive:** all parts, with a live run in Part D.
- **Governance-led:** lead with Part C step 4 (authentication) and Part F, then Part E to prove the
  audit trail is real, then Parts A/B for delivery.

## Reset between demos

Refresh the agent connection (Copilot Studio → Settings → Connections), clear any test claims in the
legacy app, and confirm the always-available pool Cloud PC is warm so there is no cold start. The
prior run stays in **Activity** for replay as long as retention is set to forever.
