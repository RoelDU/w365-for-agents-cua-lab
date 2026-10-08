# 0. Prerequisites

## Licences and billing

| Need | Why it is needed | Where to set it up |
| --- | --- | --- |
| Azure subscription | Hosts the Function app, Storage, Static Web App, Container Registry, and billing policies. | Azure portal. |
| Copilot Studio entitlement or pay-as-you-go | Lets you create and publish the MCS agent. | Power Platform admin center. |
| Dataverse database in the Copilot Studio environment | The MCS path starts from a Dataverse row. Copilot Studio environments without Dataverse can appear to spin forever. | Power Platform admin center. |
| Windows 365 for Agents billing for the MCS Cloud PC pool | Computer Use needs Cloud PCs for the Copilot Studio pool. | Power Platform admin center for Copilot Studio pools. |
| Windows 365 for Agents billing for the Foundry Cloud PC pool | The Foundry hosted agent checks out Cloud PCs from its own pool. | Microsoft 365 admin center and Intune. |
| Microsoft Foundry project and model deployment | Hosts the pro-code agent and the model it calls. The reference setup used `gpt-4.1-mini` version `2025-04-14`, Global Standard. Hosted agents are offered in some regions only. | Azure CLI or the Foundry portal (install page 5). |
| Azure Container Registry | Holds the agent image you build from this repository. No prebuilt image is published. | Azure CLI (install page 5, step 5.3). |

Microsoft references:

- Windows 365 for Agents is a pool-based Cloud PC service where agents check out and check in Cloud PCs: <https://learn.microsoft.com/en-us/windows-365/agents/introduction-windows-365-for-agents>
- Cloud PC agent pools are shared pools, reset after use, and are managed as pools rather than assigned to one human user: <https://learn.microsoft.com/en-us/windows-365/agents/cloud-pc-agent-pools>
- Windows 365 for Agents billing uses pay-as-you-go plus optional always-available Cloud PCs: <https://learn.microsoft.com/en-us/windows-365/agents/billing-w365a>
- Copilot Studio Cloud PC pools are backed by Windows 365 for Agents and are Entra-joined and Intune-enrolled: <https://learn.microsoft.com/en-us/microsoft-copilot-studio/use-cloud-pc-pool>
- Intune Win32 apps are the supported package type for traditional Windows desktop apps: <https://learn.microsoft.com/en-us/mem/intune/apps/apps-win32-app-management>
- Windows 365 supports the Enrollment Status Page (ESP), but custom ESP targeting for Cloud PCs must use an `enrollmentProfileName` filter, not dynamic groups: <https://learn.microsoft.com/en-us/windows-365/enterprise/enrollment-status-page>

## Admin roles

| Step | Minimum role normally needed |
| --- | --- |
| App registrations, exposed scopes, and tenant consent | Global Administrator or Cloud Application Administrator plus a tenant admin for consent. |
| Azure resources and role assignments | Owner, or Contributor plus User Access Administrator for role assignments. |
| Intune Win32 app, device groups, provisioning policies, and ESP | Intune Administrator. |
| Dataverse table, security roles, trigger flow, and app user | Power Platform admin or environment System Administrator. |
| Copilot Studio agent and Computer Use tool | Copilot Studio maker with access to the target environment and Cloud PC pool. |
| Foundry project, model deployment, registry and role assignments | Contributor on the resource group (create), Owner or User Access Administrator (role assignments), Foundry User on the project (deploy agent versions). |
| Foundry agent user and Computer Use consent (install step 5.7) | Agent ID Administrator, plus Privileged Role Administrator or Global Administrator for tenant-wide consent. |
| Optional Cloud PC availability check (install step 6.2a) | An administrator who can grant Microsoft Graph application permissions (`CloudPC.Read.All`). |

## Local tools for the installer

Install these on the administrator workstation that runs scripts:

```powershell
az version
pwsh --version
node --version          # Node 20 or later for local builds
python --version        # Python 3.12 for the Foundry hosted sample
func --version          # Azure Functions Core Tools v4
swa --version           # Azure Static Web Apps CLI, or use npx
```

If a tool is missing, install it before continuing. The presenting package for Foundry does not need these tools; only the one-time installer does.

A C compiler is **not** needed: the install uses the committed Claims package
`deploy\intune-packages\ZavaClaims.intunewin`. Only someone who changes the Claims app's source
and rebuilds the package (page 2, step 2.3) needs MinGW `gcc` and `windres` on `PATH`.

## Safety checks

- Real copies of config files must be named `*.local.json`; those files are git-ignored.
- Never paste secrets into Markdown, sample JSON, command history you plan to share, or committed files.
- Use `-WhatIf`, `-Plan`, or read-only commands first. Only run creating commands after the tenant owner approves them.
