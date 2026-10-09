# 5. Foundry hosted path

> **Reference page.** The guided setup in the [install guide](README.md) does this page's work for you (steps 14-17 and 20 there). Use this page to understand a step, to troubleshoot, or to install by hand.

This path is the supported pro-code install path:

```text
Zava -> /api/foundry-claims/* relay -> Foundry hosted agent Invocations endpoint -> Windows 365 for Agents Cloud PC -> Claims app
```

How the agent works is described in the [sample overview](../../samples/foundry-hosted-claims/README.md) and its reference pages. This page gives the repeatable install shape and the repository scripts.

## 5.1 Prepare the Foundry project, identity, and permissions

Use synthetic claims data only. Do not connect this sample to production claims data.

### 5.1.1 Foundry project and model

Choose the Foundry project **explicitly** and write its names in the worksheet: Foundry
resource (account) name, project name, subscription, resource group and region. Use a project
meant for this lab. Do not reuse another project (for example a training or exam project)
just because your sign-in can see it: the hosted agent, its identity and its model calls are
created in whichever project the config names. Hosted agents are available only in some
regions; check [region support](https://learn.microsoft.com/azure/foundry/reference/region-support)
first. The reference environment used Australia East.

1. Create the project, or confirm the existing one, with the Azure CLI (2.80 or later;
   **Contributor** on the resource group). Creating:
   [Learn](https://learn.microsoft.com/azure/foundry/how-to/create-projects).

   ```powershell
   az cognitiveservices account create --name <foundry-resource> --resource-group <resource-group> `
     --kind AIServices --sku S0 --location <region> --custom-domain <foundry-resource> `
     --assign-identity --allow-project-management true
   az cognitiveservices account project create --name <foundry-resource> --resource-group <resource-group> `
     --project-name <project> --location <region>
   ```

   Read-only check (both must print `Succeeded`, and the region must be the one you chose):

   ```powershell
   az cognitiveservices account show --name <foundry-resource> --resource-group <resource-group> --query "{state:properties.provisioningState, region:location}"
   az cognitiveservices account project show --name <foundry-resource> --resource-group <resource-group> --project-name <project> --query properties.provisioningState -o tsv
   ```

   The project endpoint is `https://<foundry-resource>.services.ai.azure.com/api/projects/<project>`.
2. Deploy the model the agent calls. The agent uses the deployment named in
   `AZURE_AI_MODEL_DEPLOYMENT_NAME` (default `gpt-4.1-mini`). The reference environment used
   model `gpt-4.1-mini` version `2025-04-14`, deployment type **Global Standard**, capacity 250
   (thousand tokens per minute). One claim takes tens of model calls, each with a full screen
   description, so a small quota slows or fails runs. Check your quota first with
   `az cognitiveservices usage list --location <region> -o table`. Model deployments are billed per
   token used.

   ```powershell
   az cognitiveservices account deployment create --name <foundry-resource> --resource-group <resource-group> `
     --deployment-name gpt-4.1-mini --model-name gpt-4.1-mini --model-version 2025-04-14 `
     --model-format OpenAI --sku-name GlobalStandard --sku-capacity 250
   az cognitiveservices account deployment show --name <foundry-resource> --resource-group <resource-group> `
     --deployment-name gpt-4.1-mini --query "{model:properties.model.name, version:properties.model.version, sku:sku.name, capacity:sku.capacity, state:properties.provisioningState}"
   ```

3. Create or choose the **container registry** that will hold the agent image. You build the
   image from this repository into your own registry (step 5.3); no prebuilt image is
   published and you need no access to anyone else's registry. A Basic registry has a small
   monthly charge, and registry builds are billed per build time. Use the same subscription;
   the region can match the project:

   ```powershell
   az acr create --name <registry> --resource-group <resource-group> --sku Basic --location <region>
   az acr show --name <registry> --query "{name:name, loginServer:loginServer, state:provisioningState}"   # read-only check
   ```

   The second command must show `Succeeded`. Record `<registry>` in the worksheet; it is
   `containerRegistryName` in step 5.2. If you use an existing registry, run only the check.
4. Give the person who deploys the agent **Foundry User** on the project (it lets them create
   hosted agent versions; older pages call it **Azure AI User**), and **Contributor** on the
   registry from item 3 so `az acr build` can run a registry build and push the image.
5. Let the project pull the image from that registry: give the **project's** managed identity **Container
   Registry Repository Reader** on the registry (or **AcrPull** if the registry does not use
   repository permissions). The registry must exist first (item 3): the commands read its ID.
   The hosted agent definition does not name a registry connection;
   do not add `registry_connection_id` (see the sample README). The reference project also has a
   container-registry project connection; it is not used by this definition and is not known to
   be required.

   ```powershell
   $projectMi = az cognitiveservices account project show --name <foundry-resource> --resource-group <resource-group> --project-name <project> --query identity.principalId -o tsv
   $acrId = az acr show --name <registry> --query id -o tsv
   az role assignment create --assignee-object-id $projectMi --assignee-principal-type ServicePrincipal --role AcrPull --scope $acrId
   az role assignment list --assignee $projectMi --scope $acrId -o table   # read-only check
   ```

   Rollback: `az role assignment delete --assignee $projectMi --role AcrPull --scope $acrId`.

Microsoft references:

- Hosted agent deployment: <https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/deploy-hosted-agent>
- Hosted agent permissions: <https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agent-permissions>
- Hosted environment variables and reserved `FOUNDRY_*` names: <https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-hosted-agent-env-variables>

### 5.1.2 Agent identity, agent user and Computer Use permissions (overview)

The hosted agent signs in with its own native identity, not a Bot Service identity and not a
secret. The pieces are created in this order, and each step below says when:

1. The **first hosted version** (step 5.5, with both execution gates `no`) makes Foundry create
   the agent's **blueprint** and **agent identity**. The deployment receipt records them.
2. Step 5.7 then creates the **agent user** linked to that agent identity, consents exactly three
   delegated scopes on the blueprint, and assigns the agent to the Windows 365 for Agents pool.
3. You fill the four `CLAIMS_*_ID` values, turn the gates on and **deploy again** (step 5.7).

Never create a second, unrelated blueprint or identity to work around a token failure: the
sample rejects IDs that conflict with the hosted runtime's own values.

Microsoft references:

- Agent user: <https://learn.microsoft.com/graph/api/agentuser-post>
- Autonomous agent token flow: <https://learn.microsoft.com/entra/agent-id/autonomous-agent-authentication-authorization-flow>
- Windows 365 for Agents MCP tools: <https://learn.microsoft.com/windows-365/agents/mcp-tool-overview>

### 5.1.4 Function app relay permission

Grant the handoff Function app's managed identity **Foundry Agent Consumer** on the Foundry
project. It is Microsoft's least-privilege role for calling agent endpoints, and it is what the
reference environment uses. (An earlier reference project used the broader **Foundry User**;
that also works but is not needed.) This is separate from the hosted agent's own identity and
from the presenter's relay token.

```powershell
$relayMi = az functionapp identity show --name <function-app-name> --resource-group <resource-group> --query principalId -o tsv
$projectId = az cognitiveservices account project show --name <foundry-resource> --resource-group <resource-group> --project-name <project> --query id -o tsv
az role assignment create --assignee-object-id $relayMi --assignee-principal-type ServicePrincipal --role "Foundry Agent Consumer" --scope $projectId
az role assignment list --assignee $relayMi --scope $projectId -o table   # read-only check
```

Rollback: `az role assignment delete --assignee $relayMi --role "Foundry Agent Consumer" --scope $projectId`.
The Function app exists after page 3; do this step then if you are following the pages in order.

## 5.2 Create the private deployment config

```powershell
Copy-Item .\deploy\foundry\foundry-agent.sample.json .\deploy\foundry\foundry-agent.local.json
notepad .\deploy\foundry\foundry-agent.local.json
```

Fill only your tenant-neutral values in the local file. Keep secrets out of it. The sample file documents each field.

The deploy helper runs Python with the Foundry SDK. Install the sample's pinned packages into
a local virtual environment once (it is git-ignored), and pass that Python to every
`Deploy-FoundryAgent.ps1` command below with `-Python`:

```powershell
py -3.12 -m venv .\samples\foundry-hosted-claims\.venv
.\samples\foundry-hosted-claims\.venv\Scripts\python -m pip install -e .\samples\foundry-hosted-claims
$foundryPython = (Resolve-Path .\samples\foundry-hosted-claims\.venv\Scripts\python.exe).Path
```

Without `-Python $foundryPython`, the script uses whatever `python` is on `PATH` and stops with
"Missing Foundry SDK packages" if that Python lacks them.

Placeholder reference:

| Field or placeholder | What to put there | Where you get it |
| --- | --- | --- |
| `tenantId` | Microsoft Entra tenant ID. | Values worksheet. |
| `subscriptionId` | Azure subscription ID. | Values worksheet. |
| `resourceGroup` | Resource group that holds the container registry. | Values worksheet or your Azure plan. |
| `containerRegistryName` | Azure Container Registry name, without `.azurecr.io`. | Step 5.1.1, item 3. |
| `imageRepository` / `imageTag` | Repository and tag to build, for example `claims-w365:v1`. | Choose before building the image. |
| `imageDigest` | Image digest such as `sha256:...`. | Leave blank. `-BuildImage` writes the built digest here; the later steps read it from this file. |
| `foundryProjectEndpoint` / `https://<account>.services.ai.azure.com/api/projects/<project>` | Foundry project endpoint. | Foundry project overview. |
| `agentName` | Hosted agent name, normally `claims-w365`. | Values worksheet. |
| `CLAIMS_TENANT_ID`, `CLAIMS_BLUEPRINT_ID`, `CLAIMS_AGENT_ID`, `CLAIMS_AGENT_USER_ID` | Leave all four **empty** for the first deployment (gates `no`). | Printed by `Set-FoundryAgentIdentity.ps1` in step 5.7; fill them before the second deployment. |
| `expectedInstanceIdentityClientId` | Optional safety check for the hosted agent instance identity client ID. | Same value as `CLAIMS_AGENT_ID`, if you want the check. |
| `outputReceiptPath` | Git-ignored local receipt path. | Keep the sample default unless your operator process needs another path. |

## 5.3 Build the container image

The registry was created or chosen in step 5.1.1, item 3, and the project can already pull from it (item 5).

Plan first:

```powershell
pwsh -File .\deploy\foundry\Deploy-FoundryAgent.ps1 `
  -ConfigPath .\deploy\foundry\foundry-agent.local.json `
  -Plan
```

Check that the plan names your subscription, registry and Foundry project. Build only after the owner approves the Azure Container Registry build cost:

```powershell
pwsh -File .\deploy\foundry\Deploy-FoundryAgent.ps1 `
  -ConfigPath .\deploy\foundry\foundry-agent.local.json `
  -Python $foundryPython `
  -BuildImage
```

The script copies only the files the Dockerfile uses (the agent source, its `pyproject.toml` and three shared schemas) into a temporary folder and builds that with `samples\foundry-hosted-claims\Dockerfile`, so git-ignored local files such as `.env` files or virtual environments are never uploaded to the registry's build service. It then saves the image digest as `imageDigest` in `foundry-agent.local.json`, so the separate commands in 5.4 and 5.5 use exactly that image. Hosted agent versions must use an image pinned by `@sha256:...`, not a mutable tag.

Every changing switch (`-BuildImage`, `-DeployVersion`, `-ConfigureEndpoint`) accepts `-WhatIf`, which only prints what it would do: no build, no Python call, no Foundry change.

## 5.4 Render the hosted-agent definition

```powershell
pwsh -File .\deploy\foundry\Deploy-FoundryAgent.ps1 `
  -ConfigPath .\deploy\foundry\foundry-agent.local.json `
  -Python $foundryPython `
  -RenderDefinition
```

This writes the git-ignored definition receipt `deploy\foundry\foundry-agent-deployment-render.local.json`. Review it before deploying. The default definition keeps both execution gates off unless your local config explicitly enables them:

- `LIVE_EXECUTION_APPROVED`
- `CLAIMS_EXECUTION_APPROVED`

## 5.5 Create a hosted agent version

Deploy only after the rendered definition is reviewed:

```powershell
pwsh -File .\deploy\foundry\Deploy-FoundryAgent.ps1 `
  -ConfigPath .\deploy\foundry\foundry-agent.local.json `
  -Python $foundryPython `
  -DeployVersion
```

The script uses your Azure CLI sign-in and the Foundry SDK to create a new version of the configured agent. On the first run the agent does not exist yet and this command creates it with version 1 (only a "not found" answer is treated that way; sign-in or permission errors stop the script). Later runs add versions; if `expectedInstanceIdentityClientId` is set, they first check that the live agent has that identity. The result, including the agent identity, is recorded in the deployment receipt `deploy\foundry\foundry-agent-deployment.local.json`. Only this step writes that file.

A hosted agent's compute is billed while a session runs (0.5 vCPU / 1 GiB here); each session
ends 20 minutes after its last request, and that idle time is billed too.

Read-only check (the same read the operator's readiness script uses):

```powershell
az rest --method get --resource https://ai.azure.com `
  --url "https://<foundry-resource>.services.ai.azure.com/api/projects/<project>/agents/claims-w365?api-version=v1" `
  --query "{latest:versions.latest.version, status:versions.latest.status, image:versions.latest.definition.container_configuration.image, live:versions.latest.definition.environment_variables.LIVE_EXECUTION_APPROVED, claims:versions.latest.definition.environment_variables.CLAIMS_EXECUTION_APPROVED, identity:instance_identity.client_id}"
```

`status` must be `active` and `image` must end with the digest from 5.3.

Rollback: Foundry keeps earlier versions and the endpoint serves the latest one. The fastest
stop needs no redeploy: set the relay's `FOUNDRY_CLAIMS_READY=0` (page 6, step 6.2), and Zava no
longer starts Foundry transfers. To change the agent itself, put the earlier `imageDigest` or
both gates `no` back in the local config and run 5.4 and 5.5 again; that adds a new version
with those settings.

## 5.6 Configure the Invocations endpoint

If your Foundry project did not already expose the agent endpoint as Invocations with Entra authorization, run the endpoint configuration only after reading the plan:

```powershell
pwsh -File .\deploy\foundry\Deploy-FoundryAgent.ps1 `
  -ConfigPath .\deploy\foundry\foundry-agent.local.json `
  -Python $foundryPython `
  -ConfigureEndpoint
```

Its result goes to its own receipt, `deploy\foundry\foundry-agent-deployment-endpoint.local.json`, so the deployment receipt from 5.5 (with the agent identity needed in 5.7) is kept. Record the Invocations endpoint in the worksheet. It becomes the handoff service setting `FOUNDRY_INVOCATIONS_URL`:

```text
https://<foundry-resource>.services.ai.azure.com/api/projects/<project>/agents/claims-w365/endpoint/protocols/invocations?api-version=v1
```

Read-only check: run the 5.5 read with `--query agent_endpoint`; it must list the Invocations
protocol and Entra authorization. Running this step again is harmless (it sets the same values).

## 5.7 Create the agent user, consent the Computer Use scopes, and turn the agent on

Do this once, after the first hosted version from step 5.5 is active.

1. **Find the agent identity.** Open the deployment receipt written by step 5.5 (step 5.6 does not change it)
   (`deploy\foundry\foundry-agent-deployment.local.json`). Under `deployment.identity`, copy
   `instance_identity.client_id`. That is the agent identity's ID.
2. **Plan the identity setup (read-only).** Sign the Azure CLI in to the tenant as an
   administrator who holds **Agent ID Administrator**, plus **Privileged Role Administrator** or
   **Global Administrator** for tenant-wide consent:

   ```powershell
   az login --tenant <tenant-id>
   pwsh -File .\deploy\foundry\Set-FoundryAgentIdentity.ps1 `
     -TenantId <tenant-id> `
     -AgentIdentityId <instance_identity.client_id> `
     -AgentUserPrincipalName claims-agent@<your-verified-domain>
   ```

   It lists what it would do: create the agent user, register the **W365Agents-Production**
   service in the tenant if it is missing, and declare, make inheritable and consent tenant-wide
   exactly these delegated scopes on the agent's blueprint:

   | Resource | App ID | Scope |
   | --- | --- | --- |
   | Agent 365 Tools | `ea9ffc3e-8a23-4a7d-836d-234d7c7565c1` | `McpServersMetadata.Read.All` |
   | Windows 365 Computer Use MCP | `da81128c-e5b5-4f9e-8d89-50d906f107c5` | `Tools.ListInvoke.All` |
   | W365Agents-Production | `90ecec28-f5a6-42b3-9bde-dae1ca98f8b5` | `Computer.See` |

   `Computer.Control` is deliberately not granted: the live view in Zava is view-only.
3. **Apply it** by running the same command with `-Apply`. Run the plan again afterwards; it
   must say "Nothing to change". It prints the four `CLAIMS_*_ID` values.
4. **Assign the agent to its Cloud PC pool.** Create the Windows 365 for Agents pool now (page 2,
   step 2.6) or edit it: on its **Agents** page select **Add Agents** and choose this hosted
   agent ([Learn](https://learn.microsoft.com/windows-365/agents/create-provisioning-policy-agents)).
   Without the portal, add the agent user (`CLAIMS_AGENT_USER_ID`) with Microsoft Graph beta
   `POST /deviceManagement/virtualEndpoint/cloudPcPools/{pool-id}/assignments` and body
   `{"@odata.type": "#microsoft.graph.cloudPcAgentPoolUserAssignment", "userPrincipalId": "<agent user id>"}`
   (delegated `CloudPC.ReadWrite.All`; [Learn](https://learn.microsoft.com/graph/api/cloudpcpool-post-assignments?view=graph-rest-beta)).
   Existing assignments are kept. Send an ordinary `User-Agent` header: the Windows 365 service
   gateway answered 403 to Python's default one. Read-only check:
   `GET /deviceManagement/virtualEndpoint/cloudPcPools/{pool-id}/assignments` must list the agent
   user. Rollback: remove the agent from the pool's **Agents** page.
5. **Fill the values and turn the agent on.** In `deploy\foundry\foundry-agent.local.json` set
   the four `CLAIMS_*_ID` values from step 3, `LIVE_EXECUTION_APPROVED` = `yes` and
   `CLAIMS_EXECUTION_APPROVED` = `yes`, and set `expectedInstanceIdentityClientId` to the agent
   identity ID. Then run step 5.4 (render) and step 5.5 (deploy) again. The deployment script
   refuses to turn a gate on while any of the four IDs is empty.

The reference environment's first agent was configured with exactly these Graph calls (agent
user, service registration, scope declaration, inheritance and tenant-wide consent); the script
then found nothing to change there. On 8 October 2026 the script's `-Apply` set up a second
agent in a new project of the same tenant: it created the agent user and the three consents,
and its re-plan said "Nothing to change". It has not been run in another tenant.

Sign-in: these are administrator actions on Microsoft Entra, done with the administrator's own
Azure CLI sign-in. The script does not store tokens or create a service principal for itself.
To undo them, delete the agent user (`DELETE /users/<agent user id>`) and the blueprint's three
tenant-wide grants: list them read-only with
`GET /oauth2PermissionGrants?$filter=clientId eq '<blueprint service principal id>'` and delete
each with `DELETE /oauth2PermissionGrants/<id>`. The script has no remove mode.

## 5.8 What is not scripted here

- creating the Windows 365 for Agents pool itself (page 2, step 2.6, Intune portal), because
  the pool's billing plan, size and image are tenant decisions;
- proving live Claims execution in your tenant (page 7).

Everything else on this page has a command above. Each command that creates or changes
something has a read-only check and a rollback next to it.
