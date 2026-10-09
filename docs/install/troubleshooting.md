# Troubleshooting

## Start with the symptom

| Symptom | Likely effect | First checks |
| --- | --- | --- |
| Copilot Studio portal shows only a spinner | You cannot build or publish the MCS agent. | Confirm the environment has a Dataverse database. The default environment often does not. |
| Computer Use says it is disabled for unauthenticated agents | MCS never starts a Cloud PC run. | Set the agent's authentication to **Authenticate with Microsoft** (Settings > Security > Authentication), save, and publish again. |
| A finished MCS run is missing from Copilot Studio **Activity**, or shows no screenshots | No native run history to review. | Agent on **Authenticate with Microsoft** and published; Microsoft 365 data storage for Copilot Studio on; the viewing account has an Exchange mailbox and owns the flow's Copilot Studio connection or has shared access; Computer Use logs stored in Dataverse with verbosity **All data**. Runs from before the authentication change are not added afterwards. See install section 4.6. |
| Every MCS transfer fails with `REGION_MISMATCH` | Zava's selected region differs from the handoff service. | The `activeRegion` in Zava's `region-config.json` must equal `CUA_REGION` (install section 6.4). Run the guided setup again; it generates both from one value. |
| No Cloud PC pool option in the Computer Use tool | The tool cannot bind to a pool. | Confirm generative orchestration is on, Cloud PC feature is enabled for the environment, tenant prerequisites are complete, and the environment geo supports the pool. |
| MCS handoff creates a row but no result | Zava waits or fails. | Check the trigger flow run, agent publish state, Dataverse application user rights, `CUA_AGENT_BOTID`, and result field names. |
| Progress screenshots are missing | Zava cannot show near-live progress. | Confirm the Function app identity can read `flowsessions`, `flowlogs`, and `flowsessionbinaries`. |
| Foundry option says reconnect Microsoft sign-in | Presenter cannot start Foundry. | Reconnect sign-in before taking the call. Confirm the relay API scope was consented. |
| Foundry availability is not ready | Foundry transfer is disabled. | Check `FOUNDRY_INVOCATIONS_URL`, `FOUNDRY_RELAY_TENANT_ID`, `FOUNDRY_RELAY_CLIENT_ID`, and `FOUNDRY_CLAIMS_READY`. |
| Foundry card says **Unable to check Cloud PC availability.** | The capacity gate is on and the relay could not read the pool. Hover the message for the reason. | `graph_permission_denied`: the relay identity lacks `CloudPC.Read.All` (section 6.2a). `pool_not_configured` / `pool_not_found`: check `FOUNDRY_CLOUDPC_POOL_ID`. `usage_missing`: the Graph beta response no longer includes `sessionUsage`. To bypass, set `FOUNDRY_CAPACITY_GATE=0`. |
| Foundry transfer may still be running | Starting again could duplicate or collide. | Check existing run status in the same Zava interaction before retrying. |
| Cloud PC pool still resetting | Foundry cannot get a PC yet. | Wait. A one-PC pool was observed taking 15-17 minutes after a run. |
| Foundry Cloud PC shows Windows account setup | Agent cannot reach the desktop or Claims app. | Use `Set-AgentPoolEspSkip.ps1` only for Windows 365 for Agents pools whose model is **Cloud PC for Agents**, after owner approval. |
| Copilot Studio hosted Cloud PC shows Windows account setup | MCS agent cannot reach the desktop or Claims app. | Do not use `Set-AgentPoolEspSkip.ps1`; those devices are model **Copilot Studio Hosted Agent Machine ...** and need separate Intune review. |
| Claims app missing on a pool PC | Agent cannot file the claim. | Check Intune required assignment, device group membership, app detection, and whether ESP blocked app install. |

## MCS path checks

1. Confirm `DATAVERSE_ORG_URL` points to the correct environment.
2. Confirm `CUA_TRIGGER_ENTITYSET` and every `CUA_TRIGGER_FIELD_*` setting matches the table schema.
3. Confirm `CUA_RESULT_FIELD_CLAIMID`, `CUA_RESULT_FIELD_STATUS`, and `CUA_RESULT_FIELD_RECEIPT` match the columns the flow updates.
4. Confirm `CUA_REQUIRE_REAL_RESULT=1` and `CUA_PROGRESS_MOCK=0` for a real demo.
5. Confirm the trigger flow writes a receipt with `definition_version: 2.0.0`.
6. Confirm the Dataverse application user is the Function app managed identity, not a human user.

## Foundry relay checks

1. `GET /api/foundry-claims/availability` should return configured and ready.
2. The presenter must be signed in to Zava with the same tenant expected by `FOUNDRY_RELAY_TENANT_ID`.
3. The Zava app must request the relay scope on the relay API app.
4. The Function app managed identity must be able to get a token for Foundry and invoke the hosted agent.
5. The hosted agent endpoint must be the Invocations endpoint, not a management endpoint.
6. `FOUNDRY_CLAIMS_READY` should stay `0` until the deployed hosted version is intentionally Claims-enabled.

## Intune and Windows 365 checks

- Windows 365 for Agents pools are shared pools; agents check out a Cloud PC and return it afterward.
- Cloud PCs for Agents reset after use, unlike a human's persistent Enterprise Cloud PC.
- Intune Win32 app installs must be silent. Interactive installers are not supported.
- For Cloud PCs, ESP custom targeting must use an `enrollmentProfileName` filter. Dynamic groups are not supported for ESP targeting.
- `Set-AgentPoolEspSkip.ps1` plan mode is the default. It has no `-WhatIf` parameter.

## When to stop and ask the environment owner

Stop before changing anything if the next fix would:

- grant a new tenant-wide permission;
- enable billing or increase always-available Cloud PC count;
- change ESP behaviour for more than the intended pool;
- enable Foundry Claims execution gates;
- delete or reset a Cloud PC pool;
- change the Copilot Studio tool instructions.
