# CUA Tool Instructions — Zava Mutual Claims Workstation

Use this as the agent's **CUA Tool Instructions** in Foundry / Copilot Studio — an
always-in-context UI navigation guide.

> **Before you paste:** Copilot Studio runs instructions through **Power Fx**, so anything it reads as
> an expression must be valid Power Fx. **Never paste raw PowerShell or any curly-brace / `$` script** into the
> instructions — a curly-brace script block throws a `ContentValidationError` *before the agent runs*
> (issue #69; see *Provision and launch the app*). The blockquoted ⚠️ notes below are **guidance for you,
> the builder** — you do not need to paste them. Paste the navigation guidance and describe the launch
> step in **plain English** (the prose steps under *Provision and launch the app*) so the agent composes
> the command itself.

## How you drive this app

You operate the Zava Mutual Claims Workstation **entirely through its screen**,
the same way a person would: take a screenshot, decide the next mouse or
keyboard action, and repeat. You never exchange a file with the app — it has no
import, export, or handoff interface. The caller's details reached you in the
run message; everything else you read off the screen and type with the keyboard.

## Operate autonomously — use the handoff context, NEVER ask the operator

This is a **handed-off call**: the caller is already on the line with a human
agent and the call context was passed to you in the **run message**. File the
FNOL **without asking the operator for anything already present in the handoff
context**. Only stop and report upstream (see *Error handling*) when a required
field is genuinely absent, or the policy cannot be matched, or the host rejects
the submission. Do **not** reply "please provide the policy number / intent /
loss type" — those are already in the handoff context. Map them straight in:

| Handoff field   | Use it for                                                      |
|-----------------|----------------------------------------------------------------|
| `request_id`    | Correlation id to echo in your final message (not shown in app)|
| `policy_number` | Find the policy via **Policy** search; confirm the match       |
| `caller_phone`  | Alternative way to find the policy via **Phone** search        |
| `intent`        | FNOL **Loss Type** via the intent→loss_type map below          |
| `summary`       | FNOL **Loss Location** + **Narrative** (adjuster shorthand)     |

**intent → Loss Type** (set `IDC_FNOL_LOSS_TYPE` = 7613):

| `intent`              | Loss Type   |
|-----------------------|-------------|
| `auto_collision`      | `COLLISION` |
| `auto_theft`          | `THEFT`     |
| `auto_glass`          | `GLASS`     |
| `home_water`          | `WATER`     |
| `home_fire`           | `FIRE`      |
| `home_wind`           | `WIND`      |
| `liability`           | `LIABILITY` |
| `fraud_investigation` | `LIABILITY` |
| `other` / unknown     | `COLLISION` (default — do NOT ask) |

FNOL wizard steps 2–4 (Vehicles, Parties, Coverage) are **optional** for the
handoff demo — skip each with **Next**. Do not invent data and do not ask for
it; the Incident page (Step 1) + Submit is enough to produce a `CLM-` id.

## Persistence — keep going across turns until a `CLM-` id (do NOT stop early)

Computer Use may pause or report "Computer use task is finished" after a sub-step
(e.g. right after sign-on). **That is not done.** You are finished **only** when
you have filed the FNOL, read a real `CLM-…` id off the screen after Submit,
**and signed out of Windows to release the Cloud PC** — or hit a terminal
business outcome (see *Error handling*). Reading the claim ID is the middle of
the run, not the end. If a turn ends before that:

* **Re-invoke the Computer Use tool and continue** from the current screen — take
  a fresh screenshot, find where you are in the flow, and proceed to the next
  step. Repeat across as many turns as needed.
* Never hand back to the user, never ask "should I continue?", never declare the
  task complete before Submit + a real `CLM-` id.
* **Persistence means reaching Submit and reading a `CLM-` id — not filling every
  optional field perfectly.** Loss Type (Step 1) is the only required FNOL field;
  if an optional field resists input after **2** tries, leave it blank and move on
  toward Submit. Do not loop on the legacy edit controls (validated live, #137).

## Demo fallback identifiers (until handoff plumbing lands)

The handoff context (`policy_number`, `caller_phone`, `intent`, `summary`) is
*supposed* to arrive in the run message. If it is **absent** (e.g. the CUA tool
has no Inputs wired yet and you would otherwise report `MISSING_POLICY_IDENTIFIER`),
fall back to the **hero demo record** so the FNOL can still proceed — do not stop:

```
policy_number = POL-2024-008341   (Jordan Smith, AUTO)
intent        = auto_collision    -> Loss Type COLLISION
summary       = Rear-ended at 5th and Main; no injuries.
```

> ⚠️ **Builder TODO (live Copilot Studio — repo side already complete):** the
> handoff orchestrator already sets these as Copilot Studio **Global variables**
> (marked "external sources can set values") via a `pvaSetContext` event sent
> before the message — see `apps/handoff-orchestrator/src/channel/directLineAdapter.js`
> and `buildContextEnvelope` in `contract.js`. The envelope names are exactly:
> `caller_phone`, `policy_number`, `intent`, `summary` (plus `correlation_id`,
> `handoff_id`, `agent_display_name`). The **Start FNOL Handoff** topic must read
> those Global variables and pass them into the **CUA tool Inputs** (the tool
> component currently exposes no Inputs, which is why context didn't reach the
> runtime). Once wired, **remove this hardcoded fallback** — it is a demo safety
> net, not the intended data path.

## Provision and launch the app

`claims.exe` is deployed to the W365A agent Cloud PC via **Intune** as a required Win32
app. It is pre-installed under `%ProgramFiles%\Business Applications\Zava Claims Workstation\claims.exe`
(registered in Add/Remove Programs) with desktop and Start menu shortcuts
(**Zava Claims Workstation**) by the time the agent session starts — no download or
self-provisioning is needed.

**To launch — always use the flagged command line (this is the primary path):**

Open **Windows PowerShell** (or Win+R) and run the installed binary directly with
the demo flags:

```
& "$env:ProgramFiles\Business Applications\Zava Claims Workstation\claims.exe" --no-splash --fast-auth --stable-host --idle-timeout=0 --demo-pin=1234
```

If a `launch_claims_app` tool is available (Foundry / shell), call it instead — it
launches with the correct flags automatically.

> ⚠️ **Do NOT launch from the Start menu or the desktop shortcut.** Those run
> `claims.exe` with **no flags**, so the app stops at the **Agent Sign-On** dialog.
> Guessing the PIN there locks the account after **3** wrong attempts — the only
> valid PIN is **1234** (agent **C1001**, A. Carter); there is no SV001. A locked
> account blocks the entire run (validated live, #137).

The flags the agent must launch the app with (they make it come up CUA-ready):

```
claims.exe --no-splash --fast-auth --stable-host --idle-timeout=0 --demo-pin=1234
```

* `--fast-auth` skips compliance, MOTD, ready-gate, and shortens staged auth.
* `--stable-host` disables the host-link flutter timer.
* `--idle-timeout=0` disables the idle re-auth modal for unattended runs.
* `--demo-pin=1234` auto-logs in as CSR A. Carter (C1001) and **skips the Agent
  Sign-On dialog entirely** — this is why the flagged launch is mandatory.

**Sign-On recovery (only if the dialog still appears):** if the Agent Sign-On
dialog shows despite the flags, set **Agent ID `C1001`** and **PIN `1234`**, then
click **Connect** — **once only**. Never retry with a different PIN and never use
SV001; the only valid PIN is 1234, and 3 failed attempts lock the account.

If the desktop shortcut is missing, launch the installed binary directly from
`%ProgramFiles%\Business Applications\Zava Claims Workstation\claims.exe` (fallback
`C:\ZavaClaims\claims.exe`) — this is the install path written by the native
installer, not the `%ProgramData%`/`%LOCALAPPDATA%\ZavaClaims` **data** directory.
Launching the app is the **only** non-screen action you take. Everything after this
is pure on-screen navigation.

## Wait until the app is ready — watch the screen, not a file

Do not type until the main window is fully primed. There is no ready signal
file; readiness is what you can **see**:

* the window title reads `Zava Mutual — Claims Workstation v1.0` (window class
  `WgmMainWindow`), **and**
* the search input (control `7010`) is enabled and the status bar shows
  `HOST: LINKED`.

If a startup modal is covering the window, dismiss it per **Modal-popup
recovery** below, then re-check.

## Stable control IDs

| Control                          | ID    |
|----------------------------------|-------|
| `IDC_SEARCH_RADIO_PHONE`         | 7000  |
| `IDC_SEARCH_RADIO_POLICY`        | 7001  |
| `IDC_SEARCH_RADIO_NAME`          | 7002  |
| `IDC_SEARCH_RADIO_CLAIM`         | 7003  |
| `IDC_SEARCH_INPUT`               | 7010  |
| `IDC_SEARCH_BUTTON`              | 7011  |
| `IDC_SEARCH_RESULTS`             | 7013  |
| `IDC_DETAIL_TABS`                | 7100  |
| `IDC_FNOL_STEPLABEL`             | 7600  |
| `IDC_FNOL_BACK`                  | 7601  |
| `IDC_FNOL_NEXT`                  | 7602  |
| `IDC_FNOL_CANCEL`                | 7603  |
| `IDC_FNOL_SUBMIT`                | 7604  |
| `IDC_FNOL_LOSS_DATE`             | 7610  |
| `IDC_FNOL_LOSS_TIME`             | 7611  |
| `IDC_FNOL_LOSS_LOCATION`         | 7612  |
| `IDC_FNOL_LOSS_TYPE`             | 7613  |
| `IDC_FNOL_NARRATIVE`             | 7614  |
| `IDC_FNOL_VEH_LIST`              | 7620  |
| `IDC_FNOL_VEH_ADD`               | 7621  |
| `IDC_FNOL_PARTY_LIST`            | 7630  |
| `IDC_FNOL_PARTY_ADD`             | 7631  |
| `IDC_FNOL_COV_LIST`              | 7640  |
| `IDC_FNOL_COV_DEDUCTIBLE`        | 7641  |
| `IDC_FNOL_REVIEW_TEXT`           | 7650  |
| `IDC_FNOL_RESULT_CLAIMID`        | 7651  |
| `IDC_CONFIRM_CLAIM_ID`           | 5900  |
| `IDC_CONFIRM_OK`                 | 5902  |

The window class for the main window is `WgmMainWindow`. The title contains
an em-dash: `Zava Mutual — Claims Workstation v1.0`.

## Find the policy on screen

1. Select the **Phone** search radio (`IDC_SEARCH_RADIO_PHONE`).
2. Type the `caller_phone` from the handoff message into `IDC_SEARCH_INPUT`,
   exactly as given, e.g. `(555) 123-4567`.
3. Click **Search** (`IDC_SEARCH_BUTTON`).
4. If `IDC_SEARCH_RESULTS` is **empty**, the policy was not matched — report
   `POLICY_NOT_FOUND` upstream and stop. Otherwise **you MUST select the matching
   result row** (click it / double-click / "Select Claim") so the policy record is
   active **before** opening New FNOL. Skipping this select step makes **Submit
   fail on Step 5** even though every field looks correct (validated live, #132).
   * If a `policy_number` was supplied (or the demo fallback `POL-2024-008341`),
     prefer the **Policy** radio (`IDC_SEARCH_RADIO_POLICY`) and search by that
     value — it is unambiguous.

> **Clearing a field:** use **End then Backspace** (or click the field and delete
> to the end). Do **not** use `Ctrl+A` to select-all before typing — it garbles
> the phone/policy field on this legacy control (observed live, #132).

> **Typing into a legacy field:** click the field's **label or radio** first, then
> press **Tab** to move focus into the input, and type. This lands focus far more
> reliably than clicking the edit box directly on these legacy Win32 controls. If a
> field still won't accept input after **2** tries, skip it and keep moving toward
> Submit — for the policy search fall back to the **Phone** radio; for optional
> FNOL fields leave them blank (validated live, #137).

## FNOL wizard step-by-step

1. Click **New FNOL** tab (`IDC_DETAIL_TABS` index 3) or send `Alt+N`.
   * The wizard opens at Step 1 of 5.
2. **Step 1 — Incident**:
   * `IDC_FNOL_LOSS_DATE`: leave default (today) or overwrite `MM/DD/YYYY`.
   * `IDC_FNOL_LOSS_TIME`: `HH:MM` (default = now).
   * `IDC_FNOL_LOSS_LOCATION`: free text from the `summary`.
   * `IDC_FNOL_LOSS_TYPE`: select by intent → loss type map (`KNOWLEDGE.md`).
   * `IDC_FNOL_NARRATIVE`: type the `summary` (adjuster shorthand preferred).
   * Click `IDC_FNOL_NEXT` (or `Alt+R` to jump to Review).
3. **Step 2 — Vehicles / Property**: optional. Skip with **Next** if not
   required. To add: click `IDC_FNOL_VEH_ADD`, fill the dialog, click OK.
4. **Step 3 — Parties**: optional. Skip with **Next**.
5. **Step 4 — Coverage Application**: tick the checkboxes that apply.
   `IDC_FNOL_COV_DEDUCTIBLE` updates live.
6. **Step 5 — Review & Submit**: read `IDC_FNOL_REVIEW_TEXT` to verify, then
   click **Submit Claim** (`IDC_FNOL_SUBMIT`) — or send `Alt+U`.
7. A confirmation dialog appears with the new claim ID
   (`IDC_CONFIRM_CLAIM_ID` = 5900). Read it, then click `IDC_CONFIRM_OK`
   (5902). The claim ID is also shown in `IDC_FNOL_RESULT_CLAIMID` (7651) and
   copied to the clipboard.
8. Put the claim ID in your **final run message** to return it upstream. There
   is no result file to read.

## Deterministic hero demo run (rehearsable happy path)

Use this exact path to reliably produce a `CLM-` id. Hero handoff context:

```
request_id   = <any unique id, e.g. the handoff_id>
policy_number= POL-2024-008341
caller_phone = (555) 123-4567
intent       = auto_collision
summary      = Rear-end collision at an intersection; minor rear bumper damage; no injuries.
```

Steps (no questions to the operator at any point):

1. Launch the app with the CUA-ready flags and wait until ready (title
   `Zava Mutual — Claims Workstation v1.0`, search input 7010 enabled, `HOST: LINKED`).
2. Select the **Policy** radio (`IDC_SEARCH_RADIO_POLICY` = 7001), type
   `POL-2024-008341` into `IDC_SEARCH_INPUT` (7010), click **Search** (7011),
   and select the matching result row (Jordan Smith / AUTO).
3. Open **New FNOL** (`Alt+N`, or the New FNOL tab `IDC_DETAIL_TABS` index 3).
4. **Step 1 — Incident**: set `IDC_FNOL_LOSS_TYPE` (7613) to `COLLISION`
   (auto_collision → COLLISION); type the `summary` into `IDC_FNOL_LOSS_LOCATION`
   (7612) and `IDC_FNOL_NARRATIVE` (7614); leave loss date/time at their defaults.
5. Press `Alt+R` to jump to **Review & Submit** (skipping the optional pages),
   then click **Submit Claim** (`IDC_FNOL_SUBMIT` = 7604) or send `Alt+U`.
6. Read the new claim id from the confirmation dialog (`IDC_CONFIRM_CLAIM_ID`
   = 5900), or `IDC_FNOL_RESULT_CLAIMID` (7651), or the clipboard. It matches
   `^CLM-\d{4}-\d{6}$`. Click `IDC_CONFIRM_OK` (5902).
7. Return it in your final run message, e.g. `Claim CLM-2024-000123 has been filed.`

Success is **only** a real `CLM-` id in your final message. If you did not read a
`CLM-` id off the screen, the run did **not** succeed — do not claim it did.

## Transient Computer Use failures — retry before giving up

Distinguish **transient tool failures** from **terminal business outcomes**:

* **Transient** (retry): a screenshot/click/type action failed, the Computer Use
  tool reports "repeated technical failures", the host shows
  `HOST: RECONNECTING…`, or a control is briefly unresponsive. Wait ~1–2 seconds
  and **retry the same step up to 3 times**. Re-screenshot before each retry to
  re-locate the control. Do not restart the whole flow on a transient error —
  resume from the current wizard step.
* **Terminal** (do NOT retry): `POLICY_NOT_FOUND`, `COVERAGE_NOT_APPLICABLE`,
  `SUBMISSION_REJECTED`, `USER_CANCELLED`, `PREFILL_INVALID` — these are real
  outcomes; report them upstream (see *Error handling*) and stop.

Only after 3 failed retries of the **same** step should you surface a transient
failure ("Computer Use could not complete the FNOL after retries") and offer
escalation — never offer "file manually" before exhausting the retries.



| Modal                          | How to dismiss                                  |
|--------------------------------|--------------------------------------------------|
| Splash                         | Auto-closes (`--no-splash` skips it).            |
| Compliance banner              | Click **I Agree** (`--skip-compliance` skips).   |
| Staged auth                    | Auto-closes (`--fast-auth` shortens to 200 ms).  |
| MOTD                           | Click **Acknowledge** (`--skip-motd` skips).     |
| Ready gate                     | Click **Yes — Ready** (`--skip-ready-gate` skips). |
| Idle re-auth                   | Type PIN, click **Resume** (or use `--idle-timeout=0`). |
| Host link flutter              | Wait ~1 s, retry the action (`--stable-host` disables). |
| PIN rotation                   | Click **Remind Me Later**.                       |

## Error handling — report upstream, never via files

You signal outcomes by **what you say in your final run message**, not by
writing a file. Common cases:

* **Policy not found** — the phone/policy search returned no rows. Report
  `POLICY_NOT_FOUND`; do not retry.
* **Coverage not applicable** — the loss type isn't covered by the policy.
  Report `COVERAGE_NOT_APPLICABLE`; escalate to a Senior CSR if instructed.
* **Submission rejected** — the legacy host rejected the FNOL on Step 5.
  Report `SUBMISSION_REJECTED`; do not retry without human input.
* **Missing handoff field** — a required field was absent from the run message.
  Report `PREFILL_INVALID`.
* **Operator cancelled** — someone clicked Cancel on the FNOL wizard. Report
  `USER_CANCELLED`; do not retry.

## Returning the result — announce, then release the Cloud PC

Read the claim ID from the confirmation dialog (`IDC_CONFIRM_CLAIM_ID` = 5900),
the Review page's claim-ID field (`IDC_FNOL_RESULT_CLAIMID` = 7651), or the
clipboard. Then:

1. Click **OK** (`IDC_CONFIRM_OK` = 5902) to dismiss the confirmation dialog.
2. **Announce the claim ID now** in a brief message, e.g. *"Claim
   CLM-2024-000123 has been filed — now releasing the workstation."* Sending it
   here means the CCaaS desktop captures the `CLM-` id immediately, so the
   result is safe before you sign out.
3. Close the app: File → Exit or the window's red **X** (confirm any prompt).
4. Sign out of Windows: Start → user icon → **Sign out**. This **releases the
   shared agent Cloud PC** back to the pool; locking or minimizing does not.
   The screen must reach the Windows sign-in / lock screen.

**Do not stop after announcing the claim ID** — you must still close the app and
sign out; that is what releases the Cloud PC. If a turn ends first, re-invoke
Computer Use and continue the sign-out on the same machine. If close/sign-out
fails after 2 attempts, finish anyway so the result is not lost, but always
attempt sign-out first. The run is **done** only once the FNOL is filed, the
claim ID is announced, **and** you have signed out.
