import asyncio
import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from microsoft_agents_a365.tooling import McpToolServerConfigurationService
from microsoft_agents_a365.tooling.utils.utility import resolve_token_scope_for_server

from .engine import START_TIMEOUT_SECONDS
from .identity import COMPUTER_AUDIENCE, DISCOVERY_SCOPE, VIEW_SCOPE, AgentIdentity
from .tools import ComputerTools

SERVER_NAME = "mcp_W365ComputerUse"
GATEWAY_HOST = "agent365.svc.cloud.microsoft"
logger = logging.getLogger(__name__)
# The checked discovery result, kept for this process (one hosted session) so a prepared
# session does not repeat it at start. Only a server that passed every check is kept.
_servers: dict[tuple[str, str], Any] = {}
_discovery_locks: dict[int, asyncio.Lock] = {}


def clear_discovery_cache() -> None:
    _servers.clear()
    _discovery_locks.clear()


def _require_live(identity: AgentIdentity | None, approved: bool) -> AgentIdentity:
    if not approved:
        raise PermissionError("Explicit cloud approval is required before any live connection.")
    if identity is None:
        raise ValueError("A configured Agent 365 agent-user identity is required.")
    if os.environ.get("PYTHON_ENVIRONMENT") != "Production":
        raise ValueError(
            "Live discovery requires PYTHON_ENVIRONMENT=Production, not a mock manifest."
        )
    if os.environ.get("MCP_PLATFORM_ENDPOINT") or os.environ.get(
        "MCP_PLATFORM_AUTHENTICATION_SCOPE"
    ):
        raise ValueError("Live execution does not accept tooling gateway or audience overrides.")
    return identity


async def _discover(identity: AgentIdentity, auth: Any, context: Any) -> tuple[Any, str]:
    key = (identity.tenant_id, identity.agent_id)
    async with _discovery_locks.setdefault(id(asyncio.get_running_loop()), asyncio.Lock()):
        server = _servers.get(key)
        if server is None:
            server = await _discover_once(identity, auth, context)
            _servers[key] = server
    return server, resolve_token_scope_for_server(server)


async def _discover_once(identity: AgentIdentity, auth: Any, context: Any) -> Any:
    discovery = await auth.exchange_token(context, [DISCOVERY_SCOPE], "agent")
    servers = await McpToolServerConfigurationService().list_tool_servers(
        identity.agent_id,
        discovery.token,
        authorization=auth,
        auth_handler_name="agent",
        turn_context=context,
    )
    matches = [s for s in servers if s.mcp_server_unique_name == SERVER_NAME]
    if len(matches) != 1:
        raise ValueError("Discovery must return exactly one mcp_W365ComputerUse server.")
    server = matches[0]
    url = urlsplit(server.url or "")
    if (
        url.scheme != "https"
        or url.hostname != GATEWAY_HOST
        or url.port not in (None, 443)
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        raise ValueError("Discovered Computer-Use endpoint is not the approved Microsoft gateway.")
    if server.audience not in (COMPUTER_AUDIENCE, f"api://{COMPUTER_AUDIENCE}"):
        raise ValueError("Discovered Computer-Use audience differs from the approved resource.")
    return server


async def prepare(identity: AgentIdentity | None, request_id: str, *, approved: bool) -> None:
    """Sign in and discover the Computer-Use server ahead of a start, without acquiring a
    Cloud PC or opening a Computer-Use session. Tokens and discovery stay in this process."""
    identity = _require_live(identity, approved)
    auth, context = identity.context(request_id)
    _, scope = await _discover(identity, auth, context)
    await auth.exchange_token(context, [scope], "agent")
    await auth.exchange_token(context, [VIEW_SCOPE], "agent")


@asynccontextmanager
async def connect(
    identity: AgentIdentity | None,
    request_id: str,
    *,
    approved: bool,
) -> AsyncGenerator[ComputerTools, None]:
    identity = _require_live(identity, approved)
    auth, context = identity.context(request_id)
    server, scope = await _discover(identity, auth, context)

    class AgentUserBearer(httpx2.Auth):
        async def async_auth_flow(
            self,
            request: httpx2.Request,
        ) -> AsyncGenerator[httpx2.Request, httpx2.Response]:
            token = await auth.exchange_token(context, [scope], "agent")
            request.headers["Authorization"] = f"Bearer {token.token}"
            yield request

    async def observe_response(response: httpx2.Response) -> None:
        logger.info("Computer-Use HTTP response status: %d", response.status_code)

    async with (
        httpx2.AsyncClient(
            auth=AgentUserBearer(), timeout=httpx2.Timeout(40, read=START_TIMEOUT_SECONDS + 10),
            follow_redirects=False,
            event_hooks={"response": [observe_response]},
        ) as http,
        streamable_http_client(server.url or "", http_client=http) as streams,
        ClientSession(*streams, read_timeout_seconds=35) as session,
    ):
        await session.initialize()
        yield await ComputerTools.discover(session)
