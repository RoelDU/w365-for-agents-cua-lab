# Windows 365 for Agents: Build and Demo with Copilot Studio and Microsoft Foundry

Agentic AI enables software to work towards a defined goal by planning steps and using tools,
rather than only generating an answer. Computer use extends that approach to application
interfaces: an agent observes the screen and performs actions such as clicking and typing when a
suitable API is not available. **Windows 365 for Agents** provides the managed Cloud PC
environment in which that work takes place.

Microsoft offers different ways to build agents, from no-code experiences through low-code tools
to pro-code development. This repository demonstrates two approaches using Windows 365 for
Agents: a **low-code** agent built with **Microsoft Copilot Studio** and a **pro-code** agent
hosted in **Microsoft Foundry**. Both carry out the same insurance-claim task, showing how the
platform supports different agent-building choices.

![A goal goes to an agent built with Copilot Studio or Microsoft Foundry. The agent observes and acts on an existing Windows app in a Cloud PC for Agents from a Windows 365 for Agents pool, governed by Microsoft Entra ID and Intune, and the result returns to the same interaction.](docs/media/w365-agents-concept.svg)

*Conceptual illustration ([SVG source](docs/media/w365-agents-concept.svg),
[PNG](docs/media/w365-agents-concept.png)); not a product screenshot.*

## Agentic AI, computer use and Windows 365 for Agents

An **agent** receives a goal, uses a model to decide the next step, calls a tool to carry it out,
checks the result and repeats until the goal is met. **Computer use** is the tool for the cases
where the system has no API: in Microsoft's words it lets an agent work with websites and desktop
apps "by selecting buttons, choosing menus, and entering text into fields on the screen", so that
"if a person can use an app or website, computer use can too"
([Copilot Studio computer use](https://learn.microsoft.com/microsoft-copilot-studio/computer-use)).

**Windows 365 for Agents** is where that screen work happens. It provides "a brand-new class of
Cloud PCs for agent use", built on the same Windows 365 platform as Windows 365 Enterprise
([What is Windows 365 for Agents?](https://learn.microsoft.com/windows-365/agents/introduction-windows-365-for-agents)):

- **Identity and access.** Cloud PCs for Agents are joined to Microsoft Entra ID and managed by
  Microsoft Intune, so agents work inside the organisation's identity, security and compliance
  boundary.
- **App delivery.** Intune installs the applications the agent needs. Here that is the Legacy
  Claims Workstation, a Win32 app delivered as a required Intune app.
- **Observe and act.** The agent sees the Cloud PC's screen and sends mouse and keyboard actions.
  Copilot Studio does this through its computer use tool; a pro-code agent does it through the
  Windows 365 for Agents computer use MCP server
  ([architecture](https://learn.microsoft.com/windows-365/agents/architecture-overview)).
- **Session lifecycle.** Cloud PCs are kept in a **Cloud PC agent pool**. An agent checks one
  out for a task and checks it back in afterwards; the Cloud PC is reset before it is used again
  ([Cloud PC agent pools](https://learn.microsoft.com/windows-365/agents/cloud-pc-agent-pools)).

## Ways to build an agent: no-code, low-code and pro-code

| Approach | Microsoft example | Typical builder | In this lab |
| --- | --- | --- | --- |
| No-code | Agent Builder in Microsoft 365 Copilot | Anyone describing an agent in plain language | Not implemented here. |
| **Low-code** | **Microsoft Copilot Studio**, "a graphical, low-code studio for building and managing AI-powered agents and workflows" | Organisations and makers who configure agents, tools and connectors | **MCS path:** a Copilot Studio agent with the computer use tool, on a Copilot Studio Cloud PC pool. |
| **Pro-code** | **Microsoft Foundry** with SDKs and your own code | Agent builders and developers who need code-level control | **Foundry path:** a Python hosted agent that calls the Windows 365 for Agents computer use MCP server, on a Windows 365 for Agents pool. |

Sources: [Compare tools for declarative agents](https://learn.microsoft.com/microsoft-365/copilot/extensibility/declarative-agent-tool-comparison),
[Copilot Studio overview](https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-what-is-copilot-studio),
[Custom engine agents: development approaches](https://learn.microsoft.com/microsoft-365/copilot/extensibility/overview-custom-engine-agent#development-approaches-for-custom-engine-agents).

## The example: an insurance claim handed over from a contact centre

A familiar contact-centre moment: a caller to **Zava Mutual**, a fictional insurer, reports a car
accident. All data is synthetic.

1. The human agent takes the call in the **Zava CCaaS Agent Desktop**, a contact-centre web app,
   and has the policy number and a summary of what happened.
2. The human agent opens **Transfer** and chooses an AI agent: **Copilot Studio** or
   **Microsoft Foundry**. The handoff carries the policy and the facts of the call.
3. The chosen agent checks out a Cloud PC from its own pool and files the claim in the **Legacy
   Claims Workstation**, a Win32 app with no API, by operating its screen.
4. Progress shows in the same Zava interaction while the agent works; on the Foundry path the
   presenter can also watch the agent's Cloud PC live (view-only). The claim number returns to
   that interaction.
5. The agent signs out and the Cloud PC is checked back in and reset.

The integration is between Zava, the handoff service and the two agents. There is **no
integration with the Claims app itself**: both agents use its screen, as a person would.

```text
Presenter in Zava (Microsoft Entra ID sign-in)
  -> handoff service (Azure Functions, managed identity)
       MCS:     /api/cua-run writes a Dataverse row -> Power Automate trigger flow
                -> Copilot Studio agent -> Computer Use on a Copilot Studio Cloud PC pool
       Foundry: /api/foundry-claims/* checks the user's token -> Foundry hosted agent
                -> Agent 365 SDK discovers the Windows 365 for Agents Computer Use MCP server
                -> Cloud PC from the agent's Windows 365 for Agents pool
  -> Legacy Claims Workstation (delivered to both pools by Intune)
  -> observed claim number back in the same Zava interaction -> Cloud PC released
```

What each path proves about the claim number is described under [Known limitations](#known-limitations).

### Demo video (historical)

https://github.com/user-attachments/assets/10913efc-8abc-475b-8674-12b46245edfa

This 2.5-minute walkthrough was recorded in June 2026 and shows the **Copilot Studio** path
(English). Japanese:
[`zava-ccaas-demo-guided-ja.mp4`](apps/ccaas-agent-desktop/docs/media/zava-ccaas-demo-guided-ja.mp4?raw=1).
The Foundry path and the current transfer screens are newer than the recording.

## What this repository provides

| Part | Folder |
| --- | --- |
| Zava CCaaS Agent Desktop (React/Vite on Azure Static Web Apps) | `apps\ccaas-agent-desktop` |
| Handoff service (Azure Functions) | `apps\handoff-orchestrator` |
| Legacy Claims Workstation and its Intune packages | `apps\legacy-claims-workstation`, `deploy\intune-packages` |
| Foundry hosted agent (Python) and its deploy scripts | `samples\foundry-hosted-claims`, `deploy\foundry` |
| Copilot Studio agent configuration and trigger flow | `docs\mcs-computer-use-instructions.md`, `deploy\mcs`, `scripts\mcs` |
| Installation guide and helper scripts | `docs\install`, `scripts` |

In the Foundry path the MCP server is called from the agent's own code; nothing is added as a
tool in the Foundry portal designer. Details:
[`samples\foundry-hosted-claims\README.md`](samples/foundry-hosted-claims/README.md).

- You **build the Foundry agent image yourself** from this repository into your own Azure
  Container Registry; no prebuilt image is published and no access to anyone else's registry
  is needed.
- The Claims app is committed as a ready Intune package; no compiler is needed.
- Every tenant value is a placeholder in the committed files. Your own values go in git-ignored
  `*.local.json` files.
- Scripts preview first (`-WhatIf`, `-Plan` or plan mode). Commands that create resources,
  grant permissions or turn the agent on are run deliberately by the environment owner.

## Install it in your own tenant

1. **Check the [prerequisites](docs/install/01-prerequisites.md) first.** They list every
   product, licence, billing plan, Microsoft Entra ID setting, permission and installer tool that
   the two paths depend on, which ones you must already have and which ones the guide creates.
   A missing product entitlement blocks the installation; it is not a detail to sort out later.
2. **Follow the one ordered guide:** [`docs\install\README.md`](docs/install/README.md).

In short, both paths need a Microsoft Entra ID tenant, Microsoft Intune, Microsoft Agent 365 and
an Azure subscription. The MCS path adds Microsoft Entra ID P1 (for a dynamic device group),
Copilot Studio, a Power Platform environment with Dataverse, and Windows 365 for Agents billing
once the Copilot Studio trial allowance is used up. The Foundry path adds a Microsoft Foundry
project with a model deployment and an active Windows 365 for Agents billing policy.

After installation, the [presenting guide](docs/install/presenting.md) is all a presenter
needs; it needs no checkout or developer tools.

## What has been demonstrated, and what has not

- **Demonstrated** in the author's reference environment on 7-8 October 2026: complete Zava
  transfers on both backends filed synthetic claims and returned the observed claim number to
  the same interaction; the Foundry path showed the live Cloud PC session in Zava. Timings are
  in the presenting guide.
- **Not demonstrated:** a fresh installation in a different tenant by following the guide.
  The guide is written from the scripts and the reference setup, and each step has a read-only
  check, but expect to adapt names, regions and quotas.
- **Install defaults are safe:** a new Foundry agent version has its execution gates off and
  refuses desktop work until the owner turns them on after identity setup.

## Known limitations

- Expect waits. A Cloud PC is reset after each run; in the reference one-PC Foundry pool it was
  free again after about 15-17 minutes. MCS runs took about 4-13 minutes, mostly depending on
  whether the pool handed over a newly prepared Cloud PC.
- The optional "Cloud PC available" check in Zava reads a Microsoft Graph **beta** field, and
  its permission (`CloudPC.Read.All`) is tenant-wide read access to Cloud PC data.
- The MCS Computer Use tool receives the handoff only through its tool instructions
  (`{System.Activity.Text}`); see [`docs\mcs-computer-use-instructions.md`](docs/mcs-computer-use-instructions.md).
- On the MCS path the handoff service establishes from the Computer Use log that this run
  clicked Submit Claim and then the confirmation dialog, but the claim number itself is the one
  the agent stated at that dialog; nothing reads the number off the screen. The Foundry agent
  reads it from the dialog itself.
- Use synthetic data and a dedicated low-privilege demo pool. The agent's Claims-only
  instructions are not an operating-system security boundary.
- Windows 365 for Agents, Agent 365 tooling and Foundry hosted agents are new services; names,
  APIs and regions can change. Check the linked Microsoft documentation.

## Experimental and retired material

- **Experimental:** `samples\mcs-new-harness` (authentication-only harness). Not part of the
  install.
- **Retired:** the Direct Line handoff and the Durable Functions orchestration. Their code is
  still in the two apps for compatibility, but the install guide does not configure them; do not
  set `HANDOFF_*`, `ENGINE_*` or `DIRECTLINE_*` settings for a new install. The local
  orchestrator and the local Foundry runner (`samples\foundry-w365a-runner`) were removed; do not
  follow older instructions that mention them.
- **Historical documents:** `docs\CCaaS-Demo-Setup-Guide.docx` (May 2026) describes the retired
  local-orchestrator design. `docs\Zava-CCaaS-Demo.pptx` is the June 2026 overview deck. Use
  this README and `docs\install` for the current design.

## Third-party components

Nothing third-party is bundled in this repository. Dependencies are downloaded from their
official sources when you build or run: npm packages (`package.json`), Python packages
(`samples\foundry-hosted-claims\pyproject.toml`, pinned), Microsoft's Win32 Content Prep Tool
(downloaded by the packaging scripts only if you rebuild an Intune package) and Microsoft's
Windows 365 screen-share SDK (loaded by the browser from Microsoft's URL). Each is used under its
own licence and terms. This repository's own code is under the [MIT licence](LICENSE).

## Safety rules

- Do not commit tenant IDs, secrets, tokens, keys, connection strings, or filled-in `*.local.json` files.
- Do not push from this repository unless a human explicitly asks you to.
- Any command that creates cloud resources, grants roles, or deploys a hosted agent must be run
  deliberately by the environment owner.
