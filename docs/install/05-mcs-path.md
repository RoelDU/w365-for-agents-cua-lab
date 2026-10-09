# 4. Copilot Studio path (MCS)

> **Reference page.** The guided setup in the [install guide](README.md) does this page's work for you (steps 9-13 there). Use this page to understand a step, to troubleshoot, or to install by hand.

This path is the supported MCS install path:

```text
Zava -> POST /api/cua-run -> Dataverse trigger row -> Power Automate autonomous trigger flow -> Copilot Studio agent -> Computer Use -> Claims app
```

It is not the old Direct Line path.

## 4.1 Create the Dataverse trigger table

You can create the table manually, or use the planning script below. The live working table was read through the Dataverse Web API and uses these defaults:

| Purpose | Logical name | Dataverse type | Max length | Notes |
| --- | --- | --- | --- | --- |
| Table | `crcce_claimrequest` | Standard custom table | n/a | Entity set: `crcce_claimrequests`; ownership: user/team owned (`UserOwned`). |
| Primary name | `crcce_name` | Text | 200 | Primary name column. Can be blank for trigger rows, but it is useful to set it to the correlation ID. |
| Row ID | `crcce_claimrequestid` | Unique identifier | n/a | Primary key, created by Dataverse. |
| Policy number | `crcce_policynumber` | Text | 100 | Written by the handoff service. |
| Summary | `crcce_summary` | Text | 4000 | Short call summary for filtering and human inspection. Full context still goes in `crcce_handoffcontext`. |
| Correlation ID | `crcce_correlationid` | Text | 100 | Zava request/correlation ID. |
| Language | `crcce_lang` | Text | 10 | For example `en` or `ja`. |
| Full handoff JSON | `crcce_handoffcontext` | Multiple lines of text | 1,048,576 | Must hold the full JSON payload sent to the agent. Do not use a short text field. |
| Result claim ID | `crcce_claimid` | Text | 50 | Optional direct write-back; the handoff service can also read the claim ID from the receipt responses. |
| Result receipt JSON | `crcce_handoffreceipt` | Multiple lines of text | 1,048,576 | Must hold the full JSON receipt. Do not use a short text field. |
| Result status | `crcce_status` | Text | 50 | Optional status label. |

Plan the table creation without changing Dataverse:

```powershell
pwsh -File .\scripts\mcs\New-McsTriggerTable.ps1 `
  -OrgUrl "https://<your-org>.crm.dynamics.com" `
  -PublisherPrefix "crcce"
```

Create it only after reviewing the plan:

```powershell
pwsh -File .\scripts\mcs\New-McsTriggerTable.ps1 `
  -OrgUrl "https://<your-org>.crm.dynamics.com" `
  -PublisherPrefix "crcce" `
  -Apply
```

If you use a different publisher prefix, set the matching `CUA_TRIGGER_*` and `CUA_RESULT_*` Function app settings in step 6.

## 4.2 Create the Dataverse application user for the Function app

Manual portal step.

1. In Power Platform admin center, open the environment.
2. Go to **Settings > Users + permissions > Application users**.
3. Create an application user for the Function app managed identity application ID.
4. Assign a security role that can:
   - create and update rows in the trigger table;
   - read `flowsessions`, `flowlogs`, and `flowsessionbinaries` for Computer Use progress;
   - read the trigger row result fields.

Microsoft reference: <https://learn.microsoft.com/en-us/power-platform/admin/manage-application-users>

## 4.3 Build and publish the Copilot Studio agent

Manual portal step.

1. Create an agent named for your environment, for example **Zava Claims Intake (CUA)**.
2. Turn on generative orchestration.
3. Require authentication. Computer Use is disabled for unauthenticated agents.
4. Add a **Computer Use** tool. In its **Machines** setting choose **Cloud PC pool** and create
   the MCS pool:
   - billing: a tenant can create up to two Cloud PC pools without a Windows 365 for Agents
     billing plan and gets 50 free hours for published agents running autonomously, which is how
     this lab runs; after that the environment needs its pay-as-you-go billing plan (page 0,
     section 0.1);
   - Microsoft documents automatic scaling for these pools (up to 10 Cloud PCs) but no
     always-available setting, so a run can still have to wait for a newly prepared Cloud PC;
   - record the machine group or pool ID for the worksheet.

   Provisioning can take about 30 minutes. These Cloud PCs show the model name **Copilot Studio
   Hosted Agent Machine ...** and an Intune provisioning policy named like
   `CPCPool_<environment>_<machinegroupid>`, so they join the step 2.2 dynamic group and get
   the Claims app from step 2.4 without further assignment.
   The first run on each new Cloud PC is several minutes slower (Windows sets up the agent
   user; see [presenting](presenting.md)); later runs on the same Cloud PC are not.
5. Open [`..\mcs-computer-use-instructions.md`](../mcs-computer-use-instructions.md).
6. Paste the **Agent instructions** block into **Overview > Instructions**.
7. Paste the **Computer use tool instructions** block into **Tools > Computer use > Instructions**.
8. Leave the Computer Use tool **Inputs** empty. The current working configuration has no tool inputs.
9. Save, then publish the agent.

You can also apply the same two text blocks with the publish helper (the guided setup runs it
for you in its step 12). It needs Python with PyYAML and the Azure CLI signed in as a System
Customizer or System Administrator in the environment. The agent schema name is under
**Settings > Advanced > Metadata** in Copilot Studio. Dry run first, then apply and publish:

```powershell
python .\scripts\mcs\publish_mcs_agent_config.py --org-url https://<your-org>.crm.dynamics.com --agent-schema <agent-schema-name> --dry-run
python .\scripts\mcs\publish_mcs_agent_config.py --org-url https://<your-org>.crm.dynamics.com --agent-schema <agent-schema-name>
```

It backs up the live definitions to `scripts\mcs\backups` first. More detail: the **How to apply
it** section in [`..\mcs-computer-use-instructions.md`](../mcs-computer-use-instructions.md).

How the call's details reach Computer Use: the tool instructions contain `{System.Activity.Text}`, which Copilot Studio replaces with the handoff JSON that started the run. Paste the instructions exactly. Do not add tool **Inputs** by editing the tool definition: Copilot Studio then does not start the tool at all (details in [the MCS agent configuration](../mcs-computer-use-instructions.md#how-the-calls-details-reach-computer-use)).

Do not invent alternate instructions. The Claims app is a screen-driven workflow; small wording changes can change what the model clicks.

## 4.4 Create the autonomous trigger flow

The trigger must run as a Copilot Studio autonomous trigger flow so the run appears in Copilot Studio **Activity**. Do not use a manual test-only flow for the install.

A sanitized template is committed at:

```text
deploy\mcs\trigger-flow.template.json
```

Use it as an import/build reference. Replace every `__PLACEHOLDER__` value with your environment values; do not commit the filled-in copy.

Manual build steps in Power Automate:

1. Create a cloud flow in the same environment as the agent and Dataverse table.
2. Trigger: Dataverse **When a row is added, modified or deleted**.
   - Change type: **Added** (`subscriptionRequest/message = 1`).
   - Table name: singular table logical name, for example `crcce_claimrequest`.
   - Scope: **Organization** (`subscriptionRequest/scope = 4`).
   - Trigger condition: `@not(empty(triggerBody()?['crcce_handoffcontext']))`.
3. Add Copilot Studio **Execute Agent and wait**.
   - Copilot/agent: the schema name of your agent, for example `crcce_ZavaClaimsIntakeCUA`.
   - Locale expression:
     ```text
     @if(equals(json(triggerBody()?['crcce_handoffcontext'])?['language'], 'ja'), 'ja-JP', 'en-US')
     ```
   - Message expression:
     ```text
     @triggerBody()?['crcce_handoffcontext']
     ```
   - Do not map individual Dataverse columns into Computer Use tool inputs here. The Computer Use tool has no inputs: the agent receives the full handoff JSON as its message, and the tool's `{System.Activity.Text}` placeholder passes that same message to Computer Use.
4. Add a **Compose** action named `Compose_receipt` with this expression:
   ```text
   @addProperty(addProperty(addProperty(addProperty(addProperty(json('{}'), 'definition_version', '2.0.0'), 'trigger_row_id', triggerBody()?['crcce_claimrequestid']), 'flow_run_id', workflow()?['run']?['name']), 'conversation_id', body('Execute_Agent_and_wait')?['conversationId']), 'responses', body('Execute_Agent_and_wait')?['responses'])
   ```
5. Add Dataverse **Update a row** against the original trigger row.
   - Table name/entity set: `crcce_claimrequests`.
   - Row ID:
     ```text
     @triggerBody()?['crcce_claimrequestid']
     ```
   - `crcce_handoffreceipt`:
     ```text
     @string(outputs('Compose_receipt'))
     ```

The receipt fields are exactly:

| Receipt field | Expression source |
| --- | --- |
| `definition_version` | Literal `2.0.0`. |
| `trigger_row_id` | `triggerBody()?['crcce_claimrequestid']`. |
| `conversation_id` | `body('Execute_Agent_and_wait')?['conversationId']`. |
| `flow_run_id` | `workflow()?['run']?['name']`. |
| `responses[]` | `body('Execute_Agent_and_wait')?['responses']`. |

Keep secure inputs/outputs on for the trigger, Execute Agent action, receipt compose, and update action if the payload can contain personal data.

Template placeholder reference:

| Placeholder | What to put there | Where you get it |
| --- | --- | --- |
| `__DATAVERSE_CONNECTION_NAME__` | The connection name/id of the Dataverse connection used by the flow. | Power Automate connection reference when you build or import the flow. |
| `__DATAVERSE_CONNECTION_REFERENCE_LOGICAL_NAME__` | The Dataverse connection reference logical name. | Power Automate connection reference details. |
| `__COPILOT_STUDIO_CONNECTION_NAME__` | The connection name/id of the Copilot Studio connection used by **Execute Agent and wait**. | Power Automate connection reference when you build or import the flow. |
| `__COPILOT_STUDIO_CONNECTION_REFERENCE_LOGICAL_NAME__` | The Copilot Studio connection reference logical name. | Power Automate connection reference details. |
| `__TRIGGER_TABLE_LOGICAL_NAME_SINGULAR__` | Singular Dataverse table logical name, for example `crcce_claimrequest`. | Step 4.1. |
| `__TRIGGER_TABLE_ENTITY_SET__` | Dataverse entity set, for example `crcce_claimrequests`. | Step 4.1 and the values worksheet. |
| `__COPILOT_SCHEMA_NAME__` | Copilot Studio agent schema name, for example `crcce_ZavaClaimsIntakeCUA`. | Copilot Studio agent details. |
| `__PREFIX__` | Your Dataverse publisher prefix, for example `crcce`. | Step 4.1. |

## 4.5 Record the Copilot Studio bot ID

The handoff service uses `CUA_AGENT_BOTID` to find the right Computer Use flow sessions.

Use one of these exact methods:

1. In Copilot Studio, open the agent, then go to **Settings > Advanced > Metadata**. Copy the bot ID from the metadata panel.
2. Or query Dataverse read-only. Replace the schema name with your agent schema name:
   ```powershell
   $org = "https://<your-org>.crm.dynamics.com"
   $token = az account get-access-token --resource $org --query accessToken -o tsv
   Invoke-RestMethod `
     -Headers @{ Authorization = "Bearer $token"; Accept = "application/json" } `
     -Uri "$org/api/data/v9.2/bots?`$select=botid,schemaname,name&`$filter=schemaname eq '<agent-schema-name>'"
   ```

Set the returned `botid` as the Function app setting `CUA_AGENT_BOTID`.
