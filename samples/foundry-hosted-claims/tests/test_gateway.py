import pytest

from hosted_claims.gateway import connect


@pytest.mark.asyncio
async def test_unapproved_connection_stops_before_credentials_or_network_are_used():
    with pytest.raises(PermissionError, match="approval"):
        async with connect(None, "REQ-2024-0042", approved=False):
            raise AssertionError("No connection may be opened")


@pytest.mark.asyncio
@pytest.mark.parametrize("catalog_fails", [False, True])
async def test_discovery_and_real_mcp_transport_complete_acquire_action_release(
    monkeypatch, catalog_fails
):
    import json
    from types import SimpleNamespace

    import httpx2
    from microsoft_agents.authentication.msal import MsalAuth
    from microsoft_agents_a365.tooling import McpToolServerConfigurationService
    from test_contract import handoff

    from hosted_claims import gateway
    from hosted_claims.engine import DETAILS, END, START, run
    from hosted_claims.identity import AgentIdentity

    monkeypatch.setenv("PYTHON_ENVIRONMENT", "Production")
    monkeypatch.delenv("MCP_PLATFORM_ENDPOINT", raising=False)
    monkeypatch.delenv("MCP_PLATFORM_AUTHENTICATION_SCOPE", raising=False)
    invoked = []
    catalog_sessions = []

    async def token(*args):
        return "test-only-not-valid"

    async def discovery(self, agent_id, auth_token, **kwargs):
        assert agent_id == "test-agent"
        assert auth_token == "test-only-not-valid"
        return [
            SimpleNamespace(
                mcp_server_unique_name="mcp_W365ComputerUse",
                url="https://agent365.svc.cloud.microsoft/fixture-only",
                audience="da81128c-e5b5-4f9e-8d89-50d906f107c5",
                scope="Tools.ListInvoke.All",
            )
        ]

    async def mcp_endpoint(request):
        assert request.headers["authorization"] == "Bearer test-only-not-valid"
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
                "serverInfo": {"name": "explicit-offline-fixture", "version": "1"},
            }
        else:
            assert request.headers["mcp-session-id"] == "fixture-transport"
            if method == "tools/list":
                catalog_session = message.get("params", {}).get("_meta", {}).get("sessionId")
                catalog_sessions.append(catalog_session)
                assert catalog_session in (None, "fixture-pc")
                if catalog_session and catalog_fails:
                    return httpx2.Response(
                        200,
                        json={
                            "jsonrpc": "2.0",
                            "id": message["id"],
                            "error": {"code": -32000, "message": "Offline fixture catalog failure"},
                        },
                    )
                cursor = message.get("params", {}).get("cursor")
                catalog = (
                    [
                        (
                            "launch_application",
                            {"path": {"type": "string"}, "args": {"type": "array"}},
                        ),
                        (
                            "get_accessibility_tree",
                            {"maxDepth": {"type": "integer"}, "maxElements": {"type": "integer"}},
                        ),
                        ("get_screen_size", {}),
                    ]
                    if catalog_session
                    else [
                        (START, {}),
                        (END, {"sessionId": {"type": "string"}}),
                        (DETAILS, {"sessionId": {"type": "string"}}),
                    ]
                )
                next_cursor = None
                if catalog_session:
                    assert cursor in (None, "desktop-page-2")
                    catalog = catalog[1:] if cursor else catalog[:1]
                    next_cursor = None if cursor else "desktop-page-2"
                result = {
                    "tools": [
                        {
                            "name": name,
                            "inputSchema": {"type": "object", "properties": properties},
                        }
                        for name, properties in catalog
                    ],
                    "nextCursor": next_cursor,
                }
            else:
                name = message["params"]["name"]
                if name != START:
                    assert message["params"]["arguments"]["sessionId"] == "fixture-pc"
                invoked.append(name)
                payload = {
                    START: {"sessionId": "fixture-pc"},
                    DETAILS: {"status": "Ready"},
                    "get_screen_size": {"width": 1920, "height": 1080},
                    "launch_application": {"pid": 42},
                    "get_accessibility_tree": {"name": "Claims Workstation"},
                    END: "Accepted",
                }[name]
                result = {"content": [{"type": "text", "text": json.dumps(payload)}]}
        return httpx2.Response(
            200,
            json={"jsonrpc": "2.0", "id": message["id"], "result": result},
            headers={"Mcp-Session-Id": "fixture-transport"},
        )

    client = httpx2.AsyncClient
    monkeypatch.setattr(MsalAuth, "get_agentic_user_token", token)
    monkeypatch.setattr(McpToolServerConfigurationService, "list_tool_servers", discovery)
    monkeypatch.setattr(
        gateway.httpx2,
        "AsyncClient",
        lambda **kwargs: client(
            transport=httpx2.MockTransport(mcp_endpoint),
            **kwargs,
        ),
    )
    identity = AgentIdentity("tenant", "blueprint", "test-agent", "user", "unused")
    async with connect(identity, "REQ-2024-0042", approved=True) as computer:
        outcome = await run(
            handoff(), "smoke", computer, lambda e: None, ready_timeout=0.5, poll_interval=0.05
        )
    assert outcome["release_status"] == "accepted"
    assert catalog_sessions[:2] == [None, "fixture-pc"]
    if catalog_fails:
        assert outcome["status"] == "error"
        assert invoked == [START, DETAILS, END]
    else:
        assert outcome["status"] == "smoke_completed"
        assert catalog_sessions.count("fixture-pc") == 2
        assert invoked == [
            START,
            DETAILS,
            "get_screen_size",
            "get_accessibility_tree",
            "launch_application",
            "get_accessibility_tree",
            END,
        ]


@pytest.mark.asyncio
async def test_prepare_signs_in_and_discovers_once_without_opening_a_computer_session(monkeypatch):
    import time
    from types import SimpleNamespace

    from microsoft_agents.authentication.msal import MsalAuth
    from microsoft_agents_a365.tooling import McpToolServerConfigurationService
    from test_identity import fake_jwt

    from hosted_claims import gateway
    from hosted_claims.identity import AgentIdentity

    monkeypatch.setenv("PYTHON_ENVIRONMENT", "Production")
    monkeypatch.delenv("MCP_PLATFORM_ENDPOINT", raising=False)
    monkeypatch.delenv("MCP_PLATFORM_AUTHENTICATION_SCOPE", raising=False)
    scopes, discoveries = [], []

    async def token(self, tenant, agent, user, requested):
        scopes.append(requested[0])
        return fake_jwt(int(time.time()) + 3600)

    async def discovery(self, agent_id, auth_token, **kwargs):
        discoveries.append(agent_id)
        return [
            SimpleNamespace(
                mcp_server_unique_name="mcp_W365ComputerUse",
                url="https://agent365.svc.cloud.microsoft/fixture-only",
                audience="da81128c-e5b5-4f9e-8d89-50d906f107c5",
                scope="Tools.ListInvoke.All",
            )
        ]

    def no_session(*args, **kwargs):
        raise AssertionError("prepare must not open a Computer-Use connection")

    monkeypatch.setattr(MsalAuth, "get_agentic_user_token", token)
    monkeypatch.setattr(McpToolServerConfigurationService, "list_tool_servers", discovery)
    monkeypatch.setattr(gateway, "streamable_http_client", no_session)
    identity = AgentIdentity("tenant", "blueprint", "test-agent", "user", "unused")
    await gateway.prepare(identity, "REQ-2024-0042", approved=True)
    await gateway.prepare(identity, "REQ-2024-0042", approved=True)
    assert discoveries == ["test-agent"]
    assert sorted(set(scopes)) == sorted(scopes), "each token is requested once"
    assert "90ecec28-f5a6-42b3-9bde-dae1ca98f8b5/Computer.See" in scopes
    assert len(scopes) == 3


@pytest.mark.asyncio
async def test_prepare_without_approval_uses_no_credentials():
    from hosted_claims import gateway

    with pytest.raises(PermissionError, match="approval"):
        await gateway.prepare(None, "REQ-2024-0042", approved=False)
