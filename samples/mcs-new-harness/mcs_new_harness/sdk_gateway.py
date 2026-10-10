"""Opt-in wire adapter. No credentials, identities, scopes or pools are provisioned here."""

from contextlib import asynccontextmanager
from uuid import UUID

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from microsoft_agents.authentication.msal import MsalConnectionManager


class SdkAgentUserTokens:
    """Use the installed Microsoft Agents SDK agent-user flow, never hand-written OAuth."""

    def __init__(self, provider, tenant_id, agent_id, agent_user_id, computer_scope, viewer_scope):
        for identifier in (tenant_id, agent_id, agent_user_id):
            UUID(identifier)
        if not computer_scope or not viewer_scope.endswith("/Computer.See"):
            raise ValueError("Verified computer-use scope and view-only ARI scope are required")
        self.provider = provider
        self.tenant_id = tenant_id
        self.agent_id = agent_id
        self.agent_user_id = agent_user_id
        self.scopes = {"computer": computer_scope, "viewer": viewer_scope}

    @classmethod
    def from_connection_manager(
        cls, manager: MsalConnectionManager,
        tenant_id, agent_id, agent_user_id, computer_scope, viewer_scope,
    ):
        # The host supplies an approved workload-identity/FIC SDK configuration.
        # No synthetic human sign-in, copied Foundry identity, or MCS blueprint credential.
        return cls(
            manager.get_default_connection(), tenant_id, agent_id, agent_user_id,
            computer_scope, viewer_scope,
        )

    async def token(self, resource):
        if resource not in self.scopes:
            raise PermissionError("Resource is outside the configured view/computer scope")
        token = await self.provider.get_agentic_user_token(
            self.tenant_id, self.agent_id, self.agent_user_id, [self.scopes[resource]]
        )
        if not isinstance(token, str) or not token:
            raise PermissionError("SDK returned no agent-user token")
        return token


class AgentUserBearer(httpx2.Auth):
    def __init__(self, tokens, endpoint):
        self.tokens = tokens
        self.endpoint = endpoint

    async def async_auth_flow(self, request):
        if str(request.url) != self.endpoint:
            raise PermissionError("Refusing to disclose agent credentials to another target")
        token = await self.tokens.token("computer")
        request.headers["Authorization"] = "Bearer " + token
        yield request
        # Never replay a lifecycle/action request automatically after 401 or uncertainty.


def gateway_factory(tokens, endpoint, *, live_execution_enabled=False):
    expected = (
        "https://agent365.svc.cloud.microsoft/agents/tenants/"
        f"{tokens.tenant_id}/servers/mcp_W365ComputerUse"
    )
    if endpoint != expected:
        raise ValueError("Use the exact tenant-specific W365 endpoint from verified discovery")

    @asynccontextmanager
    async def connect():
        if not live_execution_enabled:
            raise PermissionError("Live execution is disabled in this local feasibility candidate")
        async with (
            httpx2.AsyncClient(
                auth=AgentUserBearer(tokens, endpoint),
                timeout=httpx2.Timeout(70),
                follow_redirects=False,
            ) as http,
            streamable_http_client(endpoint, http_client=http) as streams,
            ClientSession(*streams, read_timeout_seconds=65) as client,
        ):
            await client.initialize()
            yield client

    return connect
