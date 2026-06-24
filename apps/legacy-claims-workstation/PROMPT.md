# Build Prompt — CCaaS Demo App (Zava Mutual Claims Workstation)

> Copy everything below the horizontal rule into Copilot Workspace, Claude Code,
> Cursor, or any capable coding agent and ask it to produce a complete, buildable
> repository in a single pass. The agent is expected to create every source file,
> resource file, build script, installer script, packaging file, seed-data file,
> test, sample, GitHub Actions workflow, and document required to satisfy the
> acceptance criteria. **The app must work end-to-end inside a Microsoft
> Windows 365 Agentic (W365A) Cloud PC, driven by Copilot Studio's Computer Use
> Agent (CUA), with caller context handed off by Agent365 from any CCaaS
> voicebot.** Authentication is intentionally faked and out of scope.

---

## Role

You are building a complete native Windows desktop application from scratch in
the **`apps/legacy-claims-workstation/`** folder of the **`RoelDU/w365-for-agents-cua-lab`**
monorepo (working directory:
`C:\Dev\Work\CCaaSDemoApp\apps\legacy-claims-workstation`). Treat this folder
as the root of your build. **Only modify files under this folder.** Do not
touch anything under `..\..\apps\ccaas-agent-desktop\`,
`..\..\samples\local-orchestrator\`, or `..\..\docs\`. You MAY read (but not
modify) the shared JSON schemas at `..\..\schemas\*.json` — they are the
source of truth for the prefill/ready/result/error contract and override any
inline JSON examples in this prompt.

Produce all source files, build scripts, packaging files, seed data, tests,
documentation, and CI for this app in one self-contained pass.

## What we're building

A demo app called the **Zava Mutual Claims Workstation**. It is the
**insurance contact-center sibling** of
[shannonfritz/throwback-banker](https://github.com/shannonfritz/throwback-banker).
The two apps should feel like a deliberate family: same general compiler /
runtime ethos, same legacy UI vibe, same `--test` flag pattern, similar
`WORKFLOWS.md` format. **Do not depend on code or assets from Throwback Banker.**

The purpose of the app is to be a **realistic-feeling legacy claims workstation**
that Microsoft's Computer Use Agent (CUA), running inside a Windows 365 Agentic
(W365A) Cloud PC provisioned by Agent365, can drive end-to-end during a live
partner demo. The app must be visibly a demo (the splash and About box say so),
but must look and behave like the kind of thick-client claims system a
contact-center agent uses today.

## Target environment (CRITICAL)

The demo runs on a stock **Microsoft Entra-joined** Windows 365 Agentic Cloud PC.
**There is no on-prem Active Directory, no Domain Controller, no Entra Connect,
no hybrid join, and no domain trust** in the demo environment, and **none will
be installed to make the app work**.

The app must therefore:

- Run cleanly on an **Entra-joined or workgroup** Windows machine with no
  domain membership.
- Not depend on **Active Directory**, **Domain Controller**, **Kerberos**,
  **NTLM domain authentication**, **LDAP**, **Group Policy**, **DFS**,
  **SYSVOL**, **Integrated Windows Authentication**, **SQL Server integrated
  auth**, **domain file shares**, or any other on-prem AD-dependent feature.
- Not rely on **Entra ID** itself either — no MSAL, no OAuth flows, no
  `WAM`/`Web Account Manager`, no browser sign-in, no token cache, no
  `Microsoft.Identity.Client`, no graph calls. Real cloud identity is **out of
  scope** for the demo and will be simulated by the in-app PIN login.
- Not require the user to be a member of any specific Entra group, AAD role,
  or device-management scope to launch or use the app.
- Use only **local Windows paths** (`%ProgramData%`, `%LOCALAPPDATA%`,
  `C:\ZavaClaims\`) — no UNC, no SMB, no DFS namespace as the primary
  path. If the chosen folder is not writable, fall back silently to a
  user-writable folder.

This constraint exists because installing AD just to make a demo authenticate
would defeat the purpose of showing how lightweight the W365A + CUA + Agent365
pattern is.

## Mandatory tech stack

- **Language:** C99
- **UI:** Win32 API + Common Controls (no .NET, no Qt, no Electron, no WinUI)
- **Compiler:** MinGW-w64 / LLVM MinGW (GCC), x86_64 only
- **Data storage:** CSV files (RFC 4180) with embedded `RCDATA` fallback so the
  binary is self-contained
- **Dependencies:** none beyond Win32 system libraries
- **Output:** a single portable `claims.exe`; target small size, preferably
  under 2 MB, but **demo reliability is more important than binary size**
- **Build:** `build.bat` (Windows) and `build.sh` (Linux/Wine for CI) if feasible
- **Tests:** `claims.exe --test` runs an embedded data-layer test suite (target
  40+ tests; 60+ preferred)
- **Logging:** see Live demo reliability section
- **Reset:** menu item **Actions → Reset All Data** (manager only), CLI flag
  `--reset-data`, or delete the local data folder

## The product

Use the Microsoft-fictional brand **Zava Mutual** (same fictional family as
Zava Bank in Throwback Banker). Tagline on the splash and About box:
*"Zava Mutual — Claims Workstation, est. 1998. Demonstration build."*

Main window title (exact, no variation): `Zava Mutual — Claims Workstation v1.0`

## Roles and login

PIN-based login, purely in-app:

| PIN  | Name        | Role           | Agent ID |
| ---- | ----------- | -------------- | -------- |
| 1234 | A. Carter   | CSR            | C1001    |
| 2345 | M. Johnson  | CSR            | C1002    |
| 3456 | R. Davis    | Senior CSR     | C1003    |
| 9999 | A. Morgan   | Claims Manager | M2001    |

Role permissions:
- **CSR** — view policy, open new FNOL, attach INFO notes, submit claim ≤ $25,000
- **Senior CSR** — all CSR + close claims, override coverage warnings, notes any
  severity
- **Claims Manager** — all + reset data, void claims, view audit log in-app

**Cloud PC / Entra / Conditional Access authentication is out of scope for this
app.** The app must not depend on Windows account identity, Entra ID, MFA, web
sign-in, Credential Manager, network identity, or any on-prem Active Directory
service (no domain join, no Kerberos, no NTLM, no LDAP, no Group Policy). It
must run as a standard interactive desktop process after the W365A Cloud PC
session is available, regardless of whether that Cloud PC is Entra-joined,
hybrid-joined, or workgroup. The PIN login is demo-only and purely in-app.

## Window layout

Split-pane, persistent single-window layout:

```
+--------------------------------------------------------------+
| File   Edit   Actions   Help                                 |
+--------------------------------------------------------------+
| [Search Panel  ]  |  [Detail / Workflow Area              ]  |
|                   |                                          |
| Search by:        |  Tabs: Policy | Coverage | Claims |     |
|  ( ) Phone        |        New FNOL | Notes                  |
|  ( ) Policy #     |                                          |
|  ( ) Name         |  (tab content here)                      |
|  ( ) Claim #      |                                          |
|                   |                                          |
| [ Search ]        |                                          |
|                   |                                          |
| Results list:     |                                          |
|  - row 1          |                                          |
|  - row 2          |                                          |
+-------------------+------------------------------------------+
| Status bar: user, role, faux server name, time                |
+--------------------------------------------------------------+
```

Common Controls to use: `ListView` for results and claims lists, `TabControl`
for detail tabs, and `TreeView` for the coverage hierarchy on the Coverage tab.

The **New FNOL flow must be implemented inside the main application window as a
single-window wizard panel**, not as a native `PropertySheet` and not as
separate modeless child windows. The wizard may visually show steps, but it
must keep a single stable top-level window title and a single predictable focus
path.

Do not use owner-drawn controls, custom-painted buttons, custom combo boxes,
floating tool windows, tray UI, or modeless popups in the primary demo path.

### Display requirements

- Must be usable at 1024×768 minimum.
- Must render correctly at 100%, 125%, and 150% Windows scaling.
- Use dialog units, system metrics, or responsive layout calculations rather
  than hard-coded pixel-only positioning where practical.
- Do not require GPU acceleration.

Visual tone: MS Sans Serif 8pt where the system allows, classic grey 3D borders,
no animations, no fade transitions. Deliberately flat "Windows 98". See the
**Audience engagement and visual realism** section below for the detailed look-
and-feel requirements — those requirements are mandatory, not aesthetic
suggestions, because audience engagement is what makes the demo land.

## Audience engagement and visual realism (CRITICAL)

The app must look and feel like a **real late-1990s / early-2000s claims
workstation** that a US insurance carrier might still be running today. The
audience is system integrators who implement CCaaS for insurers, banks,
telcos, utilities, and the public sector — they have personally seen real
Siebel, Guidewire on-prem, mainframe green screens, and dozens of bespoke
claims apps. **The more the app looks like what they recognize, the more they
emotionally engage with the demo and the more they project "this is exactly
what my customer runs" onto the screen.** It is fine that they know it is a
demo — but a demo that looks like a placeholder will not land.

### Things that make legacy apps feel real (MUST do)

- **Dense information layout.** Real legacy apps cram a lot into a window.
  Empty whitespace reads as unfinished. Aim for 60–70% visual density on every
  screen.
- **Real insurance terminology** in every label: *Insured Last Name*, *Loss
  Date/Time*, *Date of Report*, *Coverage A Limit*, *Deductible*,
  *Subrogation Status*, *Reserve Amount*, *Adjuster Assigned*, *Field Office*,
  *Coverage Verification*, *FNOL*, *BI/PD Split*, *Salvage Disposition*.
- **Realistic IDs everywhere.** Policy `POL-2024-008341`, claim
  `CLM-1998-000472`, agent `C1001`, adjuster `ADJ-NA-0142`, field office
  `FO-WST-014`, transaction `TXN-19980412-00318`. **Every record shows a
  visible ID column.**
- **Cryptic enterprise status codes** like `PEND-REVW`, `OPEN-ASGN`,
  `CLSD-PAID`, `CLSD-DEN`, `RSRV-INCR`, `SUBR-OPEN`, with a status-bar
  legend or tooltip explaining what they mean.
- **Multi-zone status bar** (not just a single text line): user name, role,
  terminal ID (`T-1001`), faux mainframe link status (`HOST: LINKED`), record
  count, system time. Real apps have status bars stuffed with information.
- **Full menu bar**, not just `File / Help`: **File / Edit / View / Records /
  Reports / Tools / Help**.
- **Toolbar with grey 16×16 bitmap icons** (basic flat bitmaps are fine —
  New / Open / Save / Print / Search / Refresh / Exit). The icons reinforce
  "this is a real production app."
- **Right-click context menus** on the customer record and claims list with
  enterprise-flavor actions: *Reassign…*, *Note…*, *Mark Suspicious*,
  *Print Record*, *Export to Excel…*, *Audit History…*.
- **Real-looking claim narratives in adjuster shorthand**, not
  marketing-friendly prose. Example seed narrative:
  > `CLMT REPORTS COLLISION AT INTRSXN OF 5TH & MAIN ON 04/12/1998 14:30. NO`
  > `INJ REPORTED. POL VEH (1995 FORD TAURUS) DAMAGED RR BUMPER & TAILGATE.`
  > `OTHER VEH (1996 HONDA CIVIC) F&S WITH MINOR FRONT DAMAGE. NO POLICE RPT`
  > `FILED. ADJ ASSGN: ADJ-NA-0142. RSRV SET: $4,200.00. SUBR-OPEN.`
- **Properly-formatted dollar amounts** everywhere: `$4,250.00`, `$1,000.00`,
  `$249,000.00`. Premiums look believable for the policy type and year.
- **Realistic dates / timestamps everywhere.** Policy effective
  `01/01/2024 – 12/31/2024`. Last modified by `C1001` on `04/15/1998 14:22:36`.
  Do **not** show 2026+ dates anywhere in seed data — the records are supposed
  to be from "the system of record."
- **Visible audit trail by default.** A read-only "Last Modified by … on …"
  footer on each tab. An Audit subtab/section on claim detail.

### Simulated legacy authentication flow (MUST do)

Legacy contact-center systems rarely have clean, single-step, SSO logins. What
the audience recognizes — and what makes them lean in — is the **friction
pattern** of legacy auth: multi-step logons, staged "host link" delays,
compliance banners, message-of-the-day modals, failed-attempt counters, idle
re-auth, and pre-shift "ready" gating. **All of this must be simulated entirely
in-app with timers, hard-coded text, and modal dialogs. No real identity
provider, no LDAP, no AD DS, no RADIUS, no SQL auth backend, no MSAL, no
Entra calls — the simulation IS the feature.**

The default startup sequence (unless flags below override it) must be:

1. **Splash** (~2 s) — *"Initializing host link…"* with deterministic-fill
   progress bar.
2. **Compliance banner modal** — full-text legal disclaimer
   (~6 lines of late-90s corporate intimidation copy), single **I Agree**
   button. The window cannot be closed any other way (no `X` close, no
   `Esc`-to-dismiss).
3. **Login screen** (the corporate teller login already specified above) —
   Agent ID, PIN, Workstation ID, Branch combobox, **Connect** button.
4. **Staged authentication progress dialog**, ~3–4 seconds total, showing
   sequential status lines (each appears in turn, prior ones stay visible):
   - `Establishing host link to WMHOST01 …`
   - `Validating credentials …`
   - `Loading user profile for A. CARTER …`
   - `Checking terminal authorization (T-1001) …`
   - `Loading menu permissions …`
   - `Synchronizing local cache …`
   - `Welcome, A. CARTER (CSR — Branch WST-014). HOST: LINKED.`
5. **Message of the Day modal** — a faux corporate notice with realistic
   operational content, e.g.:
   > *"NOTICE FROM CLAIMS OPERATIONS — 04/15/2024 06:00 EST*
   >
   > *Catastrophe event declared: Hurricane Donovan, FL region. All Florida*
   > *property claims must be escalated to the Catastrophe Unit (FO-FL-CAT)*
   > *for review prior to reserve setting. Standard SLAs are suspended for*
   > *affected ZIP codes through 04/30/2024.*
   >
   > *— Claims Ops Desk, ext. 7421"*

   Single **Acknowledge** button. Cannot be dismissed otherwise.
6. **Pre-shift Ready-to-Accept-Calls gate** — small modal: *"Ready to accept
   calls from queue? `[ Yes ]   [ No — Aux Code: ___ ]`"*. Selecting *No*
   requires picking an aux code (`BREAK`, `MEAL`, `TRAINING`, `OUTBOUND`,
   `TECH-ISSUE`). The selection is shown in the status bar and persisted to
   the audit log. Selecting *Yes* drops the user into the main workstation.
7. **Main workstation appears**, status bar showing `READY` (or aux code),
   `HOST: LINKED`, terminal ID, user, role, record count, system time.

### Ongoing simulated auth behaviors (while the app is running)

- **Failed-attempt counter on the login screen.** First wrong PIN:
  *"1 of 3 failed attempts."* Second: *"2 of 3 failed attempts. Account will
  be locked after the next failed attempt."* Third: *"Account locked. Contact
  your branch supervisor (ext. 7400)."* — followed by a 30-second cooldown
  during which the **Connect** button is disabled. The lockout state resets
  on next process launch (demo-friendly).
- **Forced PIN rotation prompt** that appears once per process lifetime after
  login, ~5 seconds in: *"Your PIN expires in 3 days. Change now?
  `[ Change Now ]   [ Remind Me Later ]`"*. *Change Now* shows a 3-field
  dialog (Old PIN / New PIN / Confirm) that always succeeds with a
  *"PIN updated successfully. Effective on next logon."* `MessageBox`.
  *Remind Me Later* dismisses with no effect.
- **Idle re-authentication.** After ~15 minutes of inactivity (configurable
  via `--idle-timeout=<sec>`; default `900`; `0` disables), pop a modal:
  *"Session has been idle. Please re-enter your PIN to continue.
  `[ PIN: ____ ]  [ Resume ]  [ Sign Off ]`"*. The main window stays visible
  but un-interactive behind the modal.
- **Host link "flutter."** Every ~3–5 minutes the status bar `HOST: LINKED`
  briefly changes to `HOST: RECONNECTING…` for ~1 second before returning to
  `LINKED`. Disable in test/demo runs via `--stable-host`.
- **Audit log entries** for every auth event: login attempt (success/fail),
  compliance acknowledgement, MOTD acknowledgement, ready-state change,
  re-auth prompt, PIN rotation prompt, sign-off. Written to the same
  `claims.log`.

### Authentication-simulation override flags

The legacy auth flow is great for partner-led demos but slows down
CUA-driven flows. Provide these flags so Roel can choose at demo time:

| Flag | Behavior |
| ---- | -------- |
| `--demo-pin=<pin>` | Skip the login screen entirely; auto-login as that PIN. Still shows compliance banner and MOTD unless those are also skipped. |
| `--skip-compliance` | Skip the compliance banner. |
| `--skip-motd` | Skip the message-of-the-day modal. |
| `--skip-ready-gate` | Skip the pre-shift ready-to-accept-calls modal; assume `READY`. |
| `--fast-auth` | Apply `--skip-compliance`, `--skip-motd`, `--skip-ready-gate`, and shorten the staged auth dialog to a single line shown for 200 ms. Equivalent to "I want CUA to log in immediately." |
| `--idle-timeout=<sec>` | Set the idle re-auth timeout in seconds. `0` disables. Default `900`. |
| `--stable-host` | Disable host-link flutter and any periodic UI changes. |

`--no-splash` (already defined) suppresses only the splash screen, not the
rest of the legacy auth flow.

**Important constraint:** all of the above is purely cosmetic / time-based
simulation. The app must not attempt to validate credentials against any
external service, must not call any identity API, must not query DNS for a
domain, must not open a network socket for auth, and must not require any
identity infrastructure to be installed in the demo environment.

### Splash / About box realism (MUST do)

- **Splash:** shown for ~2 seconds on startup unless `--no-splash` is passed.
  Big *"Zava Mutual"* wordmark, build number, `Initializing host link…`
  text, a deterministic-fill progress bar.
- **About box:** company wordmark, copyright
  `© 1998–2024 Zava Mutual Insurance Group, Inc.`, build number
  `Build 7.2.1.4427`, license expiry date, support phone
  `1-800-ZAVA`, three lines of legal mumble.
- **The splash and About box must include the small footer** *"Demonstration
  build — fictional data — not a real insurance system"* (the "visibly a
  demo" requirement). Keep it small, in 8pt grey, at the bottom — present
  enough for honesty, not so prominent it breaks the illusion.

### Things that break the illusion (MUST avoid)

- **Modern flat design** — no flat icons, no oversized typography, no card
  layouts, no rounded corners, no shadow effects.
- **Modern theming** — do not let Windows 11's modern theme paint over the
  controls. Use `InitCommonControlsEx` with classic appearance; do **not**
  ship a manifest that opts into visual styles theming.
- **Empty whitespace.** Reads as unfinished.
- **Lorem ipsum or `[ TODO ]` placeholders.** Every visible field shows
  realistic data, even read-only fields you don't think anyone will look at.
- **Future-dated data** (anything 2026+).
- **Single-action screens.** Real apps have 10 buttons where you only use 2.
  Show the others (greyed out or live with a "Not implemented in this demo
  build" `MessageBox`) for realism.
- **Marketing-style claim narratives.** Use adjuster shorthand, not full
  sentences.

## Seed data (embedded as `RCDATA`, exported to a local `data\` folder on first run)

Generate **100 customers, 140 policies, 220 claims (mix of open/closed), ~900
claim activity entries**. Data must feel late-1990s plausible:

- Customer names from a varied US census-style pool
- Phone numbers in `(NPA) NXX-XXXX` format
- Addresses across all 50 states
- Policy types: AUTO, HOME, RENTERS, UMBRELLA
- Coverage codes like `COLL-500`, `COMP-250`, `LIAB-100/300`, `DWELL-A`
- Loss types: COLLISION, THEFT, FIRE, WATER, WIND, LIABILITY, GLASS, VANDALISM
- Adjuster firms: invented 1990s-feel names (e.g., "Pacific Coast Adjusters")

Use a deterministic seed so the same demo replays identically every run. All
claim narratives must be written in **adjuster shorthand** (see the Audience
engagement and visual realism section above) and all dates must be in the
1998–2024 range — never future-dated.

### Hero records (MUST exist exactly, used by demo scripts and acceptance tests)

1. **Auto collision demo**
   - Customer: Jordan Smith
   - Phone: `(555) 123-4567`
   - Policy: `POL-2024-008341`
   - Policy type: AUTO
   - Loss type: COLLISION
   - Prefill summary: `Rear-ended at intersection of 5th and Main, no injuries`

2. **Home water damage demo**
   - Customer: Morgan Lee
   - Phone: `(555) 222-0198`
   - Policy: `POL-2024-002210`
   - Policy type: HOME
   - Loss type: WATER

3. **Fraud pattern demo**
   - At least three related claims with round-dollar losses and similar
     narratives, discoverable from the Claims tab by a Claims Manager.

These records must not change across runs or rebuilds.

## Workflows the app must support

1. **Policy / Caller Lookup** — search by phone, policy #, name, or claim #;
   results list selectable; double-click loads detail.
2. **Policy Tab** — customer info, policy effective dates, premium, billing
   status; read-only.
3. **Coverage Tab** — tree of coverages with limits, deductibles, endorsements;
   read-only.
4. **Claims Tab** — sortable list of prior claims; double-click opens claim
   detail inline in the main detail area or in a simple modal dialog. **The
   primary CUA demo path must remain single-window.**
5. **New FNOL — 5-step single-window wizard panel** with Next / Back / Cancel:
   1. *Incident* — date/time/location, loss type, narrative (multiline)
   2. *Vehicles / Property* — dynamic list, add/remove rows
   3. *Parties* — claimant, other parties, witnesses
   4. *Coverage Application* — pick which coverages apply, show deductible
   5. *Review & Submit* — read-only summary; a single primary button labeled
      **Submit Claim** (not "OK"). On click, assign `CLM-YYYY-NNNNNN` claim ID,
      show confirmation dialog with claim ID and "Copy to Clipboard".
6. **Notes Tab** — add INFO / WARNING / CRITICAL notes, timestamped, by-user.
7. **Actions menu** — Transfer Claim, Reassign Adjuster, Close Claim, Void
   Claim (manager), Reset All Data (manager).

## CUA-friendliness (CRITICAL — this is the whole point of the app)

The app must be exceptionally easy for a Computer Use Agent to drive.

### General requirements

- **Every interactive control has a stable, descriptive resource ID** in
  `resource.h` (e.g. `IDC_SEARCH_PHONE`, `IDC_FNOL_NARRATIVE`,
  `IDC_FNOL_SUBMIT`, `IDC_FNOL_RESULT_CLAIMID`). Do **not** auto-generate IDs
  that change between builds.
- **No timing-dependent UI** — no auto-dismissing toasts, no animated state
  changes. State transitions are instantaneous and visible.
- **Confirmation dialogs use standard `MessageBox`** with predictable button
  text (`OK`, `Cancel`, `Yes`, `No`) — no custom buttons.

### UIA reliability (standard controls only, no custom UIA provider)

- Use only standard Win32 / Common Controls for the primary demo path:
  `EDIT`, `BUTTON`, `STATIC`, `COMBOBOX`, `LISTVIEW`, `TREEVIEW`, `TABCONTROL`.
- No owner-drawn controls in the primary workflow.
- Every interactive control must have:
  - a stable numeric resource ID in `resource.h`;
  - unique visible text **or** an immediately adjacent unique static label;
  - deterministic tab order;
  - keyboard access path where practical.
- Prefer visible labels and standard control text over custom accessibility
  code. **Do not implement a custom UIA provider** unless absolutely necessary.
- The app must be usable entirely by keyboard for the primary demo path:
  login → search → open policy → start FNOL → next/previous pages → submit.
- Menu accelerators:
  - `Ctrl+F` or `Alt+S` focus search
  - `Alt+N` start New FNOL
  - `Alt+R` go to Review page
  - `Alt+U` submit claim when on the final page
- Avoid duplicate button captions on the same page. For example, prefer
  `Submit Claim` over a generic `OK` button in the main window.

### Result surfacing (the claim ID is the headline output)

The final claim ID must appear in **all three** places:

- a read-only edit/static control with resource ID `IDC_FNOL_RESULT_CLAIMID`
- the Windows clipboard (set automatically on submission success)
- the result JSON file (see Handoff contract below)

## Agent365 / CCaaS handoff contract

The app must support a **file-based local handoff contract** designed for an
agent running inside the same W365A Cloud PC session.

### Primary contract

- Input folder: `%ProgramData%\ZavaClaims\handoff\in\`
- Output folder: `%ProgramData%\ZavaClaims\handoff\out\`
- Agent365 or a local launcher script writes a flat JSON prefill file to the
  input folder.
- The app writes readiness, completion, and error files to the output folder.
- **All writes must be atomic:** write `*.tmp`, flush/close, then rename to
  final filename.

### Supported launch flags

- `--prefill=<path>` — load a specific JSON prefill file.
- `--handoff-dir=<path>` — use a handoff root containing `in\` and `out\`.
- `--result=<path>` — write final result JSON to this exact path.
- `--ready-file=<path>` — write readiness JSON after login, **all simulated
  legacy-auth screens (compliance, MOTD, ready-gate)**, prefill load, search
  completion, and UI stabilization.
- `--no-splash` — skip the startup splash dialog.
- `--demo-pin=<pin>` — optional demo-only auto-login for unattended smoke
  testing. Normal UI login must still work.
- `--skip-compliance` — skip the simulated compliance acknowledgement modal.
- `--skip-motd` — skip the simulated message-of-the-day modal.
- `--skip-ready-gate` — skip the simulated pre-shift ready-to-accept-calls modal.
- `--fast-auth` — composite shortcut: equivalent to `--skip-compliance`
  `--skip-motd` `--skip-ready-gate` plus a single 200 ms staged-auth dialog.
  Use for CUA-driven runs where the legacy auth flow is theatre, not the demo
  point.
- `--idle-timeout=<sec>` — set idle re-auth timeout in seconds; `0` disables.
  Default `900`.
- `--stable-host` — disable host-link flutter and any other periodic UI changes.
- `--reset-data` — delete and re-seed local data deterministically.
- `--prepare-demo-data` — create/export seed data ahead of time without showing
  the UI.
- `--test` — run the embedded data-layer test suite.

Do not rely on stdout for orchestration; GUI apps launched by
ShellExecute/shortcuts may not have a useful console. Do not use named pipes
for the demo path. Clipboard is a fallback for CUA, not the authoritative
result channel.

### Compatible agent platforms

The handoff contract is **deliberately agent-platform-agnostic**. The app does
not know or care which platform the calling agent runs on. The same `claims.exe`
must work end-to-end with all of:

1. **Azure AI Foundry agent managed by Agent365** (primary demo target).
   - The Foundry agent uses the Computer Use tool to drive the app inside a
     W365A Cloud PC.
   - Agent365 provides identity (Entra Agent ID), per-call Cloud PC
     provisioning, audit, and lifecycle.
   - The prefill JSON is written into the handoff folder either by Agent365
     during Cloud PC provisioning, or by the Foundry agent via a shell tool.
   - The Foundry agent waits on `ready.json` before starting to type, drives
     the FNOL wizard via CUA, then reads `result.json` to return the claim ID
     upstream.
2. **Copilot Studio agent with Computer Use** managed by Agent365.
3. **Any custom agent** (Python, Node, .NET) using the same handoff contract,
   for partners who want to bring their own orchestration.
4. **The bundled PowerShell `Invoke-ZavaHandoff.ps1` simulator** for
   local contract testing without any real agent platform.

The coding agent must not add platform-specific code paths to the app for any
of the above. The handoff folder + CLI flags ARE the integration surface.

### Schemas

The authoritative schemas live at `..\..\schemas\*.json` (monorepo-root
`schemas/` folder) — read them before producing the JSON I/O code and prefer
them over the inline examples below if they ever differ. Reference files:
`prefill.schema.json`, `ready.schema.json`, `result.schema.json`,
`error.schema.json`. The CCaaS Agent Desktop produces `call-context` and the
local orchestrator translates that to `prefill` before it lands in your
handoff folder — you only need to consume `prefill` and produce
`ready`/`result`/`error`.

**Input (prefill) JSON example:**
```json
{
  "request_id": "REQ-2025-0001",
  "caller_phone": "(555) 123-4567",
  "policy_number": "POL-2024-008341",
  "intent": "auto_collision",
  "summary": "Rear-ended at intersection of 5th and Main, no injuries",
  "requested_by": "ccaas-demo"
}
```

**Ready JSON:**
```json
{
  "request_id": "REQ-2025-0001",
  "status": "ready",
  "window_title": "Zava Mutual — Claims Workstation v1.0",
  "matched_policy_number": "POL-2024-008341",
  "timestamp": "2025-01-01T12:00:00Z"
}
```

**Result JSON:**
```json
{
  "request_id": "REQ-2025-0001",
  "status": "submitted",
  "claim_id": "CLM-2025-000123",
  "agent_id": "C1001",
  "policy_number": "POL-2024-008341",
  "timestamp": "2025-01-01T12:03:00Z"
}
```

**Error JSON:**
```json
{
  "request_id": "REQ-2025-0001",
  "status": "error",
  "error_code": "POLICY_NOT_FOUND",
  "message": "No matching policy found for caller_phone or policy_number.",
  "timestamp": "2025-01-01T12:01:00Z"
}
```

## Live demo reliability requirements

The app must be reliable in a short-lived W365A Cloud PC session.

- Startup must not require admin rights, UAC prompts, network access, COM
  registration, external services, browser sign-in, or first-run setup dialogs.
- The app must run correctly from either:
  - `C:\ZavaClaims\claims.exe`, or
  - a portable folder such as `%LOCALAPPDATA%\ZavaClaims\claims.exe`.
- `--no-splash` must suppress splash/about/startup dialogs (does **not**
  suppress the simulated legacy-auth flow — use `--fast-auth` or the
  individual `--skip-*` flags for that).
- `--ready-file=<path>` must be written only after:
  - the main window exists;
  - login is complete (whether interactive or via `--demo-pin`);
  - the compliance banner, message-of-the-day, and ready-to-accept-calls
    modals have been acknowledged or skipped;
  - the staged authentication progress dialog has completed;
  - prefill was loaded (if any);
  - the matching policy/customer is visible;
  - the New FNOL tab/wizard is ready for CUA input.
- Result files must be written **locally first**. Do not write directly to a UNC
  path as the primary live-demo path.
- Default log location:
  - `%ProgramData%\ZavaClaims\logs\claims.log`,
  - with fallback to `%LOCALAPPDATA%\ZavaClaims\logs\claims.log` if
    ProgramData is not writable.

## Distribution and packaging

**Portable-first deployment is mandatory.**

### Required

- `claims.exe` must run from any writable local folder without installation.
- `Install.ps1` and `Uninstall.ps1` install/remove the app under
  `C:\ZavaClaims\`.
- `Install.ps1` must support non-interactive execution and must not require
  network access.
- Create Desktop + Start Menu shortcut named **"Zava Claims"**.
- `Detect.ps1` for Intune-style detection.
- Produce `ZavaClaims.zip` for manual or image-bake deployment.

### Optional release artifact

- `ZavaClaims.intunewin` may be produced when the Microsoft Intune Win32
  Content Prep Tool is available. **Failure to produce `.intunewin` must not
  block local build/test success.**

Document three deployment paths in `INTEGRATION.md`:

1. Portable copy into a prepared Cloud PC or golden image.
2. `Install.ps1` during image bake/provisioning.
3. Intune Win32 app deployment using `.intunewin`.

## Documentation to produce

- `README.md` — replace the spec-only stub: what it is, screenshot, build,
  install, run, login PINs, link to `WORKFLOWS.md`, link to `INTEGRATION.md`,
  tech stack, release history, license.
- `WORKFLOWS.md` — six scripted demo workflows, each a numbered click-by-click
  list with exact field values to type. Mandatory:
  1. Inbound call — auto policy holder (Jordan Smith, `(555) 123-4567`) reports
       collision, agent files FNOL **(full legacy auth flow visible — compliance
       banner, staged "Establishing host link", MOTD, ready-gate)**
  2. Inbound call — homeowner (Morgan Lee) reports water damage, escalated to
     Senior CSR
  3. Fraud investigation — Manager reviews suspicious pattern across 3 claims
  4. Reassign adjuster on an open claim
  5. Add a CRITICAL note and transfer the claim
  6. Reset and reseed for a fresh demo run
- `INTEGRATION.md` — how the app fits into a CCaaS handoff:
  - The handoff folder convention (`in\` / `out\`)
  - The CLI flag reference
  - The prefill / ready / result / error JSON schemas
  - Sample Agent365 webhook payload that would produce a prefill file
  - Recommended W365A image-bake steps
  - CUA selector reference (full list of stable control IDs)
- `ACCESSIBILITY.md` — full tab order, MSAA roles, list of every stable control
  ID and what it represents.
- `LICENSE` — MIT.
- `CONTRIBUTING.md` — short.
- `samples/agent365-handoff/` — local handoff simulator:
  - `sample-request.json`
  - `Invoke-ZavaHandoff.ps1`
  - `README.md`
- `samples/foundry-agent/` — starter assets for an Azure AI Foundry agent
  managed by Agent365 (these are *templates* the agent author will adapt;
  the app itself does not depend on them). **The agent guidance is split
  into three files to optimize token usage** — Knowledge is retrieved on
  demand, Instructions are always in context:
  - `KNOWLEDGE.md` — reference data the agent searches when needed:
    hero records, policy structure, status codes, coverage codes, the
    five FNOL wizard pages and what each field expects, MOTD aux codes,
    sample claim narratives in adjuster shorthand. **Uploaded to the
    agent as a Knowledge file**, not pasted into Instructions.
  - `AGENT-INSTRUCTIONS.md` — always-in-context persona and behavior:
    role ("you are a claims-intake AI agent picking up a CCaaS call"),
    objective (file an FNOL and return the claim ID), decision framework
    (when to ask for clarification vs proceed, when to abort vs retry),
    communication style with the upstream voicebot, escalation rules.
  - `CUA-TOOL-INSTRUCTIONS.md` — always-in-context UI-navigation guide:
    handoff folder convention, exact CLI to launch `claims.exe`, how to
    wait on `ready.json`, the stable control IDs from
    `ACCESSIBILITY.md`, the five FNOL pages step-by-step with the exact
    field-by-field actions, modal-popup recovery (compliance, MOTD,
    ready-gate, idle re-auth, host-link flutter), how to read
    `result.json` and return the claim ID upstream, error-code handling
    for `POLICY_NOT_FOUND` / `COVERAGE_NOT_APPLICABLE` / `SUBMISSION_REJECTED`.
  - `tools/` — sample Foundry tool definitions in JSON:
    - `launch-claims-app.json` — shell tool that runs `claims.exe` with
      `--prefill`, `--result`, `--ready-file`, `--fast-auth`,
      `--demo-pin=1234`, `--no-splash`.
    - `wait-for-file.json` — polls for a file path with timeout.
    - `read-json-file.json` — reads a JSON file and returns parsed content.
  - `sample-call-context.json` — example call context payload Agent365
    would hand to the agent (caller_phone, policy_number, intent,
    summary, transcript_excerpt).
  - `evaluations/` — CSV test batches for the Copilot Studio /
    Foundry Evaluation feature so Roel can validate the agent
    end-to-end against the legacy app **before** a live partner
    demo. Mirror the cobol-banker-demo pattern:
    - `evaluation-1-smoke.csv` — 5 tests: launch, login, hero record
      lookup, basic policy detail, claim list visibility.
    - `evaluation-2-readonly.csv` — 7 tests: search by phone /
      policy / name / claim #, coverage tree navigation, prior-claims
      detail, error handling for unknown policy.
    - `evaluation-3-write.csv` — 7 tests: end-to-end FNOL submission
      for collision / water damage / glass / liability, plus add
      INFO/WARNING/CRITICAL notes, plus claim reassignment.
    - `evaluation-4-compound.csv` — 4 tests: multi-step (file FNOL
      then add a CRITICAL note then reassign adjuster), behavioral
      guardrails (refuse to submit over CSR limit, escalate fraud
      pattern to manager), recovery from a forced PIN-rotation modal
      mid-flow, recovery from a `POLICY_NOT_FOUND` error.
  - `README.md` — explains how to drop these into a Foundry (or
    Copilot Studio) agent project, wire them to the Computer Use tool,
    and run an end-to-end test inside a W365A Cloud PC managed by
    Agent365. Must include:
    - **Model recommendations:** Claude Sonnet 4.5 / 4.6 OR GPT-4.1
      (fast vision, strong instruction-following). **Do NOT** use
      reasoning-class models (GPT-5 Reasoning, Claude Opus) — they
      add latency with no benefit for UI navigation, since this is a
      vision-heavy, instruction-following task.
    - **Disable web search on the agent.** Adds latency, risks
      injecting irrelevant context, and is a compliance concern in any
      regulated-industry demo narrative.
    - **Stale-connection refresh tip:** the Windows 365 / CUA
      connection token expires when the Cloud PC session disconnects
      or restarts. Before each demo, go to Settings → Connections in
      the agent platform and refresh the Windows 365 connection.
    - Which steps the agent author still has to complete in their own
      tenant (Computer Use enablement on the Cloud PC, Agent365
      identity binding, CCaaS webhook).

The PowerShell simulator must:
1. create a handoff folder;
2. write `sample-request.json`;
3. launch `claims.exe` with `--prefill`, `--result`, `--ready-file`,
   `--no-splash`, and optionally `--demo-pin=1234`;
4. wait for the ready file;
5. instruct the human/CUA to complete the wizard;
6. wait for result JSON;
7. print the claim ID to the console.

This is **not** the real Agent365 driver. It is a local contract test for the
app/agent seam.

## Acceptance criteria

### Must pass for demo build

1. `build.bat` on Windows produces `claims.exe`.
2. `claims.exe --test` runs deterministic data/model tests, all pass, exit
   code 0. Target 40+ tests; 60+ preferred but not required for the first
   demo build.
3. `claims.exe --prepare-demo-data --reset-data` creates deterministic local
   data.
4. `claims.exe --prefill=samples\agent365-handoff\sample-request.json
   --result=out\result.json --ready-file=out\ready.json --no-splash
   --demo-pin=1234 --fast-auth` launches, fast-paths the simulated auth flow,
   loads the matching policy, writes `ready.json`, and allows a user/CUA to
   submit a claim.
5. Submitting the FNOL creates a claim ID matching `CLM-\d{4}-\d{6}`.
6. The claim ID is visible in `IDC_FNOL_RESULT_CLAIMID`, copied to clipboard,
   AND written to the result JSON.
7. The primary workflow works in **one top-level app window** using standard
   controls and deterministic tab order.
8. `Install.ps1` installs locally to `C:\ZavaClaims\` without network
   access and without UAC prompts when run in an elevated context.

### Should pass for release hardening

1. `build.sh` builds/tests on Linux/Wine if feasible.
2. Build uses `-Wall -Wextra`; warnings should be fixed where practical.
3. GitHub Actions builds on push and uploads `ZavaClaims.zip`.
4. `.intunewin` packaging works when the Intune Win32 Content Prep Tool is
   present.
5. README includes a screenshot.
6. `ACCESSIBILITY.md` lists tab order and stable control IDs.
7. `INTEGRATION.md` documents portable, image-bake, and Intune deployment
   paths.

## Non-goals (do NOT do these)

- Do not use C++, .NET, WPF, WinUI, Electron, or any web tech.
- Do not add a real network stack — no HTTP client in the app itself.
- Do not implement real authentication, encryption, or PII handling — this is
  a demo with fictional data.
- Do not add localization beyond en-US.
- Do not pretend to be a real insurer. Branding is **Zava Mutual** (the
  Microsoft fictional brand) and the splash explicitly says
  "Demonstration build".
- Do not add real CCaaS, Agent365, or CUA automation logic in this repo. CUA
  scripting lives in the agent / Agent365 side. This repo may include a local
  PowerShell handoff simulator that writes prefill JSON, launches the app,
  waits for ready/result files, and prints the claim ID.
- Do not implement a custom UIA provider, named pipes, stdout-based protocol,
  or custom URL handlers.
- Do not require domain join, Active Directory, a Domain Controller,
  Kerberos, NTLM domain auth, LDAP, Group Policy, Entra Connect, or hybrid
  identity. The app must run on a stock Entra-joined or workgroup Windows
  machine with nothing else installed.
- Do not call Microsoft Graph, MSAL, Entra ID, Azure AD B2C, or any cloud
  identity service. Real auth is faked entirely in-app.

## Deliverables checklist

- [ ] Complete source tree (`src/`, `res/`, `data/`, `tests/`, `samples/`,
      `installer/`, `.github/workflows/`)
- [ ] `build.bat` (and `build.sh` if feasible)
- [ ] Reproducible `claims.exe` artifact
- [ ] All documentation listed above
- [ ] Seed data CSVs embedded as `RCDATA` and exported to `data\` on first run
- [ ] Hero records exactly as specified
- [ ] `samples/agent365-handoff/sample-request.json`,
      `Invoke-ZavaHandoff.ps1`, `README.md`
- [ ] `samples/foundry-agent/agent-instructions.md`, `tools/*.json`,
      `sample-call-context.json`, `README.md`
- [ ] `Install.ps1`, `Uninstall.ps1`, `Detect.ps1`
- [ ] GitHub Actions workflow producing `ZavaClaims.zip` (and `.intunewin`
      if tooling is available) on tag push
- [ ] MIT `LICENSE`
- [ ] Leave the repository in a complete, buildable state. **Do not commit,
      push, or tag yourself** — Roel will review and push manually.
