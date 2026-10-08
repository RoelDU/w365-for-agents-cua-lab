"""External SDK/HTTP fixtures only; no token is requested from Microsoft."""

import httpx2
import pytest

from mcs_new_harness.sdk_gateway import AgentUserBearer, SdkAgentUserTokens, gateway_factory

TENANT = "11111111-1111-1111-1111-111111111111"
AGENT = "22222222-2222-2222-2222-222222222222"
USER = "33333333-3333-3333-3333-333333333333"
ENDPOINT = f"https://agent365.svc.cloud.microsoft/agents/tenants/{TENANT}/servers/mcp_W365ComputerUse"
COMPUTER_SCOPE = "api://fixture-computer-resource/Tools.ListInvoke.All"
VIEW_SCOPE = "api://fixture-ari-resource/Computer.See"


class FixtureSdkProvider:
    def __init__(self):
        self.calls = []

    async def get_agentic_user_token(self, tenant, agent, user, scopes):
        self.calls.append((tenant, agent, user, scopes))
        return "fixture-access-token-not-a-real-token"


@pytest.mark.asyncio
async def test_agent_user_token_uses_sdk_and_only_enters_exact_gateway_authorization_header():
    provider = FixtureSdkProvider()
    tokens = SdkAgentUserTokens(provider, TENANT, AGENT, USER, COMPUTER_SCOPE, VIEW_SCOPE)
    requests = []

    async def remote(request):
        requests.append(request)
        return httpx2.Response(200, json={"ok": True})

    async with httpx2.AsyncClient(
        auth=AgentUserBearer(tokens, ENDPOINT),
        transport=httpx2.MockTransport(remote),
        follow_redirects=False,
    ) as client:
        response = await client.post(ENDPOINT, json={"method": "tools/list", "params": {}})
        assert response.status_code == 200
        assert requests[0].headers["Authorization"] == "Bearer fixture-access-token-not-a-real-token"
        assert b"fixture-access-token" not in requests[0].content
        with pytest.raises(PermissionError):
            await client.post("https://wrong-host.invalid/mcp", json={})
        with pytest.raises(PermissionError):
            await client.post(ENDPOINT.replace(TENANT, AGENT), json={})
    assert len(requests) == 1
    assert provider.calls == [(TENANT, AGENT, USER, [COMPUTER_SCOPE])]
    await tokens.token("viewer")
    assert provider.calls[-1] == (TENANT, AGENT, USER, [VIEW_SCOPE])
    with pytest.raises(PermissionError):
        await tokens.token("arbitrary-resource")


@pytest.mark.asyncio
async def test_live_gateway_factory_is_disabled_without_explicit_host_enablement():
    tokens = SdkAgentUserTokens(FixtureSdkProvider(), TENANT, AGENT, USER, COMPUTER_SCOPE, VIEW_SCOPE)
    factory = gateway_factory(tokens, ENDPOINT)
    with pytest.raises(PermissionError):
        async with factory():
            pytest.fail("Must not connect in this feasibility task")


def test_gateway_endpoint_must_match_configured_tenant_without_redirect_or_url_overrides():
    tokens = SdkAgentUserTokens(FixtureSdkProvider(), TENANT, AGENT, USER, COMPUTER_SCOPE, VIEW_SCOPE)
    for invalid in [ENDPOINT.replace(TENANT, AGENT), ENDPOINT + "?redirect=1", ENDPOINT.replace("https:", "http:")]:
        with pytest.raises(ValueError):
            gateway_factory(tokens, invalid)
