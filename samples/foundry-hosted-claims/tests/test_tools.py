import pytest
from mcp.types import ListToolsResult, Tool
from test_lifecycle import result

from hosted_claims.tools import START_TIMEOUT_SECONDS, ComputerTools


class Mcp:
    async def list_tools(self, *, params=None):
        return ListToolsResult(
            tools=[
                Tool(
                    name="mcp_W365ComputerUse_StartSession",
                    input_schema={
                        "type": "object",
                        "properties": {"idempotencyKey": {"type": "string"}},
                    },
                ),
                Tool(
                    name="mcp_W365ComputerUse_EndSession",
                    input_schema={
                        "type": "object",
                        "properties": {"sessionId": {"type": "string"}},
                        "required": ["sessionId"],
                    },
                ),
                Tool(
                    name="mcp_W365ComputerUse_GetSessionDetails",
                    input_schema={
                        "type": "object",
                        "properties": {"sessionId": {"type": "string"}},
                        "required": ["sessionId"],
                    },
                ),
                Tool(
                    name="click",
                    input_schema={
                        "type": "object",
                        "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}},
                        "required": ["x", "y"],
                        "additionalProperties": False,
                    },
                ),
                Tool(name="execute_shell_command", input_schema={"type": "object"}),
                Tool(
                    name="press_keys",
                    input_schema={
                        "type": "object",
                        "properties": {"keys": {"type": "array", "items": {"type": "string"}}},
                        "required": ["keys"],
                    },
                ),
            ]
        )

    async def call_tool(self, name, arguments, **kwargs):
        if name.endswith("StartSession"):
            return result('{"sessionId":"only-session"}')
        assert arguments == {"sessionId": "only-session", "x": 12, "y": 24}
        return result("Clicked")


@pytest.mark.asyncio
async def test_discovered_tools_bind_actions_to_only_acquired_session_and_exclude_shell():
    computer = await ComputerTools.discover(Mcp())
    await computer.call("mcp_W365ComputerUse_StartSession", {"idempotencyKey": "stable-key"})
    value = await computer.call("click", {"sessionId": "only-session", "x": 12, "y": 24})
    assert value.content[0].text == "Clicked"
    with pytest.raises(ValueError, match="session"):
        await computer.call("click", {"sessionId": "someone-else", "x": 12, "y": 24})
    with pytest.raises(ValueError, match="allowed"):
        await computer.call("execute_shell_command", {"sessionId": "only-session"})


@pytest.mark.asyncio
async def test_keyboard_tool_cannot_escape_into_windows_run_or_task_manager():
    computer = await ComputerTools.discover(Mcp())
    await computer.call("mcp_W365ComputerUse_StartSession", {"idempotencyKey": "stable-key"})
    with pytest.raises(ValueError, match="shortcut"):
        await computer.call("press_keys", {"sessionId": "only-session", "keys": ["win", "r"]})


@pytest.mark.asyncio
async def test_start_session_waits_longer_than_other_tools():
    class Timed(Mcp):
        def __init__(self):
            self.timeouts = {}

        async def call_tool(self, name, arguments, **kwargs):
            self.timeouts[name] = kwargs.get("read_timeout_seconds")
            return await super().call_tool(name, arguments, **kwargs)

    client = Timed()
    computer = await ComputerTools.discover(client)
    await computer.call("mcp_W365ComputerUse_StartSession", {"idempotencyKey": "stable-key"})
    await computer.call("click", {"sessionId": "only-session", "x": 12, "y": 24})
    assert client.timeouts["mcp_W365ComputerUse_StartSession"] == START_TIMEOUT_SECONDS
    assert START_TIMEOUT_SECONDS >= 120
    assert client.timeouts["click"] == 35
