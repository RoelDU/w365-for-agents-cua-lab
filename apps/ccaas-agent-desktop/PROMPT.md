# Build Prompt — CCaaS Agent Desktop (Zava Contact Center — Agent Workspace)

> Copy everything below the horizontal rule into Copilot Workspace, Claude Code,
> Cursor, or any capable coding agent and ask it to produce a complete, buildable
> web app in a single pass. The deliverable is a modern React + Vite + TypeScript
> single-page application styled after Genesys Cloud / Five9 / NICE CXone, that
> simulates an inbound contact-center call and lets the human agent hand off the
> call to an Agent365-managed AI agent (a Foundry agent + Computer Use) which
> drives the sibling **Legacy Claims Workstation** app inside a W365A Cloud PC.
>
> **Authentication can be real Entra ID (MSAL) or simulated — both modes must
> work; default is simulated for environment-friction-free demos.** The app
> lives in an M365 E5 demo tenant. It does NOT depend on any real CCaaS backend,
> real telephony, real speech-to-text, or real call recording — those are all
> simulated.

---

## Role

You are building a complete modern web application from scratch in the folder
**`apps/ccaas-agent-desktop/`** of the **`RoelDU/w365-for-agents-cua-lab`** monorepo
(working directory: `C:\Dev\Work\CCaaSDemoApp\apps\ccaas-agent-desktop`).
Produce all source files, build configuration, TypeScript types, components,
mock data, state stores, tests, documentation, and CI configuration in one
self-contained pass. **You may reference the shared JSON schemas at
`../../schemas/*.json`** but you must not modify them.

## What we're building

A demo app called the **Zava Contact Center — Agent Workspace**. It is
the **modern CCaaS frontend** half of a two-app demo pair (the other half is
the legacy `Zava Mutual Claims Workstation`, a deliberately legacy-styled
Win32 app at `../legacy-claims-workstation/`). Together they demonstrate the
end-to-end Microsoft pattern:

```
CCaaS Agent Desktop (this app, hosted on Azure Static Web Apps)
   → human agent clicks "Hand off to AI Agent"
   → POSTs CallContext JSON to the SWA-hosted /api/handoff endpoint
   → /api starts a Foundry thread/run for the Computer-Use agent
   → Agent365 + Foundry agent + Computer Use drive the legacy claims app on screen
   → /api status polling returns the Foundry run result
   → this app shows the resulting claim ID for the agent to read to the caller
```

The audience is system-integrator partners (NTT Data, Tata, Cognizant,
Accenture, Infosys, Capgemini, regional SIs). The point of this app is to
land "**this is what your customer's CSR sees today**" before pivoting to
"**this is what AI Agents in Agent365 unlock**".

## Target environment

- **M365 E5** tenant (shared with the legacy app)
- **Modern browser:** Edge or Chrome, latest stable
- **Hosting:** local Vite dev server for development; primary deployment is
  Azure Static Web Apps, which hosts both the SPA and managed Functions `/api`
- **Handoff API:** default base URL is `/api` in the deployed SWA. A local URL
  can be configured only for legacy/local testing.
- **No real telephony, no real STT, no real call recording, no real CCaaS
  backend** — those are all simulated in-app with canned data and timers

## Mandatory tech stack

- **Framework:** React 18 (function components + hooks)
- **Build:** Vite 5+, TypeScript 5+
- **Styling:** Tailwind CSS 3+ with a custom dark theme matching Genesys
  Cloud's palette
- **UI primitives:** shadcn/ui (Radix UI primitives + Tailwind) — install via
  the shadcn CLI; copy components into `src/components/ui/`
- **Icons:** Lucide React
- **State:** Zustand stores (one per domain: `useAuthStore`, `useCallStore`,
  `useHandoffStore`, `useAgentStateStore`)
- **Routing:** React Router 6+ (minimal — Login, Workspace, optional Settings)
- **HTTP:** native `fetch` with a small typed wrapper; no axios
- **Auth (Entra mode):** `@azure/msal-browser` + `@azure/msal-react`
- **Schema validation:** `ajv` (validate inbound/outbound JSON against
  `../../schemas/*.json` at runtime — fail loudly in dev, fail safely in
  production)
- **Tests:** Vitest + React Testing Library for components, MSW for HTTP
  mocking
- **Linting/formatting:** ESLint (default Vite + TS config) + Prettier
- **Package manager:** npm (`package.json` engines: `"node": ">=20"`)

## Brand and tone

- **Brand:** *Zava Contact Center — Agent Workspace v3.2*
- **Tagline (footer):** *"Demonstration build — fictional contact center.
  Not connected to a real telephony or CCaaS provider."*
- **Visual tone:** modern, dark-themed, dense-but-readable. Reference:
  Genesys Cloud agent UI, Five9 Agent Desktop Plus, NICE CXone, Talkdesk
  Callbar. Avoid looking like a tutorial app (no childish illustrations, no
  rounded oversize cards, no marketing-style gradients).

## Auth — two modes, default simulated

The app must support **both** authentication modes via the environment variable
`VITE_AUTH_MODE=entra|simulated` (default: `simulated`).

### Simulated mode (default)

- On first load, show a login screen with an **agent picker**: a card grid of
  4–6 fictional CSRs (avatar initials, name, role, queue assignment), e.g.:
  - A. Carter — CSR — Auto Claims queue
  - M. Johnson — CSR — Auto Claims queue
  - R. Davis — Senior CSR — Property Claims queue
  - A. Morgan — Claims Manager — Supervisor view
- Clicking a card "signs in" as that user (writes to `useAuthStore`,
  persists in `localStorage`) and lands on the main workspace.
- A **"Sign in with Microsoft (demo only)"** button is visible but, when
  clicked in simulated mode, opens a `MessageBox`-style toast: *"Switch to
  Entra ID mode via `VITE_AUTH_MODE=entra` to enable real sign-in."*
- No network calls. No tenant configuration required to run.

### Entra mode (real auth)

- Standard MSAL React setup with login-redirect flow:
  - `VITE_AZURE_CLIENT_ID` — app registration client ID in the demo M365 E5
    tenant
  - `VITE_AZURE_TENANT_ID` — tenant ID (or `common`)
  - `VITE_AZURE_REDIRECT_URI` — redirect URI (must match app registration)
- Requested scopes: `openid profile email User.Read` only. **No Graph writes,
  no app-only permissions.**
- After successful sign-in, derive the agent identity from the token (display
  name, email, oid) and write to `useAuthStore`.
- If the signed-in user is not in a hardcoded `AGENT_DIRECTORY` map
  (`oid → { role, queue }`), fall through to a default `CSR / Auto Claims`
  role so the demo doesn't fail.
- The login screen UI is identical in both modes except the primary button
  becomes **"Sign in with Microsoft"** (calls `loginRedirect`).
- **No graph API calls beyond the token issuance.** No mailbox, calendar,
  presence, or directory queries.

### Auth-mode override flags (URL params, useful for demo)

- `?auth=simulated` — force simulated mode for this session
- `?auth=entra` — force Entra mode (only works if env vars are present)
- `?agent=acarter` — auto-pick this agent (simulated mode only)

## Application layout

Single-window single-tab SPA. Three regions:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Top Bar:  brand | queue: AUTO CLAIMS (3 waiting, longest 02:14)    │
│            | agent: A. CARTER ● READY ▼ | 14:32:11                  │
├──────────┬──────────────────────────────────────────────────────────┤
│          │                                                          │
│  Nav     │   Main Interaction Pane                                  │
│          │   ┌──────────────────────┬────────────────────────────┐  │
│  ● Calls │   │ Active Call           │ Customer 360 / Screen-Pop  │  │
│    Hist  │   │  (caller, timer,      │   • Policy POL-2024-008341 │  │
│    KB    │   │   queue, hold/mute)   │   • Premium current        │  │
│    Stats │   │                       │   • 2 prior claims         │  │
│    Sets  │   │  Live Transcript      │                            │  │
│          │   │  ▶ Caller: "I was..."  │  Recent interactions       │  │
│          │   │  ▶ Caller: "...and..." │                            │  │
│          │   │  (typewriter scroll)  │                            │  │
│          │   └──────────────────────┴────────────────────────────┘  │
│          │                                                          │
│          │   Right Rail (collapsible):                              │
│          │     Notes / Disposition / [Hand off to AI Agent]         │
├──────────┴──────────────────────────────────────────────────────────┤
│  Status: Simulated CCaaS  •  Handoff API: /api ●                   │
│  Mode: Simulated Auth  •  Build 3.2.0                               │
└─────────────────────────────────────────────────────────────────────┘
```

### Top bar

- Left: Zava wordmark + "Contact Center" subhead
- Center: queue card showing assigned queue, calls waiting, longest wait
  (updates every second from a Zustand store — purely simulated)
- Right: agent identity chip with aux-state selector dropdown:
  `Available (READY)`, `After Call Work (ACW)`, `Break`, `Lunch`,
  `Training`, `Outbound`, `Tech Issue` — selection updates the dot color
  (green, yellow, grey, red)
- Far right: live clock (system time)

### Left nav

- Icons + labels: **Calls** (default active), **Interactions** (call history
  list, mock data), **Knowledge Base** (search box + mock article list),
  **Statistics** (mock dashboard), **Settings**
- Highlighted active item; collapsible to icon-only on narrow viewports

### Main interaction pane

Two side-by-side panels, resizable splitter:

**Active Call panel** (left)
- When no call: shows a large empty state with a **Simulate Inbound Call**
  button and a small dropdown to pick which hero scenario to load
  (Jordan Smith / Morgan Lee / Fraud pattern)
- When call active: caller name, phone, queue name, ring-then-talk timer
  (`00:00:14`), and call-control buttons: Hold, Mute, Transfer, Conference,
  Hangup — all visually present but only Hold/Mute/Hangup are wired (others
  show a "Demo build — not implemented" toast)
- Live transcript area below: scrolling list of `Caller:` and `Agent:` lines
  with timestamps, typewriter effect for each new line (configurable speed),
  auto-scroll to bottom, selectable text

**Customer 360 panel** (right)
- Header: customer name, status badge (`Active customer since 2019`)
- Tabs: **Overview** (default), **Policies**, **Claims**, **Notes**,
  **Interactions**
- Overview: contact info (phone, email, address), preferred channel,
  CLV indicator, sentiment indicator (canned)
- Policies: list of policies with type, number, status, premium
- Claims: list of prior claims with status, date, amount
- Notes: free-text editor (in-memory only)
- Interactions: previous calls / chats with timestamps

### Right rail

- **Notes** (free text the agent can type during the call, in-memory)
- **Disposition** dropdown: `Resolved`, `Escalated to AI Agent`,
  `Callback Scheduled`, `Wrong Number`, `Abandoned`
- **Primary action: `[ Hand off to AI Agent ]` button** — disabled when no
  call active; primary visual emphasis
- After handoff: button is replaced by a live **AI Agent Status** card (see
  Handoff section below)

### Footer / status bar

- Simulated CCaaS indicator
- Handoff API connection status (green dot if reachable, red if not, with
  the configured base URL visible)
- Auth mode indicator
- Build version

## Simulated CCaaS workflow

### Hero scenarios (MUST be identical to the legacy app's hero records)

Use the exact same hero records as the legacy app. Inbound-call simulation
loads one of these:

| Pick | Caller | Phone | Policy | Intent | Transcript snippet |
|---|---|---|---|---|---|
| Default | Jordan Smith | `(555) 123-4567` | `POL-2024-008341` | `auto_collision` | "I was rear-ended at the intersection of 5th and Main around 2:30 this afternoon. A Honda Civic rear-ended me. No one was hurt. Both cars are still drivable." |
| Alt | Morgan Lee | `(555) 222-0198` | `POL-2024-002210` | `home_water` | "I came home from work and there's water all over the kitchen floor. I think a pipe under the sink burst. The carpet in the next room is soaked through." |
| Manager view | Pat Rivera | `(555) 444-7711` | `POL-2024-005544` | `fraud_investigation` | "I'm calling to follow up on three claims that were flagged this week. The pattern of round-dollar losses across different customers..." |

Each scenario ships with a pre-scripted 8–12 line transcript that plays back
with a typewriter effect over ~25 seconds.

### Inbound-call timeline

1. Click **Simulate Inbound Call** → ringing sound (visual only, no audio),
   call card slides in, top bar queue indicator decrements
2. After 3 seconds of "ringing" → call auto-answers (or agent clicks Answer
   button — both wired), aux state changes to `In Call`, timer starts
3. Customer 360 screen-pops with the matched customer (deterministic on the
   caller phone)
4. Transcript plays back line-by-line over ~25 seconds
5. At any point, agent can click **Hand off to AI Agent**, **Hangup**, or set
   a Disposition

### Handoff to AI Agent

This is the demo wedge. When clicked:

1. Show a **confirmation modal**:
   - Summary of what's being handed off (caller, intent, summary)
   - Editable summary field (auto-filled from the last 30s of transcript)
   - **Send to AI Agent** primary button + **Cancel** secondary
2. On confirm:
   - Build a `CallContext` payload conforming to
     `../../schemas/call-context.schema.json`
   - Validate locally with `ajv` (fail loudly with a red toast in dev if
     invalid)
   - POST to the configured handoff API base URL
     (`VITE_ORCHESTRATOR_URL`, default `/api`) at `POST /handoff` with the
     payload
   - If POST succeeds: store the returned `thread_id`, `run_id`, and
     `status_url`, then replace the **Hand off** button with the **AI Agent
     Status** card (see below)
   - If POST fails (network error, 4xx, 5xx): show a recoverable error with a
     retry/manual-takeover path; do not switch to a file handoff as the primary
     architecture

### AI Agent Status card

After a successful handoff, this card replaces the Hand off button and shows
real-time state:

| State | Visual | Source |
|---|---|---|
| `queued` | grey dot + "Waiting for AI agent to pick up…" | initial POST response |
| `prefilled` | yellow dot + "AI agent has the call context" | SWA `/api` status poll mapped from Foundry run state |
| `ready` | yellow dot + "AI agent is now driving the claims system" | app-level checkpoint from the Foundry/Computer-Use flow |
| `submitted` | green dot + claim ID prominently displayed + reserve amount + adjuster + "Confirm with caller and dispose the call" | Foundry run completed and `/api` parsed the result |
| `error` | red dot + error code + message + **Retry** / **Fall back to manual** buttons | `/api` mapped a failed/expired/cancelled run or a request error |

State updates are obtained by **polling**
`GET /handoff/:request_id/status?thread_id=...&run_id=...` every 1.5 seconds.
The current SWA `/api` contract is the source of truth; SSE/local-orchestrator
behavior is legacy/local testing only.

When state reaches `submitted`, the claim ID must be:
- Displayed in a large monospace font in the status card
- Shown briefly as a desktop toast notification ("Claim CLM-2024-000123
  ready to communicate to caller")
- Copied to the clipboard
- Logged to the in-app activity log

### Local/legacy testing mode

The primary demo path is always JSON `POST` to the SWA-managed `/api` endpoint.
If a developer intentionally points `VITE_ORCHESTRATOR_URL` at a local/legacy
endpoint, the UI may still exercise that endpoint for smoke tests. The product
spec must not present a browser-downloaded prefill file as the recommended
handoff, because the agent-to-legacy-app seam is on-screen Computer Use only.

## CUA-friendliness (this app must ALSO be CUA-drivable)

Even though the primary CUA target is the legacy app, the CCaaS desktop may
itself be driven by a CUA (Foundry agent, Copilot Studio) for fully-autonomous
end-to-end demos. So:

- Every interactive control has a stable `data-testid` AND a meaningful
  `aria-label` (e.g., the AI transfer destination is
  `data-testid="handoff-to-ai"`, `aria-label="Transfer to AI Agent"`).
- All buttons use real `<button>` elements; no `<div onClick>` patterns.
- The handover follows the realistic CCaaS **transfer-to-destination** model: the
  call-toolbar **Transfer** control (or `Ctrl+Shift+H`) opens a **Transfer
  Directory** where the AI agent is one destination alongside human queues, then a
  single confirm modal. To keep unattended (CUA) demos one-touch, **CUA mode
  auto-selects the AI destination** and auto-confirms — so the visible path stays
  short while remaining faithful to how real platforms route to an AI worker.
- No drag-and-drop in the primary workflow (destinations are single clicks).
- All toasts have stable IDs and auto-dismiss times of ≥5 seconds (no flash
  toasts that disappear before CUA can read them).
- The **AI Agent Status** card has a stable `data-testid="ai-status-claim-id"`
  for the claim ID readout.
- Loading spinners use accessible names and predictable lifecycles.
- All animations respect `prefers-reduced-motion`.
- Provide a `?cua=true` URL param that:
  - Disables typewriter animation on transcripts (instant text)
  - Pre-resolves handoff status polling intervals to 500 ms
  - Disables the inbound call ring delay (call answers immediately)
  - Auto-acknowledges the handoff confirmation modal after 1 second
    (showing it briefly for audit/visual continuity)

## Audience engagement and visual realism (CRITICAL)

The app must look and feel like a **real Genesys Cloud / Five9 / NICE CXone
agent desktop**, not a tutorial sample. SI partners have personally lived in
these products for years. The more it looks like what they recognize, the more
they emotionally engage with the demo.

### Things to do (MUST)

- **Dark theme by default.** Match the Genesys Cloud palette: deep navy
  background (`#0f172a` / `#1e293b`), accent teal (`#14b8a6`), warm orange
  for alerts (`#f97316`).
- **Density.** Tight padding, small fonts (text-sm by default), high
  information density per square inch. No oversized cards.
- **Real CCaaS terminology** everywhere: *queue*, *wrap-up* (not "complete"),
  *aux state*, *disposition*, *screen-pop*, *interaction*, *transfer*,
  *consult*, *hold*, *barge-in*, *adherence*, *ACW*, *AHT*, *ASA*.
- **Realistic mock metrics** in the Statistics view: AHT 4:32, ASA 0:18,
  Service Level 87%, Adherence 94%, Calls today 23. Don't show round
  numbers.
- **Real-time elements that pulse / animate subtly.** The queue indicator
  digit ticks up/down; the agent status dot pulses; the active-call timer
  increments by the second.
- **Tooltips on every icon and metric.** Hover the queue indicator → see
  the full breakdown; hover the AHT metric → see the calculation.
- **Keyboard shortcuts** with a discoverable shortcut help overlay (`?` key):
  - `Ctrl+A` Answer / `Ctrl+H` Hold / `Ctrl+M` Mute / `Ctrl+E` End
  - `Ctrl+Shift+H` Hand off to AI Agent
  - `Ctrl+1..5` switch left-nav sections
- **A subtle but constant indication that this is a demo.** Footer text
  *"Demonstration build — fictional contact center."* and a small banner
  on the login screen. Don't pretend to be a real product, but don't
  apologize for it either.

### Things to avoid (MUST NOT)

- **Looking like a tutorial.** No bootstrap-default look, no Material UI
  defaults, no "Hello World" placeholder text anywhere.
- **Marketing-style copy** in transcripts or notes. Real call transcripts
  have hesitations, repetitions, and partial sentences.
- **Cartoon avatars or stock-photo customers.** Initials in colored circles
  is the right vibe.
- **Modals that block the main workspace for >2 seconds without an action.**
- **Notification spam.** The demo should produce 2–3 toasts max per scenario.

## Settings (Settings page)

Expose these controls so Roel can switch modes mid-demo without redeploying:

- **Auth mode** (read-only display of effective `VITE_AUTH_MODE`)
- **Handoff API URL** (live-editable, persists to `localStorage`; default `/api`)
- **Handoff mode:** Webhook/API (default); local/legacy testing only if a local URL is configured
- **CUA-friendly mode toggle** (equivalent to `?cua=true`)
- **Typewriter speed slider** (transcript playback)
- **Reset demo state** button — clears active call, status, notes; reseeds
  hero scenarios
- **About** — build version, environment, the demo-honest disclaimer

## Acceptance criteria

### Must pass for demo build

1. `npm install && npm run dev` on a fresh clone starts the dev server on
   port 5173 without errors and the app loads.
2. In **simulated** auth mode (default), the login screen shows the 4–6
   agent picker cards; selecting one lands on the main workspace with that
   agent's identity in the top bar.
3. Clicking **Simulate Inbound Call** (default scenario = Jordan Smith)
   pops the customer 360 with policy `POL-2024-008341`, starts the call
   timer, and begins streaming the canned transcript.
4. With the handoff API unreachable, clicking **Hand off to AI Agent** shows a
   recoverable error with retry/manual-takeover controls and does not present a
   file handoff as the recommended path.
5. With a mock SWA `/api` running (Vitest + MSW mocks the `POST /handoff` and
   `GET /handoff/:id/status?thread_id=...&run_id=...` endpoints), the full
   handoff flow produces the AI Agent Status card transitioning queued →
   prefilled → ready → submitted, and the final claim ID `CLM-YYYY-NNNNNN` is
   displayed prominently and copied to clipboard.
6. The keyboard shortcut `Ctrl+Shift+H` triggers the same handoff flow
   when a call is active.
7. `npm test` runs Vitest with at least 25 tests covering: auth-store,
   call-store, handoff-store, the CallContext payload builder, schema
   validation, `/api` polling with Foundry run identifiers, API failure
   handling, and 3 component smoke tests (login screen, active call panel,
   AI status card). All pass, exit code 0.
8. `npm run build` produces a static `dist/` bundle ≤ 1.5 MB gzipped for the
   SPA; the primary deployment target is Azure Static Web Apps with managed
   Functions `/api`.
9. The app is usable end-to-end with `?cua=true` set (typewriter disabled,
   instant call answer, fast polling) — verifiable in the test suite.

### Should pass for release hardening

1. Real Entra mode works with a valid app registration in the demo M365 E5
   tenant (manual verification — not part of CI).
2. GitHub Actions builds on push, runs `npm test` and `npm run build`,
   uploads the `dist/` artifact.
3. Lighthouse score ≥ 90 for Performance and Accessibility on the main
   workspace view.
4. The 1.5 MB gzipped budget is met (CI fails the build if exceeded).
5. README includes a screenshot of the workspace with an active call.
6. `docs/keyboard-shortcuts.md` lists every shortcut.

## Non-goals (do NOT do these)

- Do not use Next.js, Remix, Angular, Vue, or Svelte — React + Vite only.
- Do not add a separate Node server for the SPA. The deployed backend seam is
  the Azure Static Web Apps managed Functions API under `api/`; the old
  `../../samples/local-orchestrator/` path is legacy/local testing only.
- Do not integrate with any real CCaaS provider's API (Genesys Cloud,
  Five9, NICE, Talkdesk). The whole CCaaS layer is simulated.
- Do not integrate with any real telephony, real speech recognition, real
  call recording, or real audio playback.
- Do not query Microsoft Graph beyond the basic identity at sign-in.
- Do not add tracking, telemetry, analytics, or third-party widgets.
- Do not implement payment, PII storage, or any GDPR-relevant data
  handling.
- Do not pretend to be a real product. The brand is "Zava Contact
  Center" (Microsoft fictional) and the footer says so.
- Do not implement multi-tenant, multi-user concurrency, or persistent
  server-side state. Demo data is per-browser-tab.
- Do not implement i18n beyond en-US.
- Do not add a feature flag system, a CMS, a design-system extraction, or
  a Storybook. Keep the surface small.
- Do not add platform-specific Foundry code to the SPA. Foundry integration
  belongs in the SWA managed Functions `/api` (or Agent365 platform seam).

## Documentation to produce

- `README.md` — replace the spec-only stub: what it is, screenshot, dev
  setup, build, deploy, env vars, link to `docs/keyboard-shortcuts.md`,
  link to the monorepo top-level README
- `docs/keyboard-shortcuts.md` — full keyboard shortcut reference
- `docs/auth.md` — how to switch between simulated and Entra modes; how
  to register the Entra app
- `api/README.md` — how this app talks to the SWA managed Functions `/api`
  handoff endpoint; cross-references the shared schemas
- `docs/orchestrator-contract.md` — optional legacy/local reference only, if kept
- `CONTRIBUTING.md` — short
- `LICENSE` — MIT

## Deliverables checklist

- [ ] `package.json` with all dependencies pinned (no ranges loose enough
      to break a reproducible build)
- [ ] `vite.config.ts`, `tsconfig.json`, `tailwind.config.ts`,
      `postcss.config.js`, `.eslintrc.cjs`, `.prettierrc`
- [ ] Source tree: `src/components/`, `src/components/ui/` (shadcn),
      `src/stores/`, `src/lib/`, `src/pages/`, `src/mocks/`,
      `src/types/`
- [ ] All documentation listed above
- [ ] `npm test` passes, `npm run build` produces `dist/`
- [ ] `.gitignore` includes `node_modules/`, `dist/`, `.env*` (except
      `.env.example`)
- [ ] `.env.example` with all `VITE_*` variables and explanatory comments
- [ ] GitHub Actions workflow at `../../.github/workflows/ccaas-agent-desktop.yml`
      that builds and tests this app on PRs touching `apps/ccaas-agent-desktop/**`
- [ ] Leave the repository in a complete, buildable state. Do not commit/push
      yourself — Roel will review and push.
