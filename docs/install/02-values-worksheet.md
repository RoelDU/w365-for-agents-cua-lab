# 1. Values worksheet

> **With the guided setup you do not fill this in.** `scripts\Install-Lab.ps1` finds these values
> itself, keeps them in `scripts\lab-setup.local.json` on your computer (git-ignored; names, IDs
> and addresses only) and writes them into the config files and settings below. This page is for
> an installation by hand, and to explain what each value is.

Copy this table into your private notes. Do not commit the filled-in values.

| Value | Filled in at step | Used later for |
| --- | --- | --- |
| Tenant ID | Prerequisites | Every sign-in, app registration, and Function setting. |
| Azure subscription ID | Azure resources | Resource creation and billing. |
| Azure region | Azure resources | Resource group, Function app, Storage, Container Registry, and billing policy region. |
| Resource group name | Azure resources | Function app, Storage, Static Web App, Container Registry if used. |
| Function app name | Azure resources | Handoff service URL and app settings. |
| Function app managed identity principal ID | Azure resources | Dataverse application user and Foundry project role assignment. |
| Handoff service base URL | Azure resources | `region-config.json` as `cuaRunBaseUrl` and `orchestratorUrl`. |
| Static Web App URL | Zava deployment | Zava redirect URI and presenter address. |
| Zava sign-in app client ID | App registrations | `entra-config.json`; relay token scope audience. |
| Relay API app client ID and Application ID URI | App registrations | Current code uses the Zava SPA app registration itself: audience `api://<Zava SPA client ID>`. |
| Relay scope name | App registrations | Must be exactly `Handoff.Access`. |
| Dataverse environment URL | Dataverse | Function setting `DATAVERSE_ORG_URL`. |
| Dataverse trigger table entity set | Dataverse | Function setting `CUA_TRIGGER_ENTITYSET`. Default is `crcce_claimrequests`. |
| Copilot Studio bot ID | MCS | Function setting `CUA_AGENT_BOTID`; used to find Computer Use flow sessions. |
| MCS Cloud PC pool / machine group ID | MCS and Intune | Computer Use tool machine binding and Intune targeting. |
| Foundry resource, project, region | Foundry (5.1.1) | Every Foundry command; chosen explicitly, never another existing project. |
| Foundry project endpoint | Foundry | Deploy hosted agent versions and set relay target. |
| Model deployment name | Foundry (5.1.1) | `AZURE_AI_MODEL_DEPLOYMENT_NAME`; default `gpt-4.1-mini`. |
| Container registry name | Foundry (5.1.1, item 3) | `containerRegistryName`; your own registry, built from this repository. |
| Image digest | Foundry (5.3) | Written into `foundry-agent.local.json` by `-BuildImage`; pins the hosted version. |
| Foundry hosted agent name | Foundry | Default: `claims-w365`; used by the deploy script. |
| Foundry Invocations endpoint URL | Foundry | Function setting `FOUNDRY_INVOCATIONS_URL`. |
| Foundry agent identity client ID | Foundry | Hosted agent environment validation. |
| Foundry agent user object ID | Foundry | Hosted agent environment validation. |
| Foundry Cloud PC agent pool ID | Foundry | Function setting `FOUNDRY_CLOUDPC_POOL_ID` (optional availability check) and the operator readiness script. |

## Private config files you will create

| File | Start from | Purpose |
| --- | --- | --- |
| `scripts\demo-config.local.json` | `scripts\demo-config.sample.json` | Existing deployment helper config. Keep only non-secret values here unless a field explicitly says it is secret and git-ignored. |
| `deploy\foundry\foundry-agent.local.json` | `deploy\foundry\foundry-agent.sample.json` | Foundry image and hosted-agent version deployment. |
| `apps\ccaas-agent-desktop\public\region-config.json` | `apps\ccaas-agent-desktop\public\region-config.sample.json` | Runtime endpoints served next to the Zava bundle. |
| `apps\ccaas-agent-desktop\public\entra-config.json` | `apps\ccaas-agent-desktop\public\entra-config.sample.json` | Runtime Microsoft sign-in settings. |
| `scripts\foundry-demo-prep\foundry-demo.config.json` | `scripts\foundry-demo-prep\foundry-demo.config.template.json` | Operator-only readiness checks for presenting. |
