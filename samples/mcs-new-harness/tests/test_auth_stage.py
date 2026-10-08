"""Local signed-token checks of the exact isolated /api/mcp staging interface."""

import httpx2
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from mcs_new_harness.auth_stage import create_auth_only_app
from test_request_host import A, AUDIENCE, KEY, TENANT, token
from test_transport import payload


@pytest.mark.asyncio
async def test_direct_functions_host_uses_standard_bearer_and_ignores_copied_header():
    app = create_auth_only_app(
        "https://candidate.local", tenant=TENANT, audience=AUDIENCE,
        mcp_client="fixture-mcp-client", use_scope="candidate.use",
        signing_key=lambda encoded: KEY.public_key(), preserve_swa_header=False,
    )
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="https://candidate.local",
        ) as http:
            denied = await http.post("/api/mcp", json={}, headers={"X-Zava-Authorization": "Bearer " + token()})
            assert denied.status_code == 401
            http.headers["Authorization"] = "Bearer " + token()
            http.headers["X-Zava-Authorization"] = "Bearer invalid-copy"
            async with streamable_http_client("https://candidate.local/api/mcp", http_client=http) as streams:
                async with ClientSession(*streams) as client:
                    await client.initialize()
                    result = payload(await client.call_tool("request_caller_context", {}))
                    assert result["principal"] == f"{TENANT}:{A}"
            registration = await http.post("/api/requests", json={})
            assert registration.status_code == 403
            assert registration.headers["x-zava-gateway"] == "disabled"


@pytest.mark.asyncio
async def test_auth_stage_has_real_mcp_and_no_request_or_gateway_path():
    app = create_auth_only_app(
        "https://candidate.local", tenant=TENANT, audience=AUDIENCE,
        mcp_client="fixture-mcp-client", use_scope="candidate.use",
        signing_key=lambda encoded: KEY.public_key(),
    )
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="https://candidate.local",
        ) as http:
            denied = await http.post("/api/mcp", json={})
            assert denied.status_code == 401
            assert denied.json()["reason"] == "authorization_header_missing"
            assert denied.headers["www-authenticate"] == (
                'Bearer resource_metadata="https://candidate.local/api/.well-known/oauth-protected-resource"'
            )
            assert denied.headers["x-zava-gateway"] == "disabled"
            metadata = await http.get("/api/.well-known/oauth-protected-resource")
            assert metadata.status_code == 200
            assert metadata.json()["resource"] == "https://candidate.local/api/mcp"
            assert metadata.json()["authorization_servers"] == [f"https://login.microsoftonline.com/{TENANT}/v2.0"]
            http.headers["X-Zava-Authorization"] = "Bearer " + token()
            wrong_scope = await http.post("/api/mcp", json={}, headers={
                "X-Zava-Authorization": "Bearer " + token(scope="unapproved.scope"),
            })
            assert wrong_scope.status_code == 401
            assert wrong_scope.json()["reason"] == "required_scope_missing"
            denied_registration = await http.post(
                "/api/requests", json={"interaction_id": "no-real-handoff"},
            )
            assert denied_registration.status_code == 403
            async with streamable_http_client(
                "https://candidate.local/api/mcp", http_client=http,
            ) as streams:
                async with ClientSession(*streams) as client:
                    await client.initialize()
                    names = {tool.name for tool in (await client.list_tools()).tools}
                    assert "request_caller_context" in names
                    assert "computer_acquire" in names
                    result = payload(await client.call_tool("request_caller_context", {}))
                    assert result["principal"] == f"{TENANT}:{A}"
                    result = await client.call_tool(
                        "computer_acquire", {"request_id": "model-invented"},
                    )
                    assert result.is_error


@pytest.mark.asyncio
async def test_swa_preserves_signed_caller_not_platform_authorization():
    app = create_auth_only_app(
        "https://candidate.local", tenant=TENANT, audience=AUDIENCE,
        mcp_client="fixture-mcp-client", use_scope="candidate.use",
        signing_key=lambda encoded: KEY.public_key(),
    )
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(
                    transport=httpx2.ASGITransport(app=app), base_url="https://candidate.local",
                    headers={"Authorization": "Bearer fixture-platform-replacement"},
        ) as http:
                    denied = await http.post("/api/mcp", json={})
                    assert denied.status_code == 401
                    assert denied.headers["x-zava-gateway"] == "disabled"

                    http.headers["X-Zava-Authorization"] = "Bearer " + token()
                    async with streamable_http_client(
                        "https://candidate.local/api/mcp", http_client=http,
                    ) as streams:
                        async with ClientSession(*streams) as client:
                            await client.initialize()
                            assert "request_caller_context" in {
                                tool.name for tool in (await client.list_tools()).tools
                            }
                            result = payload(await client.call_tool("request_caller_context", {}))
                            assert result["principal"] == f"{TENANT}:{A}"


@pytest.mark.asyncio
@pytest.mark.parametrize("forwarded", [
    None,
    "Bearer invalid-fixture-token",
    "Bearer " + token(scope="unapproved.scope"),
], ids=["missing", "invalid", "wrong-scope"])
async def test_swa_never_falls_back_to_platform_or_unverified_identity(forwarded):
    app = create_auth_only_app(
        "https://candidate.local", tenant=TENANT, audience=AUDIENCE,
        mcp_client="fixture-mcp-client", use_scope="candidate.use",
        signing_key=lambda encoded: KEY.public_key(),
    )
    headers = {"Authorization": "Bearer " + token()}
    if forwarded is not None:
        headers["X-Zava-Authorization"] = forwarded
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(
                    transport=httpx2.ASGITransport(app=app), base_url="https://candidate.local",
        ) as http:
                    result = await http.post("/api/mcp", headers=headers, json={})
                    assert result.status_code == 401
                    assert result.headers["x-zava-request-registration"] == "disabled"


@pytest.mark.asyncio
async def test_swa_rejects_ambiguous_forwarded_bearers():
    app = create_auth_only_app(
        "https://candidate.local", tenant=TENANT, audience=AUDIENCE,
        mcp_client="fixture-mcp-client", use_scope="candidate.use",
        signing_key=lambda encoded: KEY.public_key(),
    )
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(
                    transport=httpx2.ASGITransport(app=app), base_url="https://candidate.local",
        ) as http:
                    result = await http.post("/api/mcp", json={}, headers=[
                        ("X-Zava-Authorization", "Bearer " + token()),
                        ("X-Zava-Authorization", "Bearer different-fixture"),
                    ])
                    assert result.status_code == 401


@pytest.mark.asyncio
async def test_swa_accepts_only_its_platform_configured_backend_host(monkeypatch):
    backend_host = "fixture-managed-function.azurewebsites.net"
    monkeypatch.setenv("WEBSITE_HOSTNAME", backend_host)
    app = create_auth_only_app(
        "https://candidate.local", tenant=TENANT, audience=AUDIENCE,
        mcp_client="fixture-mcp-client", use_scope="candidate.use",
        signing_key=lambda encoded: KEY.public_key(),
    )
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(
                    transport=httpx2.ASGITransport(app=app),
                    headers={"X-Zava-Authorization": "Bearer " + token()},
        ) as http:
                    async with streamable_http_client(
                        f"https://{backend_host}/api/mcp", http_client=http,
                    ) as streams:
                        async with ClientSession(*streams) as client:
                            await client.initialize()
                            result = payload(await client.call_tool("request_caller_context", {}))
                            assert result["principal"] == f"{TENANT}:{A}"
                    denied = await http.post(
                        "https://attacker.invalid/api/mcp", json={},
                        headers={"Accept": "application/json, text/event-stream"},
                    )
                    assert denied.status_code == 421
