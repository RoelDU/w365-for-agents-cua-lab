import asyncio

import pytest
from mcp.types import CallToolResult, TextContent
from test_contract import handoff

from hosted_claims.engine import run


def result(text):
    return CallToolResult(content=[TextContent(type="text", text=text)])


class Cloud:
    """External MCP boundary with the documented session and action contracts."""

    def __init__(self):
        self.acquired = False
        self.released = False
        self.visible = False

    async def call(self, name, arguments):
        if name == "mcp_W365ComputerUse_StartSession":
            self.acquired = True
            return result(
                '{"sessionId":"pc-session-1","screenShareUrl":'
                '"https://pc.example/computers/pc-42/screenshare?api-version=test-v1&value=a%2Fb"}'
            )
        assert arguments["sessionId"] == "pc-session-1"
        if name == "mcp_W365ComputerUse_GetSessionDetails":
            return result('{"status":"Ready"}')
        if name == "get_screen_size":
            return result('{"width":1920,"height":1080}')
        if name == "launch_application":
            self.visible = True
            return result('{"pid":1234}')
        if name == "get_accessibility_tree":
            return result(
                '{"role":"Window","name":"Zava Mutual - Claims Workstation v1.0","children":[]}'
            )
        if name == "mcp_W365ComputerUse_EndSession":
            self.released = True
            return result("Accepted")
        raise AssertionError(f"Unexpected tool {name}")

    def model_tools(self):
        return []


@pytest.mark.asyncio
async def test_smoke_acquires_makes_claims_window_visible_and_releases_same_session():
    cloud = Cloud()
    events = []
    outcome = await run(handoff(), "smoke", cloud, events.append)
    assert (cloud.acquired, cloud.visible, cloud.released) == (True, True, True)
    assert outcome["request_id"] == "REQ-2024-0042"
    assert outcome["status"] == "smoke_completed"
    assert outcome["release_status"] == "accepted"
    assert "claim_id" not in outcome
    assert next(e for e in events if e["type"] == "computer")["session_id"] == "pc-session-1"


@pytest.mark.asyncio
async def test_lost_acquire_response_is_unknown_not_a_claim_that_nothing_was_allocated():
    class LostResponse(Cloud):
        async def call(self, name, arguments):
            if name == "mcp_W365ComputerUse_StartSession":
                self.acquired = True
                raise TimeoutError("response lost")
            return await super().call(name, arguments)

    outcome = await run(handoff(), "smoke", LostResponse(), lambda e: None)
    assert outcome["release_status"] == "unknown"
    assert outcome["status"] == "error"


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["readiness", "tool", "cancel", "release", "malformed"])
async def test_every_acquired_session_gets_release_attempt_even_on_failure(failure):
    class Failing(Cloud):
        release_attempted = False

        async def call(self, name, arguments):
            if name.endswith("StartSession") and failure == "malformed":
                return result("{}")
            if name == "get_screen_size" and failure == "readiness":
                return CallToolResult(is_error=True, content=[])
            if name == "launch_application" and failure == "tool":
                return CallToolResult(is_error=True, content=[])
            if name == "launch_application" and failure == "cancel":
                raise asyncio.CancelledError()
            if name.endswith("EndSession"):
                self.release_attempted = True
                if failure == "release":
                    raise TimeoutError("release failed")
            return await super().call(name, arguments)

    cloud = Failing()
    outcome = await run(
        handoff(), "smoke", cloud, lambda e: None, ready_timeout=0.01, poll_interval=0.001
    )
    assert cloud.release_attempted is (failure != "malformed")
    assert outcome["release_status"] == (
        "unknown" if failure == "malformed" else "failed" if failure == "release" else "accepted"
    )
    assert outcome["status"] == ("smoke_completed" if failure == "release" else "error")


@pytest.mark.asyncio
async def test_claims_model_failure_still_releases_and_returns_correlated_error_contract():
    class FailedModel:
        async def respond(self, messages, tools, max_output_tokens=None):
            raise RuntimeError("external model failed")

    cloud = Cloud()
    outcome = await run(handoff(), "claims", cloud, lambda e: None, model=FailedModel())
    assert cloud.released
    assert outcome["result"]["request_id"] == "REQ-2024-0042"
    assert outcome["result"]["status"] == "error"
    assert outcome["release_status"] == "accepted"


@pytest.mark.asyncio
async def test_visible_action_waits_for_viewer_and_failure_to_attach_releases():
    cloud = Cloud()

    async def viewer():
        assert cloud.acquired and not cloud.visible
        raise TimeoutError("viewer never attached")

    outcome = await run(handoff(), "smoke", cloud, lambda e: None, wait_for_viewer=viewer)
    assert not cloud.visible
    assert cloud.released
    assert outcome["status"] == "error"


@pytest.mark.asyncio
async def test_smoke_waits_for_the_new_window_instead_of_claiming_launch_is_immediate():
    class SlowWindow(Cloud):
        observations = 0

        async def call(self, name, arguments):
            if name == "get_accessibility_tree":
                self.observations += 1
                if self.observations == 1:
                    return result('{"name":"Desktop"}')
            return await super().call(name, arguments)

    cloud = SlowWindow()
    outcome = await run(handoff(), "smoke", cloud, lambda e: None, poll_interval=0.001)
    assert outcome["status"] == "smoke_completed"
    assert cloud.observations == 2
    assert cloud.released


@pytest.mark.asyncio
async def test_repeated_cancellation_cannot_cancel_the_bounded_release_attempt():
    releasing = asyncio.Event()
    finish = asyncio.Event()

    class DelayedRelease(Cloud):
        async def call(self, name, arguments):
            if name.endswith("EndSession"):
                releasing.set()
                await finish.wait()
            return await super().call(name, arguments)

    cloud = DelayedRelease()
    task = asyncio.create_task(run(handoff(), "smoke", cloud, lambda e: None))
    await asyncio.wait_for(releasing.wait(), 1)
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()
    await asyncio.sleep(0)
    finish.set()
    outcome = await task
    assert outcome["release_status"] == "accepted"
    assert cloud.released


@pytest.mark.asyncio
async def test_screen_check_runs_while_the_viewer_connects_and_claims_reuses_the_first_full_read():
    order = []

    class Recording(Cloud):
        async def call(self, name, arguments):
            if name == "get_accessibility_tree":
                order.append(f"read depth {arguments['maxDepth']}")
            elif name == "launch_application":
                order.append("launch")
            return await super().call(name, arguments)

    class Stop:
        async def respond(self, messages, tools, max_output_tokens=None):
            order.append("model")
            return {"status": "completed", "output": [{
                "type": "function_call", "name": "finish_claim", "call_id": "c1",
                "arguments": '{"status":"error","error_code":"UNKNOWN","message":"stop"}'}]}

    async def viewer():
        order.append("viewer connected")

    cloud = Recording()
    outcome = await run(handoff(), "claims", cloud, lambda e: None, model=Stop(), wait_for_viewer=viewer)
    assert outcome["release_status"] == "accepted"
    # Read-only setup check first, nothing visible until the viewer is connected, and the one
    # full screen read after launch is the screen Claims starts from.
    assert order == ["read depth 10", "viewer connected", "launch", "read depth 6", "model"]
