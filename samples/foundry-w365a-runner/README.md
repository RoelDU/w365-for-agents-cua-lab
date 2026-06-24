# Foundry + Windows 365 for Agents runner

The **Azure AI Foundry** equivalent of the Copilot Studio (MCS) path: it captures the
**CCaaS outcome**, drives the legacy Zava Claims Workstation with the Foundry
**Computer Use** loop on a **Windows 365 for Agents** Cloud PC, and relays the result
back to the CCaaS Agent Desktop — over the *same* handoff contract the MCS path uses.

```
CCaaS desktop ──POST /handoff──▶ local-orchestrator ──writes in\prefill.json (CAPTURE CCaaS OUTCOME)
                                                          │
                          this runner watches in\prefill.json
                                                          │
                check out a W365A Cloud PC ─▶ Foundry Computer Use loop ─▶ drives claims.exe
                (POST /api/pools/{pool}/sessions)  (responses API + computer_use_preview)
                                                          │
                          writes out\ready.json + out\result.json (or error.json)
                                                          │
                          local-orchestrator relays status back to the desktop
                          check the Cloud PC back in (DELETE /api/sessions/{id})
```

Because both backends speak the identical `CallContext` ▸ `ready/result/error` contract,
the desktop needs no special knowledge of which one is running — you point its
orchestrator URL at the MCS orchestrator **or** at the local-orchestrator that this
runner is paired with (the orchestrator serves the desktop's HTTP `/handoff`; this runner
watches the orchestrator's file-drop and drives the Cloud PC). See the desktop's backend
toggle for switching live.

## Two modes

| Mode | What it does | Needs |
|---|---|---|
| `simulation` (default) | Fully offline. Captures the prefill and relays a synthesized, schema-valid claim result. Use it to wire up and rehearse the end-to-end flow with **no Azure access**. | Node 20+ |
| `live` | Checks out a real Windows 365 for Agents Cloud PC and drives the app with the Foundry Computer Use loop. | Azure sub, `computer-use-preview` access, a W365A pool/session, `@azure/identity` |

## Foundry prerequisites checklist (for `live` / the `foundry` backend)

Before the `foundry` or `both` backend can work end-to-end, have these ready (the build's
config validation fails fast on a missing/placeholder `foundry.endpoint`):

- [ ] A **Microsoft Foundry project** and its **Project endpoint** — `https://<resource>.services.ai.azure.com/api/projects/<project>` (→ `foundry.endpoint`).
- [ ] The backing **Foundry / Azure AI Services resource** (and its ARM **account resource id** if you'll use `Deploy-Agent.ps1 -CreateModelDeployment` → `foundry.accountResourceId`).
- [ ] **`computer-use-preview` access** approved — manual gate: <https://aka.ms/oai/cuaaccess>.
- [ ] A **`computer-use-preview` model deployment** (→ `foundry.modelDeployment`), or run `Deploy-Agent.ps1 -CreateModelDeployment` after access is approved.
- [ ] The deploying identity holds the required **RBAC** on the project (**Azure AI User**; **Cognitive Services Contributor** on the backing account if creating deployments).

Full step-by-step: [`docs/agent-cua-setup.md`](../../docs/agent-cua-setup.md#prerequisites-one-time-greenfield) → *Prerequisites (one-time, greenfield)*.

## Only acting on handoffs addressed to this runner

In a `both`-backend demo the presenter chooses MCS or Foundry per handoff via the desktop toggle.
The desktop stamps that choice onto the handoff as `target_backend`, which flows into `in\prefill.json`.
This runner self-filters: it acts **only** when `target_backend` matches its own `RUNNER_BACKEND_ID`
(default `foundry`), and logs-and-ignores any prefill addressed to another backend — so the MCS and
Foundry agents never both drive `claims.exe`. A legacy prefill with no `target_backend` is still
processed, so single-backend setups are unchanged.

## Quick start (simulation)

```powershell
cd samples\foundry-w365a-runner
npm install
npm test            # unit + end-to-end simulation tests
npm run build
npm start           # watches the handoff folder; relays a result on each handoff
```

Pair it with the local orchestrator (which receives the desktop handoff and writes
`in\prefill.json`):

```powershell
# terminal 1
cd samples\local-orchestrator ; .\start-orchestrator.bat
# terminal 2
cd samples\foundry-w365a-runner ; .\start-runner.bat
```

Then click **Hand off to AI agent** in the CCaaS desktop: the orchestrator captures the
outcome, this runner produces a claim, and the desktop shows `ready` then `submitted`.

## Going live

1. Request `computer-use-preview` access: <https://aka.ms/oai/cuaaccess>.
2. Deploy/configure the Foundry agent assets with `scripts\Deploy-Agent.ps1` (knowledge,
   instructions, Computer Use tool).
3. Enable a **Windows 365 for Agents** pool and note its session-lifecycle endpoint +
   pool id (see `docs\agent-cua-setup.md` ▸ *Optional — enterprise hardening*).
4. Copy `.env.example` to `.env`, set `RUNNER_MODE=live` and the `FOUNDRY_*` / `W365A_*`
   variables.
5. `npm run build ; npm start`.

### Preview-API verification points

The live integration targets documented **preview** APIs. Verify these against your
tenant (clearly marked in code):

- **W365A session lifecycle** (`src/w365aSession.ts`): the checkout/check-in responses'
  field names (`sessionId`, `computerId`) and the `/computers/{id}/mcp` tool surface.
  The action→tool mapping is `computer_<type>` (`mapActionToMcp`) — adjust if your pool
  exposes different MCP tool names.
- **Foundry Computer Use** (`src/computerUse.ts`): the responses API loop matches the
  documented `computer_call` → `computer_call_output` (screenshot) contract. Set
  `FOUNDRY_TOOL_TYPE=computer` for newer models, or `computer_use_preview` (default).

## Files

| File | Purpose |
|---|---|
| `src/config.ts` | Env → config; `validateForLive` |
| `src/handoff.ts` | Capture `in\prefill.json`; atomic write `out\ready/result/error.json`; watcher |
| `src/w365aSession.ts` | W365A check-out/drive/check-in (live + simulation); action→MCP mapping |
| `src/computerUse.ts` | Foundry responses Computer Use loop; loads the in-repo agent instructions |
| `src/runner.ts` | `LiveAgentDriver` / `SimulationAgentDriver` + outcome interpretation |
| `src/processor.ts` | Single-flight handoff processor (capture → drive → relay) |
| `src/index.ts` | Entry point; `--once` processes a waiting handoff then exits |
| `src/schemas.ts` | Embedded `v1` JSON Schemas + Ajv validators |
