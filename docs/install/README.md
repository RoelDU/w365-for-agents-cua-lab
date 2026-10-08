# Install the Zava two-backend lab

This is the single starting point for installing the lab in your own tenant. Follow the pages in order. Do not skip ahead: several values from one page are needed by the next page.

## Page list

| Step | Page | What you finish with |
| --- | --- | --- |
| 0 | [Prerequisites](01-prerequisites.md) | Licences, roles, tools, and public Microsoft references checked. |
| 1 | [Values worksheet](02-values-worksheet.md) | A safe place to record non-secret IDs and URLs as you create them. |
| 2 | [Tenant, Intune, and Cloud PC pools](03-tenant-and-cloud-pcs.md) | Dataverse environment, Cloud PC pool prerequisites and dynamic device group, Claims app assigned to the MCS pool devices (committed package), Foundry Cloud PC pool (done after page 5), and optional ESP skip plan. |
| 3 | [Azure resources and app registrations](04-azure-and-identity.md) | Function app, storage, managed identity, Static Web App (resource-only bootstrap, no agent deployment), Zava sign-in app, relay API scope with v2 access tokens, and presenter desktop icon. |
| 4 | [Copilot Studio path](05-mcs-path.md) | Dataverse trigger table, MCS agent with its Computer Use tool and Cloud PC pool, trigger flow, and published agent. |
| 5 | [Foundry hosted path](06-foundry-path.md) | Foundry project prerequisites, image build plan, hosted agent version, endpoint, and relay permissions. |
| 6 | [Handoff service and Zava deployment](07-handoff-and-zava.md) | Current `CUA_*`, `DATAVERSE_*`, and `FOUNDRY_*` settings; runtime `region-config.json` and `entra-config.json`; deployed Zava. |
| 7 | [Verification](08-verify.md) | A checklist for proving MCS, Foundry, Intune app delivery, sign-in, and safe retry behaviour. |

## After install

- [Presenting guide](presenting.md) is for normal demo operation. A presenter does not need a developer checkout.
- [Troubleshooting guide](troubleshooting.md) collects the known issues and first checks.

## Supported architecture only

Use these two paths:

- **MCS:** Zava calls the handoff service, the service writes a Dataverse trigger row, the trigger flow calls the authenticated Copilot Studio agent, and Computer Use drives the Claims app.
- **Foundry:** Zava calls the relay endpoints in the same handoff service, the relay verifies the signed-in user and forwards to the Foundry hosted agent, and that hosted agent drives the Claims app.

Do not use the old Direct Line, Durable handoff, local orchestrator, or local Foundry runner documents for a new install.
