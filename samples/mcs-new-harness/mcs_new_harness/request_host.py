"""Local-stageable authenticated host: ordinary OAuth bearer + authorized request records.

No socket listener or cloud resource is started by this module.
"""

import asyncio
import copy
import secrets
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import jwt
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .transport_candidate import RequestOwner, TOOLS, reply


class EntraAccessTokens:
    def __init__(self, tenant, audience, signing_key, *, use_scope, register_scope, mcp_clients, registration_clients):
        self.tenant = tenant
        self.audience = audience
        self.signing_key = signing_key
        self.issuer = f"https://login.microsoftonline.com/{tenant}/v2.0"
        self.use_scope = use_scope
        self.register_scope = register_scope
        self.mcp_clients = set(mcp_clients)
        self.registration_clients = set(registration_clients)

    @classmethod
    def from_tenant_jwks(cls, tenant, audience, **policy):
        keys = jwt.PyJWKClient(
            f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys",
            cache_keys=True, timeout=10,
        )
        return cls(tenant, audience, lambda token: keys.get_signing_key_from_jwt(token).key, **policy)

    def validate(self, header, *, registration=False, control=False):
        if not header:
            raise PermissionError("authorization_header_missing")
        if not header.startswith("Bearer "):
            raise PermissionError("unsupported_authorization_scheme")
        encoded = header[7:]
        try:
            claims = jwt.decode(
                encoded, self.signing_key(encoded), algorithms=["RS256"],
                audience=self.audience, issuer=self.issuer,
                options={"require": ["exp", "iat", "iss", "aud", "tid", "oid", "azp", "scp"]},
            )
        except jwt.MissingRequiredClaimError as error:
            raise PermissionError(f"required_claim_missing:{error.claim}") from None
        except jwt.PyJWKClientError as error:
            raise PermissionError(f"signing_key_resolution_failed:{type(error).__name__}") from None
        except Exception as error:
            reasons = {
                "InvalidAudienceError": "invalid_audience",
                "InvalidIssuerError": "invalid_issuer",
                "InvalidSignatureError": "invalid_signature",
                "ExpiredSignatureError": "expired_token",
                "PyJWKClientConnectionError": "signing_keys_unavailable",
            }
            raise PermissionError(reasons.get(type(error).__name__, f"invalid_token:{type(error).__name__}")) from None
        scope = self.register_scope if registration else self.use_scope
        clients = self.registration_clients if registration else self.mcp_clients
        if control and not registration:
            clients = self.registration_clients | self.mcp_clients
        if claims["tid"] != self.tenant:
            raise PermissionError("tenant_not_allowed")
        if claims["azp"] not in clients:
            raise PermissionError("client_not_allowed")
        if scope not in str(claims["scp"]).split():
            raise PermissionError("required_scope_missing")
        if not isinstance(claims["oid"], str) or not claims["oid"]:
            raise PermissionError("invalid_subject")
        return f"{claims['tid']}:{claims['oid']}"


@dataclass
class RegisteredRequest:
    request_id: str
    principal: str
    interaction_id: str
    expires_at: float
    phase: str = "open"
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def owner(self):
        return RequestOwner(self.principal, self.request_id)


class RequestRegistry:
    def __init__(self, interaction_owner, *, clock=time.time, ttl_seconds=900):
        if not 1 <= ttl_seconds <= 3600:
            raise ValueError("A bounded request lifetime is required")
        self.interaction_owner = interaction_owner
        self.clock = clock
        self.ttl_seconds = ttl_seconds
        self.records = {}
        self.by_interaction = {}

    def register(self, principal, interaction):
        # This lookup reads the trusted CCaaS assignment/handoff store, not request-body claims.
        if not isinstance(interaction, str) or self.interaction_owner(interaction) != principal:
            raise PermissionError("Interaction is not authorized")
        previous = self.by_interaction.get((principal, interaction))
        if previous:
            record = self.records[previous]
            if record.phase != "open" or self.clock() >= record.expires_at:
                raise PermissionError("Previous request requires an explicit new intent")
            return record
        request_id = secrets.token_urlsafe(24)
        record = RegisteredRequest(request_id, principal, interaction, self.clock() + self.ttl_seconds)
        self.records[request_id] = record
        self.by_interaction[(principal, interaction)] = request_id
        return record

    def owned(self, principal, request_id):
        record = self.records.get(request_id) if isinstance(request_id, str) else None
        if record is None or record.principal != principal:
            raise PermissionError("Unknown or unauthorized request")
        return record


def create_app(candidate, registry, tokens, *, public_origin, additional_hosts=(), delay_probe_enabled=False):
    parsed = urlsplit(public_origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Configure the existing host's exact HTTPS origin")

    @asynccontextmanager
    async def checked(principal, request_id):
        record = registry.owned(principal, request_id)
        async with record.lock:
            if record.phase != "open":
                raise PermissionError("Request is closed")
            if registry.clock() >= record.expires_at:
                record.phase = "expired"
                await candidate.close_request(record.owner)
                raise PermissionError("Request expired")
            # Revocation/assignment changes in the authoritative interaction store take effect per call.
            if registry.interaction_owner(record.interaction_id) != principal:
                record.phase = "revoked"
                await candidate.close_request(record.owner)
                raise PermissionError("Interaction authorization revoked")
            yield record

    async def list_tools(context, params):
        tools = [types.Tool(
            name="request_caller_context",
            description="Read the authenticated MCP connection principal for binding diagnostics; does not contact Windows 365.",
            inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
        )]
        if delay_probe_enabled:
            from .no_pc_delay import TOOL
            return types.ListToolsResult(tools=[*tools, TOOL])
        for tool in TOOLS:
            schema = copy.deepcopy(tool.input_schema)
            schema["properties"]["request_id"] = {
                "type": "string", "minLength": 1,
                "description": "Registered request identifier from the handoff; not an authorization credential.",
            }
            schema["required"].append("request_id")
            tools.append(tool.model_copy(update={"input_schema": schema}))
        return types.ListToolsResult(tools=tools)

    async def call_tool(context, params):
        # The official HTTP MCP transport exposes the actual HTTP request; no Copilot custom header is used.
        request = context.request
        principal = request.scope.get("state", {}).get("verified_principal") if request else None
        if not principal:
            return reply({"error": "authenticated_http_context_required"}, True)
        args = dict(params.arguments or {})
        if params.name == "request_caller_context":
            if args:
                return reply({"error": "no_arguments_allowed"}, True)
            return reply({"principal": principal, "binding": "requires_registered_owned_request"})
        if delay_probe_enabled:
            if params.name != "auth_only_delay_probe":
                return reply({"error": "authentication_diagnostic_tools_only"}, True)
            from .no_pc_delay import run
            try:
                return reply(await run(args, principal))
            except (ValueError, TimeoutError):
                return reply({"error": "invalid_or_timed_out_delay_probe"}, True)
        request_id = args.pop("request_id", None)
        try:
            async with checked(principal, request_id) as record:
                return await candidate.invoke(record.owner, params.name, args)
        except PermissionError:
            return reply({"error": "request_not_authorized_or_expired"}, True)

    manager = StreamableHTTPSessionManager(
        Server("new-harness-request-bound-candidate", on_list_tools=list_tools, on_call_tool=call_tool),
        stateless=True, json_response=True,
        security_settings=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[parsed.netloc, *additional_hosts], allowed_origins=[public_origin],
        ),
    )

    async def authenticate(request, registration=False, control=False):
        return await asyncio.to_thread(
            tokens.validate, request.headers.get("authorization"),
            registration=registration, control=control,
        )

    class McpEndpoint:
        async def __call__(self, scope, receive, send):
            request = Request(scope, receive)
            try:
                principal = await authenticate(request)
            except PermissionError as error:
                return await JSONResponse(
                    {
                        "error": "unauthorized", "reason": error.args[0],
                    }, status_code=401,
                    headers={"WWW-Authenticate": "Bearer"},
                )(scope, receive, send)
            scope.setdefault("state", {})["verified_principal"] = principal
            await manager.handle_request(scope, receive, send)

    async def registration(request):
        try:
            principal = await authenticate(request, registration=True)
            data = await request.json()
            if set(data) != {"interaction_id"}:
                return JSONResponse({"error": "interaction_id_only"}, status_code=400)
            record = registry.register(principal, data["interaction_id"])
            return JSONResponse({
                "request_id": record.request_id, "interaction_id": record.interaction_id,
                "expires_at": record.expires_at, "target": "new-harness",
            }, status_code=201)
        except PermissionError:
            return JSONResponse({"error": "unauthorized_interaction"}, status_code=403)
        except (ValueError, TypeError):
            return JSONResponse({"error": "invalid_request"}, status_code=400)

    async def request_state(request):
        try:
            principal = await authenticate(request, control=True)
            async with checked(principal, request.path_params["request_id"]) as record:
                if request.method == "DELETE":
                    record.phase = "closed"
                    return JSONResponse(await candidate.close_request(record.owner))
                if request.url.path.endswith("/viewer"):
                    viewer = await candidate.viewer_context(record.owner, request.query_params.get("handle"))
                    return JSONResponse({
                        "request_id": record.request_id,
                        "session_id": viewer.session_id, "session_link": viewer.session_link,
                    })
                return JSONResponse(candidate.request_report(record.owner))
        except (PermissionError, ValueError):
            return JSONResponse({"error": "request_unavailable"}, status_code=403)

    async def expire_requests():
        while True:
            await asyncio.sleep(1)
            for record in list(registry.records.values()):
                if record.phase == "open" and registry.clock() >= record.expires_at:
                    async with record.lock:
                        record.phase = "expired"
                        await candidate.close_request(record.owner)

    @asynccontextmanager
    async def lifespan(app):
        async with manager.run():
            sweeper = asyncio.create_task(expire_requests())
            try:
                yield
            finally:
                sweeper.cancel()
                await asyncio.gather(sweeper, return_exceptions=True)
                for record in registry.records.values():
                    async with record.lock:
                        record.phase = "closed"
                        await candidate.close_request(record.owner)

    return Starlette(
        routes=[
            Route("/requests", registration, methods=["POST"]),
            Route("/requests/{request_id}/viewer", request_state, methods=["GET"]),
            Route("/requests/{request_id}", request_state, methods=["GET", "DELETE"]),
            Route("/mcp", McpEndpoint(), methods=["GET", "POST", "DELETE"]),
        ],
        lifespan=lifespan,
    )
