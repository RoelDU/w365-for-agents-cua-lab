# Presenting guide

This page is for normal presenting after the environment is already installed. The presenter
needs only a browser: no Git, Node, Python, Azure admin access, developer checkout or extra
tool.

## Who does what

| Person | Needs |
| --- | --- |
| Presenter | Zava web address, presenting account, normal browser window. |
| Environment owner | Access to the admin portals named below, for the checks a presenter cannot do. |
| Operator (optional) | Only for the [optional advanced checks](#optional-advanced-checks-for-the-environment-operator). |

## Day before

1. Run one complete rehearsal only if you can leave enough reset time afterward.
2. Confirm both Cloud PC pools are healthy (see the checks under "30 minutes before").
3. Confirm the Claims app is still installed on pool Cloud PCs.
4. Confirm the presenter can open Zava and sign in.
5. Confirm the MCS agent is published.
6. Confirm the MCS trigger flow is turned on.
7. Confirm the MCS Cloud PC pool has a free PC or enough warm capacity for the expected run.
8. Do not leave a Foundry run half-finished.

## 30 minutes before

Presenter, in the browser:

1. Open `https://<zava-site>/workspace` in the normal browser profile you will present from and
   sign in.
2. Simulate inbound call -> **Answer** -> **Transfer**, look at the two agent cards, then close
   the transfer list without choosing an agent and reset the demo.
3. If the environment has the Cloud PC availability check turned on (install step 6.2a), the
   Foundry card is enabled only when the Foundry pool reports a free Cloud PC. **No Cloud PC
   available yet.** means wait; it re-enables by itself. Without that check, the card does not
   show availability; use the owner's check below.

Environment owner, optional checks in the admin portals:

1. **Foundry pool:** in the Intune admin center, open the Foundry provisioning policy (agents)
   and look at **Available sessions** under **Session Usage**.
2. **MCS:** in Copilot Studio, confirm the agent's latest changes are published; in Power
   Automate, confirm the Dataverse trigger flow is **On**; under **Monitor > Machines > Machine
   groups**, open the MCS Cloud PC pool and confirm capacity is available.
3. Confirm the Function app settings still point to the correct Dataverse environment and
   `CUA_AGENT_BOTID`.

## 2-5 minutes before

Presenter:

1. Open `https://<zava-site>/workspace` in the normal browser profile you will present from.
2. Sign in if needed.
3. Simulate inbound call -> **Answer** -> **Transfer**.
4. Confirm **Claims Automation Agent (Foundry)** is enabled with no warning message if you will use Foundry.
5. Confirm **Claims Automation Agent (Copilot Studio)** is visible if you will use MCS.
6. Close the transfer list without choosing an agent.
7. Reset the demo.

Do **not** run a warm-up claim right before presenting. In a one-PC Foundry pool, a warm-up can leave the only Cloud PC resetting for 15-18 minutes.

## Optional advanced checks for the environment operator

Not needed for normal presenting. An existing Foundry demo prep tool can run read-only checks
from a Windows computer without a checkout: it checks that Zava opens, wakes the relay, reads
the active Foundry version and checks whether a Cloud PC is free. It does not start a transfer,
file a claim, call the Foundry agent or take a Cloud PC. See
[`deploy\foundry-demo-prep\README.md`](../../deploy/foundry-demo-prep/README.md).

- **Getting it:** a maintainer builds the ZIP from a checkout with
  `pwsh -File .\scripts\Build-FoundryDemoPrepPackage.ps1` (written under
  `deploy\foundry-demo-prep\`) and shares it, with the environment's `foundry-demo.config.json`,
  through the team's normal private file-sharing channel. Do not commit the filled-in config.
  The operator extracts it anywhere and starts with `START-HERE.txt`.
- **Sign-ins:** two read-only Azure CLI sign-ins (Foundry User on the project; for the pool
  check, an app sign-in with the Microsoft Graph application permission `CloudPC.Read.All`).
  The app sign-in is a limit of this tool, which gets its Graph token through the Azure CLI;
  Microsoft Graph itself also accepts a person's delegated `CloudPC.Read.All`
  ([prerequisites, section 0.2](01-prerequisites.md#microsoft-entra-id)). Without these
  sign-ins, run `.\Prepare-FoundryDemo.cmd -SkipAzureChecks`, which checks only the Zava page
  and wakes the relay.
- **When:** about 30 minutes before, `.\Prepare-FoundryDemo.cmd -WaitForCloudPcMinutes 20`;
  2-5 minutes before, `.\Prepare-FoundryDemo.cmd`.

Values in `foundry-demo.config.json` (from the package template). The guided setup
(`scripts\Install-Lab.ps1`) writes this file for you as
`scripts\foundry-demo-prep\foundry-demo.config.json` when the Foundry path is ready; it does not
replace an existing file. By hand, the values are:

| Template value | What to put there |
| --- | --- |
| `zavaUrl` | Static Web App root URL, for example `https://<your-static-web-app>.azurestaticapps.net`. |
| `relayUrl` | Function app relay URL ending in `/api/foundry-claims`. |
| `foundryAgentUrl` | Foundry hosted agent management URL ending in `/agents/<agent-name>?api-version=v1`. |
| `cloudPcPoolId` | Windows 365 for Agents Cloud PC pool ID. |
| `tenantId` | Microsoft Entra tenant ID, used only for sign-in hints. |
| `expectedFoundryVersion` | Optional hosted version ID the operator expects to be active. Leave blank if the operator should only report the active version. |
| `poolAzureConfigDir` / `foundryAzureConfigDir` | Optional separate Azure CLI profile folders if the pool and Foundry checks use different sign-ins. Leave blank to use the normal Azure CLI sign-in. |

## What the audience should see

### Foundry

- After the presenter confirms the transfer, Zava prepares the hosted request.
- Windows 365 hands the hosted agent a Cloud PC.
- The live same-session desktop viewer appears in Zava.
- The agent opens the Claims app and files the claim.
- Expected timing: in the reference environment (7 October 2026) the claim number appeared 85-95 seconds after **Confirm** (about 97 seconds counted from opening the confirmation, read aloud for about 12 seconds). Roughly 27-33 seconds of that is Windows 365 handing over the Cloud PC, and the model's decisions vary from 3 to 9 seconds each. Treat this as a guide, not a promise.

### MCS

- Zava creates a Dataverse-backed CUA run.
- The autonomous trigger flow starts the Copilot Studio agent.
- Computer Use runs on the Copilot Studio Cloud PC pool.
- Expected timing: in the reference environment on 7 October 2026 the claim number appeared 4 min 50 s, 5 min 31 s and 6 min 28 s after **Confirm** in three of four complete runs, and 13 min 24 s in the fourth. The time depends mostly on which Cloud PC the pool hands over. A freshly prepared one shows Windows "Account setup" for about 70 seconds and then may ignore keyboard and mouse input for between about 1 and 8 minutes while it finishes setting up (its Claims shortcuts still have blank icons). On a Cloud PC that was used before, the first launch used to show no window (the agent added the launch command to the old `shutdown /l` text in the Run box) and cost 60-90 seconds; since the Ctrl+A fix of 7 October 2026 evening, the next run on a used Cloud PC launched first time and the claim number appeared 4 min 5 s after **Confirm** (Claims ready at 2 min 16 s, signed out at 4 min 30 s). The first run on each newly prepared Cloud PC is still slow; the MCS pool in the reference tenant has two Cloud PCs, so after each has done one run, later runs avoid that setup delay until the pool replaces a Cloud PC. The claim work itself takes about 1.5-2 minutes. Plan the talk track for a possible long wait, or show the Foundry path when time is short.
- The result appears in the same Zava interaction after the trigger flow writes the receipt back to Dataverse.

## If something is not ready

- **Foundry card says No Cloud PC available yet** (or the optional prep tool says still preparing): wait, or use the backup video. Do not start a test transfer.
- **MCS flow is off:** turn it on before the call, then use a fresh test only if there is enough time.
- **MCS agent has unpublished changes:** publish before the call.
- **Zava says reconnect Microsoft sign-in:** reconnect before the call.
- **Cloud PC in use with no visible transfer:** open the existing transfer in Zava and check status/release. Do not start another transfer blindly.
- **Live screen does not appear:** use the **Watch live screen** action if available.
