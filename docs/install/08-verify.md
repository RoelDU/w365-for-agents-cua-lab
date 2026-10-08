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

## 7.4 Foundry path

1. Run the preparation check in [Presenting](presenting.md) first.
2. In Zava, answer a simulated call.
3. Choose **Claims Automation Agent (Foundry)**.
4. Confirm the presenter sees the live same-session viewer.
5. Confirm the claim number appears in the same Zava interaction.
6. After the run, wait for the Cloud PC to reset before another run. A one-PC pool may take 15-17 minutes.

## 7.5 Safe retry rule

If a transfer outcome is uncertain, do not start a second transfer for the same call. First check the existing run status in Zava. A second start can create duplicate work or collide with an in-use Cloud PC.
