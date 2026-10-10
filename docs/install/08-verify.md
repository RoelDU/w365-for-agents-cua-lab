# 7. Verification

Run these checks after the one-time install. Use synthetic test data only.

## 7.1 Intune delivery

On each Cloud PC pool, confirm the Claims app is installed:

```text
C:\Program Files\Business Applications\Zava Claims Workstation\claims.exe
```

If it is missing, check the Intune Win32 app assignment, device group membership, and ESP policy. Required apps may install after first sign-in if ESP does not block on them.

## 7.2 Handoff service health

Check read-only endpoint availability:

```powershell
Invoke-RestMethod https://<function-app>.azurewebsites.net/api/foundry-claims/availability
```

Expected for a ready Foundry install:

```json
{ "configured": true, "ready": true, "message": "Foundry hosted agent is available." }
```

With the optional Cloud PC availability gate on (section 6.2a), the same response also contains `"capacity_gate": true`. The availability reading itself is at `GET /api/foundry-claims/capacity` and needs the presenter's sign-in, so check it in Zava: open **Transfer** and the Foundry card must not say **Unable to check Cloud PC availability.**

For MCS, start with one test transfer and watch `/api/cua-run/{runId}/progress` in the browser network tools or app status panel.

## 7.3 MCS path

1. In Zava, answer a simulated call.
2. Choose **Claims Automation Agent (Copilot Studio)**.
3. Confirm the handoff service creates a Dataverse trigger row.
4. Confirm the trigger flow starts and writes a receipt back to the same row.
5. Confirm the Zava status panel shows progress and a real claim ID from the result field.

If the result is not real and `CUA_REQUIRE_REAL_RESULT=1`, the run should fail rather than return a fake claim.

### Native run history (after an approved real MCS run)

Run this only after a real transfer that you were allowed to start; do not start one just to
check history. Use the account described in [section 4.6](05-mcs-path.md#46-native-run-history-in-copilot-studio-activity).

1. When the run has finished, open Copilot Studio > the agent > **Activity**. Sort by date.
2. Open the row for this run. It is usually listed as **Automated**, at the time of the transfer.
3. Match it to the transfer: the transcript's first message is the handoff JSON, and its
   `request_id` must be the Zava request ID of this call.
4. Open the **Computer use** step. Confirm that the explanations are there and that the
   **screenshots are actually shown** for the actions (the side panel's session replay steps
   through them). A screenshot count or a Dataverse record count is not enough: record that you
   saw the images.
5. Note what you see, without treating it as more than it is:
   - a `SessionHasLoggedOff` entry after the sign-out is the agent ending the Cloud PC session;
   - the claim outcome is the one Zava showed (step 5 above), checked against the Claims app;
     Activity history and Cloud PC clean-up are separate from it.

If the row is missing: check the agent uses **Authenticate with Microsoft** and is published, the
Microsoft 365 data storage setting, the viewing account's Exchange mailbox, and sharing (section
4.6). Runs from before the authentication change are not added afterwards.

## 7.4 Foundry path

1. Run the preparation check in [Presenting](presenting.md) first.
2. In Zava, answer a simulated call.
3. Choose **Claims Automation Agent (Foundry)**.
4. Confirm the presenter sees the live same-session viewer.
5. Confirm the claim number appears in the same Zava interaction.
6. After the run, wait for the Cloud PC to reset before another run. A one-PC pool may take 15-17 minutes.

## 7.5 Safe retry rule

If a transfer outcome is uncertain, do not start a second transfer for the same call. First check the existing run status in Zava. A second start can create duplicate work or collide with an in-use Cloud PC.
