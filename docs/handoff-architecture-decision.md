# Handoff architecture decision — CCaaS → Copilot Studio agent → Computer Use (CUA)

**Status:** Proposed (awaiting owner go/no-go). **Date:** 2026-06-02.
**Supersedes** the Foundry-centric description in `agentic-handover-mechanism.md` for the
*invocation mechanism* (that doc's CCaaS-pattern survey is still valid background).

> **Update (2026-06-08):** the handoff *contract* below is backend-agnostic. Besides the
> Microsoft Copilot Studio (MCS) invocation path, the same contract is now also served by an
> **Azure AI Foundry + Windows 365 for Agents** backend ([`samples/foundry-w365a-runner`](../samples/foundry-w365a-runner)),
> selectable with `Build-DemoFromScratch.ps1 -AgentBackend mcs|foundry|both`. The CCaaS
> desktop and orchestrator are unchanged either way — only the runtime behind the contract
> differs.

> **Update (2026-06-12, issue #112):** the *invocation channel* changed. **Computer Use is NOT
> supported on classic Bot Framework Direct Line** — the tool only runs on `msteams`,
> `pva-engine-direct`, `pva-studio`, `pva-maker-evaluation`, or `pva-autonomous`. An orchestrator
> on classic Direct Line reaches the Cloud PC (`ready`) but the tool ends with *"the current
> channel does not meet these requirements."* The orchestrator now invokes the agent over
> **Copilot Studio Direct-to-Engine** (channel `pva-engine-direct`, `HANDOFF_CHANNEL=engine`,
> `apps/handoff-orchestrator/src/channel/engineDirectAdapter.js`). The **contract is unchanged**
> (same `pvaSetContext` event + natural-language trigger + result callback / watermark fallback);
> only the channel + auth (Entra bearer instead of a Direct Line secret) differ. Classic Direct
> Line remains for non-CUA testing. See `docs/handoff-runbook.md` §10 and decision **D19** below.

**Why this doc exists:** the demo's single most scrutinised seam is how the contact-center
hands a live interaction to the AI that then drives the legacy `claims.exe` via Computer Use.
If that seam isn't how real Tier-1 CCaaS solutions work, a CCaaS-savvy audience won't be won
over. This records the verified mechanism, the production-realistic design (hardened by two
independent design-critique passes), and the path to swap the CCaaS layer to **Dynamics 365
Contact Center** later.

> **Confidence legend:** ✅ Verified from official docs (Microsoft Learn / vendor), 2026-05
> dated. ⚠️ Must validate in a live tenant. All Learn citations captured in the project log.

---

## 1. Verified facts that drive the design

| # | Fact | Conf |
|---|------|------|
| F1 | **Computer Use** tool (the AI driving an app on screen) is **GA** (OpenAI CUA, Claude Sonnet 4.5). Requires **Generative Orchestration** on the agent. | ✅ |
| F2 | **Windows 365 for Agents (W365A) Cloud PC pool** — where Computer Use runs — is **GA** (announced at Microsoft Build, 2026-06-02). (Was public preview through 2026-06-01.) | ✅ |
| F3 | To invoke a **published Copilot Studio agent** from a **custom, unattended (server-side)** app, the documented path was **Bot Framework Direct Line 3.0**. ⚠️ **Superseded for the CUA handoff (issue #112): Computer Use is NOT supported on classic Direct Line** — it runs only on `msteams`, `pva-engine-direct`, `pva-studio`, `pva-maker-evaluation`, `pva-autonomous`. The unattended orchestrator now uses **Direct-to-Engine** (`pva-engine-direct`) with an **Entra bearer token**. The **M365 Agents SDK** Copilot Studio client is delegated-user only (no app-only); if app-only is disallowed, inject a delegated token via `ENGINE_TOKEN`/`ENGINE_TOKEN_ENDPOINT`. | ✅ / ⚠️ |
| F4 | Structured context is passed by sending a custom **`pvaSetContext`** event activity (name + value JSON) as the first activity, into **Global variables** marked *"External sources can set values."* Optionally a `startConversation`/explicit trigger event. | ✅ |
| F5 | Direct Line auth: never expose the **secret** to the browser; server exchanges secret → **single-conversation token** (~1800 s, refreshable); `user.id` starts `dl_`, set `trustedOrigins`. | ✅ |
| F6 | Responses are received via **WebSocket stream** or **HTTP GET polling by watermark**. Computer Use is synchronous *within a turn* (can run minutes), streams intermediate reasoning + screenshots, and has **no proactive/webhook completion** — watermark polling is the only documented retrieval. | ✅ |
| F7 | **No Tier-1 CCaaS uses raw Direct Line in production.** Each has a native connector. **Dynamics 365 Contact Center has first-class, zero-code native Copilot Studio integration** via the **Omnichannel channel**; context arrives as **`msdyn_*`** variables; routing/hold-resume/timeline/wrap-up are native. | ✅ |
| F8 | No CCaaS blocks a live turn beyond ~8–15 s for a long task. Universal pattern: **collect → put caller on hold → async backend → re-inject result → resume.** | ✅ |

---

## 2. Core idea — a swappable **channel adapter** (also delivers the D365 future-swap)

Keep the **Copilot Studio agent + Computer Use logic + the structured result it returns**
identical and portable. Isolate everything CCaaS-specific behind a thin **channel adapter**.
Switching the CCaaS platform = swap the adapter/connector, **not** rebuild the AI.

```
   CCaaS layer            Channel adapter             AI (portable, unchanged)
 ┌──────────────┐      ┌────────────────────┐      ┌───────────────────────────┐
 │ Zava desktop │ ───▶ │ Direct Line adapter │ ──▶ │ Copilot Studio agent      │
 │  (today)     │      │ (our backend)       │     │  (Generative Orchestration)│
 └──────────────┘      └────────────────────┘     │        │                   │
 ┌──────────────┐      ┌────────────────────┐     │        ▼                   │
 │ Dynamics 365 │ ───▶ │ Omnichannel channel │ ──▶ │  Computer Use tool        │
 │ Contact Ctr  │      │ (native, no code)   │     │        │                   │
 │  (future)    │      └────────────────────┘     │        ▼                   │
 └──────────────┘                                  │  W365A Cloud PC ▶ claims.exe│
                                                   └───────────────────────────┘
```

The agent reads context from **neutral-named global variables**; each adapter populates them:

| Concept (neutral global var) | Zava adapter (Direct Line) | D365 CC adapter (native) |
|---|---|---|
| conversation/interaction id | our `correlation_id` | `msdyn_ConversationId` |
| customer / policy ref | `policy_number` in `pvaSetContext` | `msdyn_CustomerId` / case fields |
| customer name | `caller_name` | `msdyn_CustomerName` |
| caller phone | `caller_phone` | `Activity.From.Name` |
| intent / summary | `intent`, `summary` | survey / case fields |
| human agent identity | `agent_user_id`, `agent_display_name` | signed-in D365 agent |

One Copilot Studio agent can be connected to **both** channels simultaneously. Moving to D365
CC **replaces** most of Zava's custom plumbing (Direct Line backend, durable job store,
hold/resume/timeline UI) with D365 native capabilities — the AI is untouched.

---

## 3. Production-realistic flow (Zava adapter, hardened by design critique)

1. Human agent clicks **Hand off to AI** in Zava → `POST /api/handoff`.
2. Backend creates a **durable handoff job** (`handoff_id`) and returns it immediately.
   `POST` is **idempotent** on a business key (see §5) → retries return the same job.
3. A **durable worker** exchanges the Direct Line **secret → conversation token**, starts a
   conversation, sends **`pvaSetContext`** with the full context envelope (§5) **including the
   human agent identity + interaction context for audit**, then sends an **explicit trigger**
   event (not the auto-greeting).
4. The agent (Gen Orchestration ON) reads context into globals → invokes **Computer Use** on
   the **W365A pool** → resets/► drives `claims.exe` → files the FNOL → reads the claim ID off
   screen (validated, read twice) → returns a **structured completion** (§5).
5. The worker **polls Direct Line by watermark**, owns token refresh, and terminates **only**
   on an explicit structured success/error payload matching `correlation_id`, OR timeout, OR
   cancel — **never** on idle/silence.
6. Browser polls `GET /api/handoff/{handoff_id}/status` (our id — **not** Direct Line state).
   UI shows real states: `queued → working → succeeded | failed | timed_out`.
7. Zava re-injects the result: agent reviews the claim ID, resumes the call, claim ID + summary
   written to wrap-up/notes. (In D365 CC, these lifecycle steps are native.)

---

## 4. Hosting decision

**Move `/api` off SWA-managed Functions to a standalone Azure Functions app with Durable
Functions.** Keep the Zava UI on SWA. SWA-managed Functions cannot own a long-running handoff
(no Durable Functions, no timers/queues, no managed identity, ~45 s cap). Standalone Durable
Functions is the **least-effort credible** choice (vs ACA + queue + Cosmos, which is more
production-like but stage-risky for a live demo).

- Direct Line **secret** in **Key Vault**, accessed via **managed identity**. Never sent to the
  browser. Token refreshed by the worker at ~T-5 min; on 401 refresh once.
- Durable job state persists: `handoff_id, correlation_id, conversation_id, token_expiry,
  watermark, status, claim_id, error_code, agent_user_id, interaction_id, timestamps`.
- Persist watermark **only after** activities are durably processed; dedupe by `activity.id`.

---

## 5. Data contracts

**Context envelope (Zava → agent via `pvaSetContext`):**
```json
{
  "correlation_id": "...", "tenant_id": "...", "source_system": "Zava",
  "interaction_id": "...", "call_id": "...", "queue_id": "...",
  "agent_user_id": "...", "agent_display_name": "...",
  "customer_id": "...", "caller_name": "...", "caller_phone": "...",
  "policy_number": "POL-...", "intent": "auto_collision", "summary": "...",
  "consent_disclosure": true, "requested_at": "2026-06-02T13:00:00Z"
}
```

**Structured completion (agent → backend) — preferred: a typed Power Automate flow / custom
connector the agent calls as its final step (do NOT regex free chat text):**
```json
{ "handoff_id": "...", "correlation_id": "...", "status": "succeeded",
  "claim_id": "CLM-2026-000123", "legacy_system": "claims.exe", "confidence": 0.97 }
```
**Error shape:**
```json
{ "handoff_id": "...", "correlation_id": "...", "status": "error",
  "error_code": "LEGACY_APP_VALIDATION_FAILED", "recoverable": true, "message": "..." }
```
Demo-speed fallback only: a sentinel-wrapped JSON block in the bot message
(`HANDOFF_RESULT_JSON: {...} END_HANDOFF_RESULT_JSON`), parsed with strict `correlation_id`
match. ⚠️ Validate in-tenant whether Copilot Studio can emit outbound event activities; the
typed-action/flow callback is the safer canonical path.

---

## 6. Exactly-once / idempotency (blocking realism point)

Backend idempotency alone can't guarantee one claim — the legacy app must participate.
- Idempotency key: `tenant_id + interaction_id + policy_ref + loss_timestamp + loss_type`.
- `POST /handoff` with the same key returns the existing `handoff_id`; worker dedupes final
  activities by `activity.id`.
- The agent performs a **pre-create duplicate check** in `claims.exe` (search by policy + loss
  date + claimant, or a visible external-reference field) before filing.
- **Human review** is the final duplicate guard. Do **not** claim "exactly once" unless
  `claims.exe` enforces it.

---

## 7. Build vs narrate (don't gold-plate a demo)

**MUST-BUILD (credibility / avoid on-stage failure):** standalone Durable Functions backend;
durable job state; server-side secret in Key Vault (no browser exposure); explicit status UI
(queued/working/succeeded/failed/timed_out); structured result path; idempotent `POST /handoff`;
timeout + human fallback; pre-demo app reset/health check; claim-id validation (read twice /
format); **W365A GA-region confirmation note**.

**NARRATE-ONLY (say it's the production design; don't build for the demo):** full audit pipeline
+ screenshot retention; secret rotation; multi-region; advanced pool-capacity mgmt; legacy-app
-side dedupe; full D365 native-channel implementation; admin dashboards; auto supervision routing.

**The money shot** = the AI visibly driving `claims.exe` and returning a real claim ID.
Plumbing must be credible but not the star; on stage, reliability beats completeness.

---

## 8. Honest disclosure + risk register

| Risk | Disclosure / mitigation |
|---|---|
| W365A substrate maturity | **Resolved — no caveat.** Computer Use is GA and the W365A execution substrate is GA (announced at Microsoft Build, 2026-06-02). Both layers are production-supported. |
| Custom Direct Line vs Tier-1 native | Position Direct Line as **Zava's custom-app adapter**; show the D365 Omnichannel native path as the Tier-1 form (same agent). |
| Long CUA run vs serverless | Durable Functions worker + watermark polling + token refresh; caller "on hold" model. |
| Free-text claim id | Typed completion contract; regex fallback only. |
| Pool exhaustion | Visible `queued` state + queue timeout (2–5 min) vs execution timeout (10–15 min); pre-warm capacity before a live demo. |

---

## 9. Open live-tenant validations (⚠️ cannot confirm from docs)

1. Computer Use behaves identically over Direct Line as in the Test pane.
2. Copilot Studio can emit the outbound event/structured activity (else use typed flow callback).
3. "Clean Cloud PC session per job" — confirm the reset/sign-out/app-restart strategy.
4. Human-supervision pause surfaces a detectable state (else rely on timeout).
5. W365A pool created via Copilot Studio is selectable + bills as expected (existing items #1–#4
   in the project log).

---

## 10. Proposed decisions (for the project log)

- **D12** — Invocation mechanism = **Direct Line 3.0**, server-side token exchange (custom-app
  adapter). Agents SDK rejected for the unattended seam (no service-principal support).
  ⚠️ **Superseded by D19** for the CUA handoff.
- **D13** — **Channel-adapter** architecture; agent + CUA + result contract are portable.
  **D365 Contact Center** is the future swap via its **native Omnichannel channel** (no agent
  rebuild). Agent reads neutral global vars populated per-adapter.
- **D14** — Backend = **standalone Azure Functions + Durable Functions** (off SWA-managed
  Functions); secret in Key Vault via managed identity; durable job state; browser polls our
  `handoff_id`.
- **D15** — Result via **typed completion contract** (flow/custom connector); sentinel-JSON
  fallback; never trust free-text parsing.
- **D16** — **Idempotent** handoff + agent-side pre-create duplicate check + human review.
- **D17** — **W365A is GA (announced at Build, 2026-06-02); Computer Use GA.** Both layers
  production-supported. Build the credible core, narrate the rest.
- **D18** — **D365 Contact Center demo licensing — DEFERRED.** When the CCaaS app is swapped for
  Dynamics 365 Contact Center, the demo channel will be **digital chat (no voice)**: live PSTN is
  impractical/fragile on stage (trial numbers, ~60 free minutes, "someone has to call in"),
  whereas a browser chat widget is zero-dependency and fully repeatable, and still shows the real
  path (live chat -> human agent in the Omnichannel desktop -> native Copilot Studio handoff ->
  CUA files the FNOL -> claim ID returns in-conversation).
  - **Decision (2026-06-02): wait for the standalone *Dynamics 365 Contact Center* SKU to appear
    in the internal demo-licensing catalog rather than demo on the older packaging.** As of
    2026-06-02 the Contact Center SKUs are **not** in this internal catalog; only the predecessor
    combo is available (**Customer Service Enterprise Edition** + **Customer Service Digital
    Messaging add-on**, plus the **Customer Engagement Applications for Demo Trial** umbrella),
    which delivers the same Omnichannel digital-chat + Copilot Studio handoff. That combo is a
    viable fallback, but the user prefers not to demo an older product, so the D365 CC variant is
    **on hold** until the Contact Center SKU is requestable via the internal demo-licensing
    catalog. Re-check periodically.
  - **No blocker to the core demo:** the current simulated CCaaS app already shows the end-to-end
    handoff; the D365 CC swap is an enhancement, not a dependency.
  - **12-month demo environment (when unblocked):** the public trial is 30 days (+30 extend) only,
    so use an internal route — a fresh internal Microsoft demo-tenant
    (~12-month lifespan), or add the demo-use licenses via the internal demo-licensing catalog to
    the existing tenant where W365A + the orchestrator already work. In the D365 variant the
    orchestrator/Direct Line plumbing is largely replaced by the native Omnichannel channel (see D13).
- **D19** — **Invocation channel = Direct-to-Engine (`pva-engine-direct`), not classic Direct
  Line (issue #112).** Computer Use only runs on `msteams`, `pva-engine-direct`, `pva-studio`,
  `pva-maker-evaluation`, `pva-autonomous`; classic Direct Line (`directline`) is NOT supported, so
  the Direct Line adapter reaches the Cloud PC but the tool never executes. The orchestrator
  invokes the agent over Copilot Studio's Direct-to-Engine conversations API
  (`engineDirectAdapter.js`, `HANDOFF_CHANNEL=engine`), authenticating with an **Entra bearer
  token** (app-only client credentials, or an injected delegated token via
  `ENGINE_TOKEN`/`ENGINE_TOKEN_ENDPOINT` when app-only is disallowed). The channel-adapter seam
  (D13) made this a contained swap: the agent, CUA logic, `pvaSetContext`+NL-trigger contract, and
  result callback are all unchanged. Classic Direct Line stays selectable for non-CUA testing.
  ⚠️ The exact `ENGINE_CONVERSATIONS_URL` host/path and the working auth mode are validated live
  in-tenant (Scout lane); the repo wires both auth modes so no code change is needed to pick one.
