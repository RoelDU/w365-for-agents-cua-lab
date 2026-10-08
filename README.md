# Windows 365 for Agents CUA lab

A hands-on lab for a contact-centre handoff to AI on **Windows 365 for Agents**. A human agent
uses the **Zava CCaaS Agent Desktop** web app, transfers a simulated claims call, and watches
an AI agent file the claim in the **Legacy Claims Workstation**, a Win32 app with no API, by
operating it on a Cloud PC. The result comes back to the same Zava interaction.

The same handoff can go to either of **two supported backends**:

- **Copilot Studio (MCS):** a Copilot Studio agent with the Computer Use tool, on a Copilot
  Studio Cloud PC pool.
- **Microsoft Foundry:** a pro-code Python hosted agent that uses the Windows 365 for Agents
  Computer Use MCP server, on a Windows 365 for Agents Cloud PC pool, with the agent's own
  session shown live (view-only) in Zava.

## Demo

https://github.com/user-attachments/assets/10913efc-8abc-475b-8674-12b46245edfa

This 2.5-minute walkthrough was recorded in June 2026 and shows the **Copilot Studio** path
(English). Japanese:
[`zava-ccaas-demo-guided-ja.mp4`](apps/ccaas-agent-desktop/docs/media/zava-ccaas-demo-guided-ja.mp4?raw=1).
The Foundry path and the current transfer screens are newer than the recording.

## How it works

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

| Part | Folder |
| --- | --- |
| Zava CCaaS Agent Desktop (React/Vite on Azure Static Web Apps) | `apps\ccaas-agent-desktop` |
| Handoff service (Azure Functions) | `apps\handoff-orchestrator` |
| Legacy Claims Workstation and its Intune packages | `apps\legacy-claims-workstation`, `deploy\intune-packages` |
| Foundry hosted agent (Python) and its deploy scripts | `samples\foundry-hosted-claims`, `deploy\foundry` |
| Copilot Studio agent configuration and trigger flow | `docs\mcs-computer-use-instructions.md`, `deploy\mcs`, `scripts\mcs` |
| Installation and helper scripts | `docs\install`, `scripts` |

In the Foundry path the MCP server is called from the agent's own code; nothing is added as a
tool in the Foundry portal designer. Details:
[`samples\foundry-hosted-claims\README.md`](samples/foundry-hosted-claims/README.md).

## Install it in your own tenant

Follow **one ordered guide**: [`docs\install\README.md`](docs/install/README.md). Everything it
needs is in this repository or is a public Microsoft prerequisite (tenant, licences, Azure
subscription, Copilot Studio, Windows 365 for Agents billing, Intune).

- You **build the Foundry agent image yourself** from this repository into your own Azure
  Container Registry; no prebuilt image is published and no access to anyone else's registry
  is needed.
- The Claims app is committed as a ready Intune package; no compiler is needed.
- Every tenant value is a placeholder in the committed files. Your own values go in git-ignored
  `*.local.json` files.
- Scripts preview first (`-WhatIf`, `-Plan` or plan mode). Commands that create resources,
  grant permissions or turn the agent on are run deliberately by the environment owner.

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
