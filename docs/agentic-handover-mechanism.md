# CCaaS → Agentic AI handover: the mechanism (partner-technical reference)

> **⚠️ Superseded for the invocation mechanism (2026-06-02).** The current, verified design
> (Copilot Studio + Direct Line custom adapter, Computer Use on W365A, channel-adapter boundary
> for a future Dynamics 365 Contact Center swap, Durable Functions backend) lives in
> **`docs/handoff-architecture-decision.md`**. The
> Tier-1 CCaaS pattern survey below remains valid background; references to Foundry as the
> invocation path are historical.

**Audience:** Agent Builder partners and solution architects evaluating how this
demo's contact-center → AI handover compares to real Tier-1 CCaaS platforms, and
how it lands on the Microsoft Agent platform (Azure AI Foundry Agent Service,
Copilot Studio, Agent365).

**Why this doc exists:** the demo must hand a live interaction to an agentic AI
using *the same mechanism real CCaaS platforms use* — not a bespoke shortcut — so
the conversation with partners holds up technically. This doc states that
mechanism, grades the confidence of every claim, and maps it onto Microsoft.

> **Confidence legend.** ✅ **Verified** = read directly from the vendor's live
> documentation (URL cited). ⚠️ **Inferred** = from prior platform knowledge; the
> vendor's developer portal is a JavaScript single-page app that returned no
> server-rendered content and could not be fetched. ❌ **Not found** = searched,
> not documented. **Treat ⚠️ rows as "validate with the vendor before quoting to a
> customer."**

---

## 1. The canonical mechanism (the one the demo emulates)

Across the three platforms whose documentation is directly verifiable (Amazon
Connect, Twilio, Microsoft), the CCaaS → agentic-AI handover follows **a common
architectural pattern** (the underlying invocation differs — Connect Lambda is a
synchronous in-flow invoke, Twilio assigns a task/reservation, D365/Copilot
escalates through an engagement hub — so these are *analogous*, not identical):

> **A structured JSON/key-value context envelope is delivered over an HTTP/event
> API to *start an AI agent session*; the agent acts; a *result event* (JSON) is
> returned to the CCaaS platform, which then routes, updates context, or closes the
> interaction.**

High confidence in this pattern is limited to Amazon Connect, Twilio, and
Microsoft (verified docs). The other three platforms are consistent with it but
inferred.

Five invariants hold on every verified platform:

1. **A flow/routing trigger** decides "this interaction goes to the AI now"
   (a flow block, a router workflow match, or a workstream routing rule) — it is
   modelled as a **transfer/route action**, never a button literally labelled
   "send to AI".
2. **Context travels as a key-value bag** (JSON object or string map). Values are
   predominantly **flat strings**; nesting is limited or discouraged.
3. **Transport is HTTPS** — an outbound webhook POST, an SDK invoke, or a Bot
   Framework Direct Line activity.
4. **The agent returns a result** carrying *new* context it produced plus a
   **next-action / disposition** signal (continue, escalate-to-human, end).
5. **The human never sees raw JSON.** The context is rendered as labeled field
   rows (attribute bar / "additional details" card). JSON is the wire format only.

This is exactly what the demo does: `CallContext` (JSON) -> SWA-hosted `/api`
(HTTPS) -> Foundry agent run -> result event back -> status surfaced in the
desktop. The old local orchestrator is now only an optional/legacy local-testing
path. See §4.

---

## 2. Per-platform evidence

### Amazon Connect — ✅ Verified

- **Trigger:** the `Get customer input` flow block (Flow Language action
  `ConnectParticipantWithLexBot`) runs an Amazon Lex V2 bot inline and **branches
  on the returned intent name**; an `Invoke AWS Lambda function` block
  (`InvokeExternalResource`) calls any external AI/LLM/orchestrator; `Transfer to
  queue` (`TransferContactToQueue`) routes to a human.
  ✅ `docs.aws.amazon.com/connect/latest/adminguide/get-customer-input.html`,
  `.../amazon-lex.html`, `.../invoke-lambda-function-block.html`,
  `.../transfer-to-queue.html`
- **Context format:** `Details.ContactData.Attributes` is a **flat
  `map<string,string>`** (≤32 KB); Lex receives `sessionState.sessionAttributes`
  (string→string). A Lambda configured for `STRING_MAP` must return a flat
  key-value map; with JSON response validation it may return nested JSON, but flow
  references and `Set contact attributes` storage of nested/array values are
  constrained.
  ✅ `.../connect-lambda-functions.html`,
  `docs.aws.amazon.com/lexv2/latest/dg/context-mgmt-session-attribs.html`
- **Transport:** AWS SDK over HTTPS (`RecognizeText`/`RecognizeUtterance`,
  `lambda:InvokeFunction`); Connect calls these internally.
- **Return / escalate-back:** Lex returns intent + slots + updated session
  attributes; Lambda returns `$.External.*`; `Set contact attributes` → `Transfer
  to queue` carries everything to the human, rendered in the agent **AttributeBar**.
- **Standards:** Q in Connect / agentic mode is built on Amazon Bedrock
  (✅ `.../connect-ai-agent.html`). No Bot Framework / Direct Line / MCP / A2A (❌).

### Twilio (Flex / TaskRouter / Studio) — ✅ Verified

- **Trigger:** a **TaskRouter Workflow** evaluates filter expressions against task
  `attributes` and places the task on a Queue; to send straight to an AI worker,
  set the task's `routingTarget` to the bot Worker SID with `ignoreCapacity=true`.
  A Studio flow can be started via `POST /v2/Flows/{FlowSid}/Executions`.
  ✅ `twilio.com/docs/taskrouter/api/workflow`, `.../api/task#task-properties`,
  `twilio.com/docs/studio/rest-api/v2/execution`
- **Context format:** task `attributes` is an **explicit serialized JSON string**
  (the most developer-transparent format of any platform), e.g.
  `{"type":"call","contact":"+15558675309","customer-value":"gold","callSid":"CA…"}`.
  ✅ `twilio.com/docs/taskrouter/api/task#task-attributes`
- **Transport:** TaskRouter POSTs an **AssignmentCallback** (HTTP webhook) to your
  AI bot's server with `TaskAttributes`, `WorkerAttributes`, `TaskSid`,
  `ReservationSid`, etc. ✅ `twilio.com/docs/taskrouter/handle-assignment-callbacks`
- **Return / escalate-back:** the bot may reply within 5 s with a JSON instruction
  (`{"instruction":"accept"|"reject"|"dequeue"|"call"…}`), **or** respond `200 OK`
  and accept/reject the reservation asynchronously via the REST API. To update
  context + status it issues **two** `PATCH /Tasks/{Sid}` calls (attributes, then
  assignmentStatus → `wrapping`/`completed`). Escalation = new task / updated
  `routingTarget` to a human queue; Flex renders `attributes` in the TaskInfoPanel.
- **Standards:** Twilio-proprietary. No Bot Framework / MCP / A2A (❌).

### Microsoft — Dynamics 365 Contact Center + Copilot Studio — ✅ Verified

*(This is the demo's target platform family.)*

- **Trigger:** a Copilot Studio agent is added to a **push-based workstream**; to
  escalate it adds a **"Transfer conversation"** node to the *Escalate* system
  topic (and sets `CloseOmnichannelConversation=true`). Azure Bot Framework bots
  call `OmnichannelAgentClient.EscalateConversationAsync()` sending an Activity
  with `CommandType.Escalate`.
  ✅ `learn.microsoft.com/dynamics365/customer-service/administer/configure-bot-virtual-agent`,
  `learn.microsoft.com/power-virtual-agents/advanced-hand-off`,
  `learn.microsoft.com/dynamics365/customer-service/develop/bot-escalate-end-conversation`
- **Context format:** Copilot Studio passes **named context variables** at
  transfer — `va_Scope`, `va_LastTopic`, `va_Topics`, `va_LastPhrases`,
  `va_Phrases`, `va_ConversationId`, `va_BotId`, `va_Language`, `va_AgentMessage`,
  plus all user-defined topic variables (note `va_Topics`/`va_Phrases` are
  **arrays**, so Copilot Studio handoff values are not all flat strings). The
  **String-or-Integer-only** value constraint applies specifically to the **Azure
  Bot Framework** escalation `Dictionary<string,object>` context vars, not to every
  Copilot Studio default variable.
  ✅ `learn.microsoft.com/power-virtual-agents/advanced-hand-off`
- **Transport:** **Bot Framework Direct Line 3.0** over HTTPS + WebSocket
  (`*.directline.botframework.com`) is the channel used by Bot Framework bots and
  by custom clients/channels. (For out-of-the-box **D365 Contact Center** handoff
  the partner-visible mechanism is workstream routing + the *Transfer
  conversation*/*Escalate* node, not a hand-written `POST
  /v3/directline/conversations` — Direct Line is the underlying transport, not the
  configuration surface.) Conversation start:
  `POST https://directline.botframework.com/v3/directline/conversations`;
  activities flow as `ActivitySet` JSON over the `streamUrl` WebSocket (or HTTP GET
  polling). Channel-data message limit 28 KB.
  ✅ `learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-direct-line-3-0-start-conversation`,
  `.../bot-framework-rest-direct-line-3-0-receive-activities`,
  `learn.microsoft.com/power-virtual-agents/requirements-quotas`
- **Return / escalate-back:** the bot sends the `Escalate` Activity; Omnichannel
  routing rules fire on the context-variable values; the human rep sees the **full
  bot transcript** in the "Self service" tab and the context vars as labeled fields
  in the **"Additional details"** tab — **not raw JSON**.
- **Standards:** ✅ **Bot Framework / Direct Line 3.0 is the documented protocol.**
  MCP and A2A are ❌ not found in D365 Contact Center docs (as of this research).

### Genesys Cloud — ⚠️ Inferred

Developer portal (`developer.genesys.cloud`) is SPA-rendered; not fetchable.
- **Trigger:** Architect actions `Call Dialog Engine Bot Flow`, `Call Lex Bot`,
  `Call Digital Bot Flow`, **Bot Connector** (external bot webhook), then `Transfer
  to ACD` to a human. **Audiohook** streams audio to external AI over WebSocket.
- **Context:** participant data `map<string,string>` via
  `PATCH /api/v2/conversations/{id}/participants/{participantId}`; Bot Connector
  exchanges `BotTurnRequest`/`BotTurnResponse` JSON with `nextAction` =
  `MoreData`/`Disconnect`/`TransferToAcd`.
- **Standards:** proprietary Bot Connector; no Bot Framework / MCP / A2A documented.
- ⚠️ **Validate against Genesys AppFoundry / authenticated developer docs.**

### Salesforce Agentforce for Service — ⚠️ Inferred

`developer.salesforce.com` / `help.salesforce.com` returned empty SPA shells.
- **Trigger:** Omni-Channel routes work items to an Agentforce Service Agent like a
  human; Agent Builder **Topics + Actions** define scope; an **Escalate** action
  routes to a human queue when unresolved.
- **Context:** strongly-typed **Salesforce Flow variables** + record objects
  (`VoiceCall`, `MessagingSession`, `ConversationEntry`) — **not a raw JSON blob**;
  an AI **Conversation Summary** is surfaced as a card.
- **Standards:** proprietary. Agentforce **MCP** support was announced publicly in
  2025 — ⚠️ from industry announcements, not verified from fetched docs. A2A ❌.
- ⚠️ **Validate against Salesforce Partner Community docs.**

### NICE CXone — ⚠️ Inferred (lowest confidence)

`help.niceincontact.com` / `developer.niceincontact.com` unreachable / 404.
- **Trigger:** CXone Studio `VirtualAgent` action → **Virtual Agent Hub** (connects
  Google CCAI, Amazon Lex, **Azure Bot Framework**, or custom REST bots); `ROUTE` /
  `REQAGENT` send to an ACD skill.
- **Context:** Studio named string variables (`ASSIGN`); per-provider JSON to the
  bot; result in `VirtualAgentResult` (intent/slots).
- **Standards:** Virtual Agent Hub can connect **Azure Bot Framework** bots (so a
  Copilot Studio bot can be wired in); otherwise proprietary; no MCP/A2A documented.
- ⚠️ **Validate against NICE's authenticated developer portal.**

### Verified-vs-inferred summary

| Platform | Trigger | Payload | Transport | Return | Standards |
|---|---|---|---|---|---|
| Amazon Connect | ✅ | ✅ | ✅ | ✅ | ✅/❌ |
| Twilio Flex/TaskRouter | ✅ | ✅ | ✅ | ✅ | ❌ |
| Microsoft D365 + Copilot | ✅ | ✅ | ✅ | ✅ | ✅ |
| Genesys Cloud | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| Salesforce Agentforce | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| NICE CXone | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |

---

## 3. Is JSON the right representation? — Yes, on the wire; never to the human

| Platform | Backend wire format | What the human agent sees |
|---|---|---|
| Amazon Connect | flat string contact attributes | **AttributeBar** labeled rows |
| Twilio Flex | task `attributes` JSON **string** | TaskInfoPanel labeled fields |
| Microsoft D365 | typed context variables (String/Int) | **"Additional details"** card + transcript tab |
| Genesys ⚠️ | participant data `map<string,string>` | Script-panel rendered fields |
| Salesforce ⚠️ | Flow variables + record fields | record layout + AI summary card |
| NICE ⚠️ | Studio named string vars | MAX contact card fields |

**Verdict (✅ verified for 3/6, consistent on the other 3): in the verified
platforms, production agent UIs render selected context as labeled fields rather
than exposing the raw transport JSON.** JSON/string-map is the *transport*.
Therefore the demo:

- keeps **JSON as the wire contract** (defensible: Twilio task attributes *are* a
  JSON string; Connect attributes are a string map; D365 vars are typed),
- renders the handover context to the human as a **labeled "Handover context"
  card** (an AttributeBar / "Additional details" analog), and
- exposes a **collapsible "View payload (JSON)" developer disclosure** — for
  partner/technical conversations only, mirroring how a developer would inspect the
  wire payload in the platform's API tooling.

### Is JSON *really* realistic? — fidelity notes for agent builders

Agent builders push on this, so be precise:

1. **JSON is correct as the transport** — every verified platform uses it, and so
   does Microsoft (Foundry Agent Service thread *messages* and Bot Framework
   *activities* are JSON over REST). ✅
2. **But "JSON" ≠ "ad-hoc blob."** The credible pattern is a **structured,
   schema-validated contract** — which is why the demo uses
   `call-context.schema.json` with `additionalProperties:false`. That is the part
   to copy.
3. **Keep values flat / primitive.** Connect attributes are a `map<string,string>`;
   Bot Framework escalation context vars are **String/Integer-only**. Deeply nested
   JSON can break real targets — design to the lowest common denominator.
4. **Not every platform exposes a single blob.** Salesforce passes **strongly-typed
   Flow variables + record objects**, not a raw JSON document, even though its
   REST/Agentforce APIs still speak JSON. "Structured context" is the invariant;
   "one JSON object" is one common realization of it.

---

## 4. Mapping to the Microsoft Agent platform

The demo hands over to Microsoft using the **same canonical mechanism**, realized
two ways that partners actually ship:

### Path A (the demo's primary path) — SWA `/api` + Azure AI Foundry Agent Service

✅ Verified mechanism
(`learn.microsoft.com/azure/ai-foundry/agents/concepts/threads-runs-messages`).
The deployed handoff entry point is the managed Functions API hosted by the same
Azure Static Web App as the CCaaS desktop; `apps\ccaas-agent-desktop\api\` is the
source of truth for settings and endpoint behavior:

1. **Create / reuse an agent** (instructions + tools). Legacy-app automation uses
   the **Computer Use** tool (`computer-use-preview` model), which adds its own
   **screenshot → action → screenshot** feedback loop (`computer_call` /
   `computer_call_output`) on top of the run —
   ✅ `learn.microsoft.com/azure/ai-foundry/agents/how-to/tools/computer-use`.
2. **Create a thread** (the conversation session).
3. `POST /api/handoff` adds a message carrying the **JSON context envelope**
   (the `CallContext`).
4. The SWA `/api` creates a run — the agent processes the thread and drives the
   legacy app via the Computer Use loop.
5. The desktop polls `/api/handoff/{requestId}/status` with the returned
   `thread_id` and `run_id` and reads the result.

Foundry agents use the **threads → messages → runs** model for execution; Computer
Use introduces the additional screenshot/action loop within it. The demo maps its
orchestration status onto these concepts — note the demo statuses are
**application-level states**, not all 1:1 native Foundry run states:

| Foundry run status | Demo `HandoffStatus` (app-level) | Meaning in the demo |
|---|---|---|
| `queued` | `queued` | handover accepted, agent not started |
| `in_progress` | `prefilled` | agent is filling the legacy FNOL via CUA |
| `requires_action` (native: agent needs tool/function-call output) | surfaced under `prefilled`; app raises `ready` as its own checkpoint | agent is mid-loop; demo `ready` = app-level "filled, awaiting submit/monitor" |
| `completed` | `submitted` | claim created; claim ID returned |
| `failed` / `expired` | `error` | run failed or timed out; error code surfaced |
| `cancelled` | (human "take back control") | human reclaims the task |

**Important:** native `requires_action` means the run is waiting for
**tool/function-call results**, *not* "ready for human confirmation." The demo's
`ready` is an application-level checkpoint raised by the demo API/UI layer, not a
native Foundry status — don't represent them as equivalent to a partner.

### Path B (alternative partners will recognize) — Copilot Studio + Direct Line

For a bot-first contact center, the equivalent is a Copilot Studio agent reached
over **Direct Line 3.0**, with context passed as **conversation variables /
`ChannelData`** and escalation via the **"Transfer conversation"** node
(✅ verified, §2 Microsoft). The same JSON context maps onto Direct Line activity
`value` / `channelData`.

### Identity & audit — Agent365 / Entra Agent ID (recommended governance target)

As a **production governance target**, the AI agent should run under an
**Agent365 / Entra Agent ID** so the handover is an authenticated, auditable actor
(the `requested_by` human agent + the AI agent identity both appear in the audit
trail). The Computer Use connection to the Windows 365 Cloud PC is a managed
connection that must be refreshed per session (see `demo-flow.md` setup checklist).
Whether the demo enforces this identity model depends on the configured Agent365
environment; treat it as the recommended pattern rather than an implemented
guarantee.

### Standards trajectory — MCP (tools) vs A2A (handover) [today → near future]

Partners frequently ask "do they hand over via **MCP**?" The precise answer
distinguishes two different protocols — getting this right is a credibility marker:

| | **MCP** (Model Context Protocol) | **A2A** (Agent2Agent) |
|---|---|---|
| Connects | agent → **tools / data / APIs** ("USB-C for AI") | agent → **agent** |
| Purpose | tool invocation, context/resource access | **handoff**, delegation, task ownership transfer, status |
| Relevance to handover | what the receiving agent uses to **do the work** | the **handover** itself |
| Microsoft support | **GA in Copilot Studio** (Build 2025); **GA in Azure AI Foundry Agent Service** | **GA in Azure AI Foundry Agent Service** (GA Mar 16, 2026) & Copilot Studio — open protocol with Google et al. (announced May 2025, preview late 2025, GA 2026) |

So: **handover is an A2A concern; MCP is for the agent's tool access.** They are
complementary, not alternatives.

**A2A roles — the CCaaS app is the *client*, not a peer agent.** A2A defines a
**User**, an **A2A Client** ("an application, service, or another AI agent that acts
on behalf of the user") and an **A2A Server / remote agent** (the AI that does the
work). Crucially the **client need not itself be an AI agent** — a human-operated
application qualifies. So a CCaaS agent desktop handing over to an AI is **app →
remote-agent** delegation via the A2A client role; it only becomes literal
"agent-to-agent" once the CCaaS *assist* layer is itself an autonomous agent. (Source:
A2A spec, "Core Actors" — a2a-protocol.org.)

**Do CCaaS vendors use these for handover today?** (current, 2025 — ⚠️ fast-moving,
re-verify before quoting):

- **Salesforce Agentforce 3** (Jul 2025) — **natively supports MCP**, positioning
  Agentforce as an "AI agent gateway." This is primarily **tool/data
  interoperability**, not the call-transfer gesture itself.
- **Avaya Infinity** — explicitly markets **MCP for context preservation across
  handoffs** (the closest vendor claim to "MCP for handover").
- **Amazon Connect, Twilio, Genesys, NICE, D365 Contact Center** — **no native
  MCP-for-handover today**; still proprietary routing/APIs, with MCP-for-tools
  adoption underway. **A2A-for-handover is emerging, not yet the production
  default** at these vendors.

**What this means for the demo (today vs. tomorrow):**

- **Today (implemented):** the handover is a **transfer/route gesture carrying a
  structured JSON `CallContext`** — exactly the proprietary-equivalent model real
  platforms ship now. The UI frames the workspace as the **A2A client** handing to a
  **remote agent**, naming the trajectory honestly without claiming the CCaaS side
  already emits an A2A wire.
- **Tomorrow (recommended target):** carry the same structured context as an **A2A
  Task message** with this workspace as the **A2A client** and the Microsoft agent as
  the **A2A remote agent** — and have that agent reach systems-of-record via **MCP
  tools**. The receiving side is **available today**: A2A is **GA in Azure AI Foundry
  Agent Service (Mar 2026)** and Copilot Studio, governed by an **Entra Agent ID**.
  The remaining gap is the **CCaaS-vendor (client) side** emitting A2A, which is still
  emerging at Connect/Twilio/Genesys/NICE/D365.
- **Why CUA still matters:** the **legacy claims app has no API/MCP surface**, so the
  agent must drive its GUI via **Computer Use**. "MCP where an API exists; CUA where
  it doesn't" is itself a compelling partner narrative.

> Honest caveat: "MCP-for-handover" today is essentially an Avaya positioning plus
> Salesforce's tool-interop play. The rigorous statement is **handover → A2A (GA on
> Microsoft rails; still emerging on the CCaaS-vendor client side); tool access → MCP
> (GA on Microsoft)**.

---

## 5. The recommended production handover envelope

The demo currently ships a deliberately **minimal** wire contract
(`schemas/call-context.schema.json`, `additionalProperties:false`) so the
end-to-end legacy-app integration stays simple. For **production / partner
architecture discussions**, the envelope below is the recommended target. Every
field is justified by a verified platform precedent:

```json
{
  "request_id": "REQ-2024-0042",
  "interaction_id": "4a573372-1f28-4e26-b97b-XXXX",
  "channel": "voice",
  "direction": "inbound",
  "queue": "Auto Claims",
  "caller_phone": "(555) 123-4567",
  "language": "en-US",
  "ivr_intent": "auto_collision",
  "policy_number": "POL-2024-008341",
  "bot_handled": false,
  "handoff_reason": "agent_initiated_fnol",
  "sentiment": "neutral",
  "prior_attempts": 0,
  "summary": "Rear-ended at 5th and Main, no injuries, both vehicles drivable.",
  "transcript_excerpt": "Caller: ...stopped at the light and a Civic rear-ended me...",
  "requested_by": { "agent_id": "csr-acarter", "display_name": "A. Carter" },
  "timestamp": "2024-04-15T18:32:11Z"
}
```

| Field | Precedent |
|---|---|
| `interaction_id` | Connect `ContactId`; Twilio `callSid`/`TaskSid`; D365 `va_ConversationId` |
| `channel` / `direction` | Connect `Channel` / `InitiationMethod` |
| `queue` | Connect `Queue.Name`; Twilio `TaskQueueSid`; D365 workstream |
| `language` | Connect `LanguageCode`; D365 `va_Language` |
| `ivr_intent` | Connect Lex intent; Twilio `task-reason`; D365 `va_LastTopic` |
| `bot_handled` / `handoff_reason` | Connect/Twilio/D365 escalation reason |
| `sentiment`, `prior_attempts` | common enrichment attributes (string-valued) |
| `summary` / `transcript_excerpt` | D365 `va_*Phrases` + transcript tab |
| `requested_by` | the initiating human agent identity (audit) |

**Migration note.** Adding these fields means updating the shared
`schemas/*.json`, the SWA `/api` contract in `apps\ccaas-agent-desktop\api\`, and
the desktop/test fixtures. Values should stay **flat and string-valued** to remain
portable to Connect's string-map and D365's String/Integer context-variable
constraints. Until then, the demo passes the minimal contract and *renders* the
richer context from in-app interaction metadata. The agent-to-legacy-app seam
remains on-screen Computer Use only, not a file handoff.

---

## 6. What a partner should take away

1. The demo hands over **the way real platforms do**: a JSON context envelope over
   HTTPS that **starts an agent run**, with a **result event** back and a
   **status lifecycle** in between.
2. The demo's status lifecycle **maps onto the Azure AI Foundry Agent Service run
   model** (threads/messages/runs), and the legacy-app automation is the
   **Computer Use** tool — both first-party Microsoft. (Demo statuses are
   application-level labels, not 1:1 native run states — see §4.)
3. **JSON is the wire format, not the agent-facing UI.** The human sees a rendered
   context card; the JSON is available behind a developer disclosure.
4. Confidence is **high (verified docs)** for Amazon Connect, Twilio, and Microsoft;
   **Genesys / Salesforce / NICE specifics are inferred** and flagged for vendor
   validation before being quoted to a customer.
5. **Protocol trajectory:** handover maps to **A2A** (with the CCaaS desktop as the
   A2A **client** and the AI as the **remote agent** — A2A clients need not be agents),
   while **MCP** is for the agent's **tool/data access**. On Microsoft both are now
   first-party and **GA** (Copilot Studio MCP GA; **A2A GA in Azure AI Foundry Agent
   Service, Mar 2026**). The receiving side can therefore be a real A2A remote agent
   today; the still-emerging piece is the **CCaaS-vendor client side** emitting A2A, so
   the demo ships today's structured-JSON-over-transfer model framed as the A2A
   client→remote-agent path. (See §4.)
