import logging
from typing import Any

from jsonschema import Draft202012Validator
from mcp import ClientSession
from mcp.types import CallToolResult, PaginatedRequestParams, RequestParamsMeta, Tool

from .engine import (
    CLAIMS_ARGS,
    CLAIMS_EXE,
    DETAILS,
    END,
    START,
    START_TIMEOUT_SECONDS,
    RunError,
    session_id_from,
)

logger = logging.getLogger(__name__)

# No shell, code execution, clipboard, arbitrary applications, browser, or file tools.
DESKTOP = frozenset(
    {
        "click",
        "type_text",
        "press_keys",
        "scroll",
        "take_screenshot",
        "analyze_screen",
        "get_accessibility_tree",
        "find_ui_element",
        "list_windows",
        "activate_window",
        "get_screen_size",
        "zoom_region",
    }
)
ALLOWED = DESKTOP | {START, DETAILS, END, "launch_application"}


class SessionMetadata(RequestParamsMeta):
    sessionId: str


class ComputerTools:
    def __init__(self, client: ClientSession, tools: dict[str, Tool]) -> None:
        self.client = client
        self.tools = tools
        self.session_id: str | None = None
        self.desktop_discovered = False

    @classmethod
    async def discover(cls, client: ClientSession) -> "ComputerTools":
        tools = await cls._list_tools(client)
        if not {START, DETAILS, END}.issubset(tools):
            raise RunError("Computer-Use did not expose the documented session lifecycle tools.")
        for name in (START, DETAILS, END):
            logger.warning(
                "Lifecycle tool %s inputs=%s output_schema=%s",
                name,
                sorted(tools[name].input_schema.get("properties", {})),
                sorted((tools[name].output_schema or {}).get("properties", {})),
            )
        return cls(client, tools)

    @staticmethod
    async def _list_tools(client: ClientSession, session_id: str | None = None) -> dict[str, Tool]:
        tools: dict[str, Tool] = {}
        meta = SessionMetadata(sessionId=session_id) if session_id else None
        cursor = None
        seen: set[str] = set()
        while True:
            page = await client.list_tools(params=PaginatedRequestParams(cursor=cursor, _meta=meta))
            for tool in page.tools:
                if tool.name in ALLOWED:
                    tools[tool.name] = tool
            cursor = page.next_cursor
            if not cursor:
                break
            if cursor in seen:
                raise RunError("Computer-Use tool discovery repeated a page cursor.")
            seen.add(cursor)
        return tools

    async def call(self, name: str, arguments: dict[str, Any]) -> CallToolResult:
        if name not in ALLOWED:
            raise ValueError(f"Tool is not allowed or not discovered: {name}")
        args = dict(arguments)
        if name != START and (not self.session_id or args.get("sessionId") != self.session_id):
            raise ValueError("Tool call does not match the acquired Cloud PC session.")
        if name in DESKTOP | {"launch_application"} and not self.desktop_discovered:
            # Refresh only after the caller has recorded the acquisition for guaranteed cleanup.
            scoped = await self._list_tools(self.client, self.session_id)
            self.tools = {
                key: tool for key, tool in self.tools.items() if key in {START, DETAILS, END}
            } | {
                key: tool for key, tool in scoped.items() if key in DESKTOP | {"launch_application"}
            }
            self.desktop_discovered = True
        if name not in self.tools:
            raise ValueError(f"Tool is not allowed or not discovered: {name}")
        tool = self.tools[name]
        properties = tool.input_schema.get("properties", {})
        if name == START:
            if self.session_id:
                raise ValueError("A Cloud PC session is already acquired.")
            if "idempotencyKey" not in properties:
                args.pop("idempotencyKey", None)
        if name == "launch_application" and (
            args.get("path") != CLAIMS_EXE or args.get("args") != CLAIMS_ARGS
        ):
            raise ValueError("Only the approved installed Claims application may be launched.")
        if name == "activate_window" and args.get("title") != "Claims Workstation":
            raise ValueError("Only the Claims Workstation window may be activated.")
        if name == "press_keys":
            keys = tuple(str(k).lower() for k in args.get("keys", []))
            single = {
                "enter",
                "return",
                "tab",
                "esc",
                "escape",
                "backspace",
                "delete",
                "space",
                "left",
                "right",
                "up",
                "down",
                "home",
                "end",
                "pageup",
                "pagedown",
            }
            if not (
                (
                    len(keys) == 1
                    and (keys[0] in single or (len(keys[0]) == 1 and keys[0].isalnum()))
                )
                or keys in {("alt", "n"), ("alt", "r"), ("alt", "u"), ("shift", "tab")}
            ):
                raise ValueError("Keyboard shortcut is outside the Claims navigation boundary.")
        schema_args = dict(args)
        # W365's session envelope is required even when the desktop schema omits it.
        if name in DESKTOP | {"launch_application"} and "sessionId" not in properties:
            schema_args.pop("sessionId")
        Draft202012Validator(tool.input_schema).validate(schema_args)
        response = await self.client.call_tool(
            name, args, read_timeout_seconds=START_TIMEOUT_SECONDS if name == START else 35
        )
        if not isinstance(response, CallToolResult):
            raise RunError(
                "Computer-Use requires additional input or approval; no automatic bypass."
            )
        if name == START:
            self.session_id, _ = session_id_from(response)
        return response

    def model_tools(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "name": name,
                "description": tool.description or name,
                "parameters": tool.input_schema,
                "strict": False,
            }
            for name, tool in self.tools.items()
            if name in DESKTOP
        ]

    async def release_existing(self, session_id: str) -> CallToolResult:
        if self.session_id:
            raise ValueError("Recovery cannot replace an active session.")
        arguments = {"sessionId": session_id}
        Draft202012Validator(self.tools[END].input_schema).validate(arguments)
        result = await self.client.call_tool(END, arguments, read_timeout_seconds=35)
        if not isinstance(result, CallToolResult):
            raise RunError("End Session did not return an accepted tool result.")
        return result
