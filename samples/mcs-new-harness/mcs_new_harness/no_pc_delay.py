"""Review-only bounded waiting diagnostic. No gateway, SDK, registration, or PC code."""

import asyncio
import time

from mcp import types

TOOL = types.Tool(
    name="auth_only_delay_probe",
    description="Authenticated no-PC transport timing: control waits1s; boundary waits125s. Never retry automatically.",
    inputSchema={
        "type": "object",
        "properties": {"mode": {"type": "string", "enum": ["control", "boundary"]}},
        "required": ["mode"],
        "additionalProperties": False,
    },
)


async def run(arguments, principal):
    if set(arguments) != {"mode"} or arguments["mode"] not in ("control", "boundary"):
        raise ValueError("Only control or boundary mode is allowed")
    requested = 1 if arguments["mode"] == "control" else 125
    started = time.monotonic()
    await asyncio.wait_for(asyncio.sleep(requested), timeout=130)
    return {
        "kind": "auth_only_transport_delay",
        "requested_seconds": requested,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "principal": principal,
        "pc_allocated": False,
        "outbound_calls": 0,
    }
