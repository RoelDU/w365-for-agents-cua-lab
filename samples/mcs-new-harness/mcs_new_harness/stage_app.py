"""Environment-configured Functions entry point. Live gateway/registration stay off."""

import os

from .auth_stage import create_auth_only_app


app = create_auth_only_app(
    os.environ["NH_PUBLIC_ORIGIN"],
    tenant=os.environ["NH_TENANT_ID"],
    audience=os.environ["NH_API_AUDIENCE"],
    mcp_client=os.environ["NH_MCP_CLIENT_ID"],
    use_scope=os.environ["NH_USE_SCOPE"],
    preserve_swa_header=os.environ.get("NH_PRESERVE_SWA_HEADER", "false") == "true",
    delay_probe_enabled=os.environ.get("ZAVA_DELAY_PROBE_ENABLED", "false") == "true",
)
