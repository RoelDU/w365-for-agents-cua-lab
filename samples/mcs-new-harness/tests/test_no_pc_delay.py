"""Local signed-token MCP control test; never calls a tenant or W365 SDK."""

import httpx2
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from mcs_new_harness.auth_stage import create_auth_only_app
from test_request_host import A, AUDIENCE, KEY, TENANT, token
from test_transport import payload


@pytest.mark.asyncio
async def test_review_delay_mode_exposes_no_computer_tools_and_bounds_duration():
    app = create_auth_only_app(
        "https://candidate.local", tenant=TENANT, audience=AUDIENCE,
        mcp_client="fixture-mcp-client", use_scope="candidate.use",
        signing_key=lambda encoded: KEY.public_key(), preserve_swa_header=False,
        delay_probe_enabled=True,
    )
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app),
            headers={"Authorization": "Bearer " + token()},
        ) as http:
            async with streamable_http_client("https://candidate.local/api/mcp", http_client=http) as streams:
                async with ClientSession(*streams) as client:
                    await client.initialize()
                    assert {tool.name for tool in (await client.list_tools()).tools} == {
                        "request_caller_context", "auth_only_delay_probe",
                    }
                    rejected = await client.call_tool("auth_only_delay_probe", {"seconds": 1000})
                    assert rejected.is_error
                    forbidden = await client.call_tool("computer_acquire", {"request_id": "invented"})
                    assert forbidden.is_error
                    result = payload(await client.call_tool("auth_only_delay_probe", {"mode": "control"}))
                    assert result["requested_seconds"] == 1
                    assert 1 <= result["elapsed_seconds"] < 10
                    assert result["principal"] == f"{TENANT}:{A}"
                    assert result["pc_allocated"] is False
                    assert result["outbound_calls"] == 0
