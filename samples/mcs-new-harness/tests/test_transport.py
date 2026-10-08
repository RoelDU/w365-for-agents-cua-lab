"""Local fixture proofs only: neither a Cloud PC nor a tenant is contacted."""

import asyncio
import json
from contextlib import asynccontextmanager

import pytest
from mcp import ClientSession, types
from mcp.server.lowlevel import Server
from mcp.shared.memory import create_client_server_memory_streams

from mcs_new_harness.transport_candidate import RequestOwner, TransportCandidate

START = "mcp_W365ComputerUse_StartSession"
DETAILS = "mcp_W365ComputerUse_GetSessionDetails"
END = "mcp_W365ComputerUse_EndSession"


def result(data):
    return types.CallToolResult(
        content=[types.TextContent(text=json.dumps(data))], structuredContent=data
    )


def payload(reply):
    assert not reply.is_error, reply
    return reply.structured_content


class FixtureW365:
    """Independent external-protocol fixture, never a real gateway."""

    def __init__(self, start_mode="normal", release_mode="normal", discovery_mode="normal", ready=True, details=None, observation=None):
        self.events = []
        self.live = set()
        self.counter = 0
        self.start_mode = start_mode
        self.release_mode = release_mode
        self.discovery_mode = discovery_mode
        self.ready = ready
        self.details = details
        self.observation = observation

    def server(self):
        def definition(name, properties=None):
            properties = properties or {}
            return types.Tool(name=name, inputSchema={
                "type": "object", "properties": properties,
                "required": list(properties), "additionalProperties": False,
            })

        async def listing(context, params):
            meta = params.meta if params else None
            self.events.append(("list", meta))
            if meta:
                assert meta["sessionId"] in self.live
                if self.discovery_mode == "fail":
                    raise RuntimeError("fixture unavailable")
                return types.ListToolsResult(tools=[
                    definition("get_accessibility_tree"),
                    definition("take_screenshot"),
                    definition("click", {"x": {"type": "integer"}, "y": {"type": "integer"}}),
                    definition("type_text", {"text": {"type": "string"}}),
                    definition("press_keys", {"keys": {"type": "array", "items": {"type": "string"}}}),
                ])
            return types.ListToolsResult(tools=[
                definition(START),
                definition(DETAILS, {"sessionId": {"type": "string"}}),
                definition(END, {"sessionId": {"type": "string"}}),
            ])

        async def calling(context, params):
            args = params.arguments or {}
            self.events.append((params.name, dict(args)))
            if params.name == START:
                self.counter += 1
                session_id = f"fixture-service-allocation-{self.counter}"
                self.live.add(session_id)
                if self.start_mode == "timeout":
                    raise TimeoutError("fixture-secret-token-must-not-escape")
                if self.start_mode == "lost_response":
                    await asyncio.Event().wait()
                if self.start_mode == "missing_id":
                    return result({"id": "not-an-allocation-id", "Mcp-Session-Id": "transport-only"})
                return result({"sessionId": session_id, "sessionLink": f"https://fixture.invalid/{session_id}"})
            assert args["sessionId"] in self.live, "Only the returned allocation ID is valid"
            if params.name == END:
                if self.release_mode == "timeout":
                    raise TimeoutError("fixture-secret-token-must-not-escape")
                self.live.remove(args["sessionId"])
                return result({"status": "Accepted"})
            if params.name == DETAILS:
                if self.details is not None:
                    if isinstance(self.details, types.CallToolResult):
                        return self.details
                    return result(self.details)
                return result({"status": "Ready" if self.ready else "Waiting"})
            if params.name == "get_accessibility_tree":
                return result(self.observation or {
                    "role": "window", "name": "Claims Workstation", "isForeground": True,
                    "children": [{"role": "button", "name": "New claim", "isEnabled": True}],
                })
            if params.name == "take_screenshot":
                return types.CallToolResult(content=[
                    types.ImageContent(data="aW1hZ2UtZml4dHVyZQ==", mimeType="image/png")
                ])
            return result({"performed": params.name})

        return Server("fixture-only-w365", on_list_tools=listing, on_call_tool=calling)

    @asynccontextmanager
    async def connect(self):
        async with connected(self.server(), timeout=1) as client:
            yield client


@asynccontextmanager
async def connected(server, timeout=3):
    async with create_client_server_memory_streams() as (client_streams, server_streams):
        task = asyncio.create_task(
            server.run(*server_streams, server.create_initialization_options())
        )
        try:
            async with ClientSession(*client_streams, read_timeout_seconds=timeout) as client:
                await client.initialize()
                yield client
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_static_tools_visible_before_any_allocation_or_gateway_connection():
    async def must_not_connect():
        raise AssertionError("Catalogue discovery must not contact Windows 365")

    candidate = TransportCandidate(must_not_connect)
    owner = RequestOwner("verified-caller-A", "originating-request-1")
    async with candidate.request(owner) as server, connected(server) as client:
        result = await client.list_tools()
        assert {tool.name for tool in result.tools} == {
            "computer_acquire", "computer_status", "computer_observe",
            "computer_screenshot", "computer_click", "computer_type_text",
            "computer_press_keys", "computer_release", "computer_viewer_context",
        }
        schema = json.dumps([tool.input_schema for tool in result.tools]).lower()
        assert not any(word in schema for word in ("token", "authorization", "caller", "sessionid"))


@pytest.mark.asyncio
async def test_agent_calls_individual_steps_and_owner_bound_viewer_uses_same_allocation():
    fixture = FixtureW365()
    candidate = TransportCandidate(fixture.connect)
    owner = RequestOwner("caller-A", "request-1")
    other = RequestOwner("caller-B", "request-2")
    async with candidate.request(owner) as server_a, connected(server_a) as a:
        acquired = payload(await a.call_tool("computer_acquire", {}))
        handle = acquired["handle"]
        assert "fixture-service-allocation" not in handle
        assert fixture.events[-1] == (START, {})
        async with candidate.request(other) as server_b, connected(server_b) as b:
            denied = await b.call_tool("computer_click", {"handle": handle, "x": 12, "y": 40})
            assert denied.is_error
            assert fixture.events[-1] == (START, {})
            b_handle = payload(await b.call_tool("computer_acquire", {}))["handle"]
            assert (await a.call_tool("computer_release", {"handle": b_handle})).is_error
        status = payload(await a.call_tool("computer_status", {"handle": handle}))
        assert status["state"] == "observable"
        assert status["task_ready"] is False
        observed = payload(await a.call_tool("computer_observe", {"handle": handle}))
        assert observed["name"] == "Claims Workstation"
        await a.call_tool("computer_click", {"handle": handle, "x": 12, "y": 40})
        await a.call_tool("computer_type_text", {"handle": handle, "text": "fixture claim description"})
        image = await a.call_tool("computer_screenshot", {"handle": handle})
        assert image.content[0].type == "image"
        assert image.content[0].data == "aW1hZ2UtZml4dHVyZQ=="
        public_viewer = payload(await a.call_tool("computer_viewer_context", {"handle": handle}))
        assert public_viewer == {"handle": handle, "available": True}
        trusted_viewer = await candidate.viewer_context(owner, handle)
        assert trusted_viewer.session_id == "fixture-service-allocation-1"
        assert trusted_viewer.session_link == "https://fixture.invalid/fixture-service-allocation-1"
        with pytest.raises(PermissionError):
            await candidate.viewer_context(other, handle)
        released = payload(await a.call_tool("computer_release", {"handle": handle}))
        assert released["state"] == "release_accepted"
        assert payload(await a.call_tool("computer_release", {"handle": handle})) == released
    assert fixture.events.count((END, {"sessionId": "fixture-service-allocation-1"})) == 1
    assert ("list", {"sessionId": "fixture-service-allocation-1"}) in fixture.events
    assert ("click", {"x": 12, "y": 40, "sessionId": "fixture-service-allocation-1"}) in fixture.events
    assert ("type_text", {"text": "fixture claim description", "sessionId": "fixture-service-allocation-1"}) in fixture.events
    assert not fixture.live


@pytest.mark.asyncio
@pytest.mark.parametrize("start_mode", ["timeout", "lost_response", "missing_id"])
async def test_uncertain_allocation_is_reported_without_retry_or_invented_release(start_mode):
    fixture = FixtureW365(start_mode=start_mode)
    candidate = TransportCandidate(fixture.connect)
    async with candidate.request(RequestOwner("caller-A", "request-uncertain")) as server, connected(server) as client:
        first = await client.call_tool("computer_acquire", {})
        assert first.is_error
        assert first.structured_content["state"] == "allocation_uncertain"
        assert "fixture-secret-token" not in first.model_dump_json()
        again = await client.call_tool("computer_acquire", {})
        assert again.is_error
        assert again.structured_content["state"] == "allocation_uncertain"
        assert first.structured_content["handle"] == again.structured_content["handle"]
    assert len([event for event in fixture.events if event[0] == START]) == 1
    assert not any(event[0] == END for event in fixture.events)
    assert fixture.live == {"fixture-service-allocation-1"}  # Unknown is NOT claimed released.


@pytest.mark.asyncio
async def test_disconnect_cleans_up_known_allocation_even_if_scoped_discovery_fails():
    fixture = FixtureW365(discovery_mode="fail")
    candidate = TransportCandidate(fixture.connect)
    async with candidate.request(RequestOwner("caller-A", "request-discovery-fail")) as server, connected(server) as client:
        handle = payload(await client.call_tool("computer_acquire", {}))["handle"]
        status = await client.call_tool("computer_status", {"handle": handle})
        assert status.is_error
    assert fixture.events[-1] == (END, {"sessionId": "fixture-service-allocation-1"})
    assert not fixture.live


@pytest.mark.asyncio
async def test_release_timeout_remains_uncertain_and_is_not_retried_on_disconnect():
    fixture = FixtureW365(release_mode="timeout")
    candidate = TransportCandidate(fixture.connect)
    async with candidate.request(RequestOwner("caller-A", "request-release-fail")) as server, connected(server) as client:
        handle = payload(await client.call_tool("computer_acquire", {}))["handle"]
        released = await client.call_tool("computer_release", {"handle": handle})
        assert released.is_error
        assert released.structured_content["state"] == "release_uncertain"
        assert "fixture-secret-token" not in released.model_dump_json()
        await client.call_tool("computer_release", {"handle": handle})
    assert len([event for event in fixture.events if event[0] == END]) == 1
    assert fixture.live


@pytest.mark.asyncio
async def test_same_caller_other_request_cannot_use_handle_or_override_service_identity():
    fixture = FixtureW365()
    candidate = TransportCandidate(fixture.connect)
    async with candidate.request(RequestOwner("caller-A", "request-1")) as server, connected(server) as client:
        handle = payload(await client.call_tool("computer_acquire", {}))["handle"]
        for field in ("token", "sessionId", "caller_id"):
            attempt = await client.call_tool("computer_status", {"handle": handle, field: "attacker"})
            assert attempt.is_error
        async with candidate.request(RequestOwner("caller-A", "request-2")) as other_server, connected(other_server) as other:
            for tool_name in ("computer_status", "computer_release", "computer_viewer_context"):
                assert (await other.call_tool(tool_name, {"handle": handle})).is_error
        assert len([event for event in fixture.events if event[0] == START]) == 1


@pytest.mark.asyncio
async def test_cancellation_after_acquisition_runs_explicit_release():
    fixture = FixtureW365()
    candidate = TransportCandidate(fixture.connect)
    acquired = asyncio.Event()

    async def interaction():
        async with candidate.request(RequestOwner("caller-A", "cancelled-request")) as server, connected(server) as client:
            await client.call_tool("computer_acquire", {})
            acquired.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(interaction())
    await acquired.wait()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert fixture.events[-1] == (END, {"sessionId": "fixture-service-allocation-1"})
    assert not fixture.live


@pytest.mark.asyncio
async def test_navigation_tool_rejects_shell_launch_shortcuts_before_upstream_call():
    fixture = FixtureW365()
    candidate = TransportCandidate(fixture.connect)
    async with candidate.request(RequestOwner("caller-A", "key-policy")) as server, connected(server) as client:
        handle = payload(await client.call_tool("computer_acquire", {}))["handle"]
        await client.call_tool("computer_status", {"handle": handle})
        rejected = await client.call_tool("computer_press_keys", {"handle": handle, "keys": ["win", "r"]})
        assert rejected.is_error
        assert not any(event[0] == "press_keys" for event in fixture.events)
        accepted = await client.call_tool("computer_press_keys", {"handle": handle, "keys": ["shift", "tab"]})
        assert not accepted.is_error


@pytest.mark.asyncio
async def test_parallel_acquire_never_duplicates_allocation_and_actions_wait_for_readiness():
    fixture = FixtureW365(ready=False, observation={"role": "window", "name": "Setting up for work or school"})
    candidate = TransportCandidate(fixture.connect)
    async with candidate.request(RequestOwner("caller-A", "parallel")) as server, connected(server) as client:
        replies = await asyncio.gather(
            client.call_tool("computer_acquire", {}),
            client.call_tool("computer_acquire", {}),
        )
        handles = {r.structured_content["handle"] for r in replies}
        assert len(handles) == 1
        handle = handles.pop()
        assert len([event for event in fixture.events if event[0] == START]) == 1
        waiting = payload(await client.call_tool("computer_status", {"handle": handle}))
        assert waiting["state"] == "observable"
        assert waiting["task_ready"] is False
        assert (await client.call_tool("computer_click", {"handle": handle, "x": 1, "y": 1})).is_error
        assert not any(event[0] == "click" for event in fixture.events)


@pytest.mark.asyncio
@pytest.mark.parametrize("details", [
    {},
    types.CallToolResult(content=[
        types.TextContent(text="Session ID: fixture-service-allocation-1"),
        types.TextContent(text="Session information has no structured status field."),
    ]),
])
async def test_missing_status_does_not_block_same_session_discovery_observation_or_viewer(details):
    fixture = FixtureW365(details=details)
    candidate = TransportCandidate(fixture.connect)
    owner = RequestOwner("caller-A", "status-absent")
    async with candidate.request(owner) as server, connected(server) as client:
        handle = payload(await client.call_tool("computer_acquire", {}))["handle"]
        await client.call_tool("computer_status", {"handle": handle})
        observation = await client.call_tool("computer_observe", {"handle": handle})
        assert not observation.is_error
        assert observation.structured_content["name"] == "Claims Workstation"
        assert ("list", {"sessionId": "fixture-service-allocation-1"}) in fixture.events
        assert (await candidate.viewer_context(owner, handle)).session_id == "fixture-service-allocation-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("details", [
    {"sessionId": "other-allocation", "status": "Ready"},
    types.CallToolResult(content=[types.TextContent(text="Session ID: other-allocation\nStatus: Ready")]),
])
async def test_conflicting_details_identity_is_rejected_and_only_original_allocation_is_released(details):
    fixture = FixtureW365(details=details)
    candidate = TransportCandidate(fixture.connect)
    async with candidate.request(RequestOwner("caller-A", "identity-conflict")) as server, connected(server) as client:
        handle = payload(await client.call_tool("computer_acquire", {}))["handle"]
        assert (await client.call_tool("computer_status", {"handle": handle})).is_error
        assert (await client.call_tool("computer_click", {"handle": handle, "x": 1, "y": 1})).is_error
        assert not any(event[0] == "click" for event in fixture.events)
    assert fixture.events[-1] == (END, {"sessionId": "fixture-service-allocation-1"})
    assert not any(args.get("sessionId") == "other-allocation" for name, args in fixture.events if isinstance(args, dict))


@pytest.mark.asyncio
async def test_responsive_setup_screen_is_observable_but_never_treated_as_claims_ready():
    fixture = FixtureW365(details={}, observation={
        "role": "window", "name": "Setting up for work or school",
        "children": [{"name": "Account setup", "value": "Working on it"}],
    })
    candidate = TransportCandidate(fixture.connect)
    owner = RequestOwner("caller-A", "setup-screen")
    async with candidate.request(owner) as server, connected(server) as client:
        handle = payload(await client.call_tool("computer_acquire", {}))["handle"]
        assert (await candidate.viewer_context(owner, handle)).session_id == "fixture-service-allocation-1"
        assert not (await client.call_tool("computer_screenshot", {"handle": handle})).is_error
        observed = payload(await client.call_tool("computer_observe", {"handle": handle}))
        assert observed["name"] == "Setting up for work or school"
        blocked = await client.call_tool("computer_click", {"handle": handle, "x": 1, "y": 1})
        assert blocked.is_error
        assert blocked.structured_content["task_evidence"] == "windows_setup_visible"
        assert not any(name == "click" for name, args in fixture.events)
        fixture.observation = {
            "role": "window", "name": "Claims Workstation", "isForeground": True,
            "children": [{"role": "button", "name": "New claim", "isEnabled": True}],
        }
        assert not (await client.call_tool("computer_click", {"handle": handle, "x": 1, "y": 1})).is_error
        fixture.observation["isForeground"] = False
        assert (await client.call_tool("computer_click", {"handle": handle, "x": 2, "y": 2})).is_error
        fixture.observation = {"role": "window", "name": "Claims Workstation"}
        assert (await client.call_tool("computer_click", {"handle": handle, "x": 3, "y": 3})).is_error
