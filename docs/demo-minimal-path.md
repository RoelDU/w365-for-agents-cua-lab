# Minimal demo path — the AI files a claim on W365A (no orchestrator, no Direct Line)

**Use this for the live demo.** It shows the thing that actually matters — a
**Copilot Studio agent driving `claims.exe` on a Windows 365 for Agents (W365A)
Cloud PC via Computer Use (CUA)** — using only pieces that are already proven to
work. It deliberately leaves out the standalone orchestrator and the custom
**Direct Line** trigger, which are an *unattended browser-handoff automation*
(Phase 2 below), not a requirement for showing the AI do the work.

> **Why this exists.** The AI core works today: with the agent set to
> **Authenticate with Microsoft**, Computer Use runs in the Copilot Studio **Test
> pane** and the W365A pool provisions a Cloud PC. The complexity that has caused
> grief — a custom Direct Line channel + an Entra app registration
> (*Authenticate manually*) — exists *only* to trigger that same agent unattended
> from the browser. The demo does not need it.

## Make it can't-fail (pre-flight — do this, not hope)

A live AI demo only "fails" when you demo on a **trial** and skip the warm-up. Both
failure modes seen so far are 100% removable *before* you're in the room:

0. **Run the prerequisite checker first** —
   **<https://dweinerhls.github.io/windows365-cua-checker/>**. It surfaces the API-verifiable
   gaps (the **PAYG / Copilot Studio license** ⚠️ WARN = #77) and the **manual** items it can't
   check (cross-geo, Intune **Allow Windows (MDM)**, **ESP** #82, **Computer Use tool** bound).
   Re-run it against the *current* environment — toggles verified "once" don't survive an
   environment being recreated/repointed. Don't debug anything until you've read what it reports.
1. **Get off the trial — attach pay-as-you-go billing.** The trial caps usage
   (~10 requests/min, ~200/hour, plus a monthly allowance a day of testing burns),
   which is what produced the **"reached its usage limit"** stop. PAYG removes that
   cap. Power Platform admin center → Licensing → Pay-as-you-go (#77,
   [`licensing-and-entitlement.md`](licensing-and-entitlement.md)). **Do not demo on a Trial pool.**
2. **Pre-warm the Cloud PC.** Set **Always available Cloud PCs = 1** and confirm one
   shows **Running** — no cold boot (#93, [`handoff-runbook.md` §8](handoff-runbook.md#8-pre-demo-checklist)).
3. **Dry-run the exact demo 15–30 min before**, on the same machine/account/network.
   If the dry run is green and you don't touch anything, the live run is green.
4. **Carry two fallbacks, in order, so the story never stops:**
   - **A recorded golden run** of *your own* real W365A CUA filing the claim (this is a
     captured genuine execution, not a mockup). If the network/cloud hiccups live, you
     narrate over the recording. ([`demo-flow.md`](demo-flow.md) backup-video row, `BUILD.md`.)
   - **The simulated CCaaS desktop** (runs with **zero backend**) to show the
     end-to-end handoff narrative if all cloud is unavailable — verified to run offline.

> Bottom line: the run that "failed" was a Trial hitting its quota. On PAYG + a warm
> pool + a dry run, the live W365A run is reliable; the recording is the safety net.

## What you already have (no new build)

- A **published Copilot Studio agent** with the **Computer Use** tool bound to your
  **W365A Cloud PC pool** (`docs/build-the-agent.md`, `docs/w365a-pool.md`).
- Agent authentication = **Authenticate with Microsoft** → **CUA is enabled** (this
  is the setting that makes the Test-pane run work). **Do not change it** for this path.
- `claims.exe` is pre-installed on the pool via **Intune** as a required Win32 app; the
  agent's first on-screen action just launches it (`apps/legacy-claims-workstation/samples/foundry-agent/CUA-TOOL-INSTRUCTIONS.md`).

## The demo (three steps)

1. **Pre-warm the pool (kills "cold boot").** In the Intune provisioning policy set
   **Always available Cloud PCs = 1** and confirm one Cloud PC shows **Running**
   before the session. See [`w365a-pool.md` → Cost / always-available](w365a-pool.md#cost)
   and [`handoff-runbook.md` §8](handoff-runbook.md#8-pre-demo-checklist). Optionally
   do one throwaway run 10–15 min beforehand so the machine is warm.
2. **Trigger the agent natively** — pick the lowest-friction surface, *not* Direct Line:
   - **Copilot Studio Test pane** (most reliable — this is where CUA is already
     confirmed to run), or
   - a **standard channel** the agent is published to (Teams / Microsoft 365 Copilot;
     these stay connected under *Authenticate with Microsoft*), or
   - a **one-step Power Automate flow** (the product-native trigger for an autonomous
     agent — confirm in your tenant before relying on it live).

   Hand the agent the claim context (caller, policy number, intent, summary).
3. **Watch it work.** The agent acquires the warm Cloud PC, drives `claims.exe`
   through the FNOL wizard, and files the claim. Read back the **claim id**
   (`CLM-YYYY-NNNNNN`).

## If the agent says "reached its usage limit"

This is a **Copilot Studio quota**, not a broken demo. Trial GenAI limits are low
(~10 requests/min, ~200/hour) and a day of test runs can exhaust the monthly
allowance. **Wait ~3–5 min and re-run** — if it works, it was the per-minute/hour
rate limit. If it **keeps** failing, the monthly capacity is spent: attach
**pay-as-you-go billing** to lift it now (`licensing-and-entitlement.md`, #77) or wait
for the 1st-of-month reset. Check usage in **Power Platform admin center → environment
usage**. (This is *different* from a "0 runs / `SystemError`" pool, which means **no**
billing policy is attached.)

## What this proves — and what it doesn't

- ✅ Proves the headline: **the AI agent files a real claim on a W365A Cloud PC via
  Computer Use.** W365A is included, end to end.
- ⛔ Does **not** include the browser → agent **unattended auto-handoff** (the CCaaS
  desktop firing the trigger with no human). That is Phase 2 — present it as roadmap.

## Phase 2 (roadmap — not needed for the demo)

The standalone **Handoff Orchestrator** + custom **Direct Line** trigger automate the
desktop → agent handoff so a CSR never leaves the call. That path is documented in
[`handoff-runbook.md`](handoff-runbook.md) and the platform trade-offs in
[`agent-platform-decision.md`](agent-platform-decision.md). It is more complex on
purpose-built reasons:

- Computer Use needs an **authenticated** agent, but the built-in **Authenticate with
  Microsoft** **disconnects the custom Direct Line channel** the orchestrator triggers
  over — so a fully-unattended Direct Line trigger requires **Authenticate manually**
  (a custom Entra app registration). That Entra-app wiring is the complexity this
  minimal path avoids.
- The product-native alternative for unattended runs is an **event / Power Automate /
  scheduled trigger** (not Direct Line). If Phase 2 is pursued, prefer that over the
  custom Direct Line channel.

> No environment-specific data appears in this note by design.
