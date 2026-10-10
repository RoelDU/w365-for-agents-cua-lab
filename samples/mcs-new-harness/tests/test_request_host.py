"""Real JWT + HTTP/MCP protocol, entirely local ASGI and gateway fixtures."""

import time
from contextlib import asynccontextmanager

import httpx2
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from mcs_new_harness.request_host import EntraAccessTokens, RequestRegistry, create_app
from test_transport import FixtureW365, START, payload
from mcs_new_harness.transport_candidate import TransportCandidate

TENANT = "11111111-1111-1111-1111-111111111111"
A = "22222222-2222-2222-2222-222222222222"
B = "33333333-3333-3333-3333-333333333333"
ISSUER = f"https://login.microsoftonline.com/{TENANT}/v2.0"
AUDIENCE = "fixture-custom-api-audience"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(oid=A, *, audience=AUDIENCE, scope="candidate.use", client="fixture-mcp-client", key=KEY):
    now = int(time.time())
    return jwt.encode({
        "iss": ISSUER, "tid": TENANT, "oid": oid, "aud": audience,
        "azp": client, "scp": scope, "iat": now, "exp": now + 600,
    }, key, algorithm="RS256")


@asynccontextmanager
async def environment():
    upstream = FixtureW365(details={})
    candidate = TransportCandidate(upstream.connect)
    clock = [time.time()]
    registry = RequestRegistry(
        interaction_owner=lambda interaction: {
            "interaction-A": f"{TENANT}:{A}", "interaction-B": f"{TENANT}:{B}",
        }.get(interaction),
        clock=lambda: clock[0], ttl_seconds=60,
    )
    validator = EntraAccessTokens(
        TENANT, AUDIENCE, lambda encoded: KEY.public_key(),
        use_scope="candidate.use", register_scope="candidate.register",
        mcp_clients={"fixture-mcp-client"}, registration_clients={"fixture-ccaas-client"},
    )
    app = create_app(candidate, registry, validator, public_origin="https://candidate.local")
    async with app.router.lifespan_context(app):
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url="https://candidate.local") as http:
            yield http, app, upstream, clock


async def register(http, oid=A, interaction="interaction-A"):
    response = await http.post("/requests", json={"interaction_id": interaction}, headers={
        "Authorization": "Bearer " + token(oid, scope="candidate.register", client="fixture-ccaas-client"),
    })
    assert response.status_code == 201, response.text
    return response.json()["request_id"]


@asynccontextmanager
async def mcp_client(app, bearer):
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app),
        headers={"Authorization": "Bearer " + bearer},
    ) as http:
        async with streamable_http_client("https://candidate.local/mcp", http_client=http) as streams:
            async with ClientSession(*streams, read_timeout_seconds=5) as client:
                await client.initialize()
                yield client


@pytest.mark.asyncio
async def test_standard_oauth_caller_and_registered_request_bind_without_dynamic_headers():
    async with environment() as (http, app, upstream, clock):
        request_id = await register(http)
        assert await register(http) == request_id  # Duplicate button delivery is idempotent.
        async with mcp_client(app, token()) as a, mcp_client(app, token(B)) as b:
            tools = await a.list_tools()
            assert all(
                "request_id" in t.input_schema["required"]
                for t in tools.tools if t.name != "request_caller_context"
            )
            caller = payload(await a.call_tool("request_caller_context", {}))
            assert caller["principal"] == f"{TENANT}:{A}"
            assert not upstream.events
            assert (await b.call_tool("computer_acquire", {"request_id": request_id})).is_error
            assert (await a.call_tool("computer_acquire", {"request_id": "invented-by-model"})).is_error
            acquired = payload(await a.call_tool("computer_acquire", {"request_id": request_id}))
            handle = acquired["handle"]
            observation = payload(await a.call_tool("computer_observe", {"request_id": request_id, "handle": handle}))
            assert observation["name"] == "Claims Workstation"
            assert (await b.call_tool("computer_release", {"request_id": request_id, "handle": handle})).is_error
            viewer = await http.get(f"/requests/{request_id}/viewer", params={"handle": handle}, headers={
                "Authorization": "Bearer " + token(),
            })
            assert viewer.status_code == 200
            assert viewer.json()["session_id"] == "fixture-service-allocation-1"
            done = await http.delete(f"/requests/{request_id}", headers={
                "Authorization": "Bearer " + token(client="fixture-ccaas-client"),
            })
            assert done.status_code == 200
            assert done.json()["state"] == "release_accepted"
            assert (await a.call_tool("computer_acquire", {"request_id": request_id})).is_error
        assert len([event for event in upstream.events if event[0] == START]) == 1
        assert not upstream.live


@pytest.mark.asyncio
async def test_wrong_scope_audience_signature_client_and_interaction_owner_are_rejected():
    async with environment() as (http, app, upstream, clock):
        bad_tokens = [
            token(audience="wrong-audience"),
            token(scope="wrong.scope"),
            token(client="unapproved-client"),
            token(client="fixture-ccaas-client"),
            token(key=rsa.generate_private_key(public_exponent=65537, key_size=2048)),
        ]
        for bearer in bad_tokens:
            response = await http.post("/mcp", headers={"Authorization": "Bearer " + bearer}, json={})
            assert response.status_code in (401, 403)
        response = await http.post("/requests", json={"interaction_id": "interaction-B"}, headers={
            "Authorization": "Bearer " + token(scope="candidate.register", client="fixture-ccaas-client"),
        })
        assert response.status_code == 403
        assert not upstream.events


@pytest.mark.asyncio
async def test_request_expiry_revokes_model_supplied_id_and_cleans_original_allocation():
    async with environment() as (http, app, upstream, clock):
        request_id = await register(http)
        async with mcp_client(app, token()) as client:
            acquired = payload(await client.call_tool("computer_acquire", {"request_id": request_id}))
            clock[0] += 61
            reply = await client.call_tool("computer_observe", {"request_id": request_id, "handle": acquired["handle"]})
            assert reply.is_error
            assert not upstream.live
            assert len([event for event in upstream.events if event[0] == START]) == 1
