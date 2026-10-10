# Current configuration reference

This repository uses git-ignored local config files. Samples are safe to commit; filled-in `*.local.json` files are not.

## Main local files

| File | Copy from | Purpose |
| --- | --- | --- |
| `scripts\demo-config.local.json` | `scripts\demo-config.sample.json` | Azure resource names, Intune group names, Function app settings for MCS and Foundry relay. |
| `deploy\foundry\foundry-agent.local.json` | `deploy\foundry\foundry-agent.sample.json` | Foundry hosted agent image and version deployment. |
| `apps\ccaas-agent-desktop\public\region-config.json` | `apps\ccaas-agent-desktop\public\region-config.sample.json` | Runtime handoff endpoints for Zava. |
| `apps\ccaas-agent-desktop\public\entra-config.json` | `apps\ccaas-agent-desktop\public\entra-config.sample.json` | Runtime Microsoft sign-in settings for Zava. |

The ordered install guide is [`install\README.md`](install/README.md). Use that guide before editing values.

## `handoffOrchestrator.dataverse`

These fields become Function app settings for the MCS path.

| Config field | Function setting | Meaning |
| --- | --- | --- |
| `orgUrl` | `DATAVERSE_ORG_URL` | Dataverse environment URL, for example `https://<org>.crm.dynamics.com`. |
| `cuaAgentBotId` | `CUA_AGENT_BOTID` | Copilot Studio bot ID used to find the right Computer Use sessions. |
| `triggerEntitySet` | `CUA_TRIGGER_ENTITYSET` | Dataverse entity set for the trigger table. Default: `crcce_claimrequests`. |
| `triggerIdAttr` | `CUA_TRIGGER_ID_ATTR` | Primary ID column. Default: `crcce_claimrequestid`. |
| `triggerFields.*` | `CUA_TRIGGER_FIELD_*` | Columns the Function writes when starting a run. |
| `resultFields.*` | `CUA_RESULT_FIELD_*` | Columns the trigger flow updates with claim result and receipt. |
| `region` | `CUA_REGION` | Region label that must match the active Zava region. |
| `requireRealResult` | `CUA_REQUIRE_REAL_RESULT` | Use `true` for real demos; fake demo IDs are rejected. |
| `progressMock` | `CUA_PROGRESS_MOCK` | Use `false` for real demos. |

## `handoffOrchestrator.foundryRelay`

These fields become Function app settings for the Foundry path.

| Config field | Function setting | Meaning |
| --- | --- | --- |
| `invocationsUrl` | `FOUNDRY_INVOCATIONS_URL` | Hosted agent Invocations endpoint, including `api-version=v1`. |
| `tenantId` | `FOUNDRY_RELAY_TENANT_ID` | Tenant expected in the presenter's relay access token. |
| `clientId` | `FOUNDRY_RELAY_CLIENT_ID` | Relay API app/client ID used to validate that token. |
| `claimsReady` | `FOUNDRY_CLAIMS_READY` | Set true only after the hosted agent is intentionally Claims-enabled. |
| `cloudPcPoolId` | `FOUNDRY_CLOUDPC_POOL_ID` | The Foundry agent's Windows 365 for Agents Cloud PC pool ID. Used only by the capacity gate. |
| `capacityGate` | `FOUNDRY_CAPACITY_GATE` | `true` greys out the Foundry transfer and refuses new starts unless that pool reports a free Cloud PC. Turn on only after the relay identity can read the pool (`docs/install/07-handoff-and-zava.md` section 6.2a). `false` is the rollback. |

## `region-config.json`

The Zava app reads this file at runtime. Current keys used by the install are:

| Key | Required | Meaning |
| --- | --- | --- |
| `activeRegion` | yes | ID of the selected region entry. |
| `regions[].id` | yes | Short region key, such as `primary`. |
| `regions[].label` | yes | Label shown to the user. |
| `regions[].cuaRunBaseUrl` | yes for MCS | Function `/api` base used by `/api/cua-run`. |
| `regions[].orchestratorUrl` | yes for Foundry | Function `/api` base used by `/api/foundry-claims`. |
| `regions[].directLineTokenUrl` | optional | Kept for in-app stream compatibility. It is not the supported trigger path. |

## Retired settings

Do not configure these for a new install unless you are deliberately maintaining a retired path: `HANDOFF_*`, `ENGINE_*`, `DIRECTLINE_*`, `CUA_DEMO_CLAIM_ID`, old local-orchestrator URLs, and old local Foundry runner settings.
