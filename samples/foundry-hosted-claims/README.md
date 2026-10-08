# Foundry hosted Claims agent

The **Foundry backend** of the Zava lab: a pro-code Python agent deployed as a Microsoft
Foundry **hosted agent**. It accepts the same handoff and returns the same result contract as
the Copilot Studio (MCS) backend, and drives the same legacy Claims app. Install it with
[install page 5](../../docs/install/06-foundry-path.md); this page is the deep reference.

## Architecture

```text
Presenter in Zava (signed in with Microsoft Entra ID)
  -> handoff service relay /api/foundry-claims/*   (checks the user's token; calls Foundry with
                                                    the Function app's managed identity)
  -> Foundry hosted agent, Invocations endpoint     (this sample; Entra authorization)
       -> Agent 365 tooling SDK discovers the Windows 365 for Agents Computer Use MCP server
          (mcp_W365ComputerUse) with the agent user's delegated token
       -> Start Session: Windows 365 hands over a Cloud PC from the agent's pool
       -> the Foundry model deployment chooses on-screen actions; this code checks and runs
          them through the MCP tools and re-reads the screen after each one
       -> End Session releases the Cloud PC
  -> the observed claim number (or a named error) returns to the same Zava interaction
```

The MCP server is called from this agent's code. Nothing is added as a tool in the Foundry
portal's agent designer. Zava shows the agent's own Cloud PC session live, **view-only**,
through Microsoft's screen-share SDK (`Computer.See` only; no `Computer.Control`).

The MCS backend does not use this code: Zava calls `/api/cua-run` on the same handoff
service, which writes a Dataverse row; a Power Automate trigger flow starts the Copilot Studio
agent and its Computer Use tool drives Claims on a Copilot Studio Cloud PC pool. See
[install page 4](../../docs/install/05-mcs-path.md).

## Status: install defaults versus what has been demonstrated

- **Install defaults are safe and do nothing on a desktop.** A new hosted version has both
  execution gates `no` (`LIVE_EXECUTION_APPROVED`, `CLAIMS_EXECUTION_APPROVED`). With either
  off, the agent refuses to acquire a Cloud PC or file a claim; it does not pretend to succeed.
  The operator turns them on deliberately after identity setup (install step 5.7).
- **Demonstrated in the reference environment (7-8 October 2026)**, with both gates on:
  complete Zava -> Foundry transfers that acquired a Windows 365 for Agents Cloud PC, showed
  that session live in Zava, opened Claims, filed a synthetic claim, returned the observed
  claim number and released the Cloud PC. Timings are in the
  [presenting guide](../../docs/install/presenting.md).
- **Not demonstrated:** an installation in a second, fresh tenant by following these pages;
  production data or load; a Foundry pool with more than one Cloud PC. Passing tests use
  labelled fixtures and are not live proof.

**Release is not the same as capacity.** The agent ends its Windows 365 session itself when a
run finishes, fails or is cancelled. The pool then resets that Cloud PC before it can be handed
out again: about 15-17 minutes in the reference one-PC pool. The optional availability check
(install step 6.2a) greys out the Foundry choice in Zava until the pool reports a free Cloud
PC. It reads a Microsoft Graph **beta** field (`sessionUsage.availableSessionsCount`), which can
change without notice, so it is a demo dependency that fails closed ("Unable to check").

## What runs

The official `InvocationAgentServerHost` accepts the existing handoff. Agent 365
tool discovery uses the configured **agent user's** delegated token, obtained
through the Microsoft Agents SDK autonomous flow. The human handoff requester
never selects the runtime identity. The Microsoft MCP client initializes the
discovered `mcp_W365ComputerUse` endpoint and uses its live tool schemas.
The initial catalog contains lifecycle tools. Before the first desktop action,
the client lists the acquired session's desktop catalog with
`params._meta.sessionId`, including every page. Calls carry that same `sessionId`
in the W365 envelope even when a desktop tool's input schema omits it. The MCP
transport-session header is not a substitute for the Cloud PC session identity.
If scoped discovery fails, the recorded acquisition is still released.

The first operation, `smoke`, acquires a Cloud PC, checks Get Session Details
names the same session (Microsoft documents no status values for that reply, so
only its field names are recorded), treats the PC as ready once the documented
lightweight `get_screen_size` call answers, waits for
the separate viewer to report connection, then reads the foreground screen. If
Windows account setup ("Setting up for work or school", the Enrollment Status
Page) is in front, it gives setup a 30-second grace and otherwise stops with a
named setup error without opening Claims; that check counts against the Claims
budget. An unreadable screen is reported as unreadable, not as setup. A screen read that
Windows 365 rejects during this check is shown and retried within the same 30 seconds (in
REQ-2026-576139834574 a tool call was rejected seconds after Start Session; from that timing it
was inferred, not proven, to be the first read after readiness); if every read is rejected,
the run stops with the service's redacted reason before Claims is opened.
It then opens the installed Claims Workstation. If another window is in front (for example a
browser window opened at first sign-in), it requests activation of the Claims Workstation window
once, retrying only while the service reports that the window is not found yet, and still requires
Claims in the foreground tree before observing; activation alone is not success. Approval-required
or other rejected activation stops the run and releases the Cloud PC. It observes Claims'
accessibility tree, and attempts release. It does not file a claim.
If Claims is not seen in the foreground, the error says so, with only booleans
as diagnostics (including whether `list_windows` shows a Claims window).
When Windows 365 rejects a tool call (`isError`), the run stops and releases as before, and the
error names the tool and the step. From the service's reply it keeps only selected fields: a
short code and status, a GUID or short correlation ID, and a message of at most 300 characters.
Secret-named values (quoted or not), tokens, URLs and long opaque values are removed first. Codes
and IDs that look like keys are dropped. A structured reply with no safe message field is never
copied; it is recorded as `service_message_withheld` with its length. Every error event also
carries `context`: the step, the last tool started, and whether Submit Claim had been sent.
After a sent Submit, the message says the claim may have been filed and must not be repeated.
The `claims` operation additionally runs a bounded model/tool loop, then checks
fresh submission-dialog evidence before returning the observed claim number.
Each screen description given to the model carries a centre click point (`clickX`,
`clickY`) for every element. Every model turn must call at least one tool; the model stops
through `finish_claim` (for example `POLICY_NOT_FOUND`), never with text only.
A turn may hold **up to six** actions when the next steps are certain from the latest screen
(for example: choose 'Policy #', type the policy number, Search, open New FNOL). The loop runs
them **one at a time, in order**, and re-reads the screen after each. It skips the rest of the
turn, telling the model why, if one action is refused, if a later click would no longer land
on the same named control, or if a later typed field was not on the screen the model saw.
Submit Claim and `finish_claim` are always alone in their turn; a turn with more than six
actions is not run at all.
After every click, key press, typing, scroll or window activation, the loop itself re-reads
the screen and gives that fresh layout (with click points) to the model before its next
decision. The model is given a compact copy of each screen: every element with its role,
label, value, automationId, bounds, click point and any true flag, without null values, empty
labels, false flags or the service's CorrelationId line; values are never shortened. Only the
newest screen is sent in full; each earlier one is replaced in place by a one-line note, so
every tool call keeps its paired result and check messages. The raw screens stay in the
activity record and are what every application check reads. Each turn's output allowance is
1024 tokens plus the supplied summary's JSON-escaped length (at least one byte per token),
so the longest permitted narrative always fits; a reply that still reaches the limit is
refused, and nothing from it is sent to the Cloud PC.
If that re-read fails, the run stops rather than act on an old view. Three identical
actions in a row that leave the screen unchanged (ignoring the status-bar clock and
correlation IDs; Tab is not counted, as focus is not shown) stop the run. A second Submit
attempt (Alt+U, a click on Submit, or Enter while Submit is shown) is refused, never sent.
Typing must name its target field (`field`, the automationId from the latest screen): the
loop clicks that field's centre, types, re-reads, and stops the run unless the field then
shows exactly the typed text; it never types into a field already holding other text (a previous run:
unfocused typing landed in the hidden FNOL narrative and the search ran empty). New FNOL is
not opened until the Policy tab shows the requested policy (or caller phone). Until it does,
the newest screen (and any refused New FNOL) carries a short application check: what the
Policy tab's own field shows, that text in the unlabelled search box is only search text and
does not select a policy, the real number of result rows, and, when Search has not been
clicked since that text was typed, the Search button's click point from that screen. Once
the Policy tab shows the policy, the check says it is selected (a previous run: the model took its
typed search text for a selected policy, tried New FNOL five times and clicked an empty
result list twice before Search). The check only reports; the model still takes every step.
Before any search it also says that no search has been run, so an empty list does not mean the
policy is missing, and names the next step. A `POLICY_NOT_FOUND` stop is accepted only after a
Search for the requested policy (or phone); otherwise it is refused, and a second unsearched one
ends the run as unverified (a run reported "not found" from the empty start screen).
The optional Add... vehicle/party dialogs are not opened. Submit is sent only when the on-screen
review shows the requested policy (or caller phone), the loss type for the intent, a
non-empty loss location found word for word in the summary or transcript, and the
supplied summary as narrative (confirmed at entry when the tree cuts the review at 256
characters); a second mismatching attempt stops the run without filing.
An old confirmation already open at task start is rejected.
Success must come from the foreground `FNOL Submitted` dialog, its fixed label,
single read-only claim-ID field and OK button after an action in this run.
Matching words inside a narrative field do not prove submission.

No shell, arbitrary launch, browser automation, clipboard, lifecycle tool, or
unrestricted keyboard shortcut is exposed to the model. Tool-required approvals
and model refusals stop the task; the agent cannot approve them itself.
The Claims-only instruction is not an operating-system security sandbox:
use a dedicated low-privilege demo PC and synthetic claims, never production data.

The viewer shows **Plan / Computer / Activity / Outcome**. Plans are labelled as
application text; explanations are actual assistant text or an available model
summary, not private reasoning. The screen uses the official screen-share SDK
in `viewOnly` mode. It derives `computerUrl` from this exact acquisition's
`screenShareUrl` by removing only the final `/screenshare` path segment,
preserving the service-issued `api-version` and remaining query verbatim.
The SDK receives that `computerUrl` and the versioned `viewerUrl`, matching
Microsoft's Playground implementation rather than the overview's older
`sessionLink` constructor. Missing or malformed screen URLs are rejected before
requesting a viewing token.
There is no recording, alternate desktop, RDP login, or simulated success path.
Tests deliberately replace external services with labelled fixtures.

## Local installation and checks

Use Python 3.12 in this directory:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python -m pip install -e ".[dev]"
.\.venv\Scripts\python -m pytest -q
.\.venv\Scripts\python -m mypy hosted_claims
.\.venv\Scripts\python -m ruff check hosted_claims tests
.\.venv\Scripts\python -m pip wheel --no-deps --wheel-dir dist .
```

The browser contract test uses an already installed Microsoft Edge, headless.
It blocks external browser requests and supplies a fake SDK to check the actual
published constructor and delayed `statusChanged` connection, not streaming.
The visible-action barrier waits for `connected` or `view-only`; resolution of
`connect()` only means the iframe was ready and does not release that barrier.
It does not download a browser. Runtime SDK versions are pinned;
transitive dependencies are resolved by pip, not a committed universal lock.

To open the real viewer shell with **no cloud access**, run:

```powershell
$env:LIVE_EXECUTION_APPROVED = "no"
.\.venv\Scripts\python -m hosted_claims.viewer
```

Open **http://127.0.0.1:8099**. All cloud actions remain denied. In another terminal,
the local hosted server can be started with the same gate off:

```powershell
$env:LIVE_EXECUTION_APPROVED = "no"
.\.venv\Scripts\python -m hosted_claims.host
```

It listens on `127.0.0.1:8088`. A POST to
`/invocations?agent_session_id=REQ-2026-0001` returns an approval-required error,
not a fake successful task. Stop either local process with Ctrl+C.

## Required configuration before cloud execution

`.env.example` documents the settings; **dotenv is not automatically loaded**.
Set them through the approved hosted-version configuration, never in an image.

| Setting | Meaning |
| --- | --- |
| `FOUNDRY_AGENT_TENANT_ID`, `FOUNDRY_AGENT_BLUEPRINT_CLIENT_ID`, `FOUNDRY_AGENT_INSTANCE_CLIENT_ID` | Native runtime identity values, read without overriding them. Blueprint and agent values are application/client IDs, not object IDs |
| `CLAIMS_TENANT_ID`, `CLAIMS_BLUEPRINT_ID`, `CLAIMS_AGENT_ID` | Operator-verified fallbacks if the corresponding native value is absent. Any conflicting override is rejected before authentication |
| `CLAIMS_AGENT_USER_ID` | Explicitly verified agent-user object ID belonging to that agent identity; never taken from the human handoff |
| `CLAIMS_AUTH_TYPE=identity_proxy_manager` | Use the real SDK's secretless identity-proxy flow with the resolved blueprint client ID, matching Microsoft's hosted autopilot sample |
| `CLAIMS_PROXY_CLIENT_ID` | Optional explicit check; must equal that blueprint client ID, never an unrelated managed identity |
| Alternative `CLAIMS_AUTH_TYPE=workload_identity` plus `CLAIMS_FEDERATED_TOKEN_FILE` | Only when the hosting platform explicitly supplies and rotates a valid federation assertion; no static token files |
| `PYTHON_ENVIRONMENT=Production` | Required for actual Agent 365 discovery; mock manifests and gateway overrides are rejected |
| `SCREEN_SHARE_SDK_URL` | Exact HTTPS `screenshare-embed.js` URL; `.env.example` contains Microsoft's published Playground version |
| `AZURE_AI_MODEL_DEPLOYMENT_NAME` | Existing deployment; default `gpt-4.1-mini` |
| `LIVE_EXECUTION_APPROVED=yes` | Enable the approved smoke path and connection |
| `CLAIMS_EXECUTION_APPROVED=yes` | Separate operator-controlled gate, enabled only after recording a successful real smoke milestone and approval to file synthetic Claims |

Foundry injects `FOUNDRY_PROJECT_ENDPOINT` and `HOME`; do not override them or
invent custom `AGENT_*` variables (that prefix is reserved). The model uses
`ManagedIdentityCredential`; Computer Use uses the separate SDK agent-user flow.

**Identity configuration.** The Azure agent-server source names the native identity
variables, and Microsoft's hosted autopilot sample maps the blueprint client ID to the
identity-proxy service connection. This sample does not rely on the platform populating them:
the install sets the four `CLAIMS_*` IDs explicitly (install step 5.7), and any native value
that is present must agree with them, or the agent stops before authenticating. That is how
the reference environment runs. IDs are never invented or copied from another agent.
This sample calls the SDK's explicit-ID autonomous token provider, not a Bot
authorization handler or handwritten OAuth. It does not assume a platform-created
assertion file.
The final agent-user exchange requires the approved delegated consent; it cannot
be used as a prerequisite for that consent, which is why the install deploys once with the
gates off, then creates the agent user and consents, then deploys again.
No second unrelated identity is an acceptable workaround.

**Windows account setup on the pool.** In the pool used for this sample, each
session was observed to get a newly provisioned Cloud PC, so the agent user
signed in for the first time every session and the tenant's default Enrollment
Status Page showed "Setting up for work or school" in front of the desktop; the
smoke then stops with the named setup error. Windows 365 supports one scoped
change: a custom ESP that hides progress, assigned to All devices with an
`enrollmentProfileName` filter. That pool's Cloud PCs enrolled with the pool
display name, so the filter is an exact pool-name match.
`scripts\Set-AgentPoolEspSkip.ps1 -TenantId <tenant-id> -PoolName "<pool display name>"`
(repo root) plans read-only and reports whether Apply would be allowed: Intune's
filter preview must reach only that pool's Cloud PCs at that moment, and no
filter or ESP may already use the script's names. `-Apply` only creates new
objects and records their IDs in a git-ignored local receipt; `-Remove` deletes
only those recorded IDs, refusing if they changed. This changes ESP gating, not
just the display: policies and apps may still be applying when the desktop
appears. A Cloud PC enrolled before `-Apply` may keep its earlier ESP. Apply
only with the tenant owner's approval.

Discovery is restricted to its approved audience, W365 `Tools.ListInvoke.All`,
and passive `Computer.See`. Register only W365 in this blueprint: the discovery
SDK may request tokens for all registered servers, and other audiences are
deliberately rejected. Declaration, tenant-admin consent and delegated-scope
inheritance are all required before publication. No `Computer.Control` is used;
human takeover requires a separately approved grant and implementation.

### Optional diagnostic: identity-only check

Not part of a normal install. Use it only to locate a sign-in failure step by step; it was
used while bringing up the reference environment.

For an approved authentication check, set `CLAIMS_IDENTITY_PROBE_REQUEST_ID`
to one fresh `REQ-AUTH-...` identifier on a new version of the **same** agent.
Keep both execution gates explicitly `no`. Supply the four verified `CLAIMS_*`
identity IDs above; native values, if present, must match. The container then
starts a separate, minimal Invocations handler instead of the desktop/Claims host.
It does not import the model, Computer-Use gateway or viewer.

POST `{"action":"identity_probe","request_id":"REQ-AUTH-..."}` with that exact
`agent_session_id` query parameter. All other actions, additional fields and
sessions are rejected. The [documented Microsoft Agents SDK token methods](https://learn.microsoft.com/python/api/microsoft-agents-authentication-msal/microsoft_agents.authentication.msal.msalauth?view=agent-sdk-python-latest)
check blueprint exchange, agent exchange, then an agent-user token for the
already-approved Agent Tools discovery audience. No downstream API is called.
This is not evidence of tool invocation, screen access, licensing or a live demo.

Only stage names, fixed status values and public Entra error codes are retained.
SDK console/tracing setup is disabled for this diagnostic host; raw SDK logs and
exceptions, assertions and tokens are not printed or persisted. A receipt is
created before authentication; repeats and process restarts return that receipt
without repeating the exchange. Interrupted attempts remain explicitly incomplete.
The exchange runs in a child process, with both output streams discarded, so
even a blocking SDK metadata lookup cannot freeze the server. The host kills
and reaps this worker after 45 seconds or request cancellation. The operator
must also bound the external request and stop the hosted session in cleanup,
including after errors.
Do not enable live execution, grant permissions or create a pool to get this
diagnostic to pass. Remove the probe setting before any later approved desktop
milestone, and keep the existing approval gates.

### Optional diagnostic: Computer-Use metadata-only check

After authentication succeeds, an approved metadata check can independently
verify production discovery and the real MCP transport without a pool or desktop
task. Remove `CLAIMS_IDENTITY_PROBE_REQUEST_ID` and set
`CLAIMS_TOOLING_PROBE_REQUEST_ID` to one fresh `REQ-TOOLS-...` identifier on the
same hosted agent. Both execution gates must remain explicitly `no`; configuring
both probe modes is rejected. This does not reset or repeat the identity proof.

POST `{"action":"tooling_probe","request_id":"REQ-TOOLS-..."}` with the matching
`agent_session_id`. The existing production gateway obtains agent-user tokens,
discovers exactly `mcp_W365ComputerUse`, initializes MCP and lists the lifecycle
catalog. It never calls a Computer-Use tool, acquires a PC, requests a screen
stream or calls a model. Success returns the actual permitted tool names, not
sample results. This proves metadata access only, not desktop invocation.

The same one-session request guard, receipt-before-work and no-replay behavior
apply, with a separate `tooling-probe.json` receipt and a 90-second worker deadline.
Failures retain only exception type, HTTP status and public Entra codes, never
raw transport payloads or credentials. Stop the hosted session afterward,
including on failure, and remove the diagnostic setting before the approved
visible-action milestone. See [Agent 365 tooling](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling)
and [Windows 365 Computer Use](https://learn.microsoft.com/en-us/windows-365/agents/mcp-tool-overview).

## Container and narrow deployment

Build context is the **repository root**, not this sample directory:

```powershell
docker build -f samples\foundry-hosted-claims\Dockerfile -t claims-w365:local .
```

The Dockerfile-specific ignore file admits only this source and the three shared
schemas for a local `docker build`. `az acr build` does not apply it the same way (it
re-includes everything under `samples\`), so `deploy\foundry\Deploy-FoundryAgent.ps1 -BuildImage`
builds from a temporary folder holding only the files the Dockerfile copies.
The container entrypoint briefly starts as root to initialize only
`/home/session/.claims-agent`, because the hosted platform mounts the persisted
home directory as root-owned. It rejects symlinks and unexpected state paths,
sets that one directory to owner-only access, then permanently switches to
UID/GID 10001 with no supplementary groups before importing or starting the agent.
It does not change ownership of the mount, recurse over files, or run the agent
as root. Local `hosted_claims.host` startup is unchanged.
Schema files are copied to `/app/schemas`;
outside this repository, a wheel needs `CLAIMS_SCHEMA_DIR` set to those shared
files. Foundry persists per-session state under `HOME`.

After approval, build into your own registry with `Deploy-FoundryAgent.ps1 -BuildImage`
(install step 5.3) and record its image digest. It is a billable cloud build, not a local check.
Generate a definition **without deploying anything**:

```powershell
.\.venv\Scripts\python -m hosted_claims.deployment `
  --image "<approved-registry>.azurecr.io/claims-w365@sha256:<64-hex-digest>" > deployment.json
```

This uses the installed SDK's `HostedAgentDefinition`, container configuration,
Invocations protocol `2.0.0`, 0.5 vCPU / 1 GiB and a 20-minute idle timeout.
The timeout outlasts the bounded task if the browser disconnects. Idle grace
still incurs compute costs; suspension, not browser closure, ends that compute.
The definition initially has **both execution gates off**.

Azure Container Registry pulls use the platform's project identity, with the
approved registry-scoped pull permission. Do not set `registry_connection_id`
to a native `ContainerRegistry` project connection: the hosted service's explicit
registry override expects an external-registry token-exchange connection and
rejects the native connection as `not_a_registry_connection`. The current
[SDK configuration](https://learn.microsoft.com/en-us/python/api/azure-ai-projects/azure.ai.projects.models.containerconfiguration?view=azure-python)
and [deployment example](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/deploy-hosted-agent)
omit this override for ACR. No stored registry password or additional agent pull
grant is implied.

The supported deployment route is [install page 5](../../docs/install/06-foundry-path.md),
which runs `deploy\foundry\Deploy-FoundryAgent.ps1` (build into your own registry, render,
create a version, configure the endpoint) and `deploy\foundry\Set-FoundryAgentIdentity.ps1`
(agent user and consent). Under the hood the deployer uses `AIProjectClient` against the
chosen project and `client.agents.create_version("claims-w365",
definition=HostedAgentDefinition(...))`. Do not run `azd up`, `a365 setup all`, broad cleanup,
or overwrite existing project/model/billing settings. Capture created IDs and the returned
endpoint; never guess the endpoint or substitute another subscription.

The container protocol and public endpoint protocol are separate settings.
Configure only the new agent's endpoint with
`AgentEndpointConfig(protocol_configuration=ProtocolConfiguration(invocations=InvocationsProtocolConfiguration()), authorization_schemes=[EntraAuthorizationScheme()])`
(the keyword is `protocol_configuration` in `azure-ai-projects` 2.7.0), using
`client.agents.update_details`.
The default endpoint otherwise advertises Responses even when the container
implements Invocations. No Bot Service, anonymous authentication or publication
is needed for this programmatic endpoint; see
[configure protocols](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-agent#enable-protocols-and-authorization-schemes).

## Developer path: local viewer (optional, not used for presenting)

Presenters use Zava: see the [presenting guide](../../docs/install/presenting.md). The
presenter needs only the Zava address, the presenting account and the browser check. An
optional operator readiness script lives in `scripts\foundry-demo-prep` (a maintainer can
package it with `scripts\Build-FoundryDemoPrepPackage.ps1`; no built ZIP is committed).

The local viewer below talks to a deployed hosted agent directly, without Zava or the relay.
It was used to bring up the hosted agent milestone by milestone and is kept for developers
diagnosing the agent on its own.

1. Confirm the dedicated one-PC pool is ready and the existing Claims executable
   is installed at the path in `engine.py`, under a non-admin demo agent account.
   Configure the official SDK URL and verify the supported agent-user credential
   path. These are prerequisites, not things the runtime provisions.
2. Configure the deployed version for **smoke only**. Use a new synthetic,
   Foundry-addressed shared handoff with a unique `request_id`. The viewer requires
   the hosted `agent_session_id` to equal that request ID, for all calls and retries.
3. In a terminal with the approved human Azure CLI sign-in, set
   `CLAIMS_TENANT_ID`, `HOSTED_AGENT_ENDPOINT` to the returned HTTPS Invocations
   endpoint, `HANDOFF_DIR` to a folder holding only unused prepared request files,
   and `LIVE_EXECUTION_APPROVED=yes`. Start `hosted_claims.viewer`.
   The human token calls Foundry only; it never becomes the Computer-Use token.
   Before starting a run, check sign-in and TLS with the read-only preflight
   (see [Local viewer](#local-viewer-start-preflight-and-failures)).
4. Open **http://127.0.0.1:8099**, choose the prepared request from the list,
   choose milestone 1, and start.
   When ready, click **Watch this Cloud PC** within two minutes. The agent waits
   for the SDK connection before its visible action. Watch Claims open.
5. Require actual acquire/readiness/action observations, a same-session screen,
   `smoke_completed`, End Session acceptance, and an independent pool-availability
   check before calling the smoke milestone successful. Save the exact request,
   hosted version, session ID and events. SDK attachment alone is not proof video
   was visible; accepted release alone is not proof cleanup finished.
6. Only then enable approved Claims execution, load a **new** request ID and choose
   milestone 2. Observe navigation and submission. Require a newly observed
   confirmation and correlated result; never use the claim number in a test.

**HTTP contract:** `start` includes `request_id`, `operation` (`smoke` / `claims`)
and `handoff`. `status`, `cancel`, `recover`, `view` include `request_id`.
`prepare` (optional, `request_id` only) is sent while the person reads the transfer
confirmation: it starts this request's hosted sandbox and, in the background, gets the
agent-user tokens and discovers the Computer-Use server. It acquires no Cloud PC, records
no run and is never required; `start` repeats any step that was not prepared.
`view_ready` additionally includes the acquired `session_id`; the viewer sends
this after an SDK `connected` or `view-only` status, never just `connect()`
resolution. These actions all use the same authenticated hosted
Invocations endpoint and stable hosted session. `status.outcome.result` carries
the shared result/error contract for Claims. Smoke never claims a business result.
`status.outcome.submit_sent` says whether this run sent Submit Claim. Zava shows a claim only
when `outcome.result.request_id` is the transfer's own request ID and the result matches the
shared contract. After an error with `submit_sent` true or missing (an older agent, unless its
error event's `context.submit_sent` is false), Zava keeps the request unresolved: no Retry, and no
new AI transfer to any destination (Copilot Studio included) until a person confirms they
checked the claims system.

### Local viewer: start, preflight and failures

From `samples\foundry-hosted-claims`, with placeholders replaced:

```powershell
$env:CLAIMS_TENANT_ID = "<tenant-id>"
$env:HOSTED_AGENT_ENDPOINT = "https://<account>.services.ai.azure.com/api/projects/<project>/agents/<agent>/endpoint/protocols/invocations"
$env:HANDOFF_DIR = "<folder of unused prepared request files>"
$env:LIVE_EXECUTION_APPROVED = "yes"
$env:VIEWER_PORT = "8099"            # optional; default 8099
# $env:AZURE_CONFIG_DIR = "<folder>"  # optional: a dedicated Azure CLI profile for this terminal only
.\.venv\Scripts\python -m hosted_claims.viewer
```

Then run the read-only preflight. It gets a token from the Azure CLI and reads the
agent's metadata (`GET .../agents/<agent>`) over the same TLS stack. It never
calls the Invocations endpoint, so it cannot start, cancel or release anything:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8099/preflight -Headers @{ Origin = "http://127.0.0.1:8099" }
```

Expect `ok: true, status: 200`. The viewer allows the Azure CLI 45 s to return a
token. It sends each hosted request once and never retries it. A failed call
returns HTTP 502 with:

- `phase`: `auth` (Azure CLI sign-in), `connect`, `tls`, `send` or `receive`.
- `delivery`: `not_sent` for `auth`, `connect` and `tls`; the hosted agent never
  received the request. `unknown` once request bytes may have left this machine.
  The viewer also sets `X-Viewer-Delivery` on these failures; the page trusts
  only that header. After any failed `start` the page will not start that
  request again unless the header says `not_sent`, including when the response
  is missing or unreadable. Use **Watch existing run** with the same request ID.
- `error_type`, and `errno` / `winerror` when the operating system supplied them,
  plus the same fields for up to three underlying causes, and `elapsed_ms`.

Exception messages are never returned or logged because they can carry Azure CLI
output. The viewer terminal logs the same fields.

## Failure, recovery and retention

Work stops on refusal, additional approval, failed tool, timeout or cancellation.
An independent bounded release is attempted for every known session ID. Outcome
and release are separate: a submitted claim can still need cleanup.
Repeated cancellation requests are idempotent and cannot cancel that bounded
release attempt.

The per-session SQLite store remembers requests/events across supported sandbox
suspension. Replaying the same request does not run it again; a changed payload
is rejected. Browser refresh does not restart the task. Use **Watch existing run**
to reconnect with the same request ID. Runs are background tasks, not a durable
job engine: process loss is reported as interrupted, never automatically resumed.

Use **Cancel and release**, then **Retry release only** for a recorded session
whose release failed. Recovery opens an authenticated connection and calls only
End Session; it never allocates a PC or repeats submission. If acquisition's
response was lost and no session ID was recorded, administrator investigation
is required. Never invent an ID, reset the pool, or assume no resource was allocated.
If hosted session storage is deleted, request history/replay protection is lost:
archive evidence first, never reuse that request ID, and inspect the Claims app.

Tokens stay in memory and view responses are `no-store`. Handoffs, UI text, tool
arguments and outcomes can contain personal data; use synthetic inputs. The
session's SQLite file is real retained data. Delete only the approved completed
hosted sessions under your retention policy after cleanup and evidence review.

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
