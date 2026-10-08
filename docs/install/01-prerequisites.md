# 0. Prerequisites

Read this whole page before you start. It lists everything the two paths of this lab depend on,
traced from the install pages and scripts:

- **0.1 Products, licences and billing** that must exist before you start. A missing product
  entitlement **blocks the installation**; it cannot be fixed later in the guide. (Billing for the
  Copilot Studio Cloud PC pool is the one exception with a documented trial allowance; see its
  row.)
- **0.2 Tenant configuration and identities**: what must already be in place and what the guide
  creates for you, step by step.
- **0.3 Who can do each step**: administrator roles and permissions. These are not licences.
- **0.4 Local tools and network** for the person who installs. Installed software is not a
  licence either.
- **0.5 Open questions**: points where Microsoft's documentation and this lab's reference
  installation do not settle the answer. Read them before you buy or change anything.

**Path** in the tables means: **Both**, **MCS** (Copilot Studio path), **Foundry** (Foundry
path), or **Optional**. If you install only one path, you can skip the rows for the other.

Several of these services are new or in preview: the Copilot Studio Cloud PC pool page is marked
preview, and Agent 365, Windows 365 for Agents and Foundry hosted agents change often. The sources
below were checked on 9 October 2026; check them again before you buy anything.

## 0.1 Products, licences and billing to have before you start

| Product or service | Path | Why the lab needs it | What you need | How to check | Microsoft source |
| --- | --- | --- | --- | --- | --- |
| **Microsoft Entra ID tenant** with a verified domain | Both | Every sign-in: presenters, the Zava app registration, the handoff service's managed identity, the Foundry agent user, and the Cloud PCs, which are joined to Microsoft Entra ID. The Foundry agent user's sign-in name must use a domain verified in the tenant (step 5.7). | A working tenant, included with any Microsoft cloud subscription. The tenant's initial `onmicrosoft.com` domain is verified and can be used. | Microsoft Entra admin center > **Domain names** lists the domain as verified. | [Windows 365 requirements](https://learn.microsoft.com/windows-365/enterprise/requirements) |
| **Microsoft Entra ID P1** | MCS | The tenant-preparation step (2.2) creates a **dynamic** device group (`CPCPool_` rule). It hides the remote desktop consent prompt for Copilot Studio Cloud PCs and receives the Claims app. Microsoft: "Dynamic groups require a Microsoft Entra ID P1 license or Intune for Education license." The Foundry pool uses an **assigned** group, which does not need P1. | Microsoft Entra ID P1, on its own or as part of a suite that includes it (for example Microsoft 365 E3 or E5, Enterprise Mobility + Security E3, Microsoft 365 Business Premium). | Microsoft Entra admin center > **Overview** shows the licence (P1 or P2). | [Cloud PC pool prerequisites](https://learn.microsoft.com/microsoft-copilot-studio/use-cloud-pc-pool#configure-technical-prerequisites-for-it-administrators), [Entra licensing](https://learn.microsoft.com/entra/fundamentals/licensing) |
| **Microsoft Intune** | Both | Cloud PCs for Agents are Intune-managed. Intune delivers the Claims app to both pools (steps 2.4, 2.6), holds the Foundry pool's provisioning policy (agents) (step 2.6) and, optionally, the presenters' desktop icon (step 3.6). | Foundry: "A Microsoft Intune license" is a listed prerequisite for a provisioning policy (agents). MCS: "A valid and working Intune and Microsoft Entra tenant." Neither page says how many licences or for whom (open question 5). The optional presenter icon only reaches presenters whose Windows device is managed by Intune. | The Intune admin center opens and **Tenant administration > Tenant status** shows an active tenant. | [Provisioning policy (agents) prerequisites](https://learn.microsoft.com/windows-365/agents/create-provisioning-policy-agents#prerequisites), [Cloud PC pool prerequisites](https://learn.microsoft.com/microsoft-copilot-studio/use-cloud-pc-pool#microsoft-entra-and-intune-requirements) |
| **Microsoft Agent 365** | Both, in this lab | **Foundry:** the Windows 365 for Agents pool is created "through Agent 365": a provisioning policy (agents) requires "An Agent 365 license in your tenant", and the agent finds its computer use tools through the Agent 365 tooling (the **Agent 365 Tools** permission in step 5.7). **MCS:** the reference installation also needed Agent 365 on the Copilot Studio path. Microsoft's Copilot Studio Cloud PC pool page does not mention Agent 365 either way; see open question 1. | Licensed **per user**; generally available for commercial customers since 1 May 2026. "At least one user must be licensed with a qualifying Microsoft Agent 365 license to enable Agent 365." Agents do not need their own licence: agents "managed or owned by a licensed user ... are covered under that user's" licence. Included in Microsoft 365 E7. Otherwise, Microsoft's licensing FAQ lists these base licences for buying Agent 365: enterprise, Microsoft 365 E5, or Microsoft 365 E3 (or Office 365 E3 + EMS E3) plus both Defender Suite and Purview Suite; frontline, Microsoft 365 F1/F3 plus Defender and Purview Suite FLW; small business, Microsoft 365 Business Premium; education, Microsoft 365 A5 or A3 for Faculty with the education Defender and Purview suites. Which lab accounts should hold it: open question 6. | Microsoft 365 admin center > **Billing > Licenses** shows an Agent 365 (or Microsoft 365 E7) licence assigned to the people who own the lab's agents. | [Agent 365 availability and licensing](https://learn.microsoft.com/microsoft-agent-365/overview#agent-365-availability-and-prerequisites), [Agent 365 licensing FAQ](https://www.microsoft.com/licensing/faqs/122), [Agent 365 FAQ (licence coverage)](https://learn.microsoft.com/microsoft-agent-365/frontier) |
| **Windows 365 for Agents billing, Copilot Studio route** | MCS | Pays for the Copilot Studio Cloud PC pool. | A pay-as-you-go billing plan for the Power Platform environment, linked to an Azure subscription, **once the trial allowance is used up**. The trial allows up to two Cloud PC pools per tenant without a billing plan, test-chat runs are not billed, and each tenant gets 50 free hours for published agents running autonomously. This lab's runs are published and autonomous (started by the trigger flow), so they use those 50 hours; a lasting installation needs the billing plan. | The Power Platform admin center shows a pay-as-you-go billing plan that includes the environment. | [Cloud PC pool licensing requirements](https://learn.microsoft.com/microsoft-copilot-studio/use-cloud-pc-pool#licensing-requirements), [Set up a pay-as-you-go plan](https://learn.microsoft.com/power-platform/admin/pay-as-you-go-set-up) |
| **Windows 365 for Agents billing, Agent 365 route** | Foundry | Pays for the Foundry pool. "If a billing plan disables Windows 365 for Agents, any Cloud PC check-out action will fail." | A billing policy in the Microsoft 365 admin center (**Copilot > Cost management > classic Billing & usage > Billing policies**) with an Azure subscription, resource group and region, and **Windows 365 for Agents** turned on under **Pay-as-you-go services**. Usage is pay-as-you-go, plus a monthly charge per always-available Cloud PC; the provisioning policy (agents) asks for an always-available count of 1-200. | The billing policy name is offered when you create the provisioning policy (agents) in Intune (step 2.6). | [Set up billing for Windows 365 for Agents](https://learn.microsoft.com/windows-365/agents/billing-w365a), [Pricing](https://learn.microsoft.com/windows-365/agents/pricing-paygo-always-available) |
| **Microsoft Copilot Studio** (standalone) | MCS | The agent uses generative orchestration, the computer use tool and connectors, and must be published. | A standalone Copilot Studio subscription for the tenant (Copilot Credits through a capacity pack or a pay-as-you-go plan). The Copilot Studio plan included in some Microsoft 365 subscriptions is **not** enough: it has no generative orchestration and no Power Platform connectors. A trial licence cannot publish. Computer use consumes Copilot Credits for each step. | You can open the environment in Copilot Studio, publish an agent, and Power Platform admin center shows Copilot Credits capacity or a billing plan for it. | [Get access to Copilot Studio](https://learn.microsoft.com/microsoft-copilot-studio/requirements-licensing-subscriptions), [Computer use](https://learn.microsoft.com/microsoft-copilot-studio/computer-use), [Licensing Guide](https://go.microsoft.com/fwlink/?linkid=2320995) |
| **Power Platform environment with Dataverse** | MCS | Holds the agent, the trigger table, the trigger flow and the computer use run log that the handoff service reads. The environment's geography decides where the Copilot Studio Cloud PCs run. | An environment with a Dataverse database and enough Dataverse capacity in the tenant. | Power Platform admin center > **Environments** shows the environment with Dataverse. | [Add a Dataverse database](https://learn.microsoft.com/power-platform/admin/create-database) |
| **Power Automate** cloud flow | MCS | Starts the agent when the handoff service adds a Dataverse row, and writes the receipt back. | The flow uses the **Microsoft Dataverse** connector (**premium**) and the **Microsoft Copilot Studio** connector (**standard**). Copilot Studio includes Power Automate rights, but they "are limited to cloud flows within the context of Microsoft Copilot Studio bots". Whether this flow is inside that context is not settled (open question 2). If it is not, the flow owner needs Power Automate Premium, or the flow needs a Process licence. | After the first run, the Power Automate licence-use view in the Power Platform admin center must not list the flow under **Attention needed** as a premium flow running out of context. | [Power Platform licensing FAQ: Copilot Studio](https://learn.microsoft.com/power-platform/admin/powerapps-flow-licensing-faq#microsoft-copilot-studio), [Dataverse connector](https://learn.microsoft.com/connectors/commondataserviceforapps/), [Copilot Studio connector](https://learn.microsoft.com/connectors/microsoftcopilotstudio/), [View Power Automate licence use](https://learn.microsoft.com/power-platform/admin/view-license-consumption-power-automate) |
| **Microsoft Foundry** with a model deployment | Foundry | Hosts the pro-code agent and the model it calls. | Azure consumption: hosted-agent compute while a session runs, and model tokens. Hosted agents are available in some regions only. The reference used `gpt-4.1-mini` version `2025-04-14`, Global Standard, with 250 thousand tokens per minute; one claim makes tens of model calls, and a small quota slows or fails runs. The minimum quota that works reliably has not been measured. | `az cognitiveservices usage list --location <region> -o table` shows the quota available for the model in your region; the region is in the hosted agents region list. | [Hosted agents (regions, billing)](https://learn.microsoft.com/azure/foundry/agents/concepts/hosted-agents), [Quotas and limits](https://learn.microsoft.com/azure/foundry/openai/quotas-limits) |
| **Azure subscription** | Both | Handoff service (Function app on the Consumption plan, Storage, Key Vault), Zava Static Web App (Free plan), and for Foundry the Foundry resource and a Container Registry (Basic). Both Windows 365 for Agents billing routes also bill to an Azure subscription. | A subscription you may create resources in. The helper registers the `Microsoft.Web`, `Microsoft.Storage` and `Microsoft.KeyVault` resource providers; the Foundry path also uses `Microsoft.CognitiveServices` and `Microsoft.ContainerRegistry`. | `az account show`; `az provider show --namespace Microsoft.CognitiveServices --query registrationState -o tsv` prints `Registered` (repeat for the others). | [Resource providers](https://learn.microsoft.com/azure/azure-resource-manager/management/resource-providers-and-types) |

Not needed: a separate Windows licence or a Microsoft 365 Unattended licence for the Copilot
Studio Cloud PC pool ([FAQ](https://learn.microsoft.com/microsoft-copilot-studio/use-cloud-pc-pool#frequently-asked-questions-faq)),
a separate Azure Virtual Desktop deployment, a separate Entra Agent ID licence ("Agent ID is
available for all Microsoft Entra customers", [Entra licensing](https://learn.microsoft.com/entra/fundamentals/licensing#microsoft-entra-agent-id)),
or a compiler.

## 0.2 Tenant configuration and identities

"Guide creates" names the step that does it. "Must exist" means the guide expects it and does
not create it.

### Microsoft Entra ID

| Item | Path | Must exist or guide creates | What to know |
| --- | --- | --- | --- |
| Microsoft Remote Desktop service principal (`a4a365df-50f1-4397-bc59-1a1564b8bb9c`) with **Microsoft Entra authentication for RDP** turned on | MCS | Service principal must exist (Microsoft creates it); step 2.2 turns RDP authentication on | Copilot Studio Cloud PC pools sign in to the Cloud PC through a remote desktop session with a Microsoft Entra account. Microsoft also documents an alternative (turning off Network Level Authentication through Intune) that this guide does not use. |
| Dynamic device group **Zava W365A Cloud PC Pools**, rule `(device.enrollmentProfileName -startsWith "CPCPool_")`, added as a **target device group** on that service principal | MCS | Step 2.2 (`-CreateDynamicGroup`) | Hides the consent prompt; without it, runs fail with `MSEntraRemoteDesktopAppConsentRequired`. Needs Entra ID P1. Up to 10 target device groups. Membership can take up to 24 hours in large tenants. |
| Windows 365 (`0af06dc6-e4b5-4f28-818e-e78e62d137a5`) and Azure Virtual Desktop service principals (`9cdead84-a844-4324-93f2-b2e6bb768d07`, `a85cf173-4192-42f8-81fa-777a763e6e2c`, `50e95039-b200-4007-bc97-8d5790743a63`) | Both | Must exist; normally created automatically | Create one with `az ad sp create --id <app id>` only if Cloud PC provisioning reports it missing. Their presence is not a sign that you need an Azure Virtual Desktop deployment. |
| Foundry pool device group **Zava W365A Foundry Claims Devices** (assigned membership) | Foundry | Step 2.6 | The Windows 365 for Agents pool adds its Cloud PCs to it. See open question 4 about the consent prompt for this group. |
| Presenter user group **Zava-Demo-Agent-Users** | Both | Step 2.4 creates it; you add presenters (step 3.6) | Presenters sign in to Zava with existing accounts in this tenant. |
| **Zava app registration**: single-page application, redirect URI = site root | Both | Step 3.3 | Do not use `/login` as the redirect URI. |
| Exposed API `api://<Zava client ID>` with delegated scope **`Handoff.Access`**, Zava added as an authorised client application or tenant admin consent, and `requestedAccessTokenVersion` = `2` | Foundry (the scope is requested only for the Foundry option) | Step 3.4 | The relay accepts only v2 tokens whose audience and `azp` are the Zava client ID, in the configured tenant. Without consent, presenters may see a consent prompt or be blocked, depending on your tenant's user consent settings. |
| Handoff Function app **system-assigned managed identity** | Both | Step 3.1 | Used for Key Vault (granted by the helper), Dataverse (MCS) and Foundry (Foundry). |
| Dataverse **application user** for that managed identity, with a security role that can write the trigger table and read `flowsessions`, `flowlogs`, `flowsessionbinaries` | MCS | Step 4.2 | Application users need no licence ("You can create an unlicensed application user"). Use the managed identity's application ID. |
| **Foundry Agent Consumer** role for the managed identity on the Foundry project | Foundry | Step 5.1.4 | Least-privilege role for calling agent endpoints. |
| Optional Microsoft Graph application permission **`CloudPC.Read.All`** for the managed identity | Optional (Foundry) | Step 6.2a, only if you turn on the availability check | Tenant-wide read access to Cloud PC data; it reads a Graph **beta** API. |
| Optional operator sign-ins for the Foundry demo prep package: a person with **Foundry User** on the project, and an app (service principal) with the Microsoft Graph application permission **`CloudPC.Read.All`** | Optional (Foundry) | Not created by the guide; see the package's `START-HERE.txt` | Used only for the operator's readiness checks before presenting ([presenting guide](presenting.md)). An ordinary person's Azure CLI sign-in cannot read Cloud PC pools. Without these, the package runs with `-SkipAzureChecks`. |
| Foundry project managed identity: **Container Registry Repository Reader** (or `AcrPull`) on your registry | Foundry | Step 5.1.1, item 5 | Lets Foundry pull the image you build. |
| **Agent identity blueprint** and **agent identity** for the hosted agent | Foundry | Created by Foundry when the first hosted version is deployed (step 5.5) | Do not create your own blueprint or identity; the sample rejects IDs that conflict with the hosted runtime's. |
| **Agent user** linked to that agent identity, `claims-agent@<verified domain>` | Foundry | Step 5.7 | Agent users cannot have passwords or privileged administrator roles. |
| Delegated scopes on the blueprint, made inheritable and consented tenant-wide: Agent 365 Tools `McpServersMetadata.Read.All`, Windows 365 Computer Use MCP `Tools.ListInvoke.All`, W365Agents-Production `Computer.See`; plus registering the W365Agents-Production service principal if missing | Foundry | Step 5.7 | `Computer.Control` is deliberately not granted; the live view is view-only. |
| Foundry agent **assigned** to its Windows 365 for Agents pool | Foundry | Steps 2.6 and 5.7 | Through the pool's **Agents** page, or Microsoft Graph beta `cloudPcPools/{id}/assignments`. |
| **Conditional Access** | Both | Not created or changed by the guide | Your existing policies apply. Microsoft's Copilot Studio pool page lists no Conditional Access requirement. On the MCS path, computer use signs in to the Cloud PC as the Microsoft Entra user who owns the computer use connection; a policy that demands interactive MFA or a compliant device for that sign-in could stop unattended runs, so test with your own policies rather than adding broad exclusions. On the Foundry path, Microsoft's guidance is that agents "can't satisfy interactive controls like MFA" and should get dedicated agent policies; Conditional Access for agent identities needs Agent 365 (or Microsoft 365 E7) together with Entra ID P1 ([Conditional Access for agents](https://learn.microsoft.com/entra/identity/conditional-access/policy-autonomous-agents#prerequisites)). Administrators can sign the scripts in with `-DeviceCode` / `-UseDeviceCode` where a policy blocks browser sign-in. |

### Microsoft Intune

| Item | Path | Must exist or guide creates | What to know |
| --- | --- | --- | --- |
| Device type enrolment restriction **Allow Windows (MDM)** for corporate enrolment | Both | **Must exist**; not scripted | A listed prerequisite for Copilot Studio Cloud PC pools and for Windows 365 generally; Cloud PCs for Agents are enrolled through the same Windows 365 provisioning ([Windows 365 requirements](https://learn.microsoft.com/windows-365/enterprise/requirements), [architecture](https://learn.microsoft.com/windows-365/agents/architecture-overview)). Set it in the Intune admin center's enrolment **device platform restrictions** for Windows. |
| Claims app (Win32, Required), agent launch shortcut app (MCS only), scope tag `Zava-Demo`, presenter Edge web app policy | Both | Steps 2.4, 2.6 and 3.6 | Uses the committed `.intunewin` package. |
| Provisioning policy (agents) for the Foundry pool | Foundry | Step 2.6 (manual, Intune admin center) | Needs the Intune licence, Agent 365 licence and active billing plan from 0.1. Choose a geography where the billing policy's region applies. |
| Enrollment Status Page skip for the Foundry pool | Optional | Step 2.7 | Plan mode first; Foundry-type pools only. |

### Power Platform and Copilot Studio

| Item | Path | Must exist or guide creates | What to know |
| --- | --- | --- | --- |
| **Computer use** with **Cloud PC** turned on for the environment | MCS | Step 2.1 | Power Platform admin center > **Copilot > Settings > Computer Use**. |
| **Cross-geo support for Windows 365-based features** | MCS, if needed | Turn on only if pool creation reports it is disabled outside the tenant location | Environment > **Settings > Features**. Cloud PCs run in the environment's geography. |
| **External models (Anthropic)** allowed | MCS, because the reference configuration uses Anthropic models | Must be turned on by an administrator before you configure the agent | The agent uses Claude Sonnet 4.6 and the computer use tool uses Claude Sonnet 4.5 ("Generally available" for computer use). First allow Anthropic in the Microsoft 365 admin center, then enable external models for the environment in the Power Platform admin center. This is a data-processing decision for your organisation, not a licence; read the terms on the linked page. Check the agent model's current status under [Select a primary AI model](https://learn.microsoft.com/microsoft-copilot-studio/authoring-select-agent-model). |
| Data policies (DLP) | MCS | Must allow the flow | The **Microsoft Dataverse** and **Microsoft Copilot Studio** connectors must be allowed and in the same data group for the environment. |
| Copilot Studio agent with authentication required, generative orchestration and the computer use tool; the Cloud PC pool; the trigger flow and its connections | MCS | Steps 4.3 and 4.4 | "Only a Microsoft Entra user account can execute computer use", and it must be "the same account that owns the computer use connection". A Copilot Studio pool scales automatically up to 10 Cloud PCs; up to five pools per environment. |

## 0.3 Who can do each step

These are administrator roles and permissions for the people who install. They are not product
licences.

| Step | Minimum role normally needed |
| --- | --- |
| Tenant preparation script (2.2): RDP authentication, dynamic group, target device group | Global Administrator, as the script states. It signs in with the Microsoft Graph permissions `Application.Read.All`, `Application-RemoteDesktopConfig.ReadWrite.All` and `Group.ReadWrite.All`; Microsoft's page does not name a smaller role. |
| Intune enrolment restriction, Win32 apps, groups, scope tag, Edge policy, provisioning policy (agents), ESP | Intune Administrator. The Intune scripts sign in through the Microsoft Graph Command Line Tools app, which needs consent for its Intune permissions in your tenant. |
| Windows 365 for Agents billing policy (Foundry route) | A Microsoft 365 administrator with access to **Copilot > Cost management**, plus rights to use the chosen Azure subscription and resource group. |
| Power Platform pay-as-you-go plan, environment settings, Computer use and Cloud PC setting, cross-geo, external models in the environment, DLP | Power Platform Administrator (roles for linking the Azure subscription are on [Set up a pay-as-you-go plan](https://learn.microsoft.com/power-platform/admin/pay-as-you-go-set-up)). |
| Allow Anthropic in the Microsoft 365 admin center | A Microsoft 365 administrator who can change that setting ([Anthropic as a subprocessor](https://learn.microsoft.com/microsoft-365/copilot/connect-to-ai-subprocessor)). |
| Dataverse table, security role, application user | Environment System Administrator (or Power Platform Administrator). |
| Copilot Studio agent, computer use tool, Cloud PC pool, trigger flow | A Copilot Studio maker with access to the environment. The same Microsoft Entra user owns the computer use connection. |
| App registration, exposed scope and consent (3.3, 3.4) | Application Administrator or Cloud Application Administrator. |
| Azure resources and role assignments | Owner, or Contributor plus User Access Administrator (or Role Based Access Control Administrator) for role assignments. |
| Foundry project, model deployment, registry | Contributor on the resource group; Owner or User Access Administrator for the role assignments in 5.1.1 and 5.1.4. |
| Deploy hosted agent versions | Foundry User (formerly Azure AI User) on the project, and Contributor on the registry for `az acr build`. |
| Foundry agent user, scopes and tenant-wide consent (5.7) | Agent ID Administrator, plus Privileged Role Administrator or Global Administrator for tenant-wide consent, as step 5.7 states. Microsoft also lets Cloud Application Administrator, Application Administrator or AI Administrator grant delegated permissions that are not Microsoft Graph application permissions ([grant admin consent](https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent#prerequisites)); that combination has not been tried with the script. |
| Assign the Foundry agent to its pool by Microsoft Graph | Delegated `CloudPC.ReadWrite.All`. |
| Optional `CloudPC.Read.All` for the relay (6.2a) | An administrator who can grant Microsoft Graph application permissions (Privileged Role Administrator or Global Administrator). |

## 0.4 Local tools and network for the installer

### Local tools

Install these on the administrator workstation that runs scripts:

```powershell
az version              # Azure CLI 2.80 or later
pwsh --version          # PowerShell 7
node --version          # Node 20 or later for local builds
python --version        # Python 3.12 or later for the Foundry hosted sample (pyproject requires >=3.12)
func --version          # Azure Functions Core Tools v4
swa --version           # Azure Static Web Apps CLI, or use npx
```

If a tool is missing, install it before continuing. Only the one-time installer needs these
tools. A presenter needs only a browser. The environment operator who runs the Foundry demo prep
package needs Windows PowerShell 5.1 or PowerShell 7, the Azure CLI and the optional sign-ins in
section 0.2, but no Git, Node or Python.

Install the PowerShell modules the scripts use, once per administrator account. This changes
only this computer:

```powershell
Install-Module Microsoft.Graph.Authentication, Microsoft.Graph.Applications, Microsoft.Graph.Groups -Scope CurrentUser
Install-Module IntuneWin32App -MinimumVersion 1.4.0 -Scope CurrentUser
Get-Module -ListAvailable Microsoft.Graph.Authentication, Microsoft.Graph.Applications, Microsoft.Graph.Groups, IntuneWin32App | Select-Object Name, Version   # check
```

`IntuneWin32App` is a community module (MSEndpointMgr, MIT licence), not a Microsoft product.

A C compiler is **not** needed: the install uses the committed Claims package
`deploy\intune-packages\ZavaClaims.intunewin`. Only someone who changes the Claims app's source
and rebuilds the package (page 2, step 2.3) needs MinGW `gcc` and `windres` on `PATH`.

### Network

- **Installer workstation:** outbound HTTPS to Microsoft sign-in (`login.microsoftonline.com`),
  Azure Resource Manager, Microsoft Graph, the Intune service, the Dataverse environment URL,
  the Foundry project endpoint (`*.services.ai.azure.com`), your Container Registry, and the
  package sources the tools download from (PowerShell Gallery, npm, PyPI).
- **Presenters' browsers:** the Zava site (`*.azurestaticapps.net`), the handoff service
  (`*.azurewebsites.net`), Microsoft sign-in, and for the Foundry live view Microsoft's
  screen-share SDK at `packages.global.cloudinferenceplatform.azure.com`.
- **Environment operator:** the Zava site, the relay, the Foundry project endpoint and
  Microsoft Graph.
- **Service to service:** the handoff Function app calls Dataverse (MCS) and the Foundry project
  endpoint (Foundry). The registry build pulls the `python:3.12-slim` base image from Docker Hub
  and Python packages from PyPI. The hosted agent calls Microsoft sign-in, the Agent 365 tooling
  gateway (`agent365.svc.cloud.microsoft`) and the model deployment. If you restrict outbound
  traffic or use private endpoints, allow these.
- **Cloud PCs** run on the Microsoft Hosted Network; you do not provide a network for them
  ([Cloud PC pool FAQ](https://learn.microsoft.com/microsoft-copilot-studio/use-cloud-pc-pool#frequently-asked-questions-faq)).

## 0.5 Open questions

These are not settled by Microsoft's documentation. They are stated precisely so that you can
check them with your Microsoft licensing contact or in your own tenant, rather than guess.

1. **Agent 365 on the MCS path.** The reference installation needed Microsoft Agent 365 for the
   Copilot Studio path as well as for Foundry, so this guide lists it for both. Microsoft
   documents Agent 365 explicitly only for the Agent 365 (Intune provisioning policy) route; the
   Copilot Studio Cloud PC pool page neither lists it nor rules it out. Still to establish:
   which MCS step failed without it in the reference tenant.
2. **Power Automate licence for the MCS trigger flow.** The flow is premium because of the
   Dataverse connector. Copilot Studio's included Power Automate rights cover "cloud flows within
   the context of Microsoft Copilot Studio bots". Microsoft does not say whether a
   Dataverse-triggered cloud flow that starts a Copilot Studio agent with **Execute Agent and
   wait** is inside that context, or whether its owner needs Power Automate Premium (or the flow
   a Process licence). The Power Platform admin center's Power Automate licence view flags
   out-of-context premium flows, which is the check to use.
3. **Function app runtime.** The bootstrap (`scripts\DemoCommon.ps1`, used in step 3.1) creates
   the handoff Function app on the Linux Consumption plan with Node.js 24. Microsoft states that
   "Node.js 22 is the last Node.js version supported for Linux Consumption plan apps"
   ([supported languages](https://learn.microsoft.com/azure/azure-functions/supported-languages)).
   Whether a new app is accepted with Node.js 24 on that plan has not been tested in another
   tenant. This documentation update does not change the script.
4. **Consent prompt for the Foundry pool's Cloud PCs.** Microsoft documents hiding the remote
   desktop consent prompt (target device groups) only for Copilot Studio Cloud PC pools. The
   guide applies it to the `CPCPool_` group only, not to the Foundry pool's assigned group.
   Microsoft does not say whether Windows 365 for Agents (Agent 365 route) pools need it.
5. **How many Intune licences.** The provisioning policy (agents) prerequisite is "A Microsoft
   Intune license", without saying per device, per user or per tenant.
6. **Which accounts hold Agent 365 licences.** Agent 365 covers agents "managed or owned by a
   licensed user". Which account counts as the owner or manager of the Foundry-created agent
   identity, and of the Copilot Studio agent, in this lab has not been established. Licensing
   the people who deploy and own the two agents is the cautious reading.

## Microsoft references

- Windows 365 for Agents is a pool-based Cloud PC service where agents check out and check in Cloud PCs: <https://learn.microsoft.com/en-us/windows-365/agents/introduction-windows-365-for-agents>
- Cloud PC agent pools are shared pools, reset after use, and are managed as pools rather than assigned to one human user: <https://learn.microsoft.com/en-us/windows-365/agents/cloud-pc-agent-pools>
- Provisioning policy (agents) prerequisites: Intune licence, Agent 365 licence, Windows 365 for Agents billing plan: <https://learn.microsoft.com/en-us/windows-365/agents/create-provisioning-policy-agents>
- Windows 365 for Agents billing uses pay-as-you-go plus optional always-available Cloud PCs: <https://learn.microsoft.com/en-us/windows-365/agents/billing-w365a>
- Copilot Studio Cloud PC pools are backed by Windows 365 for Agents, are Entra-joined and Intune-enrolled, and list the IT administrator prerequisites used in step 2.2: <https://learn.microsoft.com/en-us/microsoft-copilot-studio/use-cloud-pc-pool>
- Copilot Studio computer use, its models and external-model access: <https://learn.microsoft.com/en-us/microsoft-copilot-studio/computer-use>, <https://learn.microsoft.com/en-us/power-platform/admin/allow-llm-generative-responses>
- Microsoft Agent 365 availability and licensing: <https://learn.microsoft.com/en-us/microsoft-agent-365/overview>
- Microsoft Entra Agent ID, agent users and Conditional Access for agents: <https://learn.microsoft.com/en-us/entra/agent-id/agent-users>, <https://learn.microsoft.com/en-us/entra/agent-id/best-practices-agent-id>
- Foundry hosted agents, permissions and roles: <https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents>, <https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agent-permissions>
- Intune Win32 apps are the supported package type for traditional Windows desktop apps: <https://learn.microsoft.com/en-us/mem/intune/apps/apps-win32-app-management>
- Windows 365 supports the Enrollment Status Page (ESP), but custom ESP targeting for Cloud PCs must use an `enrollmentProfileName` filter, not dynamic groups: <https://learn.microsoft.com/en-us/windows-365/enterprise/enrollment-status-page>

## Safety checks

- Real copies of config files must be named `*.local.json`; those files are git-ignored.
- Never paste secrets into Markdown, sample JSON, command history you plan to share, or committed files.
- Use `-WhatIf`, `-Plan`, or read-only commands first. Only run creating commands after the tenant owner approves them.
