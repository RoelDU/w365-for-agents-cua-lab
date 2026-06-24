# Building from source — step by step

> **Who this is for:** anyone **building the two apps from
> source** for the first time, before v1.0 has been released. Once releases
> are published, end users follow the main [`README.md`](../README.md)
> instead and never touch this guide.

A step-by-step guide for actually building, testing, and running the two
apps in this monorepo from spec, using a coding agent (Copilot CLI / Copilot
Workspace / Claude Code / Cursor) to generate the code. Written for someone
who has not driven a coding agent end-to-end before.

> **Time budget:** Roughly half a day of *your* time spread across a week.
> The coding agents do most of the work; you supervise, test, and approve.
> The Win32 app build is the longest single step (1–3 hours of agent
> runtime, mostly unattended). The CCaaS desktop build is shorter (45 min –
> 2 hours). You can run both in parallel.

---

## Phase 0 — Install the prerequisites (one-time, ~15 minutes)

Do this once. The two coding agents both need these tools to compile and
verify their work.

### 0.1 Install MinGW-w64 (C compiler for the legacy Win32 app)

The simplest option:

1. Open https://github.com/skeeto/w64devkit/releases in your browser.
2. Download the latest `w64devkit-*.exe` (a self-extracting archive).
3. Run the .exe; when prompted, extract to **`C:\w64devkit`**.
4. Add `C:\w64devkit\bin` to your Windows PATH:
   - Press **Win** → type `environment variables` → open
     **Edit the system environment variables**.
   - Click **Environment Variables…**
   - Under **System variables**, select **Path** → **Edit…** → **New**.
   - Paste `C:\w64devkit\bin`.
   - **OK** out of all three dialogs.
5. **Close and reopen** any open PowerShell windows (PATH only refreshes for
   new shells).
6. Verify:
   ```powershell
   gcc --version
   ```
   You should see something like `gcc (GCC) 13.x.x`. If you see "not
   recognized," the PATH didn't take — repeat step 4 and reopen PowerShell.

### 0.2 Install Node.js 20 LTS (for the CCaaS desktop)

1. Open https://nodejs.org/ in your browser.
2. Download the **20 LTS** installer for Windows x64 (the green button on
   the left).
3. Run the installer. Accept all defaults. When asked, let it install
   "tools for native modules" — that step is optional but harmless.
4. Verify in a fresh PowerShell:
   ```powershell
   node --version    # should print v20.x.x or higher
   npm --version     # should print 10.x.x or higher
   ```

### 0.3 (Optional but recommended) Install Inspect.exe

For verifying that the legacy app's controls are CUA-friendly later.

1. Open https://learn.microsoft.com/en-us/windows/win32/winauto/inspect-objects.
2. If you already have the Windows SDK installed (often comes with Visual
   Studio), `inspect.exe` is at
   `C:\Program Files (x86)\Windows Kits\10\bin\10.0.*\x64\inspect.exe`.
3. If not, install the Windows 10/11 SDK from
   https://developer.microsoft.com/windows/downloads/windows-sdk/ — you only
   need the SDK, not all of Visual Studio. Pick "Debugging Tools" during
   install.

You won't need this until Phase 2.

### 0.4 Confirm Copilot CLI is set up

You're using it right now, so you're fine. Verify in PowerShell:

```powershell
copilot --version
```

---

## Phase 1 — Build the two apps in parallel (~1–3 hours of agent time)

You'll open **two new** Copilot CLI terminals (one per app) and let each
agent work autonomously. Keep this current CLI open for any strategy /
follow-up work.

### 1.1 Open Terminal A for the legacy app

Open a **new** PowerShell window:

```powershell
cd <your-clone>\apps\legacy-claims-workstation
copilot
```

When Copilot CLI is ready, paste this prompt **verbatim** as your first
message:

> Read `PROMPT.md` in the current folder. Read the JSON schemas at
> `..\..\schemas\*.json` as the contract source of truth. **Only modify
> files under the current folder (`apps/legacy-claims-workstation/`); do not
> touch anything under `..\..\apps\ccaas-agent-desktop\`, `..\..\schemas\`,
> `..\..\samples\local-orchestrator\`, or `..\..\docs\`.** Execute
> end-to-end in one pass. Stop when all "must pass for demo build"
> acceptance criteria are met. Report any spec ambiguities before guessing.
> Do not commit or push automatically; review the changes before pushing.

Hit enter. The agent will start. You can leave this terminal running.

### 1.2 Open Terminal B for the CCaaS desktop

Open **another new** PowerShell window (don't close Terminal A):

```powershell
cd <your-clone>\apps\ccaas-agent-desktop
copilot
```

When ready, paste:

> Read `PROMPT.md` in the current folder. Read the JSON schemas at
> `..\..\schemas\*.json` as the contract source of truth. **Only modify
> files under the current folder (`apps/ccaas-agent-desktop/`); do not
> touch anything under `..\..\apps\legacy-claims-workstation\`,
> `..\..\schemas\`, `..\..\samples\local-orchestrator\`, or
> `..\..\docs\`.** Execute end-to-end in one pass. Stop when all "must pass
> for demo build" acceptance criteria are met. Report any spec ambiguities
> before guessing. Do not commit or push automatically; review the changes before pushing.

Hit enter.

### 1.3 What to do while the agents work

- **Check in periodically** (every 20–30 min) — see what they're up to.
- If an agent **asks you a clarifying question**, answer concisely and let
  it continue. Most questions can be answered with "use your best
  judgment, this is a demo — keep it simple."
- If an agent **gets stuck on the same error 3+ times in a row**, tell it:
  "Try a different approach. If you cannot resolve this, stop and explain
  what's blocking you."
- **Do not interrupt unnecessarily.** Coding agents work best when allowed
  to focus.
- When an agent says it's done, **read its summary carefully** before
  moving on. Look for "all acceptance criteria met" or a list of what
  passed/failed.

### 1.4 Expected outputs when each finishes

**Terminal A (legacy app) — when done, you should see:**
- A `build.bat` file in `apps/legacy-claims-workstation/`
- A `src/` folder with `.c` and `.h` files
- A `res/` folder with `.rc` resource files
- A `claims.exe` file (~500 KB – 2 MB)
- `apps/legacy-claims-workstation/tests/` with a test runner
- The agent ran `claims.exe --test` and reported "all tests passed"
- The agent's summary lists each acceptance criterion as ✓

**Terminal B (CCaaS desktop) — when done, you should see:**
- `package.json`, `vite.config.ts`, `tsconfig.json` in the folder
- `src/components/`, `src/stores/`, `src/pages/` etc.
- A `node_modules/` folder (large — ignored by git)
- A `dist/` folder (the production build)
- The agent ran `npm test` and reported all tests passing
- The agent ran `npm run build` and reported success

---

## Phase 2 — Verify each app standalone (~30 minutes)

Before wiring them together, smoke-test each one on its own.

### 2.1 Smoke-test the legacy app

In a **new** PowerShell window (not the agent's terminal):

```powershell
cd <your-clone>\apps\legacy-claims-workstation
.\claims.exe --test
```

You should see test output ending with "All N tests passed".

Then launch the app:

```powershell
.\claims.exe
```

- The splash should appear briefly.
- The compliance banner pops — click **I Agree**.
- The login screen appears — type PIN `1234`, click **Connect**.
- The staged "Establishing host link…" dialog runs for ~3 seconds.
- The MOTD modal pops — click **Acknowledge**.
- The ready-gate appears — click **Yes**.
- The main workstation appears with the status bar showing `READY`,
  `HOST: LINKED`, `T-1001`, etc.
- In the search panel, pick "Phone", type `(555) 123-4567`, click **Search**.
- Jordan Smith should appear in the results. Double-click.
- Click the **New FNOL** tab. Walk through the 5 wizard pages with default
  values. On Review, click **Submit Claim**.
- A `CLM-YYYY-NNNNNN` ID should appear and copy to clipboard.

If any of this fails, go back to Terminal A and tell the agent what
happened.

### 2.2 Smoke-test the CCaaS desktop

In a **new** PowerShell window:

```powershell
cd <your-clone>\apps\ccaas-agent-desktop
npm install        # only needed the first time
npm run dev
```

You should see Vite print something like `Local: http://localhost:5173/`.

Open that URL in Edge or Chrome:

- The login screen shows agent picker cards (simulated mode).
- Click **A. Carter**. You land on the workspace.
- Top bar shows your queue, status `READY`, the clock.
- Click **Simulate Inbound Call** (default = Jordan Smith).
- Customer 360 pops with `POL-2024-008341`. Transcript starts streaming.
- After ~10 seconds, click **Hand off to AI Agent**.
- The confirmation modal pops. Click **Send to AI Agent**.
- Because the orchestrator isn't running, the app falls back to **file
  download** — a `prefill-REQ-….json` file downloads.
- Open it; it should contain Jordan Smith's call context.

Stop the dev server with **Ctrl+C** in the terminal.

---

## Phase 3 (recommended) — Build the local orchestrator (~45 minutes)

If you want the full webhook-driven flow instead of file-download:

In a **new** PowerShell window:

```powershell
cd <your-clone>\samples\local-orchestrator
copilot
```

Paste:

> Read the `README.md` in the current folder and the schemas at
> `..\..\schemas\*.json`. Build a complete Node 20 + TypeScript + Express
> implementation matching that spec. Validate inbound and outbound JSON
> with `ajv`. Watch the handoff `out\` folder with `chokidar`. Support
> Server-Sent Events on `/handoff/:request_id/stream`. Default port 4000.
> CORS-enable `http://localhost:5173`. Add a small test suite. Add a
> `README.md` with run instructions. Only modify files under the current
> folder. Do not commit or push.

When done, run it:

```powershell
npm install
npm start
```

You should see `Orchestrator listening on http://localhost:4000`.

---

## Phase 4 — Wire the demo together (~30 minutes)

Now you have all three pieces. Time to make them talk.

### 4.1 Decide where the legacy app runs

Two options:

**Option A — Run everything on your local Windows machine first (easiest).**
Use this to prove the wiring works before involving the Cloud PC.

**Option B — Run the legacy app inside a W365A Cloud PC.**
The realistic demo target. Requires:
- A provisioned W365A Cloud PC (you should already have one)
- The legacy app installed on it (`Install.ps1`)
- A way for the orchestrator (on your laptop) to write into the Cloud PC's
  handoff folder — either an Azure Files mount, an SMB share, or run the
  orchestrator INSIDE the Cloud PC

Start with Option A; switch to Option B once Option A works end-to-end.

### 4.2 Run the three processes (Option A — local)

Open three PowerShell windows:

```powershell
# Window 1: Orchestrator
cd <your-clone>\samples\local-orchestrator
npm start

# Window 2: CCaaS desktop
cd <your-clone>\apps\ccaas-agent-desktop
npm run dev

# Window 3: Legacy app (run when you're ready to "answer" the call)
cd <your-clone>\apps\legacy-claims-workstation
.\claims.exe --handoff-dir=C:\ProgramData\ZavaClaims\handoff --fast-auth --demo-pin=1234 --no-splash
```

### 4.3 Trigger the end-to-end flow

1. In the browser (CCaaS desktop at `http://localhost:5173`), pick an agent,
   click **Simulate Inbound Call**, watch the transcript, click **Hand off
   to AI Agent**, confirm.
2. The orchestrator window logs the incoming POST.
3. The legacy app picks up the prefill (you'll see it search by phone and
   open Jordan Smith).
4. Walk through the FNOL wizard yourself. Click **Submit Claim**.
5. The browser window's AI Agent Status card updates to `submitted` with
   the claim ID.

If the round-trip works, the demo is **functionally complete**.

---

## Phase 5 (optional) — Hook up a real Foundry agent (varies)

Only do this when Phases 1–4 are solid. This is where you stop driving the
legacy app yourself and let a Foundry agent + CUA do it.

> **Scripted alternative:** instead of the manual portal steps below, you can use
> [`samples/foundry-w365a-runner`](../samples/foundry-w365a-runner) — a runnable Foundry +
> Windows 365 for Agents backend that watches the orchestrator handoff, checks out a W365A
> session, and drives `claims.exe` via the Foundry Computer Use loop. Select it end-to-end
> with `Build-DemoFromScratch.ps1 -AgentBackend foundry` (or `both`). The manual steps
> below remain useful for understanding what the runner automates.

1. In **Azure AI Foundry portal**, create a new agent project.
2. Open `apps/legacy-claims-workstation/samples/foundry-agent/` and:
   - Upload `KNOWLEDGE.md` as a Knowledge file on the agent.
   - Paste `AGENT-INSTRUCTIONS.md` into the agent's Instructions.
   - Paste `CUA-TOOL-INSTRUCTIONS.md` as additional instructions or into
     the CUA tool configuration (depending on Foundry's current UI).
3. Enable the **Computer Use** tool on the agent.
4. Point Computer Use at your **W365A Cloud PC**.
5. **Set the model** to **Claude Sonnet 4.5 / 4.6** or **GPT-4.1**. Avoid
   reasoning models — they add latency without helping UI navigation.
6. **Disable web search** on the agent.
7. Test with one of these prompts:
   > "A new claim just came in. Caller (555) 123-4567 says they were
   > rear-ended. File the FNOL."
8. Run the `evaluations/evaluation-1-smoke.csv` batch in Foundry's
   Evaluation feature to validate the agent against the app.

> **Before every demo:** Settings → Connections in the agent platform →
> refresh the **Windows 365** connection. The CUA connection token expires
> when the Cloud PC disconnects/restarts.

---

## Phase 6 — Review and push to GitHub (~15 minutes)

After both apps build and you've smoke-tested them:

```powershell
cd <your-clone>

# See what changed
git status
git diff --stat

# Look at a few files to sanity-check the agent's work
# (use your favorite editor — VS Code, etc.)

# When happy, commit and push
git add .
git commit -m "Initial build of both demo apps"
git push
```

If a coding agent already committed during its run (it was told not to,
but agents sometimes do anyway), `git status` will show "your branch is
ahead of origin by N commits" — just `git push` and you're done.

---

## Phase 7 — Demo day prep

1. Open `docs/demo-flow.md` and run through the setup checklist.
2. Refresh the Windows 365 / CUA connection in your agent platform.
3. Disable web search on the agent.
4. Reset both apps' state:
   - Legacy: `.\claims.exe --prepare-demo-data --reset-data`
   - CCaaS desktop: use the **Reset demo state** button in Settings
5. Run through the demo once, end to end, the same way you'll do it live.
6. **Record a backup video** of a clean run. If the network dies during
   the live demo, cut to the video without missing a beat.

---

## When things go wrong

| Symptom | What to try |
|---|---|
| `gcc not found` | Reopen PowerShell. If still missing, redo Phase 0.1 step 4 (PATH). |
| `npm install` is very slow | Normal first time (~3–5 min). Subsequent installs are fast. |
| Coding agent gets stuck on the same error | Tell it: "Try a different approach. If you can't resolve, stop and explain." If still stuck, share the error with this strategy CLI and we'll triage. |
| Build agent makes "improvements" outside its folder | Tell it explicitly: "Revert any changes outside `apps/<name>/`. Only modify files in your folder." |
| Tests fail | Read the test output. Tell the agent the exact failure. Most issues are 1–2 fix cycles. |
| Legacy app crashes on launch | Run `.\claims.exe --test` — if tests fail, fix those first. If tests pass but the app crashes, share the error log with the agent. |
| CCaaS desktop blank page | Open the browser's DevTools console (F12). The error there is usually obvious — share it with the agent. |
| Orchestrator can't write to Cloud PC handoff folder | Use file-download fallback mode in the CCaaS desktop's Settings for the first demos. |
| Foundry agent picks wrong control | Add the control's stable ID to the agent's `CUA-TOOL-INSTRUCTIONS.md` more explicitly. |
| CUA connection expired during demo | Settings → Connections → refresh Windows 365. Happens. Refresh proactively before every demo. |

---

## You don't have to do all of this at once

A realistic week:

- **Day 1 (today):** Phase 0 + start Phase 1. Let the agents work overnight
  if needed.
- **Day 2:** Phase 2 — smoke-test both apps. Iterate with the agents on
  anything broken.
- **Day 3:** Phase 3 (orchestrator) + Phase 4 — wire them together.
- **Day 4:** Phase 5 — connect a Foundry agent and run evaluation batches.
- **Day 5:** Phase 6 — push, then Phase 7 — rehearse for the partner demo.

If a phase takes longer or you want to skip ahead, that's fine. Phases 3
and 5 are explicitly optional for the first demo.
