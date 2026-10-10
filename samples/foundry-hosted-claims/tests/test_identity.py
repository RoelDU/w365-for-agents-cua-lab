import pytest
from microsoft_agents.authentication.msal import MsalAuth

from hosted_claims.identity import AgentIdentity


@pytest.mark.parametrize(
    "conflict",
    [
        None,
        "CLAIMS_TENANT_ID",
        "CLAIMS_BLUEPRINT_ID",
        "CLAIMS_AGENT_ID",
        "CLAIMS_PROXY_CLIENT_ID",
    ],
)
def test_native_hosted_identity_maps_runtime_ids_without_an_assertion_file(monkeypatch, conflict):
    from hosted_claims.host import Settings

    monkeypatch.setenv("LIVE_EXECUTION_APPROVED", "yes")
    monkeypatch.setenv("CLAIMS_AUTH_TYPE", "identity_proxy_manager")
    monkeypatch.setenv("FOUNDRY_AGENT_TENANT_ID", "runtime-tenant")
    monkeypatch.setenv("FOUNDRY_AGENT_BLUEPRINT_CLIENT_ID", "runtime-blueprint-client")
    monkeypatch.setenv("FOUNDRY_AGENT_INSTANCE_CLIENT_ID", "runtime-agent-client")
    monkeypatch.setenv("CLAIMS_AGENT_USER_ID", "verified-agent-user-object")
    for name in (
        "CLAIMS_TENANT_ID",
        "CLAIMS_BLUEPRINT_ID",
        "CLAIMS_AGENT_ID",
        "CLAIMS_PROXY_CLIENT_ID",
        "CLAIMS_FEDERATED_TOKEN_FILE",
    ):
        monkeypatch.delenv(name, raising=False)
    if conflict:
        monkeypatch.setenv(conflict, "unrelated-identity")
        with pytest.raises(ValueError, match="conflicts|must match"):
            Settings.from_env()
        return
    identity = Settings.from_env().identity
    assert identity == AgentIdentity(
        tenant_id="runtime-tenant",
        blueprint_id="runtime-blueprint-client",
        agent_id="runtime-agent-client",
        user_id="verified-agent-user-object",
        auth_type="identity_proxy_manager",
        proxy_client_id="runtime-blueprint-client",
    )


@pytest.mark.asyncio
async def test_sdk_exchange_uses_configured_agent_user_not_human_requester(monkeypatch):
    calls = []

    async def token(self, tenant_id, agent_app_instance_id, agentic_user_id, scopes):
        calls.append((tenant_id, agent_app_instance_id, agentic_user_id, scopes))
        return "test-only-token-not-valid"

    monkeypatch.setattr(MsalAuth, "get_agentic_user_token", token)
    identity = AgentIdentity(
        tenant_id="00000000-0000-0000-0000-000000000001",
        blueprint_id="00000000-0000-0000-0000-000000000002",
        agent_id="00000000-0000-0000-0000-000000000003",
        user_id="00000000-0000-0000-0000-000000000004",
        assertion_file="test-only-unread-assertion",
    )
    authorization, context = identity.context("REQ-2024-0042")
    acquired = await authorization.exchange_token(
        context, ["da81128c-e5b5-4f9e-8d89-50d906f107c5/Tools.ListInvoke.All"], "agent"
    )
    assert acquired.token == "test-only-token-not-valid"
    assert calls == [
        (
            "00000000-0000-0000-0000-000000000001",
            "00000000-0000-0000-0000-000000000003",
            "00000000-0000-0000-0000-000000000004",
            ["da81128c-e5b5-4f9e-8d89-50d906f107c5/Tools.ListInvoke.All"],
        )
    ]


@pytest.mark.asyncio
async def test_discovery_cannot_expand_token_access_to_unapproved_audience(monkeypatch):
    async def unexpected(*args, **kwargs):
        pytest.fail("No token request is allowed for an unapproved resource")

    monkeypatch.setattr(MsalAuth, "get_agentic_user_token", unexpected)
    identity = AgentIdentity("tenant", "blueprint", "agent", "user", "unused")
    auth, context = identity.context("REQ-2024-0042")
    with pytest.raises(PermissionError, match="approved"):
        await auth.exchange_token(context, ["https://graph.microsoft.com/.default"], "agent")


@pytest.mark.asyncio
async def test_explicit_sdk_identity_proxy_configuration_does_not_require_a_token_file(monkeypatch):
    async def token(self, tenant, agent, user, scopes):
        return "test-only-token"

    monkeypatch.setattr(MsalAuth, "get_agentic_user_token", token)
    identity = AgentIdentity(
        "tenant",
        "blueprint",
        "agent",
        "user",
        auth_type="identity_proxy_manager",
        proxy_client_id="operator-verified-client",
    )
    auth, context = identity.context("REQ-2024-0042")
    assert (
        await auth.exchange_token(context, ["ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default"])
    ).token == "test-only-token"


def fake_jwt(exp):
    import base64
    import json

    body = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return f"e30.{body}.test-only-signature"


@pytest.mark.asyncio
async def test_agent_user_token_is_reused_until_shortly_before_it_expires(monkeypatch):
    import time

    from hosted_claims import identity as identity_module

    issued = []
    lifetime = {"seconds": 3600}

    async def token(self, tenant, agent, user, scopes):
        issued.append(scopes[0])
        return fake_jwt(int(time.time()) + lifetime["seconds"])

    monkeypatch.setattr(MsalAuth, "get_agentic_user_token", token)
    identity = AgentIdentity("tenant", "blueprint", "agent", "user", "unused")
    scope = "da81128c-e5b5-4f9e-8d89-50d906f107c5/Tools.ListInvoke.All"
    view = "90ecec28-f5a6-42b3-9bde-dae1ca98f8b5/Computer.See"
    auth, context = identity.context("REQ-2024-0042")
    first = await auth.exchange_token(context, [scope], "agent")
    # A later run context in the same process (for example after prepare) reuses it.
    again, again_context = identity.context("REQ-2024-0042")
    assert (await again.exchange_token(again_context, [scope], "agent")).token == first.token
    assert issued == [scope]
    # Another resource is never served from this token.
    await auth.exchange_token(context, [view], "agent")
    assert issued == [scope, view]
    # Inside the reuse margin a fresh token is requested.
    identity_module._tokens[("tenant", "agent", "user", scope)] = (
        first.token,
        time.time() + identity_module.TOKEN_REUSE_MARGIN_SECONDS - 1,
    )
    await auth.exchange_token(context, [scope], "agent")
    assert issued == [scope, view, scope]


@pytest.mark.asyncio
async def test_a_token_without_a_readable_expiry_is_never_reused(monkeypatch):
    issued = []

    async def token(self, tenant, agent, user, scopes):
        issued.append(scopes[0])
        return "not-a-jwt"

    monkeypatch.setattr(MsalAuth, "get_agentic_user_token", token)
    identity = AgentIdentity("tenant", "blueprint", "agent", "user", "unused")
    auth, context = identity.context("REQ-2024-0042")
    scope = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default"
    await auth.exchange_token(context, [scope], "agent")
    await auth.exchange_token(context, [scope], "agent")
    assert issued == [scope, scope]
