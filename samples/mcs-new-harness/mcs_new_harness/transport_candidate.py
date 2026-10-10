"""Experimental W365 transport candidate; no identity grants or autonomous planner."""

import asyncio
import json
import re
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from uuid import uuid4

import anyio
from jsonschema import Draft202012Validator

from mcp import types
from mcp.server.lowlevel import Server


@dataclass(frozen=True)
class RequestOwner:
    """Only the authenticated host may bind these values, never model arguments."""

    caller_id: str
    request_id: str

    def __post_init__(self):
        if not self.caller_id or not self.request_id:
            raise ValueError("Verified caller and originating request are required")


def tool(name, description, properties=None):
    properties = properties or {}
    return types.Tool(
        name=name,
        description=description,
        inputSchema={
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        },
    )


HANDLE = {"handle": {"type": "string", "minLength": 1}}
TOOLS = [
    tool("computer_acquire", "Acquire one PC for this authenticated request; never retry an uncertain allocation."),
    tool("computer_status", "Report allocation/discovery state; a service status field is optional and does not prove task readiness.", HANDLE),
    tool("computer_observe", "Read the actual Windows accessibility tree.", HANDLE),
    tool("computer_screenshot", "Return the actual desktop screenshot as MCP content.", HANDLE),
    tool("computer_click", "Perform one left mouse click chosen by the agent.", {
        **HANDLE, "x": {"type": "integer", "minimum": 0}, "y": {"type": "integer", "minimum": 0},
    }),
    tool("computer_type_text", "Type the exact text chosen by the agent.", {
        **HANDLE, "text": {"type": "string", "maxLength": 4000},
    }),
    tool("computer_press_keys", "Send one navigation key or Shift+Tab.", {
        **HANDLE, "keys": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 2},
    }),
    tool("computer_release", "Explicitly release this request's PC; acceptance is not completed cleanup.", HANDLE),
    tool("computer_viewer_context", "Report whether a same-handle authenticated viewer context is available; never returns credentials.", HANDLE),
]

START = "mcp_W365ComputerUse_StartSession"
DETAILS = "mcp_W365ComputerUse_GetSessionDetails"
END = "mcp_W365ComputerUse_EndSession"
ACTIONS = {
    "computer_observe": "get_accessibility_tree",
    "computer_screenshot": "take_screenshot",
    "computer_click": "click",
    "computer_type_text": "type_text",
    "computer_press_keys": "press_keys",
}


def reply(data, error=False):
    return types.CallToolResult(
        content=[types.TextContent(text=json.dumps(data))],
        structuredContent=data,
        isError=error,
    )


def object_reply(result):
    if not isinstance(result, types.CallToolResult) or result.is_error or result.result_type != "complete":
        raise ValueError("Unsuccessful upstream result")
    if isinstance(result.structured_content, dict):
        return result.structured_content
    for content in result.content:
        if content.type == "text":
            try:
                value = json.loads(content.text)
                if isinstance(value, dict):
                    return value
            except ValueError:
                pass
    raise ValueError("No structured object in upstream result")


class GatewaySession:
    """One task owns the MCP context for its lifetime, including final teardown."""

    def __init__(self, factory):
        self.factory = factory
        self.queue = asyncio.Queue()
        self.task = None

    async def invoke(self, method, *args, **kwargs):
        if self.task is not None and self.task.done():
            raise RuntimeError("Gateway connection ended")
        future = asyncio.get_running_loop().create_future()
        await self.queue.put((method, args, kwargs, future))
        if self.task is None:
            self.task = asyncio.create_task(self._run())
        return await future

    async def _run(self):
        current = None
        try:
            async with self.factory() as client:
                while True:
                    command = await self.queue.get()
                    if command is None:
                        return
                    method, args, kwargs, current = command
                    try:
                        value = await getattr(client, method)(*args, **kwargs)
                        if not current.done():
                            current.set_result(value)
                    except Exception:
                        if not current.done():
                            current.set_exception(RuntimeError("Upstream operation failed"))
        except Exception:
            if current is not None and not current.done():
                current.set_exception(RuntimeError("Gateway unavailable"))
            while not self.queue.empty():
                pending = self.queue.get_nowait()
                if pending is not None and not pending[3].done():
                    pending[3].set_exception(RuntimeError("Gateway unavailable"))

    async def close(self):
        if self.task is not None:
            await self.queue.put(None)
            await self.task


@dataclass
class Allocation:
    owner: RequestOwner
    handle: str
    gateway: GatewaySession
    state: str = "not_acquired"
    session_id: str | None = None
    session_link: str | None = None
    tools: dict = field(default_factory=dict)
    desktop_discovered: bool = False
    task_ready: bool = False
    task_evidence: str = "not_observed"


@dataclass(frozen=True)
class ViewerContext:
    session_id: str
    session_link: str


class TransportCandidate:
    def __init__(self, gateway_factory):
        self.gateway_factory = gateway_factory
        self.allocations = {}
        self.handles = {}
        self.locks = {}
        self.active_requests = set()

    @asynccontextmanager
    async def request(self, owner: RequestOwner):
        if owner in self.active_requests:
            raise ValueError("This request is already connected")
        self.active_requests.add(owner)
        self.locks.setdefault(owner, asyncio.Lock())

        async def list_tools(context, params):
            return types.ListToolsResult(tools=TOOLS)

        async def call_tool(context, params):
            return await self.invoke(owner, params.name, params.arguments or {})

        try:
            yield Server(
                "w365-transport-candidate-local-prototype",
                on_list_tools=list_tools,
                on_call_tool=call_tool,
            )
        finally:
            with anyio.CancelScope(shield=True):
                await self.close_request(owner)
                self.active_requests.discard(owner)

    async def invoke(self, owner, name, args):
        """Trusted host interface; owner must come from the authenticated request registry."""
        definition = next((t for t in TOOLS if t.name == name), None)
        if definition is None:
            return reply({"error": "unknown_tool"}, True)
        if not Draft202012Validator(definition.input_schema).is_valid(args):
            return reply({"error": "invalid_arguments"}, True)
        lock = self.locks.setdefault(owner, asyncio.Lock())
        async with lock:
            try:
                return await self._call(owner, name, args)
            except PermissionError:
                return reply({"error": "unknown_or_unowned_handle"}, True)
            except Exception:
                allocation = self.allocations.get(owner)
                state = self._state(allocation) if allocation else {}
                return reply({"error": "upstream_operation_failed_no_automatic_retry", **state}, True)

    async def close_request(self, owner):
        async with self.locks.setdefault(owner, asyncio.Lock()):
            allocation = self.allocations.get(owner)
            if allocation:
                await self._release(allocation)
                await allocation.gateway.close()
        return self.request_report(owner)

    def _owned(self, owner, handle):
        allocation = self.handles.get(handle)
        if allocation is None or allocation.owner != owner:
            raise PermissionError("Unknown handle")
        return allocation

    async def viewer_context(self, owner, handle):
        """Trusted authenticated viewer host only; never registered as an MCP tool."""
        allocation = self._owned(owner, handle)
        if allocation.state not in {"allocated", "observable"} or not allocation.session_link:
            raise ValueError("No active viewer context")
        return ViewerContext(allocation.session_id, allocation.session_link)

    def _state(self, allocation):
        return {
            "handle": allocation.handle, "state": allocation.state,
            "observation_available": allocation.desktop_discovered,
            "task_ready": allocation.task_ready,
            "task_evidence": allocation.task_evidence,
        }

    def request_report(self, owner):
        """Host-only completion/cleanup report; no bearer or service URL."""
        allocation = self.allocations.get(owner)
        state = allocation.state if allocation else "not_acquired"
        return {
            "request_id": owner.request_id,
            "state": state,
            "requires_reconciliation": state in {"allocation_uncertain", "release_uncertain"},
            "cleanup_completed": False,
        }

    async def _catalogue(self, allocation, scoped=False):
        cursor = None
        seen = set()
        tools = {}
        for _ in range(20):
            params = types.PaginatedRequestParams(
                cursor=cursor,
                _meta={"sessionId": allocation.session_id} if scoped else None,
            )
            page = await allocation.gateway.invoke("list_tools", params=params)
            tools.update({t.name: t for t in page.tools})
            if not page.next_cursor:
                return tools
            if page.next_cursor in seen:
                break
            seen.add(page.next_cursor)
            cursor = page.next_cursor
        raise ValueError("Unbounded or repeated discovery cursor")

    async def _discover_for_allocation(self, allocation):
        allocation.task_ready = False
        allocation.task_evidence = "fresh_task_observation_required"
        details = await allocation.gateway.invoke(
            "call_tool", DETAILS, {"sessionId": allocation.session_id}
        )
        if not isinstance(details, types.CallToolResult) or details.is_error or details.result_type != "complete":
            raise ValueError("Session details failed")
        ids = set()

        def collect(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key.lower().replace("_", "").replace(" ", "") == "sessionid":
                        if isinstance(child, str):
                            ids.add(child)
                    else:
                        collect(child)
            elif isinstance(value, list):
                for child in value:
                    collect(child)

        collect(details.structured_content)
        for content in details.content:
            if content.type == "text":
                try:
                    collect(json.loads(content.text))
                except ValueError:
                    # Accept absent fields/plain-text details, but never a conflicting labelled ID.
                    ids.update(re.findall(
                        r"(?i)\bsession[\s_]*id[\"`*\s]*[:=][\"`*\s]*([a-z0-9_-]+)",
                        content.text,
                    ))
        if any(value != allocation.session_id for value in ids):
            allocation.state = "identity_conflict"
            allocation.task_ready = False
            allocation.task_evidence = "conflicting_service_session_id"
            raise ValueError("Conflicting service session identity")
        if not allocation.desktop_discovered:
            allocation.tools.update(await self._catalogue(allocation, scoped=True))
            allocation.desktop_discovered = True
        allocation.state = "observable"

    def _record_task_evidence(self, allocation, observation):
        allocation.task_ready = False
        allocation.task_evidence = "task_ui_not_confirmed"
        try:
            data = object_reply(observation)
        except ValueError:
            return
        text = json.dumps(data).casefold()
        if any(blocker in text for blocker in (
            "setting up for work or school", "account setup", "device preparation",
        )):
            allocation.task_evidence = "windows_setup_visible"
            return
        # An actual root-window observation is required, not a title mentioned inside text.
        # Unknown service response shapes remain observable but fail closed for mutation.
        role = str(data.get("role", data.get("controlType", ""))).casefold()
        name = str(data.get("name", "")).casefold()
        unavailable = (
            data.get("isEnabled") is False or data.get("isOffscreen") is True
            or data.get("isForeground") is False
        )

        def has_interactive_control(node):
            if not isinstance(node, dict):
                return False
            control = str(node.get("role", node.get("controlType", ""))).casefold()
            if (
                control in {"button", "edit", "textbox", "combobox"}
                and isinstance(node.get("name"), str) and node["name"].strip()
                and node.get("isEnabled") is not False and node.get("isOffscreen") is not True
            ):
                return True
            return any(has_interactive_control(child) for child in (node.get("children") or []) if isinstance(child, dict))

        if role == "window" and name == "claims workstation" and not unavailable and has_interactive_control(data):
            allocation.task_ready = True
            allocation.task_evidence = "claims_root_and_interactive_control_observed"

    async def _observe(self, allocation):
        if "get_accessibility_tree" not in allocation.tools:
            raise ValueError("Accessibility observation unavailable")
        observation = await allocation.gateway.invoke(
            "call_tool", "get_accessibility_tree", {"sessionId": allocation.session_id}
        )
        self._record_task_evidence(allocation, observation)
        if not isinstance(observation, types.CallToolResult) or observation.is_error or observation.result_type != "complete":
            raise ValueError("Observation unavailable")
        return observation

    async def _call(self, owner, name, args):
        if name == "computer_acquire":
            previous = self.allocations.get(owner)
            if previous:
                return reply(self._state(previous), previous.state not in {"allocated", "observable"})
            allocation = Allocation(owner, secrets.token_urlsafe(24), GatewaySession(self.gateway_factory))
            self.allocations[owner] = allocation
            self.handles[allocation.handle] = allocation
            allocation.tools = await self._catalogue(allocation)
            if not {START, DETAILS, END}.issubset(allocation.tools):
                raise ValueError("Missing lifecycle contract")
            start_args = {}
            if "idempotencyKey" in allocation.tools[START].input_schema.get("properties", {}):
                start_args["idempotencyKey"] = str(uuid4())
            if not Draft202012Validator(allocation.tools[START].input_schema).is_valid(start_args):
                raise ValueError("Unsupported required acquisition parameters")
            allocation.state = "allocation_uncertain"
            started = await allocation.gateway.invoke("call_tool", START, start_args)
            data = object_reply(started)
            session_id = data.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                return reply(self._state(allocation), True)
            allocation.session_id = session_id
            allocation.session_link = data.get("sessionLink") or data.get("screenShareUrl")
            allocation.state = "allocated"
            return reply(self._state(allocation))

        allocation = self._owned(owner, args["handle"])
        if name == "computer_release":
            return await self._release(allocation)
        if name == "computer_status":
            if allocation.state in {"allocated", "observable"}:
                await self._discover_for_allocation(allocation)
            return reply(self._state(allocation), allocation.state == "identity_conflict")
        if allocation.state not in {"allocated", "observable"}:
            return reply({"error": "allocation_not_available", **self._state(allocation)}, True)
        if name == "computer_viewer_context":
            return reply({"handle": allocation.handle, "available": bool(allocation.session_link)})
        await self._discover_for_allocation(allocation)
        if name == "computer_observe":
            return await self._observe(allocation)
        if name in {"computer_click", "computer_type_text", "computer_press_keys"}:
            await self._observe(allocation)
            if not allocation.task_ready:
                return reply({"error": "task_ui_not_confirmed", **self._state(allocation)}, True)
        upstream = ACTIONS[name]
        if upstream not in allocation.tools:
            return reply({"error": "upstream_tool_not_available"}, True)
        wire_args = {key: value for key, value in args.items() if key != "handle"}
        if upstream == "press_keys":
            keys = tuple(key.lower() for key in wire_args["keys"])
            navigation = {
                "enter", "tab", "esc", "escape", "backspace", "delete", "space",
                "left", "right", "up", "down", "home", "end", "pageup", "pagedown",
            }
            if not (keys == ("shift", "tab") or (len(keys) == 1 and keys[0] in navigation)):
                return reply({"error": "navigation_keys_only"}, True)
        schema = allocation.tools[upstream].input_schema
        validation_args = dict(wire_args)
        if "sessionId" in schema.get("properties", {}):
            validation_args["sessionId"] = allocation.session_id
        if not Draft202012Validator(schema).is_valid(validation_args):
            return reply({"error": "upstream_schema_mismatch"}, True)
        wire_args["sessionId"] = allocation.session_id
        result = await allocation.gateway.invoke("call_tool", upstream, wire_args)
        if not isinstance(result, types.CallToolResult) or result.is_error or result.result_type != "complete":
            return reply({"error": "upstream_action_failed_no_automatic_retry"}, True)
        return result

    async def _release(self, allocation):
        allocation.task_ready = False
        if allocation.state == "release_accepted":
            return reply(self._state(allocation))
        if not allocation.session_id or allocation.state == "release_uncertain":
            return reply(self._state(allocation), allocation.state != "not_acquired")
        allocation.state = "release_uncertain"
        try:
            result = await allocation.gateway.invoke(
                "call_tool", END, {"sessionId": allocation.session_id}
            )
            if isinstance(result, types.CallToolResult) and not result.is_error and result.result_type == "complete":
                allocation.state = "release_accepted"
        except Exception:
            pass
        return reply(self._state(allocation), allocation.state != "release_accepted")
