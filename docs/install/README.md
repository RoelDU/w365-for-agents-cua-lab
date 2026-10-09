# Install the lab

This guide installs the whole lab in your own tenant: the Zava contact-centre desktop, the
handoff service, and both agent paths, **Copilot Studio** and **Foundry**. You can also install
only one path.

You do not need Git, programming experience or JSON editing. A guided setup script does the
technical work, remembers what it has done, and tells you exactly what to do at the few points
where a person must act in a Microsoft portal. You need the administrator roles and product
licences listed below; setup cannot replace those.

**One route, in order:** check the list, get the files, install the tools, preview, run setup,
open Zava. If setup stops, fix what it names and run the same command again.

## Before you start: checklist

### Products and billing

The full inventory, with Microsoft sources and how to check each item, is
[Prerequisites](01-prerequisites.md). In short:

| You need | For |
| --- | --- |
| A Microsoft Entra ID tenant with a verified domain, Microsoft Intune, and an Azure subscription you may create resources in | Both paths |
| Microsoft Agent 365, licensed to the people who build and own the agents | Both paths in this lab ([why for Copilot Studio](01-prerequisites.md#05-installer-checkpoints)) |
| Microsoft Entra ID P1, a standalone Copilot Studio subscription, and a Power Platform environment with Dataverse (or the right to create one) | Copilot Studio path |
| Windows 365 for Agents billing for the Copilot Studio Cloud PC pool, once the trial allowance is used up; Anthropic models allowed by an administrator | Copilot Studio path |
| A Windows 365 for Agents billing policy (Microsoft 365 admin center, Copilot > Cost management) | Foundry path |
| A region where Foundry hosted agents are offered, with quota for the `gpt-4.1-mini` model | Foundry path |

A missing product entitlement blocks the installation. Setup cannot buy or enable a licence.

### People who must be available

Setup runs every step from your computer, but some steps need an administrator to sign in. They
can sit with you, or sign in on the same computer and run the same command later. Setup tells you
whose turn it is.

| Role | Needed for |
| --- | --- |
| Owner of the subscription (or Contributor plus User Access Administrator) | Azure resources and role assignments |
| Application Administrator or Cloud Application Administrator | The Zava sign-in app registration |
| Global Administrator | Copilot Studio Cloud PC tenant preparation (remote desktop setting, device group) |
| Intune Administrator | Delivering the Claims app and the desktop icons; the Foundry Cloud PC pool |
| Agent ID Administrator plus Privileged Role Administrator or Global Administrator | The Foundry agent user and its tenant-wide consent |
| Power Platform Administrator and System Administrator in the environment | The Dataverse trigger table and access for the handoff service |
| Copilot Studio maker in the environment | Creating the Copilot Studio agent and its trigger flow |

### Your computer

Windows 10 or 11 with internet access to Microsoft sign-in, Azure, Microsoft Graph, Intune, npm and
PyPI. Setup checks these tools and prints one install command for any that is missing:
PowerShell 7, Azure CLI 2.80 or later, Node.js 20 or later, Azure Functions Core Tools 4 and
Python 3.12 or later. It also offers to install the PowerShell modules it needs, for your Windows
account only. Nothing is installed without asking.

## Step 1: Get the files

1. Download the lab as a ZIP file:
   - **While this version is under review**, use the review branch:
     <https://github.com/RoelDU/w365-for-agents-cua-lab/archive/refs/heads/release/zava-two-backend.zip>
   - After it is merged, use **Code > Download ZIP** on
     <https://github.com/RoelDU/w365-for-agents-cua-lab>.
2. Before extracting, right-click the ZIP file, choose **Properties**, tick **Unblock** if it is
   shown, and select **OK**. Windows otherwise treats every script in it as downloaded from the
   internet and refuses to run it.
3. Extract it to a short folder that is not synced by OneDrive, for example `C:\ZavaLab`.

If your organisation only allows signed scripts, ask your IT team how to run this setup. Do not
change the execution policy to get around a company rule.

## Step 2: Install the tools

1. Open the extracted folder in File Explorer, click the address bar, type `pwsh` and press Enter.
   A PowerShell 7 window opens in that folder. (If Windows says `pwsh` is not found, install
   PowerShell 7 first: open **Windows PowerShell** and run
   `winget install --exact --id Microsoft.PowerShell`.)
2. Run the preview from step 3. If a tool is missing, setup stops before signing in and prints the
   `winget install` command for it. Run those commands, close PowerShell, open it again the same
   way, and continue.

## Step 3: Preview (changes nothing)

```powershell
.\scripts\Install-Lab.ps1 -Preview
```

Setup asks its questions **once** and saves the answers privately on this computer:

- the tenant (it offers the one you are signed in to) and the subscription (you pick from a list;
  it never picks one for you);
- which paths: both, Copilot Studio only, or Foundry only;
- the Azure region and the resource group name;
- for Foundry: create a new Foundry resource and project for the lab (recommended), or name an
  existing one that is meant for it;
- for Copilot Studio: which Power Platform environment to use (from a list);
- the names it proposes for everything it creates. Accept them, or change any of them.

It signs in with your own account in the normal Microsoft way (browser window, or
`-DeviceCode`), shows the **destination**, then reads your tenant and shows a numbered plan:
`[done]` for what already exists and `[to do]` for each remaining step, with why, who and what.
The preview ends with "nothing in your tenant or subscription was changed".

## Step 4: Run setup

```powershell
.\scripts\Install-Lab.ps1
```

Setup shows the plan again and asks for one **yes** to start. It then works through the steps in
the order below. It asks again, separately, before granting tenant-wide consent, before turning the
Foundry agent on, before using an app registration that already has the same name, and before
changing anything else that already existed.

| # | Step | Why | Who | Finished when |
| --- | --- | --- | --- | --- |
| 1 | Create the handoff service in Azure | Zava sends each transfer here | You | The handoff service answers |
| 2 | Create the Zava web site address | Its address is needed for sign-in | You | The site address exists |
| 3 | Register the Zava sign-in app | Presenters sign in; the service accepts only this app's tokens | Application Administrator | Redirect address, scope and token version are set |
| 4 | Prepare Python on this computer | The deploy helpers are Python scripts | Setup | Packages installed in the download folder |
| 5 | Prepare the tenant for Copilot Studio Cloud PCs | Remote desktop sign-in and the device group | Global Administrator | Device group exists, tenant script finished |
| 6 | Deliver the Claims app to Copilot Studio Cloud PCs | The agent needs Claims on its Cloud PC | Intune Administrator | Claims app assigned to the group |
| 7 | Add the agent launch icon | The agent starts Claims from this icon | Intune Administrator | Icon app assigned to the group |
| 8 | Power Platform environment | Holds the agent and its data | Power Platform Administrator | You chose an environment with Dataverse |
| 9 | Create the Dataverse trigger table | One row per transfer starts the agent | Environment administrator | Table exists |
| 10 | Let the handoff service use Dataverse | Narrow role to write rows and read progress | Environment administrator | Application user has its role |
| 11 | **Portal:** create the Copilot Studio agent | No supported script exists for this | Copilot Studio maker | Agent exists with a Computer use tool |
| 12 | Write the agent instructions and publish | The documented instructions, applied exactly | Environment administrator | Instructions match; agent published |
| 13 | **Portal:** create the trigger flow | Flow connections need your own sign-in | Copilot Studio maker | Flow exists and is on |
| 14 | Create the Foundry project, model and registry | Where the agent runs and what it calls | You | All exist with the right roles |
| 15 | Build the agent image in your registry | Built from your download, pinned by digest | You | Image is in your registry |
| 16 | Create the Foundry agent (switched off) | Foundry creates the agent's own identity | You | Version active, identity known |
| 17 | Create the agent user and consent its permissions | Three delegated permissions for Windows 365 | Agent ID Administrator + Privileged Role Administrator | Nothing left to change |
| 18 | Deliver the Claims app to the Foundry pool's devices | Same app, for the Foundry Cloud PCs | Intune Administrator | Claims app assigned to the group |
| 19 | **Portal:** create the Foundry agent's Cloud PC pool | Billing, size and image are your decisions | Intune Administrator | The pool lists the agent |
| 20 | Turn the Foundry agent on | Only after identity and pool are ready | You, with explicit yes | New version active with execution on |
| 21 | Connect the handoff service to the agents | Writes the IDs and addresses it found | You | All settings match |
| 22 | Build and publish Zava | With this lab's sign-in app and addresses | You | Zava serves the right settings |
| 23 | Give presenters the Zava desktop icon | Edge app icon for the presenter group | Intune Administrator | Published for the Zava address |
| 24 | Readiness check | Reads everything once more | Setup (read-only) | Zava, both agents and the relay are ready |

If you install only one path, the other path's steps are left out and the numbers change.

### When setup pauses for a portal step

At steps 11, 13 and 19 (and step 8 if you have no Power Platform environment with Dataverse yet)
setup prints exact instructions with your names and values filled in, then waits. Do the step in the portal, return to PowerShell and press Enter: setup checks the
result and continues. To stop and come back later, type `later`. Nothing is lost.

What to expect at each:

- **Step 11, Copilot Studio agent.** You create the agent with the name setup shows, keep
  authentication on, and add a **Computer use** tool on a new Cloud PC pool. You do **not** paste
  instructions or publish; step 12 does that. The pool takes about 30 minutes to provision; you
  can continue meanwhile.
- **Step 13, trigger flow.** A short automated cloud flow in Power Automate. Setup prints each
  trigger and action with the exact table, agent and expressions.
- **Step 19, Foundry pool.** A provisioning policy (agents) in the Intune admin center, with your
  billing policy, the agent setup created, and the device group from step 18. Setup then finds
  the pool with a Microsoft Graph sign-in. If your account cannot read pools, setup asks you to
  confirm in the portal instead and says that it did not check this itself.

### If setup stops

Setup stops at the first step that cannot finish. It tells you which step, what happened, who can
fix it and what to do next. After that is fixed, run the same command again:

```powershell
.\scripts\Install-Lab.ps1
```

Every step is checked against your tenant first, so finished steps are not repeated and setup
continues where it stopped. Saved progress is never taken as proof on its own.

A few settings can be read back only by a specific administrator (for example the remote desktop
setting needs a Global Administrator). If your sign-in cannot read one, setup marks that step
**[done, not re-read]**, says when it was last confirmed, and lists it again at the end, so you
know what was not checked on this run. If setup cannot read something for another reason, such as
a missing permission, it stops instead of guessing, so it never creates a duplicate.

## Step 5: Open Zava

When the readiness check passes, setup prints the Zava address. Open it, sign in with a presenter
account, answer a simulated call and choose **Transfer**. Setup itself never starts a transfer or
files a claim.

- New Cloud PC pools can take a while before their first Cloud PC is ready, and the first run on
  each new Cloud PC is slower.
- Add presenters' accounts to the group **Zava-Demo-Agent-Users** to give them the desktop icon.
- For running the demo, use the [presenting guide](presenting.md). A presenter needs only a
  browser.

## What you supply, and what setup works out

| You supply (once) | Setup finds and carries forward |
| --- | --- |
| Tenant, subscription, region, resource group, which paths | Handoff service address and managed identity |
| Power Platform environment (picked from a list) | Zava site address and sign-in app ID |
| Names (or accept the proposed ones) | Dataverse address, Copilot Studio agent ID and schema name |
| New or named existing Foundry project | Foundry project endpoint, image digest, agent identity, blueprint, agent user, Invocations address, Cloud PC pool ID |
| Your yes at each approval | All handoff service settings, Zava's build settings and sign-in file, the Foundry deploy config, and the operator readiness config |

These are kept in `scripts\lab-setup.local.json` and a few generated `*.local.json` files in the
download folder. They hold names, IDs and addresses only, never passwords, keys or tokens, and are
excluded from Git. To change an answer later, run setup with `-ChooseAgain`.

## Not done by setup

- **Licences and billing.** Buying products, the Windows 365 for Agents billing policies, and the
  Copilot Studio pay-as-you-go plan stay with you (see [prerequisites](01-prerequisites.md)).
- **Portal-only steps** 8, 11, 13 and 19, as described above.
- **Optional extras:** the Cloud PC availability gate in Zava
  ([step 6.2a](07-handoff-and-zava.md#62a-optional-cloud-pc-availability-gate-for-foundry-transfers)),
  which needs a tenant-wide Graph permission, and the Enrollment Status Page skip for the Foundry
  pool ([step 2.7](03-tenant-and-cloud-pcs.md#27-optional-skip-esp-account-setup-for-foundry-type-agent-pools)).
- **Proof in your tenant.** Setup's readiness check reads configuration and health; only a real
  transfer shows that a claim is filed. Use the [verification checklist](08-verify.md).

Setup has been tested offline against a simulated tenant. It has not yet been run end to end in a
fresh tenant, so expect to adapt to your tenant's quotas, regions and policies.

## Reference: each step by hand

These pages describe what setup does, as manual portal steps and commands. Use them to understand
a step, to troubleshoot, or if your organisation does not allow the script. You do not need them
for a normal installation, and you do not need to follow them in order.

| Page | Covers |
| --- | --- |
| [Prerequisites](01-prerequisites.md) | Every product, licence, role, tool and open licensing checkpoint. |
| [Values worksheet](02-values-worksheet.md) | The values setup records, for a manual install. |
| [Tenant, Intune and Cloud PC pools](03-tenant-and-cloud-pcs.md) | Steps 5-8, 18-19, and the optional Enrollment Status Page skip. |
| [Azure resources and app registrations](04-azure-and-identity.md) | Steps 1-3, 23. |
| [Copilot Studio path](05-mcs-path.md) | Steps 9-13. |
| [Foundry path](06-foundry-path.md) | Steps 14-17, 20. |
| [Handoff service and Zava](07-handoff-and-zava.md) | Steps 21-22 and the optional availability gate. |
| [Verification](08-verify.md) | Checks after installation, including a real transfer. |
| [Troubleshooting](troubleshooting.md) | Known issues and first checks. |

Only these two agent paths are supported. Do not use the old Direct Line, Durable handoff, local
orchestrator or local Foundry runner documents for a new install.
