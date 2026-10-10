import asyncio
import base64
import json
import time
from dataclasses import dataclass

from microsoft_agents.activity import (
    Activity,
    ChannelAccount,
    ChannelId,
    ConversationReference,
    ResourceResponse,
    RoleTypes,
    TokenResponse,
)
from microsoft_agents.authentication.msal import MsalConnectionManager
from microsoft_agents.hosting.core import (
    AgentAuthConfiguration,
    Authorization,
    AuthTypes,
    ChannelAdapter,
    ClaimsIdentity,
    MemoryStorage,
    TurnContext,
)

DISCOVERY_SCOPE = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default"
VIEW_SCOPE = "90ecec28-f5a6-42b3-9bde-dae1ca98f8b5/Computer.See"
COMPUTER_AUDIENCE = "da81128c-e5b5-4f9e-8d89-50d906f107c5"
APPROVED_SCOPES = {
    DISCOVERY_SCOPE,
    VIEW_SCOPE,
    *(
        f"{prefix}{COMPUTER_AUDIENCE}/{scope}"
        for prefix in ("", "api://")
        for scope in (".default", "Tools.ListInvoke.All")
    ),
}


# Run J: every Computer-Use HTTP request asked the SDK for a new agent-user token, and the SDK
# builds two new MSAL clients (with their own Entra discovery) for each one. A token is reused
# within this process until shortly before its own expiry; nothing is written to disk.
TOKEN_REUSE_MARGIN_SECONDS = 300
_tokens: dict[tuple[str, str, str, str], tuple[str, float]] = {}
_token_locks: dict[tuple[int, str, str, str, str], asyncio.Lock] = {}


def token_expiry(token: str) -> float | None:
    """The token's own ``exp`` claim (seconds since epoch), or None when it has none.

    Read only to decide reuse of a token this process just received from Entra; it is never
    treated as validation.
    """
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError):
        return None
    exp = claims.get("exp") if isinstance(claims, dict) else None
    return float(exp) if isinstance(exp, (int, float)) and not isinstance(exp, bool) else None


def clear_token_cache() -> None:
    _tokens.clear()
    _token_locks.clear()


class InvocationChannel(ChannelAdapter):
    """The Invocations HTTP response, not a Teams/M365 channel, carries output."""

    async def send_activities(
        self,
        context: object,
        activities: list[Activity],
    ) -> list[ResourceResponse]:
        raise NotImplementedError("Use the hosted invocation event stream for output.")

    async def update_activity(self, context: object, activity: Activity) -> None:
        raise NotImplementedError("This agent does not modify channel activities.")

    async def delete_activity(
        self,
        context: object,
        reference: ConversationReference,
    ) -> None:
        raise NotImplementedError("This agent does not delete channel activities.")


@dataclass(frozen=True)
class AgentIdentity:
    tenant_id: str
    blueprint_id: str
    agent_id: str
    user_id: str
    assertion_file: str = ""
    auth_type: str = "workload_identity"
    proxy_client_id: str = ""

    def context(self, request_id: str) -> tuple["AutonomousAuthorization", TurnContext]:
        if self.auth_type == "identity_proxy_manager":
            if not self.proxy_client_id:
                raise ValueError(
                    "The runtime-provided or operator-verified blueprint client ID is required for the identity proxy."
                )
            auth_type = AuthTypes.identity_proxy_manager
            client_id = self.proxy_client_id
        elif self.auth_type == "workload_identity" and self.assertion_file:
            auth_type = AuthTypes.workload_identity
            client_id = self.blueprint_id
        else:
            raise ValueError(
                "Configure an approved SDK identity-proxy client or a platform-supplied federated token file."
            )
        connection = AgentAuthConfiguration(
            auth_type=auth_type,
            tenant_id=self.tenant_id,
            client_id=client_id,
            federated_token_file=self.assertion_file,
        )
        manager = MsalConnectionManager({"SERVICE_CONNECTION": connection})
        authorization = AutonomousAuthorization(self, manager)
        # Runtime identity is deployment configuration, never copied from the human handoff.
        # This SDK routing context is not evidence of caller authentication.
        context = TurnContext(
            InvocationChannel(),
            Activity(
                type="message",
                id=request_id,
                channel_id=ChannelId("invocations"),
                from_property=ChannelAccount(id=self.user_id),
                recipient=ChannelAccount(
                    role=RoleTypes.agentic_user,
                    tenant_id=self.tenant_id,
                    agentic_app_id=self.agent_id,
                    agentic_user_id=self.user_id,
                ),
            ),
            identity=ClaimsIdentity(claims={"tid": self.tenant_id}),
        )
        return authorization, context


class AutonomousAuthorization(Authorization):
    """Bridge A365 discovery's channel-shaped callback to the SDK's autonomous flow."""

    def __init__(self, identity: AgentIdentity, manager: MsalConnectionManager) -> None:
        super().__init__(storage=MemoryStorage(), connection_manager=manager)
        self.agent_identity = identity
        self.provider = manager.get_default_connection()

    async def exchange_token(
        self,
        context: TurnContext,
        scopes: list[str] | None = None,
        auth_handler_id: str | None = None,
        exchange_connection: str | None = None,
    ) -> TokenResponse:
        if not scopes:
            raise ValueError("An explicit resource scope is required.")
        if len(scopes) != 1 or scopes[0] not in APPROVED_SCOPES:
            raise PermissionError(
                "Token scope is outside the approved discovery, Computer-Use and view-only resources."
            )
        identity = self.agent_identity
        key = (identity.tenant_id, identity.agent_id, identity.user_id, scopes[0])
        lock_key = (id(asyncio.get_running_loop()), *key)
        async with _token_locks.setdefault(lock_key, asyncio.Lock()):
            cached = _tokens.get(key)
            if cached and cached[1] - TOKEN_REUSE_MARGIN_SECONDS > time.time():
                return TokenResponse(token=cached[0])
            token = await self.provider.get_agentic_user_token(
                identity.tenant_id,
                identity.agent_id,
                identity.user_id,
                scopes,
            )
            if not token:
                raise RuntimeError(
                    "Agent-user token acquisition failed; verify consent and identity setup."
                )
            expiry = token_expiry(token)
            if expiry is not None:
                _tokens[key] = (token, expiry)
            return TokenResponse(token=token)
