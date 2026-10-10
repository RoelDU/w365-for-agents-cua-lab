"""Authentication-only composition with explicit SWA or direct-Functions bearer handling."""

from contextlib import asynccontextmanager
import os

from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from .request_host import EntraAccessTokens, RequestRegistry, create_app
from .transport_candidate import TransportCandidate


class SwaCallerBearer:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = scope.get("headers", [])
            forwarded = [
                value for name, value in headers
                if name.lower() == b"x-zava-authorization"
            ]
            # SWA replaces Authorization. The copied caller bearer still needs full Entra validation.
            headers = [
                (name, value) for name, value in headers
                if name.lower() not in {b"authorization", b"x-zava-authorization"}
            ]
            if len(forwarded) == 1:
                headers.append((b"authorization", forwarded[0]))
            scope = {**scope, "headers": headers}
        await self.app(scope, receive, send)


class GateHeaders:
    def __init__(self, app, metadata_url):
        self.app = app
        self.metadata_url = metadata_url

    async def __call__(self, scope, receive, send):
        async def stage_send(message):
            if message["type"] == "http.response.start":
                message = dict(message)
                message["headers"] = list(message.get("headers", [])) + [
                    (b"x-zava-gateway", b"disabled"),
                    (b"x-zava-request-registration", b"disabled"),
                    (b"x-zava-stage", b"nh-auth-only-v1"),
                ]
                if message["status"] == 401:
                    message["headers"] = [
                        (key, value) for key, value in message["headers"]
                        if key.lower() != b"www-authenticate"
                    ]
                    message["headers"].append((
                        b"www-authenticate",
                        f'Bearer resource_metadata="{self.metadata_url}"'.encode("ascii"),
                    ))
            await send(message)

        await self.app(scope, receive, stage_send)


def disabled_gateway(*args, **kwargs):
    raise PermissionError("W365 gateway is unavailable in the authentication-only package")


def create_auth_only_app(
    public_origin, *, tenant, audience, mcp_client, use_scope, signing_key=None,
    preserve_swa_header=True,
    delay_probe_enabled=False,
):
    policy = {
        "use_scope": use_scope,
        "register_scope": "__registration_disabled__",
        "mcp_clients": {mcp_client},
        "registration_clients": set(),
    }
    tokens = (
        EntraAccessTokens(tenant, audience, signing_key, **policy)
        if signing_key is not None
        else EntraAccessTokens.from_tenant_jwks(tenant, audience, **policy)
    )
    candidate = TransportCandidate(disabled_gateway)
    backend_host = os.environ.get("WEBSITE_HOSTNAME")
    inner = create_app(
        candidate, RequestRegistry(lambda interaction: None), tokens,
        public_origin=public_origin,
        additional_hosts=(backend_host,) if backend_host else (),
        delay_probe_enabled=delay_probe_enabled,
    )

    @asynccontextmanager
    async def lifespan(app):
        async with inner.router.lifespan_context(inner):
            yield

    metadata_path = "/api/.well-known/oauth-protected-resource"

    async def protected_resource_metadata(request):
        return JSONResponse({
            "resource": f"{public_origin}/api/mcp",
            "authorization_servers": [f"https://login.microsoftonline.com/{tenant}/v2.0"],
            "scopes_supported": [f"api://{audience}/{use_scope}"],
            "bearer_methods_supported": ["header"],
        })

    app = Starlette(routes=[
        Route(metadata_path, protected_resource_metadata, methods=["GET"]),
        Mount("/api", app=inner),
    ], lifespan=lifespan)
    app.add_middleware(GateHeaders, metadata_url=f"{public_origin}{metadata_path}")
    if preserve_swa_header:
        app.add_middleware(SwaCallerBearer)
    return app
