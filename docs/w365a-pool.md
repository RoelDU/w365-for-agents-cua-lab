# Windows 365 for Agents Cloud PC pools

Use this page as a short reference. The ordered install steps are in [`install\03-tenant-and-cloud-pcs.md`](install/03-tenant-and-cloud-pcs.md).

## Pool facts that matter for this lab

- Windows 365 for Agents uses shared Cloud PC pools.
- An agent checks out a Cloud PC, does the task, then checks it back in.
- Cloud PCs for Agents reset after use.
- The MCS and Foundry paths use separate pools in the recommended install.
- A one-PC Foundry pool was observed taking 15-17 minutes to become available after a run.
- Copilot Studio Cloud PC pools are created from the Computer Use tool and are hosted in the Power Platform environment's geography.
- Agent 365 or pro-code pools are created in Intune as provisioning policies for agents.

## Billing

Windows 365 for Agents billing is separate from Copilot Studio entitlement, and the two pools are
billed through different routes:

- **Copilot Studio (MCS) pool:** a pay-as-you-go billing plan for the Power Platform environment.
  Microsoft documents automatic scaling for these pools but no always-available setting.
- **Windows 365 for Agents (Foundry) pool:** a billing policy in the Microsoft 365 admin center;
  the Intune provisioning policy (agents) sets how many Cloud PCs are always available.

Details and trial limits: [prerequisites, section 0.1](install/01-prerequisites.md#01-products-licences-and-billing-to-have-before-you-start).

Microsoft reference: <https://learn.microsoft.com/en-us/windows-365/agents/billing-w365a>

## Common problems

| Problem | Check |
| --- | --- |
| No Cloud PC pool option in Copilot Studio | Dataverse environment, Computer Use enabled, tenant prerequisites, environment geography. |
| Computer Use never starts | Agent authentication, pool availability, billing plan, and tool binding. |
| Cloud PC stuck at account setup | Review ESP targeting and the optional `Set-AgentPoolEspSkip.ps1` plan. |
| Claims app missing | Intune required assignment, device group membership, and app detection. |

More troubleshooting is in [`install\troubleshooting.md`](install/troubleshooting.md).
