import asyncio
import json
import logging
import sys
import textwrap
import time

import httpx2
import pytest
from azure.ai.agentserver.invocations import InvocationAgentServerHost

from hosted_claims.identity import DISCOVERY_SCOPE, AgentIdentity
from hosted_claims.identity_probe import create_probe_app, main

IDENTITY = AgentIdentity(
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000002",
    "00000000-0000-0000-0000-000000000003",
    "00000000-0000-0000-0000-000000000004",
    auth_type="identity_proxy_manager",
    proxy_client_id="00000000-0000-0000-0000-000000000002",
)
BODY = {"action": "identity_probe", "request_id": "REQ-AUTH-1"}
URL = "/invocations?agent_session_id=REQ-AUTH-1"


@pytest.fixture
def offline_worker(monkeypatch):
    """Run the real child process with the external SDK/HTTP boundary intercepted."""
    monkeypatch.setenv("LIVE_EXECUTION_APPROVED", "no")
    monkeypatch.setenv("CLAIMS_EXECUTION_APPROVED", "no")
    monkeypatch.setenv("CLAIMS_IDENTITY_PROBE_REQUEST_ID", "REQ-AUTH-1")
    for name, value in (
        ("CLAIMS_TENANT_ID", IDENTITY.tenant_id),
        ("CLAIMS_BLUEPRINT_ID", IDENTITY.blueprint_id),
        ("CLAIMS_AGENT_ID", IDENTITY.agent_id),
        ("CLAIMS_AGENT_USER_ID", IDENTITY.user_id),
    ):
        monkeypatch.setenv(name, value)
    for name in (
        "FOUNDRY_AGENT_TENANT_ID", "FOUNDRY_AGENT_BLUEPRINT_CLIENT_ID",
        "FOUNDRY_AGENT_INSTANCE_CLIENT_ID", "FOUNDRY_AGENT_SESSION_ID",
    ):
        monkeypatch.delenv(name, raising=False)
    original = asyncio.create_subprocess_exec
    launched = []

    def configure(mode):
        script = f"MODE = {mode!r}\n" + textwrap.dedent("""
            import logging, os, sys, time, requests
            from microsoft_agents.authentication.msal import MsalAuth
            from hosted_claims.identity_probe import main

            def no_network(self, request, **kwargs):
                if MODE == "stall":
                    time.sleep(30)
                raise RuntimeError("All real HTTP is blocked in this offline fixture.")

            async def blueprint(self, tenant, agent):
                if MODE == "error":
                    logging.getLogger("microsoft_agents.authentication.msal").error(
                        "AADSTS65001 access_token=secret-error-fixture"
                    )
                    raise ValueError("AADSTS65001 assertion=secret-exception-fixture")
                return "secret-blueprint-fixture"

            async def instance(self, tenant, agent):
                return "secret-instance-fixture", "secret-blueprint-fixture"

            async def user(self, tenant, agent, user_id, scopes):
                assert tenant == os.environ["CLAIMS_TENANT_ID"]
                assert agent == os.environ["CLAIMS_AGENT_ID"]
                assert user_id == os.environ["CLAIMS_AGENT_USER_ID"]
                assert scopes == ["ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default"]
                return "secret-user-fixture"

            requests.Session.send = no_network
            MsalAuth.get_agentic_application_token = blueprint
            if MODE != "stall":
                MsalAuth.get_agentic_instance_token = instance
                MsalAuth.get_agentic_user_token = user
            if MODE.startswith("tooling"):
                import json, httpx2
                from types import SimpleNamespace
                from microsoft_agents_a365.tooling import McpToolServerConfigurationService

                async def discovery(self, agent_id, auth_token, **kwargs):
                    assert agent_id == os.environ["CLAIMS_AGENT_ID"]
                    return [SimpleNamespace(
                        mcp_server_unique_name="mcp_W365ComputerUse",
                        url="https://agent365.svc.cloud.microsoft/offline-fixture",
                        audience="da81128c-e5b5-4f9e-8d89-50d906f107c5",
                        scope="Tools.ListInvoke.All",
                    )]

                async def endpoint(request):
                    if MODE == "tooling-error":
                        return httpx2.Response(
                            403, text="access_token=secret-server-error-fixture"
                        )
                    if request.method == "DELETE":
                        return httpx2.Response(200)
                    if request.method == "GET":
                        return httpx2.Response(405)
                    message = json.loads(await request.aread())
                    method = message["method"]
                    if method.startswith("notifications/"):
                        return httpx2.Response(202)
                    if method == "initialize":
                        result = {
                            "protocolVersion": message["params"]["protocolVersion"],
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "offline-fixture", "version": "1"},
                        }
                    elif method == "tools/list":
                        assert not message.get("params", {}).get("_meta")
                        result = {"tools": [
                            {"name": name, "inputSchema": {"type": "object"}}
                            for name in (
                                "mcp_W365ComputerUse_StartSession",
                                "mcp_W365ComputerUse_GetSessionDetails",
                                "mcp_W365ComputerUse_EndSession",
                            )
                        ]}
                    else:
                        raise AssertionError("A metadata-only probe must never invoke a tool.")
                    return httpx2.Response(
                        200, json={"jsonrpc": "2.0", "id": message["id"], "result": result},
                        headers={"Mcp-Session-Id": "offline-transport"},
                    )

                async def tooling_token(self, tenant, agent, user_id, scopes):
                    assert scopes in (
                        ["ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default"],
                        ["da81128c-e5b5-4f9e-8d89-50d906f107c5/Tools.ListInvoke.All"],
                    )
                    return "secret-tooling-fixture"

                client = httpx2.AsyncClient
                httpx2.AsyncClient = lambda **kwargs: client(
                    transport=httpx2.MockTransport(endpoint), **kwargs
                )
                MsalAuth.get_agentic_user_token = tooling_token
                McpToolServerConfigurationService.list_tool_servers = discovery
            worker_action = "--discover-tools" if MODE.startswith("tooling") else "--exchange"
            sys.argv = ["identity_probe", worker_action, sys.argv[-1]]
            main()
        """)

        async def launch(*args, **kwargs):
            process = await original(sys.executable, "-c", script, args[-1], **kwargs)
            launched.append(process)
            return process

        monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
        return launched

    return configure


@pytest.mark.asyncio
async def test_tooling_probe_lists_real_transport_metadata_once_without_tool_execution(
    tmp_path, monkeypatch, offline_worker
):
    launched = offline_worker("tooling")
    monkeypatch.delenv("CLAIMS_IDENTITY_PROBE_REQUEST_ID")
    monkeypatch.setenv("CLAIMS_TOOLING_PROBE_REQUEST_ID", "REQ-TOOLS-1")
    monkeypatch.setenv("PYTHON_ENVIRONMENT", "Production")
    monkeypatch.delenv("MCP_PLATFORM_ENDPOINT", raising=False)
    monkeypatch.delenv("MCP_PLATFORM_AUTHENTICATION_SCOPE", raising=False)
    app = create_probe_app(IDENTITY, "REQ-TOOLS-1", tmp_path / "tools.json", tooling=True)
    body = {"action": "tooling_probe", "request_id": "REQ-TOOLS-1"}
    url = "/invocations?agent_session_id=REQ-TOOLS-1"
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        result = await client.post(url, json=body)
        assert result.status_code == 200, result.text
        assert result.json()["status"] == "tools_discovered"
        assert result.json()["tools"] == [
            "mcp_W365ComputerUse_EndSession",
            "mcp_W365ComputerUse_GetSessionDetails",
            "mcp_W365ComputerUse_StartSession",
        ]
        assert result.json()["computer_tool_called"] is False
        assert result.json()["model_called"] is False
        assert "secret-" not in result.text
        replay = await client.post(url, json=body)
        assert replay.json() == result.json()
        for action in ("start", "identity_probe", "view", "recover"):
            denied = await client.post(url, json={**body, "action": action})
            assert denied.status_code == 403
        denied = await client.post(url, json={**body, "operation": "smoke"})
        assert denied.status_code == 403
    assert len(launched) == 1
    assert launched[0].returncode == 0


@pytest.mark.asyncio
async def test_tooling_failure_is_sanitized_and_not_retried_after_restart(
    tmp_path, monkeypatch, offline_worker
):
    launched = offline_worker("tooling-error")
    monkeypatch.delenv("CLAIMS_IDENTITY_PROBE_REQUEST_ID")
    monkeypatch.setenv("CLAIMS_TOOLING_PROBE_REQUEST_ID", "REQ-TOOLS-1")
    monkeypatch.setenv("PYTHON_ENVIRONMENT", "Production")
    monkeypatch.delenv("MCP_PLATFORM_ENDPOINT", raising=False)
    monkeypatch.delenv("MCP_PLATFORM_AUTHENTICATION_SCOPE", raising=False)
    receipt = tmp_path / "tools.json"
    body = {"action": "tooling_probe", "request_id": "REQ-TOOLS-1"}
    url = "/invocations?agent_session_id=REQ-TOOLS-1"
    results = []
    for _ in range(2):
        app = create_probe_app(IDENTITY, "REQ-TOOLS-1", receipt, tooling=True)
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
        ) as client:
            response = await client.post(url, json=body)
            assert response.status_code == 502
            results.append(response.json())
            assert "secret-" not in response.text
            mismatch = await client.post("/invocations?agent_session_id=REQ-OTHER", json=body)
            assert mismatch.status_code == 403
    assert results[0] == results[1]
    assert results[0]["status"] == "failed"
    assert results[0]["completed_stages"] == []
    assert results[0]["http_statuses"] == [403]
    assert results[0]["computer_tool_called"] is False
    assert len(launched) == 1


@pytest.mark.parametrize(
    "identity_request,tooling_request",
    [("", ""), ("REQ-AUTH-1", "REQ-TOOLS-1"), ("REQ-TOOLS-1", ""), ("", "REQ-AUTH-1")],
)
def test_probe_rejects_ambiguous_or_wrong_kind_configuration(
    monkeypatch, identity_request, tooling_request
):
    monkeypatch.setenv("LIVE_EXECUTION_APPROVED", "no")
    monkeypatch.setenv("CLAIMS_EXECUTION_APPROVED", "no")
    monkeypatch.setenv("CLAIMS_IDENTITY_PROBE_REQUEST_ID", identity_request)
    monkeypatch.setenv("CLAIMS_TOOLING_PROBE_REQUEST_ID", tooling_request)
    monkeypatch.setattr(logging.getLogger(), "handlers", [])
    monkeypatch.setattr(logging.getLogger(), "level", logging.INFO)
    with pytest.raises(ValueError):
        main()


@pytest.mark.asyncio
async def test_identity_only_server_exchanges_once_and_never_returns_tokens(tmp_path, offline_worker):
    launched = offline_worker("success")
    receipt = tmp_path / "probe.json"
    app = create_probe_app(IDENTITY, "REQ-AUTH-1", receipt)
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        response = await client.post(URL, json=BODY)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "token_issued"
        assert response.json()["completed_stages"] == [
            "blueprint_exchange", "agent_exchange", "agent_user"
        ]
        assert response.json()["resource"] == DISCOVERY_SCOPE
        assert response.json()["downstream_api_called"] is False
        assert "secret-" not in response.text + receipt.read_text()
        replay = await client.post(URL, json=BODY)
        assert replay.json() == response.json()
        for action in ("start", "view", "recover", "cancel"):
            denied = await client.post(URL, json={**BODY, "action": action})
            assert denied.status_code == 403
        for extra in ({"scopes": ["Mail.Read"]}, {"agent_user_id": "caller"}, {"operation": "claims"}):
            denied = await client.post(URL, json={**BODY, **extra})
            assert denied.status_code == 403
        mismatch = await client.post("/invocations?agent_session_id=REQ-OTHER", json=BODY)
        assert mismatch.status_code == 403
    restarted = create_probe_app(IDENTITY, "REQ-AUTH-1", receipt)
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=restarted), base_url="http://localhost"
    ) as client:
        replay = await client.post(URL, json=BODY)
        assert replay.json() == response.json()
    assert len(launched) == 1
    assert launched[0].returncode == 0


def test_probe_startup_does_not_expose_sdk_error_payloads(
    tmp_path, monkeypatch, capfd, offline_worker
):
    offline_worker("error")
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    monkeypatch.setattr(logging.getLogger(), "handlers", [])
    monkeypatch.setattr(logging.getLogger(), "level", logging.INFO)
    responses = []

    async def request(app):
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
        ) as client:
            responses.append(await client.post(URL, json=BODY))

    monkeypatch.setattr(
        InvocationAgentServerHost, "run", lambda app, **kwargs: asyncio.run(request(app))
    )
    main()
    assert responses[0].status_code == 502
    assert responses[0].json()["failed_stage"] == "blueprint_exchange"
    assert responses[0].json()["error_codes"] == ["AADSTS65001"]
    output = capfd.readouterr()
    assert "secret-" not in output.out + output.err + responses[0].text


@pytest.mark.parametrize("live,claims", [("yes", "no"), ("no", "yes"), ("no", ""), ("", "no")])
def test_probe_refuses_startup_unless_both_execution_gates_are_off(monkeypatch, live, claims):
    monkeypatch.setenv("LIVE_EXECUTION_APPROVED", live)
    monkeypatch.setenv("CLAIMS_EXECUTION_APPROVED", claims)
    monkeypatch.setattr(logging.getLogger(), "handlers", [])
    monkeypatch.setattr(logging.getLogger(), "level", logging.INFO)
    with pytest.raises(RuntimeError, match="both execution gates explicitly off"):
        main()


@pytest.mark.asyncio
async def test_real_sdk_metadata_stall_is_killed_without_blocking_host(
    tmp_path, monkeypatch, offline_worker
):
    launched = offline_worker("stall")
    monkeypatch.setattr("hosted_claims.identity_probe.PROBE_TIMEOUT_SECONDS", 8)
    receipt = tmp_path / "probe.json"
    app = create_probe_app(IDENTITY, "REQ-AUTH-1", receipt)
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        began = time.monotonic()
        attempt = asyncio.create_task(client.post(URL, json=BODY))
        for _ in range(60):
            await asyncio.sleep(0.1)
            if receipt.exists() and json.loads(receipt.read_text()).get("active_stage") == "agent_exchange":
                break
        else:
            await attempt
            pytest.fail("The real SDK did not reach the intercepted metadata request.")
        ready_began = time.monotonic()
        ready = await client.get("/readiness")
        assert ready.status_code == 200
        assert time.monotonic() - ready_began < 0.5
        result = await attempt
        assert time.monotonic() - began < 10
        assert result.status_code == 502
        assert result.json()["completed_stages"] == ["blueprint_exchange"]
        assert result.json()["failed_stage"] == "agent_exchange"
        assert result.json()["error_type"] == "TimeoutError"
        replay = await client.post(URL, json=BODY)
        assert replay.json() == result.json()
    assert len(launched) == 1
    assert launched[0].returncode is not None
