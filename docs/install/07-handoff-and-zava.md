# 6. Handoff service and Zava deployment

> **Reference page.** The guided setup in the [install guide](README.md) does this page's work for you (steps 21 and 22 there). Use this page to understand a step, to troubleshoot, or to install by hand.

## 6.1 Set Function app settings for the MCS path

Set these on the handoff Function app. Use your actual names if you changed the Dataverse schema.

```powershell
az functionapp config appsettings set `
  --name <function-app-name> `
  --resource-group <resource-group> `
  --settings `
    DATAVERSE_ORG_URL="https://<your-org>.crm.dynamics.com" `
    CUA_AGENT_BOTID="<copilot-studio-bot-id>" `
    CUA_TRIGGER_ENTITYSET="crcce_claimrequests" `
    CUA_TRIGGER_FIELD_POLICY="crcce_policynumber" `
    CUA_TRIGGER_FIELD_SUMMARY="crcce_summary" `
    CUA_TRIGGER_FIELD_CORRELATION="crcce_correlationid" `
    CUA_TRIGGER_FIELD_LANG="crcce_lang" `
    CUA_TRIGGER_FIELD_HANDOFF_CONTEXT="crcce_handoffcontext" `
    CUA_RESULT_FIELD_CLAIMID="crcce_claimid" `
    CUA_RESULT_FIELD_STATUS="crcce_status" `
    CUA_RESULT_FIELD_RECEIPT="crcce_handoffreceipt" `
    CUA_TRIGGER_ID_ATTR="crcce_claimrequestid" `
    CUA_REGION="primary" `
    CUA_REQUIRE_REAL_RESULT="1" `
    CUA_PROGRESS_MOCK="0"
```

`CUA_DEMO_CLAIM_ID` is legacy. Do not use it for the supported install.

## 6.2 Set Function app settings for the Foundry relay

```powershell
az functionapp config appsettings set `
  --name <function-app-name> `
  --resource-group <resource-group> `
  --settings `
    FOUNDRY_INVOCATIONS_URL="https://<foundry-invocations-endpoint>?api-version=v1" `
    FOUNDRY_RELAY_TENANT_ID="<tenant-id>" `
    FOUNDRY_RELAY_CLIENT_ID="<zava-spa-client-id>" `
    FOUNDRY_CLAIMS_READY="1"
```

Set `FOUNDRY_CLAIMS_READY=1` only after the Foundry hosted agent version is deployed, its Claims gates are intentionally configured, and the owner agrees it is ready for CCaaS transfers.

`FOUNDRY_RELAY_CLIENT_ID` must match the Zava SPA app registration that exposes `api://<client-id>/Handoff.Access`, because the browser requests that exact scope and the relay validates that exact audience/client pair.

Read-only check of both sets of settings (values are names and URLs, not secrets):

```powershell
az functionapp config appsettings list --name <function-app-name> --resource-group <resource-group> `
  --query "[?starts_with(name,'FOUNDRY_') || starts_with(name,'CUA_') || name=='DATAVERSE_ORG_URL'].{name:name, value:value}" -o table
```

Rollback without a redeploy: `FOUNDRY_CLAIMS_READY=0` stops new Foundry transfers (Zava shows
the Foundry choice as unavailable); putting the previous `FOUNDRY_INVOCATIONS_URL` back points
the relay at the previous agent. Change it only when no Foundry run is in progress.

## 6.2a Optional: Cloud PC availability gate for Foundry transfers

With this on, the Foundry card in Zava's **Transfer interaction** directory is greyed out unless the Foundry agent's Cloud PC pool reports a free Cloud PC, and the relay refuses a new start (before it records the request ID) when none is free or availability cannot be read. It is a readiness indicator and admission check only: it reserves nothing, and Windows 365 can still refuse an allocation if another run takes the last Cloud PC first. A run that has already started is never affected (its status, live screen, cancel and release keep working while its own Cloud PC makes the free count zero). MCS is not gated.

Card states while the directory is open (refreshed about every 20 seconds):

| Card | Meaning |
| --- | --- |
| Checking Cloud PC availability… | First reading pending. Greyed out. |
| (enabled) | The pool reports at least one free Cloud PC, and the existing sign-in and interaction checks pass. |
| No Cloud PC available yet. | The pool reports zero free. Re-enables by itself when a reading shows one free. |
| Unable to check Cloud PC availability. | The reading failed (permission, network, throttling, pool not found, or usage missing). Greyed out, with **Check again**. Never treated as available or as zero. |

Source: Microsoft Graph **beta** `GET /deviceManagement/virtualEndpoint/cloudPcPools/{id}`, field `sessionUsage.availableSessionsCount`. Only the single-pool read returns that field (the pool list omits it). Beta APIs can change without notice and are not supported for production; this is a demo dependency. If the field disappears, the card shows **Unable to check** rather than enabling.

1. Grant the relay Function app's system-assigned managed identity the Microsoft Graph **application** permission `CloudPC.Read.All`. This needs an administrator who can grant app roles, and explicit owner approval: it is **tenant-wide read access to Cloud PC data**, not a pool-only grant (Graph has none). No write permission is needed.

    ```powershell
    $mi = az functionapp identity show --name <function-app-name> --resource-group <resource-group> --query principalId -o tsv
    $graphSp = az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv
    $roleId = az ad sp show --id 00000003-0000-0000-c000-000000000000 --query "appRoles[?value=='CloudPC.Read.All'].id | [0]" -o tsv
    az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$mi/appRoleAssignments" `
      --body (@{ principalId = $mi; resourceId = $graphSp; appRoleId = $roleId } | ConvertTo-Json -Compress)
    ```

2. Set the pool ID, leaving the gate off:

    ```powershell
    az functionapp config appsettings set --name <function-app-name> --resource-group <resource-group> `
      --settings FOUNDRY_CLOUDPC_POOL_ID="<foundry-cloud-pc-pool-id>" FOUNDRY_CAPACITY_GATE="0"
    ```

3. Confirm the relay itself can read the pool before turning the gate on. A new app-role grant can take a few minutes to reach the managed identity token; restart the Function app if it still reads `graph_permission_denied`. Temporarily set `FOUNDRY_CAPACITY_GATE=1`, then, signed in to Zava, open **Transfer**: the Foundry card must become enabled (or show **No Cloud PC available yet.** when the pool really has none). Compare with a read-only administrator read of the same pool. If it shows **Unable to check**, set the gate back to `0` and fix the permission.

Rollback: `FOUNDRY_CAPACITY_GATE=0` (or remove it). The relay and Zava then behave exactly as before; no redeploy is needed. Once the gate is on, a failed reading stays visible as **Unable to check** and does not let a start through.

Do not set old `HANDOFF_*`, `ENGINE_*`, or `DIRECTLINE_*` settings for a new install unless you are deliberately maintaining a retired path.

## 6.3 Deploy or update the handoff service code

The helper in step 3 deploys `apps\handoff-orchestrator` during **step C. AI handoff backend**. In `scripts\DemoCommon.ps1`, the exact publish path is:

1. `Push-Location .\apps\handoff-orchestrator`
2. `npm ci`
3. `func azure functionapp publish <function-app-name> --javascript`

If you need to update only the Function app code after the Azure resources already exist, run the same commands directly:

```powershell
Set-Location .\apps\handoff-orchestrator
npm ci
func azure functionapp publish <function-app-name> --javascript
Set-Location ..\..
```

Use the Function app name from the values worksheet. This publishes both supported APIs: `/api/cua-run` for MCS progress and `/api/foundry-claims/*` for Foundry relay.

## 6.4 Create Zava runtime config files

Create the runtime config files next to the app bundle before deploying the Static Web App.

```powershell
Copy-Item .\apps\ccaas-agent-desktop\public\region-config.sample.json .\apps\ccaas-agent-desktop\public\region-config.json
Copy-Item .\apps\ccaas-agent-desktop\public\entra-config.sample.json .\apps\ccaas-agent-desktop\public\entra-config.json
```

Example `region-config.json`:

```json
{
  "activeRegion": "primary",
  "regions": [
    {
      "id": "primary",
      "label": "Primary",
      "cuaRunBaseUrl": "https://<function-app>.azurewebsites.net/api",
      "orchestratorUrl": "https://<function-app>.azurewebsites.net/api",
      "directLineTokenUrl": "https://<environment-host>.environment.api.powerplatform.com/powervirtualagents/botsbyschema/<schema>/directline/token?api-version=2022-03-01-preview"
    }
  ]
}
```

The supported live MCS progress path uses `cuaRunBaseUrl`. The region `id` that Zava selects (`activeRegion`) must equal the handoff service setting `CUA_REGION` (`primary` in 6.1); otherwise every Copilot Studio transfer is refused with `REGION_MISMATCH`. Zava ignores a region without a `directLineTokenUrl`, so the field must not be empty, but it belongs to the retired Direct Line path and is not used while `cuaRunBaseUrl` is set; the guided setup writes a deliberately non-working value there and generates this file for you.

Example `entra-config.json`:

```json
{
  "tenantId": "<tenant-id>",
  "clientId": "<zava-spa-client-id>",
  "redirectUri": "https://<zava-site>.azurestaticapps.net/"
}
```

Placeholder reference:

| Placeholder | What to put there | Where you get it |
| --- | --- | --- |
| `YOUR-HANDOFF-FUNCTION` / `<function-app>` | Function app host name without the path, for example `zava-handoff.azurewebsites.net`. | Values worksheet: Function app name / handoff service base URL. |
| `cuaRunBaseUrl` | `https://<function-app>.azurewebsites.net/api`. | Values worksheet: handoff service base URL. |
| `orchestratorUrl` | Same `https://<function-app>.azurewebsites.net/api` for this install. | Values worksheet: handoff service base URL. |
| `directLineTokenUrl` | Existing Copilot Studio Direct Line token URL if your region UI still needs it; otherwise leave the sample until that UI is removed. It is not the supported MCS trigger path. | Copilot Studio / Power Platform environment, if used. |
| `tenantId` | Microsoft Entra tenant ID. | Values worksheet. |
| `clientId` | Zava sign-in app client ID. | Values worksheet. |
| `redirectUri` | Static Web App root URL with a trailing slash. | Values worksheet: Static Web App URL. |

## 6.5 Build and deploy Zava

Set the build-time values first. The runtime JSON files above are still the preferred way to change endpoints later, but these values make the initial build deterministic.

| Build setting | Put this value |
| --- | --- |
| `VITE_AUTH_MODE` | `entra` for the installed lab. |
| `VITE_AZURE_CLIENT_ID` | Zava sign-in app client ID from the values worksheet. |
| `VITE_AZURE_TENANT_ID` | Tenant ID from the values worksheet. |
| `VITE_AZURE_REDIRECT_URI` | Static Web App root URL, for example `https://<zava-site>.azurestaticapps.net/`. |
| `VITE_ORCHESTRATOR_URL` | Handoff service base URL, for example `https://<function-app>.azurewebsites.net/api`. |
| `VITE_DIRECTLINE_TOKEN_URL` | Optional compatibility token URL from `region-config.json`. Leave unset if you are not using the old in-app Direct Line stream. |

```powershell
Set-Location .\apps\ccaas-agent-desktop
$env:VITE_AUTH_MODE = "entra"
$env:VITE_AZURE_CLIENT_ID = "<zava-spa-client-id>"
$env:VITE_AZURE_TENANT_ID = "<tenant-id>"
$env:VITE_AZURE_REDIRECT_URI = "https://<zava-site>.azurestaticapps.net/"
$env:VITE_ORCHESTRATOR_URL = "https://<function-app>.azurewebsites.net/api"
# Optional only if your environment still uses the in-app Direct Line stream:
# $env:VITE_DIRECTLINE_TOKEN_URL = "https://<environment-host>.environment.api.powerplatform.com/powervirtualagents/botsbyschema/<schema>/directline/token?api-version=2022-03-01-preview"
npm ci
npm run build
Copy-Item .\public\region-config.json .\dist\region-config.json
Copy-Item .\public\entra-config.json .\dist\entra-config.json
Set-Location ..\..
```

Deploy the built `dist` folder to Static Web Apps. The deployment token is a secret, so pass it through `SWA_CLI_DEPLOYMENT_TOKEN` and do not paste it into logs or docs:

```powershell
$env:SWA_CLI_DEPLOYMENT_TOKEN = az staticwebapp secrets list `
  --name <static-web-app-name> `
  --resource-group <resource-group> `
  --query properties.apiKey `
  -o tsv

Set-Location .\apps\ccaas-agent-desktop
npx @azure/static-web-apps-cli deploy .\dist --env production
Set-Location ..\..
Remove-Item Env:SWA_CLI_DEPLOYMENT_TOKEN
```

The full helper also builds and deploys Zava. Preview it first:

```powershell
pwsh -File .\scripts\Build-DemoFromScratch.ps1 -ConfigPath .\scripts\demo-config.local.json -WhatIf
```

## 6.6 Confirm browser sign-in and relay scope

1. Open `https://<zava-site>/workspace`.
2. Sign in as the presenting account.
3. Answer a simulated call and open **Transfer**.
4. The MCS and Foundry choices should both be visible if both endpoints are configured.
5. If the Foundry choice asks to reconnect Microsoft sign-in, complete sign-in before starting the call.

Do not start a warm-up claim if the Foundry pool has only one Cloud PC.
