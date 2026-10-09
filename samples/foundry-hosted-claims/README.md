# Foundry hosted Claims agent

The **Foundry path** of the Zava lab: a pro-code Python agent that runs as a Microsoft Foundry
**hosted agent**. It receives the same call handoff as the Copilot Studio path, uses a Windows 365
for Agents Cloud PC to file the claim in the same legacy Claims app, and returns the same result.

**To install it, use the [install guide](../../docs/install/README.md).** Its guided setup builds,
deploys, connects and turns on this agent for you. You do not need to read the rest of this page
to install or present the lab.

## How it fits together

```text
Presenter in Zava (signed in with Microsoft Entra ID)
  -> handoff service relay /api/foundry-claims/*   (checks the user's token; calls Foundry with
                                                    the Function app's managed identity)
  -> Foundry hosted agent, Invocations endpoint     (this sample; Entra authorization)
       -> finds the Windows 365 for Agents Computer Use tools through Agent 365, as its own
          agent user
       -> Start Session: Windows 365 hands over a Cloud PC from the agent's pool
       -> the Foundry model chooses on-screen actions; this code checks and runs them
       -> End Session releases the Cloud PC
  -> the observed claim number (or a named error) returns to the same Zava interaction
```

- The Computer Use tools are called from this agent's code. Nothing is added as a tool in the
  Foundry portal's agent designer.
- Zava shows the agent's own Cloud PC session live and **view-only**, through Microsoft's
  screen-share SDK (`Computer.See` only; no `Computer.Control`).
- The Copilot Studio path does not use this code. It shares the handoff service, Zava and the
  Claims app. See [install page 4](../../docs/install/05-mcs-path.md) for how it works.

## What happens during a transfer

1. The presenter answers a simulated call in Zava and transfers it to the Foundry agent.
2. The handoff service checks the presenter's sign-in and forwards the call details to the agent.
3. The agent takes a Cloud PC from its pool, waits until it is ready, and starts the live view.
4. It opens the Claims app, finds the policy, fills in the first notice of loss from the call
   summary, and submits it once.
5. It reads the claim number from the app's confirmation dialog and returns it to Zava.
6. It releases the Cloud PC. The pool then resets it before the next run.

The step-by-step behaviour and every safeguard are in [How the agent runs](docs/how-it-runs.md).

## Safety in brief

- **Off until you turn it on.** A new agent version has both execution gates off
  (`LIVE_EXECUTION_APPROVED`, `CLAIMS_EXECUTION_APPROVED`). It then refuses to take a Cloud PC or
  file a claim; it does not pretend to succeed. Setup turns them on only after the identity
  steps and your explicit yes.
- **Its own identity.** The agent signs in as its own agent user with exactly three delegated
  permissions. The presenter's sign-in is never used for the Cloud PC.
- **Narrow tools.** The model can use only the Claims app's screen. It has no shell, program
  launch, browser, clipboard or free keyboard shortcuts, and it cannot approve its own requests.
- **Checked results.** A claim counts only when the app's own confirmation dialog shows it after
  this run's Submit. A second Submit is never sent.
- **Synthetic data only.** Use a dedicated demo Cloud PC and synthetic claims. The instruction to
  use only Claims is not an operating-system security boundary.

## What has been shown, and what has not

- **Shown in the reference environment (7-8 October 2026)**, with both gates on: complete Zava to
  Foundry transfers that took a Cloud PC, showed it live in Zava, opened Claims, filed a synthetic
  claim, returned the observed claim number and released the Cloud PC. Timings are in the
  [presenting guide](../../docs/install/presenting.md).
- **Not shown:** an installation in a second, fresh tenant; production data or load; a Foundry pool
  with more than one Cloud PC. Passing tests use labelled fixtures and are not live proof.

## Known limitations

- **Waiting between runs.** After each run the pool resets the Cloud PC: about 15-17 minutes in
  the reference one-PC pool.
- **Optional availability check uses a beta API.** It reads a Microsoft Graph beta field that can
  change without notice; it then shows "Unable to check" rather than allowing a start.
- **Windows account setup can block a fresh Cloud PC.** See
  [Windows account setup on the pool](docs/configuration.md#windows-account-setup-on-the-pool).

## Reference

| Page | For |
| --- | --- |
| [How the agent runs](docs/how-it-runs.md) | Start-up, opening Claims, the model and tool loop, submit rules, errors, the live view, recovery, and the earlier runs behind each safeguard. |
| [Configuration and identity](docs/configuration.md) | Every setting, the identity design, the Windows account setup option, and the optional sign-in diagnostics. |
| [Developer reference](docs/development.md) | Local tests, running locally without cloud access, container and deployment internals, the local viewer and its HTTP contract. |
| [Install page 5: Foundry path, by hand](../../docs/install/06-foundry-path.md) | What the guided setup does for this agent, as manual commands. |

## Primary references

- [Windows 365 for Agents integration](https://github.com/microsoft/windows-365-for-agents)
- [Hosted agents](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents)
- [Agent 365 tooling SDK](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling)
- [Autonomous agent-user authentication](https://learn.microsoft.com/en-us/entra/agent-id/autonomous-agent-authentication-authorization-flow)
- [Hosted environment variables](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-hosted-agent-env-variables)
- [Azure agent-server native identity variables](https://github.com/Azure/azure-sdk-for-python/blob/main/sdk/agentserver/azure-ai-agentserver-core/azure/ai/agentserver/core/_config.py)
- [Microsoft hosted identity-proxy mapping](https://github.com/microsoft-foundry/foundry-samples/blob/main/samples/python/foundry-autopilot-agent/src/hello_world_a365_agent/.env.example)
- [Hosted permissions](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agent-permissions)
- [Screen-share SDK and scopes](https://github.com/microsoft/windows-365-for-agents/blob/main/docs/screen-sharing.md)
- [Official Playground screen URL transformation](https://github.com/microsoft/windows-365-for-agents/blob/main/W365A-Playground-Agent/src/Screenshare/ScreenshareService.cs)
- [Official Playground viewer configuration](https://github.com/microsoft/windows-365-for-agents/blob/main/W365A-Playground-Agent/src/Screenshare/ScreenshareOptions.cs)
- [Official Playground session-scoped discovery and calls](https://github.com/microsoft/windows-365-for-agents/blob/main/W365A-Playground-Agent/src/ComputerUse/ResponsesOrchestrator.cs)
- [Published screen-share SDK 1.0.0](https://packages.global.cloudinferenceplatform.azure.com/screenshare-sdk/1.0.0/screenshare-embed.js)
