# Copilot Studio agent configuration (MCS path)

This page holds the exact configuration of the Copilot Studio agent that files the claim on
the MCS path: the **agent instructions**, the **Computer use tool inputs** and the
**Computer use tool instructions**. The agent is the one started by the handoff service's
Dataverse trigger (see the installation guide). The agent uses Claude Sonnet 4.6; the
Computer use tool uses Claude Sonnet 4.5 and a Copilot Studio hosted Cloud PC pool.

The tool text is not the same as the Foundry guide
([CUA-TOOL-INSTRUCTIONS.md](../apps/legacy-claims-workstation/samples/foundry-agent/CUA-TOOL-INSTRUCTIONS.md)).

## How to apply it

Either way, the agent must already exist with generative orchestration on, authentication
required, and a **Computer use** tool pointed at your Cloud PC pool.

- **By script (recommended):** `scripts/mcs/publish_mcs_agent_config.py` reads the two
  text blocks below from this file, backs up the live agent and tool definitions, writes only those
  two texts, publishes the agent and reads it back to confirm. See the comment at the top of
  the script for its options; run it with `--dry-run` first.
- **By hand in Copilot Studio:**
  1. **Overview → Instructions:** paste the agent instructions.
  2. **Tools → Computer use → Instructions:** paste the tool instructions exactly, including
     the `{System.Activity.Text}` placeholder; Copilot Studio replaces it with the message that
     started the run (the handoff JSON). Leave **Inputs** empty (see "How the call's details
     reach Computer use" below).
  3. Save, then **Publish**.

## Agent instructions

```text
Every message is an insurance claim handoff (JSON) from the contact-center desktop. Call the Computer use tool first with the complete handoff, unchanged. It is the only way to file a claim: do not search knowledge or answer from your own knowledge.

After each Computer use result, apply exactly one case:
1. Done: "Claim CLM-... has been filed" with the sign-out command entered; or "Filing failed: CODE", a cancellation, or the session ended or signed out. Call no tool; reply with that result.
2. Filed, not signed out, same session still active: call Computer use once with only the task "Release only: leave the Claims Workstation as it is and sign out with shutdown /l". Then reply with the claim result.
3. Stopped before clicking Submit Claim, same session still active: call Computer use again with the complete handoff to continue in that session, at most twice in total.
4. Anything else, including a possible Submit Claim click without a claim number or missing or unclear output: never file again. If the same session is still active, make the one "Release only" call from case 2. Reply "Filing status uncertain: check the Claims Workstation before any retry."
Never call Computer use once that session has ended.

Final reply: "Claim CLM-YYYY-NNNNNN has been filed", "Filing failed: CODE", or the case 4 reply.
```

## Computer use tool instructions

```text
You file one insurance claim in the Zava Mutual Claims Workstation (a Win32 app installed on this Windows 365 Cloud PC), then sign out of Windows to release the Cloud PC. Work alone from launch to sign-out; no one can answer questions. Use only Windows and the Claims Workstation (no browser, downloads or installs) and never click Reset All Data.

If the task says "Release only", do only step 7 and leave the Claims Workstation as it is.

This call's handoff (JSON): {System.Activity.Text}

Handoff data: use policy_number, caller_phone, intent and summary from that handoff. Only if both policy_number and caller_phone are missing, use policy POL-2024-008341, phone (555) 123-4567, intent auto_collision, summary "Rear-ended at 5th and Main, no injuries", loss location 5th and Main.

Explanations: one plain sentence of at most 15 words per action, saying what you do and why. No praise words, no description of the screen, no repetition of earlier steps.

Procedure
1. Desktop. While Windows shows setup or sign-in progress (for example "Account setup: Working on it"), leave the keyboard and mouse alone and look again about every 30 seconds. Start when the desktop and taskbar are visible.
2. Launch. Double-click the desktop icon "Zava Claims Agent Launch" once: it starts the app with the options that sign agent C1001 in. Never use the "Zava Claims Workstation" or "Zava Claims" icons or Start menu entries; they lack those options. The window can take up to 20 seconds to appear: look again about every 5 seconds and never launch it a second time unless 30 seconds pass with nothing loading. Only if that icon is missing, or 30 seconds pass with nothing loading, launch through Run: click the taskbar Search (magnifying glass) icon, type run and press Enter (on a newly started Cloud PC, Windows key + R is ignored). When the Run dialog is open, click inside its Open box and press Ctrl+A (the click unselects the old command, which typing would otherwise extend), then type exactly
"C:\Program Files\Business Applications\Zava Claims Workstation\claims.exe" --no-splash --fast-auth --stable-host --idle-timeout=0 --demo-pin=1234
and press Enter. The app is ready when the title is "Zava Mutual - Claims Workstation v1.0", the search box is enabled and the status bar shows HOST: LINKED. Answer start-up pop-ups: compliance I Agree, MOTD Acknowledge, ready gate Yes or Ready, idle re-auth PIN 1234.
3. Policy. In the far-left search panel click the Policy # radio, click the search box below the radios, type policy_number, click Search. If the handoff has only caller_phone, use the Phone radio and caller_phone. The policy is selected when the right-hand Policy tab shows that policy number; if several rows appear, double-click the caller's row. The right-hand Policy # box is read-only: never type there. If no row is found, the result is Filing failed: POLICY_NOT_FOUND; go to step 7.
4. FNOL. Click the New FNOL tab (Step 1 of 5 - Incident). Set Loss Type from the intent: auto_collision COLLISION (preselected), auto_theft THEFT, auto_glass GLASS, home_water WATER, home_fire FIRE, home_wind WIND, liability or fraud_investigation LIABILITY, anything else COLLISION. Click Loss Location and type the place as written in the summary; click Narrative and type the summary.
5. Review and submit. Click Next > (top right of the form) on Vehicles, Parties and Coverage without entering anything, until the label reads "Step 5 of 5 - Review_Submit". Use mouse clicks: Alt+R refreshes the view and Alt+N opens another FNOL. Check the review shows the searched policy, the loss type, the location and the summary, then click Submit Claim once. Never submit a second time.
6. Result. Read the new claim number (CLM-, the year, six digits) from the confirmation dialog or the Claim ID field, state "Claim CLM-YYYY-NNNNNN has been filed, now releasing the workstation" in your explanation, then click OK. Name only this new claim number; other claim numbers in the app are history.
7. Release (always, also after a failure). Open Run, click inside its Open box, press Ctrl+A, type shutdown /l, press Enter. This signs out, closes the app (the claim is already saved) and returns the Cloud PC to the pool. Never Lock, Disconnect, Restart or Shut down. After pressing Enter, look again about every 5 seconds until Windows signs out, which ends this session by itself; do not finish before that unless 3 looks show no change.

Recovery
- Waiting: if the screen shows something loading (a window opening, busy cursor, search running), wait about 3 seconds and look again, at most 3 times. If nothing changed and nothing is loading, do not wait: use the next method below. Never repeat the same action more than twice.
- Run does not open: press Windows key + R once. If neither Search nor Windows key + R responds, Windows is still starting: wait about 10 seconds without input, then try the taskbar Search again. After 3 tries, press Ctrl+Shift+Esc, click Run new task and use its Open box. In any Open box, click it and press Ctrl+A before typing: clicking leaves earlier text unselected.
- Typed text did not appear: click inside the field and type it again once.
- A field rejects text: click its label, press Tab, type. After 2 tries, search the policy by Phone with caller_phone, or leave Loss Location or Narrative blank.
- Agent Sign-On dialog: click Switch agent, set Agent ID C1001, type PIN 1234 once, click Connect (never SV001 or another PIN; three wrong PINs lock the account). If it shows Account locked, wait 6 seconds and enter C1001 and 1234 once.
- Unsure whether Submit worked: look for the confirmation dialog or a CLM- number in the Claim ID field; never submit again.
- shutdown /l fails twice: Start, the user account icon, Sign out. If sign-out still fails after 2 attempts, finish with the result so the claim number is kept.

Final result: one line, "Claim CLM-YYYY-NNNNNN has been filed" or "Filing failed: CODE" (for example Filing failed: POLICY_NOT_FOUND). The run is complete only after step 7. If you hand back before step 7, say which point you reached: "Incomplete: stopped before Submit Claim", "Submit Claim clicked, claim number not seen", or the claim number with "not signed out yet".
```

## Why it is written this way

- **Launch by the agent icon:** the Run route took eight model steps in run MCS-9
  (REQ-2026-415896378539, 7 October 2026): Search, look, type run, Enter, click the Open box,
  Ctrl+A, type the command, Enter, 49.7 seconds from the first click to the launch Enter. The
  "Zava Claims Agent Launch" Public Desktop icon starts the same `claims.exe` with the same
  options in one double-click. It is delivered only to the MCS Cloud PCs by its own Intune app
  (`scripts/Deploy-McsAgentShortcut.ps1`); the Claims app, its normal shortcuts and the Foundry
  PCs are unchanged. Run stays as the fallback when the icon is missing or nothing loads.
  Measured in run MCS-10 (REQ-2026-985159309113, 7 October 2026 14:16 UTC): one double-click,
  and the next step was already in the ready Claims app (agent C1001, HOST: LINKED): 12.3 seconds
  from the double-click to the first Claims action, against 66.9 seconds from the Search click in
  MCS-9. The claim, review, single Submit and sign-out were unchanged. That run's Cloud PC was on
  its first sign-in (about 112 seconds of account setup first), so its total time was longer; one
  run does not show that a newly started Cloud PC always accepts the double-click first time.
- **Run fallback:** start with the taskbar Search icon. In every recorded run (2, 6 and 7 October
  2026) Windows key + R did nothing the first time on a newly started Cloud PC, and Search is
  what opened Run in the end. The Run box is clicked before typing, because text typed before
  it had focus was lost.
- **Ctrl+A after clicking the Run box:** this is why the first launch showed no window on
  reused Cloud PCs. Run opens with the previous command (`shutdown /l` from the last sign-out)
  highlighted; the click removes the highlight and leaves the cursor at its end, so the typed
  launch command was added after `shutdown /l` and Windows ran a broken `shutdown` command
  that opens nothing. Shown by the Computer use step screenshots of runs MCS-6
  (REQ-2026-519317082970, 04:53:53 UTC) and MCS-8 (REQ-2026-501550561253, 05:27:54 UTC, 7 October 2026): after
  the click the box reads `shutdown /l` with no highlight; the model stated the text was
  selected, typed, pressed Enter and waited 60-90 seconds before relaunching. Both second
  launches pressed Ctrl+A first and the window appeared within 12 seconds. MCS-8's sign-out
  repeated the same mistake (the old launch command was extended) and needed a retry.
  After Enter the agent waits for the window instead of launching the
  app a second time (run REQ-2026-519317082970 launched it twice while it was still loading).
- **Short explanations:** one sentence of at most 15 words. They are shown live in Zava and in
  the Copilot Studio activity log; longer ones cost model time on every step.
- **Release is watched, not assumed:** the agent keeps looking after entering `shutdown /l`
  until Windows signs out. With short explanations the agent once finished its turn the same
  second it pressed Enter (run REQ-2026-441369373633), so the session ended before the sign-out
  was recorded and the handoff service could not confirm the release.
- **Call details:** the `{System.Activity.Text}` line gives the tool the handoff (see below).
  The sample-data fallback only applies if a run starts without a handoff.
- **Unchanged from 5 October 2026:** the agent instructions, exact launch command and flags, Policy # radio and left
  search box (the right-hand box is read-only), the intent-to-loss-type map, one Submit after
  checking the review, the claim-number sentence the handoff service reads (together with the
  logged Submit Claim and confirmation clicks; see below), and release by `shutdown /l`.

## How the handoff service recognises a filed claim

The handoff service (`apps\handoff-orchestrator`, `GET /api/cua-run/{runId}/progress` with
`CUA_REQUIRE_REAL_RESULT=1`) uses two sources, both tied to this handoff:

- **The Computer use log of this handoff's own conversation** (the conversation named by the
  receipt the trigger flow saves on this handoff's Dataverse row). For every click, Computer use
  records the control under the pointer: its process, name and automation ID. The service needs
  a click on Claims' **Submit Claim** button (automation ID `7604`), followed by a click on a
  control of the **FNOL Submitted** dialog (`5900`-`5902`, normally **OK** `5902`). Claims shows
  that dialog only after a successful submission (see
  `apps\legacy-claims-workstation\src\resource.h` and `res\claims.rc`).
- **The claim number the agent stated while that dialog was on screen**: the only number in its
  explanations from the Submit click up to and including its first click on the dialog. A
  number it had already mentioned before the Submit (for example an older claim on the policy)
  is never accepted as the new claim. If the agent's final reply is present, it must report the
  same claim as filed ("Claim CLM-YYYY-NNNNNN has been filed").

| Evidence | Service status | Zava |
| --- | --- | --- |
| Submit Claim, then the FNOL Submitted dialog, with one new number stated there (and a matching reply, if any) | `succeeded` with that number, kept even if the Cloud PC session later ends with an error | Shows the claim; the Cloud PC release is reported separately. |
| No Submit Claim click, and the reply "Filing failed: CODE" | `failed` | Shows the code; Retry offered. |
| No Computer use session for the conversation and a reply that is not a filed claim, after the grace period | `failed` | Not filed; Retry offered. |
| Anything else that ended: Submit clicked without the dialog, the dialog without one new number, a reply that disagrees with the log, a filed-claim reply with no Submit and dialog in the log | `failed` with `outcome: "uncertain"` | "STOPPED - OUTCOME UNKNOWN", no Retry. The request stays as the last transfer through reset and reload, and no new AI transfer to any destination starts until someone selects "I checked the claims system". An uncertain Foundry request blocks Copilot Studio transfers the same way. |

While the log does not yet show this evidence, the run stays `running`.

What this establishes, and what it does not:

- **Observed by Computer use:** this run clicked Submit Claim and then a control of the dialog
  Claims shows only after a successful submission. These are platform records, not the
  agent's words.
- **Still the agent's words:** the claim number. Computer use logs which control was clicked,
  not the text shown in it, and the service does not read the screenshot. The number is the one
  the agent stated while the dialog was on screen. The Foundry agent, by contrast, reads the
  dialog's claim field itself.
- Of the eleven Computer use logs captured from the reference environment between 2 and 7 October
  2026 (UTC), the ten in which the agent reported a claim all show this sequence, with the
  number stated at the OK click; the one in which it reported no claim shows no Submit Claim
  click.
- Keep the "Result" step above (read the number from the confirmation, then click OK) and the
  final-result wording unchanged, or update this check with them. A Submit made with the
  keyboard instead of a click is not recognised and ends as "outcome unknown".

### Open limitation: the claim number is not independently observed (release QA R6, partial)

The service now establishes from Computer use's own records that **this run submitted a claim**.
It does not establish **which number** the Claims app gave it: if the agent misreads or misstates
the number while clicking OK, that number is reported. Text that names an older claim or denies a
new one, said at that moment and not earlier, is not caught; matching such wording is not a
reliable check.

What is missing is a record of the number made by something other than the agent. The
Computer use log stores, for each click, the clicked control's name and ID, not the text shown
in other controls, and the service does not read screenshots.

Smallest supported remedy (not done here; it changes the Claims app and its deployment):

1. A new Claims build sets the claim number as the accessible name of the confirmation's OK
   button (Windows Dynamic Annotation, `IAccPropServices::SetHwndPropStr` with
   `PROPID_ACC_NAME`), leaving its visible text "OK". Computer use already records the clicked
   control's name, as it did for "OK" and "Submit Claim" in the reference runs; that this
   annotated name reaches the log must be confirmed on a Cloud PC.
2. The handoff service then takes the number from that recorded name and accepts the agent's
   number only if it matches.
3. Compatibility: the Foundry agent's confirmation check (`confirmation_claim_id` in
   `samples\foundry-hosted-claims\hosted_claims\claims.py`) requires a button named exactly "OK"
   and must accept the new name. The Claims version, `Detect.ps1` and the Intune package must be
   updated and delivered to both pools before the service relies on it.
## How the call's details reach Computer use

The tool instructions contain the placeholder `{System.Activity.Text}`. At run time Copilot
Studio replaces it with the message that started the conversation, which is the handoff JSON
the trigger flow sends. The tool then reads the policy number, phone, intent and summary from
it. Evidence (7 October 2026, request REQ-2026-519317082970): the Computer use log's request
prompt contains the full handoff, and the Claims narrative field showed the caller's exact
summary ("Rear-ended at intersection of 5th and Main, no injuries reported, both vehicles
drivable.").

Before this, the tool received only its fixed instructions (every run of 2, 6 and 7 October
until then) and typed the sample narrative from its own instructions.

**Do not add tool Inputs by editing the tool definition.** Two attempts on 7 October 2026 (six
named inputs, then one `request` input in the shape of Copilot Studio's exported Computer use
tools) published without error, but in the next autonomous run Copilot Studio did not start the
tool at all: its conversation record shows no tool server start and an empty plan, and the agent
replied that Computer use was not in its toolset. Both were rolled back within minutes. In
working runs the planner sees the tool as
`MCP:<agent schema>.action.Computeruse-Computeruse:ExecuteCUA`, a connector-backed tool that
takes no arguments.

## Previous version (for rollback)

Published on 7 October 2026 09:48 UTC and used by run MCS-9: the same procedure launching only
through Run. The agent instructions did not change. To roll back, paste the tool text below,
save and publish (older versions are in this file's git history). The agent icon can stay on the
Cloud PCs; the Run procedure does not use it.

<details><summary>Computer use tool instructions, 7 October 2026 (MCS-9)</summary>

```text
You file one insurance claim in the Zava Mutual Claims Workstation (a Win32 app installed on this Windows 365 Cloud PC), then sign out of Windows to release the Cloud PC. Work alone from launch to sign-out; no one can answer questions. Use only Windows and the Claims Workstation (no browser, downloads or installs) and never click Reset All Data.

If the task says "Release only", do only step 7 and leave the Claims Workstation as it is.

This call's handoff (JSON): {System.Activity.Text}

Handoff data: use policy_number, caller_phone, intent and summary from that handoff. Only if both policy_number and caller_phone are missing, use policy POL-2024-008341, phone (555) 123-4567, intent auto_collision, summary "Rear-ended at 5th and Main, no injuries", loss location 5th and Main.

Explanations: one plain sentence of at most 15 words per action, saying what you do and why. No praise words, no description of the screen, no repetition of earlier steps.

Procedure
1. Desktop. While Windows shows setup or sign-in progress (for example "Account setup: Working on it"), leave the keyboard and mouse alone and look again about every 30 seconds. Start when the desktop and taskbar are visible.
2. Launch. Click the taskbar Search (magnifying glass) icon, type run and press Enter to open the Run dialog (on a newly started Cloud PC, Windows key + R is ignored). When the Run dialog is open, click inside its Open box and press Ctrl+A (the click unselects the old command, which typing would otherwise extend), then type exactly
"C:\Program Files\Business Applications\Zava Claims Workstation\claims.exe" --no-splash --fast-auth --stable-host --idle-timeout=0 --demo-pin=1234
and press Enter. The window can take up to 20 seconds to appear: look again about every 5 seconds and never launch it a second time unless 30 seconds pass with nothing loading. Always launch this way: the flags sign agent C1001 in; Start menu and desktop shortcuts lack them. The app is ready when the title is "Zava Mutual - Claims Workstation v1.0", the search box is enabled and the status bar shows HOST: LINKED. Answer start-up pop-ups: compliance I Agree, MOTD Acknowledge, ready gate Yes or Ready, idle re-auth PIN 1234.
3. Policy. In the far-left search panel click the Policy # radio, click the search box below the radios, type policy_number, click Search. If the handoff has only caller_phone, use the Phone radio and caller_phone. The policy is selected when the right-hand Policy tab shows that policy number; if several rows appear, double-click the caller's row. The right-hand Policy # box is read-only: never type there. If no row is found, the result is Filing failed: POLICY_NOT_FOUND; go to step 7.
4. FNOL. Click the New FNOL tab (Step 1 of 5 - Incident). Set Loss Type from the intent: auto_collision COLLISION (preselected), auto_theft THEFT, auto_glass GLASS, home_water WATER, home_fire FIRE, home_wind WIND, liability or fraud_investigation LIABILITY, anything else COLLISION. Click Loss Location and type the place as written in the summary; click Narrative and type the summary.
5. Review and submit. Click Next > (top right of the form) on Vehicles, Parties and Coverage without entering anything, until the label reads "Step 5 of 5 - Review_Submit". Use mouse clicks: Alt+R refreshes the view and Alt+N opens another FNOL. Check the review shows the searched policy, the loss type, the location and the summary, then click Submit Claim once. Never submit a second time.
6. Result. Read the new claim number (CLM-, the year, six digits) from the confirmation dialog or the Claim ID field, state "Claim CLM-YYYY-NNNNNN has been filed, now releasing the workstation" in your explanation, then click OK. Name only this new claim number; other claim numbers in the app are history.
7. Release (always, also after a failure). Open Run, click inside its Open box, press Ctrl+A, type shutdown /l, press Enter. This signs out, closes the app (the claim is already saved) and returns the Cloud PC to the pool. Never Lock, Disconnect, Restart or Shut down. After pressing Enter, look again about every 5 seconds until Windows signs out, which ends this session by itself; do not finish before that unless 3 looks show no change.

Recovery
- Waiting: if the screen shows something loading (a window opening, busy cursor, search running), wait about 3 seconds and look again, at most 3 times. If nothing changed and nothing is loading, do not wait: use the next method below. Never repeat the same action more than twice.
- Run does not open: press Windows key + R once. If neither Search nor Windows key + R responds, Windows is still starting: wait about 10 seconds without input, then try the taskbar Search again. After 3 tries, press Ctrl+Shift+Esc, click Run new task and use its Open box. In any Open box, click it and press Ctrl+A before typing: clicking leaves earlier text unselected.
- Typed text did not appear: click inside the field and type it again once.
- A field rejects text: click its label, press Tab, type. After 2 tries, search the policy by Phone with caller_phone, or leave Loss Location or Narrative blank.
- Agent Sign-On dialog: click Switch agent, set Agent ID C1001, type PIN 1234 once, click Connect (never SV001 or another PIN; three wrong PINs lock the account). If it shows Account locked, wait 6 seconds and enter C1001 and 1234 once.
- Unsure whether Submit worked: look for the confirmation dialog or a CLM- number in the Claim ID field; never submit again.
- shutdown /l fails twice: Start, the user account icon, Sign out. If sign-out still fails after 2 attempts, finish with the result so the claim number is kept.

Final result: one line, "Claim CLM-YYYY-NNNNNN has been filed" or "Filing failed: CODE" (for example Filing failed: POLICY_NOT_FOUND). The run is complete only after step 7. If you hand back before step 7, say which point you reached: "Incomplete: stopped before Submit Claim", "Submit Claim clicked, claim number not seen", or the claim number with "not signed out yet".
```

</details>
