# Foundry / Copilot Studio agent assets

This folder will be populated by the coding agent that builds the legacy
claims workstation per
[`../../PROMPT.md`](../../PROMPT.md).

It contains the **agent-side** assets that turn an Azure AI Foundry agent
(or Copilot Studio agent) with Computer Use into a working driver for the
Zava Mutual Claims Workstation.

**How the agent gets its data — and how it drives the app.** The handoff arrives
as the **agent's run message** (the call-context JSON shown in
`sample-call-context.json`), posted by Agent365 / the CCaaS `/api/handoff`
endpoint. From there the agent uses **only the Computer Use tool** plus the
single `launch_claims_app` shell tool: it launches the legacy app and then drives
it **entirely on screen** with mouse and keyboard, reading the resulting claim ID
off the confirmation dialog / clipboard. There is no shared file, folder, or
import path with the legacy app — that is the whole point of the demo.

## What lives here

The agent guidance is split into three files to optimize token usage —
Knowledge is retrieved on demand, Instructions are always in context. This
pattern is borrowed from [t3blake/cobol-banker-demo](https://github.com/t3blake/cobol-banker-demo).

| File | Where it goes in Foundry / Copilot Studio | Why |
|---|---|---|
| [`KNOWLEDGE.md`](./KNOWLEDGE.md) | Uploaded as a **Knowledge** file | Hero records, control IDs, status codes, FNOL wizard field semantics — searched on demand |
| [`AGENT-INSTRUCTIONS.md`](./AGENT-INSTRUCTIONS.md) | Pasted into **Agent Instructions** | Persona, objective, decision framework, communication style with the upstream voicebot — always in context |
| [`CUA-TOOL-INSTRUCTIONS.md`](./CUA-TOOL-INSTRUCTIONS.md) | Pasted into **CUA Tool Instructions** | UI navigation with stable control IDs, modal recovery, error-code handling — always in context |
| [`tools/launch-claims-app.json`](./tools/launch-claims-app.json) | Foundry tool definition | Shell tool that launches `claims.exe` with the unattended demo flags (no data args) |
| [`sample-call-context.json`](./sample-call-context.json) | Reference | Example handoff payload Agent365 / the CCaaS `/api/handoff` endpoint delivers as the agent's run message |
| [`evaluations/evaluation-1-smoke.csv`](./evaluations/evaluation-1-smoke.csv) | Foundry / Copilot Studio **Evaluation** import | 5 smoke tests — launch, login, lookup, policy detail |
| [`evaluations/evaluation-2-readonly.csv`](./evaluations/evaluation-2-readonly.csv) | Foundry / Copilot Studio **Evaluation** import | 7 read-only tests |
| [`evaluations/evaluation-3-write.csv`](./evaluations/evaluation-3-write.csv) | Foundry / Copilot Studio **Evaluation** import | 7 FNOL submission tests for 4 loss types |
| [`evaluations/evaluation-4-compound.csv`](./evaluations/evaluation-4-compound.csv) | Foundry / Copilot Studio **Evaluation** import | 4 multi-step compound and guardrail tests |
| `README.md` | (this file) | Setup steps, model recommendations, demo-day tips |

## Setup steps

Once the files exist, the full setup is documented in the top-level
[`README.md`](../../../../README.md), Step 5 ("Create the AI Agent").
Key reminders:

- **Model:** Claude Sonnet 4.5 / 4.6 or GPT-4.1 (fast vision, strong
  instruction-following). Avoid reasoning-class models — they add latency
  with no benefit for UI navigation.
- **Disable web search** on the agent.
- **Refresh the Windows 365 / CUA connection** in agent platform
  Settings → Connections before every demo. The token expires when the
  Cloud PC session disconnects or restarts.
