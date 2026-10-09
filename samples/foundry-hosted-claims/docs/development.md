# Foundry Claims agent: developer reference

For people who change or diagnose the agent's code. Installing and presenting the lab need none
of this: use [the install guide](../../../docs/install/README.md) and the
[presenting guide](../../../docs/install/presenting.md).

## Contents

- [Local checks](#local-checks)
- [Run the viewer or host locally without cloud access](#run-the-viewer-or-host-locally-without-cloud-access)
- [Container image and deployment internals](#container-image-and-deployment-internals)
- [Local viewer against a deployed agent](#local-viewer-against-a-deployed-agent)
- [Local viewer: start, preflight and failures](#local-viewer-start-preflight-and-failures)
- [HTTP contract](#http-contract)

## Local checks

Use Python 3.12 in `samples\foundry-hosted-claims`:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python -m pip install -e ".[dev]"
.\.venv\Scripts\python -m pytest -q
.\.venv\Scripts\python -m mypy hosted_claims
.\.venv\Scripts\python -m ruff check hosted_claims tests
.\.venv\Scripts\python -m pip wheel --no-deps --wheel-dir dist .
```

The guided setup creates the same `.venv` with the runtime packages only (no `[dev]` extras).

- The browser contract test uses an already installed Microsoft Edge, headless. It blocks
  external browser requests and supplies a fake SDK to check the published constructor and the
  delayed `statusChanged` connection, not streaming. It does not download a browser.
- The visible-action barrier waits for `connected` or `view-only`; `connect()` resolving only
  means the iframe was ready and does not release that barrier.
- Runtime SDK versions are pinned; transitive dependencies are resolved by pip, not a committed
  universal lock.

## Run the viewer or host locally without cloud access

The real viewer shell, with every cloud action denied:

```powershell
$env:LIVE_EXECUTION_APPROVED = "no"
.\.venv\Scripts\python -m hosted_claims.viewer
```

Open **http://127.0.0.1:8099**. In another terminal, the local hosted server with the same gate
off:

```powershell
$env:LIVE_EXECUTION_APPROVED = "no"
.\.venv\Scripts\python -m hosted_claims.host
```

It listens on `127.0.0.1:8088`. A POST to `/invocations?agent_session_id=REQ-2026-0001` returns
an approval-required error, not a fake successful task. Stop either process with Ctrl+C.

## Container image and deployment internals

The build context is the **repository root**, not this sample folder:

```powershell
docker build -f samples\foundry-hosted-claims\Dockerfile -t claims-w365:local .
```

- `Dockerfile.dockerignore` admits only this source and the three shared schemas for a local
  `docker build`. `az acr build` does not apply it the same way (it re-includes everything under
  `samples\`), so `deploy\foundry\Deploy-FoundryAgent.ps1 -BuildImage` builds from a temporary
  folder holding only the files the Dockerfile copies.
- The entrypoint briefly starts as root only to prepare `/home/session/.claims-agent`, because
  the hosted platform mounts the persisted home directory as root-owned. It rejects symlinks and
  unexpected state paths, makes that one directory owner-only, then permanently switches to
  UID/GID 10001 with no supplementary groups before importing or starting the agent. It does not
  change ownership of the mount, recurse over files, or run the agent as root. Local
  `hosted_claims.host` startup is unchanged.
- Schema files are copied to `/app/schemas`; outside this repository, a wheel needs
  `CLAIMS_SCHEMA_DIR` set to those shared files. Foundry keeps per-session state under `HOME`.

Generate a definition **without deploying anything** (after a registry build has given you a
digest):

```powershell
.\.venv\Scripts\python -m hosted_claims.deployment `
  --image "<approved-registry>.azurecr.io/claims-w365@sha256:<64-hex-digest>" > deployment.json
```

This uses the installed SDK's `HostedAgentDefinition`, container configuration, Invocations
protocol `2.0.0`, 0.5 vCPU / 1 GiB and a 20-minute idle timeout. The timeout outlasts the bounded
task if the browser disconnects. Idle time still costs compute; suspension, not closing the
browser, ends it. The definition starts with **both execution gates off**.

Registry pulls use the platform's project identity with a registry-scoped pull permission. Do
not set `registry_connection_id` to a native `ContainerRegistry` project connection: the hosted
service's registry override expects an external-registry token-exchange connection and rejects
the native one as `not_a_registry_connection`. The current
[SDK configuration](https://learn.microsoft.com/en-us/python/api/azure-ai-projects/azure.ai.projects.models.containerconfiguration?view=azure-python)
and [deployment example](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/deploy-hosted-agent)
omit this override for ACR. No stored registry password or extra agent pull grant is implied.

The supported deployment route is the guided setup, which runs
`deploy\foundry\Deploy-FoundryAgent.ps1` (build into your own registry, render, create a version,
configure the endpoint) and `deploy\foundry\Set-FoundryAgentIdentity.ps1` (agent user and
consent); the manual equivalent is [install page 5](../../../docs/install/06-foundry-path.md).
Under the hood the deployer uses `AIProjectClient` against the chosen project and
`client.agents.create_version("claims-w365", definition=HostedAgentDefinition(...))`. Do not run
`azd up`, `a365 setup all`, broad cleanup, or overwrite existing project, model or billing
settings. Never guess the endpoint or substitute another subscription.

The container protocol and the public endpoint protocol are separate settings. Configure only the
new agent's endpoint with
`AgentEndpointConfig(protocol_configuration=ProtocolConfiguration(invocations=InvocationsProtocolConfiguration()), authorization_schemes=[EntraAuthorizationScheme()])`
(the keyword is `protocol_configuration` in `azure-ai-projects` 2.7.0), using
`client.agents.update_details`. Otherwise the default endpoint advertises Responses even when the
container implements Invocations. No Bot Service, anonymous authentication or publication is
needed for this programmatic endpoint; see
[configure protocols](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-agent#enable-protocols-and-authorization-schemes).

## Local viewer against a deployed agent

Presenters use Zava, not this viewer. An optional operator readiness script lives in
`scripts\foundry-demo-prep` (the guided setup writes its config). The local viewer talks to a
deployed hosted agent directly, without Zava or the relay. It was used to bring up the agent
milestone by milestone and is kept for developers diagnosing the agent on its own.

1. Confirm the dedicated one-PC pool is ready and the Claims executable is installed at the path
   in `engine.py`, under a non-admin demo agent account. Configure the official SDK URL and
   verify the agent-user credential path. These are prerequisites, not things the runtime
   provisions.
2. Configure the deployed version for **smoke only**. Use a new synthetic, Foundry-addressed
   handoff with a unique `request_id`. The viewer requires the hosted `agent_session_id` to equal
   that request ID for all calls and retries.
3. In a terminal with the approved human Azure CLI sign-in, set `CLAIMS_TENANT_ID`,
   `HOSTED_AGENT_ENDPOINT` (the HTTPS Invocations endpoint), `HANDOFF_DIR` (a folder holding only
   unused prepared request files) and `LIVE_EXECUTION_APPROVED=yes`, then start
   `hosted_claims.viewer`. The human token calls Foundry only; it never becomes the Computer Use
   token. Run the read-only preflight (below) before starting a run.
4. Open **http://127.0.0.1:8099**, choose the prepared request, choose milestone 1 and start. When
   ready, click **Watch this Cloud PC** within two minutes. The agent waits for the SDK connection
   before its visible action.
5. Count the smoke milestone as successful only with real acquire, readiness and action
   observations, a same-session screen, `smoke_completed`, accepted End Session and an independent
   pool-availability check. Save the exact request, hosted version, session ID and events. SDK
   attachment alone is not proof video was visible; accepted release alone is not proof cleanup
   finished.
6. Only then enable Claims execution, load a **new** request ID and choose milestone 2. Require a
   newly observed confirmation and a correlated result; never use the claim number in a test.

## Local viewer: start, preflight and failures

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

Then run the read-only preflight. It gets a token from the Azure CLI and reads the agent's
metadata (`GET .../agents/<agent>`) over the same TLS stack. It never calls the Invocations
endpoint, so it cannot start, cancel or release anything:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8099/preflight -Headers @{ Origin = "http://127.0.0.1:8099" }
```

Expect `ok: true, status: 200`. The viewer allows the Azure CLI 45 s to return a token. It sends
each hosted request once and never retries it. A failed call returns HTTP 502 with:

- `phase`: `auth` (Azure CLI sign-in), `connect`, `tls`, `send` or `receive`.
- `delivery`: `not_sent` for `auth`, `connect` and `tls` (the hosted agent never received the
  request); `unknown` once request bytes may have left this machine. The viewer also sets
  `X-Viewer-Delivery` on these failures, and the page trusts only that header. After any failed
  `start` the page will not start that request again unless the header says `not_sent`,
  including when the response is missing or unreadable. Use **Watch existing run** with the same
  request ID.
- `error_type`, and `errno` / `winerror` when the operating system supplied them, the same fields
  for up to three underlying causes, and `elapsed_ms`.

Exception messages are never returned or logged because they can carry Azure CLI output. The
viewer terminal logs the same fields.

## HTTP contract

- `start` includes `request_id`, `operation` (`smoke` or `claims`) and `handoff`.
- `status`, `cancel`, `recover` and `view` include `request_id`.
- `prepare` (optional, `request_id` only) is sent while the person reads the transfer
  confirmation. It starts this request's hosted sandbox and, in the background, gets the
  agent-user tokens and discovers the Computer Use server. It acquires no Cloud PC, records no run
  and is never required; `start` repeats any step that was not prepared.
- `view_ready` also includes the acquired `session_id`. The viewer sends it after an SDK
  `connected` or `view-only` status, never just when `connect()` resolves.
- All actions use the same authenticated hosted Invocations endpoint and stable hosted session.
- `status.outcome.result` carries the shared result or error contract for Claims. Smoke never
  claims a business result. `status.outcome.submit_sent` says whether this run sent Submit Claim.
- Zava shows a claim only when `outcome.result.request_id` is the transfer's own request ID and the
  result matches the shared contract. After an error with `submit_sent` true or missing (an older
  agent, unless its error event's `context.submit_sent` is false), Zava keeps the request
  unresolved: no Retry, and no new AI transfer to any destination (Copilot Studio included) until
  a person confirms they checked the claims system.
