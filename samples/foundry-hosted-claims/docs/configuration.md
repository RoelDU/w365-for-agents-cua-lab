# Foundry Claims agent: configuration and identity

Reference for the hosted agent's settings and sign-in identity. The guided setup
(`scripts\Install-Lab.ps1`, see [the install guide](../../../docs/install/README.md)) writes all of
these for you. Read this page if you maintain the agent or want to know what each value does.

## Settings

`.env.example` documents the settings; **dotenv is not loaded automatically**. Set them through
the approved hosted-version configuration (`deploy\foundry\*.local.json`), never inside an image.

| Setting | Meaning |
| --- | --- |
| `FOUNDRY_AGENT_TENANT_ID`, `FOUNDRY_AGENT_BLUEPRINT_CLIENT_ID`, `FOUNDRY_AGENT_INSTANCE_CLIENT_ID` | Native runtime identity values, read without overriding them. Blueprint and agent values are application (client) IDs, not object IDs. |
| `CLAIMS_TENANT_ID`, `CLAIMS_BLUEPRINT_ID`, `CLAIMS_AGENT_ID` | Operator-verified fallbacks if the matching native value is absent. Any conflicting value is rejected before authentication. |
| `CLAIMS_AGENT_USER_ID` | Verified object ID of the agent user that belongs to that agent identity; never taken from the human handoff. |
| `CLAIMS_AUTH_TYPE=identity_proxy_manager` | Use the SDK's secretless identity-proxy flow with the resolved blueprint client ID, as in Microsoft's hosted autopilot sample. |
| `CLAIMS_PROXY_CLIENT_ID` | Optional check; must equal that blueprint client ID, never an unrelated managed identity. |
| `CLAIMS_AUTH_TYPE=workload_identity` plus `CLAIMS_FEDERATED_TOKEN_FILE` | Alternative only when the hosting platform supplies and rotates a valid federation assertion; no static token files. |
| `PYTHON_ENVIRONMENT=Production` | Required for real Agent 365 discovery; mock manifests and gateway overrides are rejected. |
| `SCREEN_SHARE_SDK_URL` | Exact HTTPS `screenshare-embed.js` URL; `.env.example` has Microsoft's published Playground version. |
| `AZURE_AI_MODEL_DEPLOYMENT_NAME` | An existing model deployment; default `gpt-4.1-mini`. |
| `LIVE_EXECUTION_APPROVED=yes` | Allows the agent to acquire a Cloud PC (the smoke path and the live connection). |
| `CLAIMS_EXECUTION_APPROVED=yes` | Separate gate that allows filing synthetic claims. Turn it on only after a successful real smoke run and approval to file synthetic claims. |

Foundry injects `FOUNDRY_PROJECT_ENDPOINT` and `HOME`; do not override them or invent custom
`AGENT_*` variables (that prefix is reserved). The model call uses `ManagedIdentityCredential`;
Computer Use uses the separate agent-user flow.

## Identity

- The agent signs in with the **native agent identity** that Foundry creates for the hosted
  agent, not with a Bot Service identity or a secret.
- The Azure agent-server source names the native identity variables, and Microsoft's hosted
  autopilot sample maps the blueprint client ID to the identity-proxy service connection. This
  sample does not rely on the platform filling them in: the install sets the four `CLAIMS_*` IDs
  explicitly, and any native value that is present must agree with them, or the agent stops
  before authenticating. That is how the reference environment runs.
- IDs are never invented or copied from another agent, and no second, unrelated identity is an
  acceptable workaround for a sign-in failure.
- The sample calls the SDK's explicit-ID autonomous token provider, not a Bot authorization
  handler or handwritten OAuth, and does not assume a platform-created assertion file.
- The final agent-user token exchange needs the delegated consent to exist first; it cannot be
  used to obtain that consent. That is why installation deploys once with both execution gates
  off, then creates the agent user and consents, then deploys again with the gates on. The guided
  setup follows exactly this order.

### Permissions the agent gets

The install consents exactly three delegated scopes on the agent's blueprint: Agent 365 Tools
`McpServersMetadata.Read.All`, Windows 365 Computer Use MCP `Tools.ListInvoke.All` and
W365Agents-Production `Computer.See` (see `deploy\foundry\Set-FoundryAgentIdentity.ps1`).

Discovery is restricted to its approved audience, Windows 365 `Tools.ListInvoke.All`, and passive
`Computer.See`. Register only Windows 365 in this blueprint: the discovery SDK may request tokens
for every registered server, and other audiences are deliberately rejected. Declaration, tenant
admin consent and delegated-scope inheritance are all required before publication.
`Computer.Control` is not used; a human takeover would need a separately approved grant and
implementation.

## Windows account setup on the pool

In the pool used for this sample, each session was observed to get a newly provisioned Cloud PC,
so the agent user signed in for the first time every session. The tenant's default Enrollment
Status Page then showed "Setting up for work or school" in front of the desktop, and the smoke
run stopped with the named setup error.

Windows 365 supports one scoped change: a custom Enrollment Status Page that hides progress,
assigned to All devices with an `enrollmentProfileName` filter. That pool's Cloud PCs enrolled
with the pool display name, so the filter is an exact pool-name match.

`scripts\Set-AgentPoolEspSkip.ps1 -TenantId <tenant-id> -PoolName "<pool display name>"` (run
from the repository root) plans read-only and reports whether Apply would be allowed:

- Intune's filter preview must reach only that pool's Cloud PCs at that moment, and no filter or
  ESP may already use the script's names.
- `-Apply` only creates new objects and records their IDs in a git-ignored local receipt.
- `-Remove` deletes only those recorded IDs, and refuses if they changed.

This changes ESP gating, not just the display: policies and apps may still be applying when the
desktop appears. A Cloud PC enrolled before `-Apply` may keep its earlier ESP. Apply only with the
tenant owner's approval. Install page 2, step 2.7 has the limits.

## Optional diagnostics

These were used while bringing up the reference environment, to find a failing sign-in or
discovery step one at a time. They are not part of a normal install. In both:

- keep both execution gates explicitly `no` and supply the four verified `CLAIMS_*` IDs;
- use a new version of the **same** agent;
- a receipt is created before any work; repeats and restarts return that receipt without
  repeating the exchange, and interrupted attempts stay explicitly incomplete;
- stop the hosted session afterwards, including after errors, and remove the diagnostic setting
  before any later desktop milestone;
- never enable live execution, grant permissions or create a pool just to make a diagnostic pass.

### Identity-only check

1. Set `CLAIMS_IDENTITY_PROBE_REQUEST_ID` to one fresh `REQ-AUTH-...` identifier. The container
   then starts a separate, minimal Invocations handler instead of the desktop host; it does not
   import the model, the Computer Use gateway or the viewer.
2. POST `{"action":"identity_probe","request_id":"REQ-AUTH-..."}` with that exact
   `agent_session_id` query parameter. All other actions, extra fields and sessions are rejected.
3. The [documented Microsoft Agents SDK token methods](https://learn.microsoft.com/python/api/microsoft-agents-authentication-msal/microsoft_agents.authentication.msal.msalauth?view=agent-sdk-python-latest)
   check the blueprint exchange, the agent exchange, then an agent-user token for the
   already-approved Agent Tools discovery audience. No downstream API is called.

This is not evidence of tool invocation, screen access, licensing or a live demo. Only stage
names, fixed status values and public Entra error codes are kept. SDK console and tracing output is
off for this host; raw SDK logs, exceptions, assertions and tokens are not printed or stored. The
exchange runs in a child process with both output streams discarded, and the host stops it after
45 seconds or when the request is cancelled. The operator must also limit the external request.

### Computer Use metadata-only check

Run this after the identity check succeeds, to verify production discovery and the real MCP
connection without a pool or desktop task.

1. Remove `CLAIMS_IDENTITY_PROBE_REQUEST_ID` and set `CLAIMS_TOOLING_PROBE_REQUEST_ID` to one fresh
   `REQ-TOOLS-...` identifier. Setting both probe modes is rejected.
2. POST `{"action":"tooling_probe","request_id":"REQ-TOOLS-..."}` with the matching
   `agent_session_id`.
3. The production gateway gets agent-user tokens, discovers exactly `mcp_W365ComputerUse`, opens
   MCP and lists the lifecycle catalogue. It never calls a Computer Use tool, acquires a Cloud PC,
   requests a screen stream or calls a model. Success returns the actual permitted tool names.

This proves metadata access only, not desktop use. It keeps a separate `tooling-probe.json`
receipt and has a 90-second worker deadline. Failures keep only the exception type, HTTP status
and public Entra codes, never raw payloads or credentials. See
[Agent 365 tooling](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling) and
[Windows 365 Computer Use](https://learn.microsoft.com/en-us/windows-365/agents/mcp-tool-overview).
