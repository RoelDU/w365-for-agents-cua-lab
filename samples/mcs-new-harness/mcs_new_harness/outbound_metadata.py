"""Staged SDK-backed probe: initialize and tools/list only, never a tool execution."""

import asyncio
import argparse
import json
import logging
import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from microsoft_agents.authentication.msal import MsalConnectionManager
from microsoft_agents.hosting.core import AgentAuthConfiguration
from microsoft_agents.hosting.core.authorization.auth_types import AuthTypes

from .sdk_gateway import AgentUserBearer, SdkAgentUserTokens


def configured_tokens(config):
    if config.get("metadata_verification_enabled") is not True:
        raise PermissionError("metadata_verification_disabled")
    tenant = str(UUID(config["tenant_id"]))
    blueprint, agent, user = [
        str(UUID(config[key])) for key in ("blueprint_id", "agent_identity_app_id", "agent_user_id")
    ]
    if blueprint == str(UUID(config["inbound_client_id"])):
        raise ValueError("inbound_human_client_is_not_an_outbound_blueprint")
    secret = os.environ.get("NH_BLUEPRINT_CLIENT_SECRET")
    if not secret:
        raise PermissionError("dedicated_blueprint_credential_not_configured")
    manager = MsalConnectionManager(connections_configurations={
        "SERVICE_CONNECTION": AgentAuthConfiguration(
            auth_type=AuthTypes.client_secret, client_id=blueprint,
            tenant_id=tenant, client_secret=secret,
        ),
    })
    return SdkAgentUserTokens.from_connection_manager(
        manager, tenant, agent, user, config["computer_scope"], config["viewer_scope"],
    )


async def probe(tokens, *, endpoint, http_transport=None):
    target = urlsplit(endpoint)
    if (
        target.scheme != "https" or not target.hostname or target.username or target.password
        or target.query or target.fragment
    ):
        raise ValueError("Use the exact approved HTTPS endpoint without credentials, query or fragment")
    async with httpx2.AsyncClient(
        auth=AgentUserBearer(tokens, endpoint), transport=http_transport,
        timeout=httpx2.Timeout(30), follow_redirects=False,
    ) as http:
        async with streamable_http_client(endpoint, http_client=http) as streams:
            async with ClientSession(*streams, read_timeout_seconds=30) as client:
                initialized = (await client.initialize()).model_dump(by_alias=True)
                catalogue = await client.list_tools()
                return {
                    "kind": "agent_user_metadata_only",
                    "endpoint": endpoint,
                    "protocol_version": initialized["protocolVersion"],
                    "tools": [tool.name for tool in catalogue.tools],
                    "executed_tools": [],
                    "pool_assignment_proven": False,
                    "desktop_proven": False,
                }


async def main(config_path):
    logging.disable(logging.CRITICAL)
    exit_code = 0
    try:
        config = json.loads(config_path.read_text())
        result = await probe(configured_tokens(config), endpoint=config["endpoint"])
    except Exception as error:
        # SDK exceptions can contain authentication payloads; never serialize their text.
        result = {"kind": "agent_user_metadata_only", "status": "not_completed", "error_type": type(error).__name__}
        if isinstance(error, PermissionError) and str(error) == "metadata_verification_disabled":
            result.update(status="disabled", reason="metadata_verification_disabled")
        exit_code = 2
    print(json.dumps(result, indent=2))
    return exit_code


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True,
                        help="Private, reviewed SDK identity/scope/endpoint configuration.")
    raise SystemExit(asyncio.run(main(parser.parse_args().config)))
