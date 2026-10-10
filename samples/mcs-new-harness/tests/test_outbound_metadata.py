"""Local HTTP/SDK fixtures; no Entra token or Cloud PC operation is requested."""

import json

import httpx2
import pytest

from mcs_new_harness.sdk_gateway import SdkAgentUserTokens
from test_sdk_gateway import AGENT, TENANT, USER, COMPUTER_SCOPE, VIEW_SCOPE, FixtureSdkProvider

ENDPOINT = "https://fixture.invalid/mcp"


@pytest.mark.asyncio
async def test_probe_uses_real_mcp_metadata_only_and_keeps_token_out_of_results():
    from mcs_new_harness.outbound_metadata import probe

    provider = FixtureSdkProvider()
    tokens = SdkAgentUserTokens(
        provider, TENANT, AGENT, USER,
        COMPUTER_SCOPE, VIEW_SCOPE,
    )
    methods = []

    async def remote(request):
        assert str(request.url) == ENDPOINT
        assert request.headers["Authorization"] == "Bearer fixture-access-token-not-a-real-token"
        assert b"fixture-access-token" not in request.content
        body = json.loads(request.content)
        method = body["method"]
        methods.append(method)
        assert method in {"initialize", "notifications/initialized", "tools/list"}
        if method == "notifications/initialized":
            return httpx2.Response(202)
        result = (
            {
                "protocolVersion": "2025-03-26",
                "serverInfo": {"name": "local-w365-metadata-fixture", "version": "1"},
                "capabilities": {"tools": {}},
            } if method == "initialize" else {
                "tools": [{"name": "StartSession", "inputSchema": {"type": "object"}}],
            }
        )
        return httpx2.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result})

    result = await probe(tokens, endpoint=ENDPOINT, http_transport=httpx2.MockTransport(remote))
    assert methods == ["initialize", "notifications/initialized", "tools/list"]
    assert result["tools"] == ["StartSession"]
    assert result["executed_tools"] == []
    assert "fixture-access-token" not in json.dumps(result)
    assert all(call[3] == [COMPUTER_SCOPE] for call in provider.calls)


def test_disabled_configuration_stops_before_any_sdk_connection():
    from mcs_new_harness.outbound_metadata import configured_tokens

    with pytest.raises(PermissionError, match="metadata_verification_disabled"):
        configured_tokens({"metadata_verification_enabled": False})


@pytest.mark.asyncio
async def test_parameterized_endpoint_rejects_plaintext_before_requesting_an_sdk_token():
    from mcs_new_harness.outbound_metadata import probe

    provider = FixtureSdkProvider()
    tokens = SdkAgentUserTokens(provider, TENANT, AGENT, USER, COMPUTER_SCOPE, VIEW_SCOPE)

    async def remote(request):
        pytest.fail("Invalid endpoint must not reach HTTP")

    with pytest.raises(ValueError, match="HTTPS"):
        await probe(tokens, endpoint="http://fixture.invalid/mcp", http_transport=httpx2.MockTransport(remote))
    assert not provider.calls
