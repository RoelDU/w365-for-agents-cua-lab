# 3. Azure resources and app registrations

> **Reference page.** The guided setup in the [install guide](README.md) does this page's work for you (steps 1-3 and 23 there). Use this page to understand a step, to troubleshoot, or to install by hand.

## 3.1 Create the Azure resources

The current handoff service is an Azure Functions app plus Storage, with a system-assigned managed identity. The Zava desktop is hosted as an Azure Static Web App.

Start from the sample config:

```powershell
Copy-Item .\scripts\demo-config.sample.json .\scripts\demo-config.local.json
notepad .\scripts\demo-config.local.json
```

Fill at least:

- `azure.subscriptionId`
- `azure.tenantId`
- `azure.location`
- `handoffOrchestrator.resourceGroup`
- optional names for the Function app, Storage account, Key Vault, and Static Web App if you do not want generated names.

Placeholder reference for `scripts\demo-config.sample.json`:

| Field or placeholder | What to put there | Where you get it |
| --- | --- | --- |
| `azure.subscriptionId` | Azure subscription ID. | Values worksheet. |
| `azure.tenantId` | Microsoft Entra tenant ID. | Values worksheet. |
| `azure.globalAdminUpn` | Admin sign-in name for tenant operations that need it. | Tenant owner. |
| `azure.location` | Azure region for Function app, Storage, and related resources. | Choose in this step. |
| `handoffOrchestrator.resourceGroup` | Resource group name. | Choose in this step. |
| `handoffOrchestrator.functionAppName`, `storageAccountName`, `keyVaultName`, `staticWebApp.name` | Optional resource names. Leave blank to let the helper generate names. | Choose only if your environment has a naming standard. |
| `handoffOrchestrator.dataverse.orgUrl` / `https://YOUR-ORG.crm.dynamics.com` | Dataverse environment URL. | Step 2.1 and values worksheet. |
| `handoffOrchestrator.dataverse.cuaAgentBotId` | Copilot Studio bot ID. | Step 4.5. |
| `handoffOrchestrator.foundryRelay.invocationsUrl` / `https://<account>.services.ai.azure.com/api/projects/<project>/agents/<agent>/endpoint/protocols/invocations?api-version=v1` | Foundry hosted agent Invocations endpoint. | Step 5.6 and values worksheet. |
| `handoffOrchestrator.foundryRelay.tenantId` | Microsoft Entra tenant ID expected by the relay. | Values worksheet. |
| `handoffOrchestrator.foundryRelay.clientId` | Zava sign-in app client ID. | Step 3.3 and values worksheet. |
| `appRegistration.clientId` | Zava sign-in app client ID after the registration exists. | Step 3.3 and values worksheet. |
| `foundry.endpoint` / `https://<account>.services.ai.azure.com/api/projects/<project>` | Foundry project endpoint. | Foundry project overview and values worksheet. |

The script parameters were checked with `Get-Command .\scripts\Build-DemoFromScratch.ps1`. Its phases run in this order: A validate config and tools, B Azure CLI sign-in, C handoff service (Function app, Storage, managed identity), D nothing (the Foundry hosted agent is deployed on page 6), E Zava Static Web App, F CORS, G Intune. Use exactly these commands; `-SkipIntune` is required because the Claims app was assigned in step 2.4 and the presenter icon is step 3.6.

Values that come from later pages (`dataverse.cuaAgentBotId`, `foundryRelay.invocationsUrl`, `foundry.endpoint`) may stay as placeholders now. The bootstrap does not need them, and page 7 sets the matching Function app settings.

Preview:

```powershell
pwsh -File .\scripts\Build-DemoFromScratch.ps1 -ConfigPath .\scripts\demo-config.local.json -AgentBackend both -SkipIntune -WhatIf
```

Run:

```powershell
pwsh -File .\scripts\Build-DemoFromScratch.ps1 -ConfigPath .\scripts\demo-config.local.json -AgentBackend both -SkipIntune
```

Record the printed **CCaaS web app** URL (the Zava site) and **Handoff API** URL in the worksheet. Do not pass `-IncludeFoundryAgent`: it runs the retired `Deploy-Agent.ps1` (assistants / `computer-use-preview`) helper, which is not part of this install.

Function app runtime: a new Function app is created on the Linux Consumption plan with
**Node.js 22**, the last Node.js version Microsoft supports on that plan
([supported languages](https://learn.microsoft.com/azure/azure-functions/supported-languages#languages-by-runtime-version)).
The handoff service's unit tests pass on Node.js 22. If the Function app already exists, the
helper does not change its runtime: it prints the runtime it found and, if that is not
`node|22`, a warning with the exact `az functionapp config set ... --linux-fx-version "node|22"`
command. Run that command only if you decide to, when no run is in progress, then republish the
code (step 6.3) and repeat the checks on page 7. Read-only check:

```powershell
az functionapp config show --name <function-app-name> --resource-group <resource-group> --query linuxFxVersion -o tsv   # new installs print node|22 (letter case may differ)
```

Microsoft Azure Functions reference: <https://learn.microsoft.com/en-us/azure/azure-functions/functions-create-function-app-portal>
Microsoft Static Web Apps reference: <https://learn.microsoft.com/en-us/azure/static-web-apps/getting-started>

## 3.2 Record the Function app managed identity

After the Function app exists, record its managed identity principal ID:

```powershell
az functionapp identity show `
  --name <function-app-name> `
  --resource-group <resource-group> `
  --query principalId `
  -o tsv
```

You will use this identity for Dataverse and Foundry permissions.

## 3.3 Create the Zava sign-in app registration

Manual portal step.

1. Create an Entra app registration for the Zava CCaaS Agent Desktop.
2. Add a **Single-page application** redirect URI equal to the Static Web App root, for example `https://<site>.azurestaticapps.net/`.
3. Add another redirect URI for local development only if needed, for example `http://localhost:5173/`.
4. Record the tenant ID, client ID, and redirect URI.

Important: unauthenticated app loads are sent to `/login`, and the app starts MSAL redirects from `/login` by design. Do not set a redirect URI to `/login`; use the site root.

## 3.4 Expose the relay scope on the Zava app registration

The current code expects the Zava SPA app registration itself to expose the relay scope.

- Zava requests this exact scope in `apps\ccaas-agent-desktop\src\lib\msalLogin.ts`:
  ```text
  api://<Zava SPA client ID>/Handoff.Access
  ```
- The relay validates this in `apps\handoff-orchestrator\src\handoffAccessToken.js`:
  - `aud` must be `<client ID>` or `api://<client ID>`.
  - `azp` must be the same client ID.
  - `scp` must include `Handoff.Access`.
- Therefore `FOUNDRY_RELAY_CLIENT_ID` must be the same app/client ID that Zava uses for sign-in, unless you first change the Zava code to request a different API audience.

Manual portal step:

1. Open the Zava SPA app registration.
2. Go to **Expose an API**.
3. Set the Application ID URI to:
   ```text
   api://<Zava SPA client ID>
   ```
4. Add a delegated scope named exactly:
   ```text
   Handoff.Access
   ```
5. Add the same Zava SPA app as an authorized client application for that scope, or grant tenant admin consent.
6. Make the app issue **version 2** access tokens. The relay accepts only v2 tokens (it checks the
   v2 issuer `https://login.microsoftonline.com/<tenant-id>/v2.0` and the `azp` claim), and a new
   registration issues v1 access tokens for its own API until this is set, even though Zava
   signs in through the v2 endpoint. Either open **Manifest** and set
   `"requestedAccessTokenVersion": 2` (in the `api` section), save, or run:
   ```powershell
   Set-Content -Path .\token-v2.json -Value '{"api":{"requestedAccessTokenVersion":2}}'
   az rest --method PATCH `
     --uri "https://graph.microsoft.com/v1.0/applications(appId='<Zava SPA client ID>')" `
     --headers "Content-Type=application/json" `
     --body "@token-v2.json"
   Remove-Item .\token-v2.json
   ```
   Check it: the following must print `2`.
   ```powershell
   az ad app show --id <Zava SPA client ID> --query api.requestedAccessTokenVersion
   ```
   The reference app registration has this value set to `2`.
   ([Microsoft Graph apiApplication](https://learn.microsoft.com/en-us/graph/api/resources/apiapplication?view=graph-rest-1.0))
7. Record the tenant ID and client ID. These become `FOUNDRY_RELAY_TENANT_ID` and `FOUNDRY_RELAY_CLIENT_ID` on the Function app.

The browser asks for this scope only when the presenter chooses the Foundry option. The handoff service validates the user's bearer token before forwarding anything to Foundry.

## 3.5 Grant the Function app access to Foundry

Manual Azure role step.

Grant the Function app managed identity the built-in **Azure AI User** role on the Foundry project scope. In some Foundry surfaces this appears as **Foundry User**. Use project scope rather than subscription scope.

Do not grant broad subscription access if project-level scope is enough.

## 3.6 Give presenters the Zava desktop icon

Now that the Zava site URL exists (step 3.1), publish it to the presenter user group created in
step 2.4 as a Microsoft Edge web app with a desktop icon. This changes only that Edge policy.

```powershell
pwsh -File .\scripts\Deploy-DemoEnvironment.ps1 `
  -TenantId <tenant-id> `
  -Phase WebLink `
  -UserGroupName "Zava-Demo-Agent-Users" `
  -CcaasWebLinkName "Zava Contact Center" `
  -CcaasWebLinkUrl "https://<your-zava-site>/" `
  -WhatIf
```

Run it again without `-WhatIf` after review, then add each presenter's user account to
**Zava-Demo-Agent-Users**.

Caution: if an Intune policy with the `-CcaasWebLinkName` name already exists, this script
deletes it and creates it again with only this group, so any other assignments are lost. Use a
name of your own for each installation (the guided setup uses
`Zava Contact Center - <static web app name>` and never runs this over an existing policy).
