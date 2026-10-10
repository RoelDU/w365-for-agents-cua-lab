import pytest
from mcp import MCPError
from mcp.types import REQUEST_TIMEOUT, CallToolResult, ImageContent
from test_contract import handoff
from test_lifecycle import Cloud, result

from hosted_claims.engine import UnreadableReply, object_content, run, session_id_from

SESSION = "3f2c9a1e-7b4d-4c2a-9e8f-0a1b2c3d4e5f"
OTHER = "aa2c9a1e-7b4d-4c2a-9e8f-0a1b2c3d4e5f"


@pytest.mark.parametrize(
    "reply",
    [
        CallToolResult(content=[], structured_content={"sessionId": SESSION}),
        result(f'{{"sessionId":"{SESSION}","status":"Waiting"}}'),
        result(f'Session started: {{"sessionId": "{SESSION}"}}'),
        result(f"Session started.\nSessionId: {SESSION}\nStatus: Waiting"),
        result(f"Session ID: {SESSION}."),
        result(f'{{"session_id": "{SESSION}"}}'),
    ],
    ids=[
        "structured",
        "json",
        "embedded-json",
        "key-value-text",
        "spaced-label-with-full-stop",
        "snake-case-json",
    ],
)
def test_start_session_reply_yields_session_id_whatever_the_documented_text_shape(reply):
    session_id, _ = session_id_from(reply)
    assert session_id == SESSION


@pytest.mark.parametrize(
    "reply",
    [
        result(""),
        CallToolResult(content=[ImageContent(type="image", data="AAAA", mimeType="image/png")]),
        result(f"Session {SESSION} replaced {OTHER}"),
        result("Session started successfully."),
        result(f"Started Windows 365 Computer Use session {SESSION}."),
        result(SESSION),
        result(f'{{"requestId": "{SESSION}", "status": "Waiting"}}'),
        CallToolResult(content=[], structured_content={"id": SESSION}),
        result(f"Correlation ID: {SESSION}. Session starting."),
    ],
    ids=[
        "empty",
        "no-text",
        "two-ids",
        "no-id",
        "lone-id-in-prose",
        "bare-id",
        "unrelated-json-field",
        "unrelated-structured-field",
        "unrelated-labelled-id",
    ],
)
def test_unreadable_start_reply_is_an_explicit_cleanup_error_not_a_json_crash(reply):
    with pytest.raises(UnreadableReply, match="administrator cleanup") as raised:
        session_id_from(reply)
    assert "unknown" in str(raised.value) and "minutes" not in str(raised.value)
    shape = raised.value.shape
    assert set(shape) >= {"content_types", "text_length", "json", "id_count"}
    assert SESSION not in repr(shape) and "started" not in repr(shape).lower()


def test_session_details_status_is_read_from_plain_text():
    assert object_content(result("Status: Ready"))["status"] == "Ready"
    assert object_content(result("Session status: Ready."))["status"] == "Ready"


@pytest.mark.asyncio
async def test_plain_text_start_reply_runs_and_releases_the_same_session():
    class TextReplies(Cloud):
        async def call(self, name, arguments):
            if name.endswith("StartSession"):
                self.acquired = True
                return result("Session started. sessionId: pc-session-1")
            if name.endswith("GetSessionDetails"):
                return result("Status: Ready")
            return await super().call(name, arguments)

    cloud = TextReplies()
    outcome = await run(handoff(), "smoke", cloud, lambda e: None)
    assert outcome["status"] == "smoke_completed"
    assert outcome["release_status"] == "accepted"
    assert cloud.released


@pytest.mark.asyncio
async def test_unreadable_start_reply_reports_cleanup_and_a_value_free_shape():
    class Unreadable(Cloud):
        async def call(self, name, arguments):
            if name.endswith("StartSession"):
                self.acquired = True
                return result("Session started successfully.")
            return await super().call(name, arguments)

    events = []
    cloud = Unreadable()
    outcome = await run(handoff(), "smoke", cloud, events.append)
    error = next(e for e in events if e["type"] == "error")
    assert outcome["status"] == "error"
    assert outcome["release_status"] == "unknown"
    assert "administrator cleanup" in outcome["message"]
    assert "JSONDecodeError" not in outcome["message"]
    assert error["diagnostic"]["text_length"] == len("Session started successfully.")
    assert "started" not in repr(error["diagnostic"]).lower()
    assert not cloud.released


@pytest.mark.asyncio
async def test_session_details_naming_a_different_session_stop_the_run_and_release_our_own():
    class Mismatched(Cloud):
        async def call(self, name, arguments):
            if name.endswith("StartSession"):
                self.acquired = True
                return result(f'{{"sessionId": "{SESSION}"}}')
            if name.endswith("GetSessionDetails"):
                return result(f'{{"sessionId": "{OTHER}", "status": "Ready"}}')
            if name.endswith("EndSession"):
                self.ended_with = arguments["sessionId"]
            return await super().call(name, arguments)

    events = []
    cloud = Mismatched()
    outcome = await run(handoff(), "smoke", cloud, events.append)
    assert outcome["status"] == "error"
    assert "different session" in outcome["message"]
    assert not any(e["type"] == "readiness" for e in events)
    assert cloud.ended_with == SESSION


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "details",
    [
        result(f'{{"sessionId": "{SESSION}", "computerName": "CPC-1"}}'),
        result("Session details retrieved."),
        CallToolResult(content=[], structured_content={"state": "Unexpected"}),
    ],
    ids=["no-status-field", "unreadable-prose", "unknown-field"],
)
async def test_undocumented_session_details_do_not_stop_a_pc_that_answers(details):
    # Live 02b (2026-10-02 09:52Z): Get Session Details had no status field and the run stopped.
    class Undocumented(Cloud):
        async def call(self, name, arguments):
            if name.endswith("StartSession"):
                self.acquired = True
                return result(f'{{"sessionId": "{SESSION}"}}')
            if name.endswith("GetSessionDetails"):
                return details
            return await super().call(name, {**arguments, "sessionId": "pc-session-1"})

    events = []
    cloud = Undocumented()
    outcome = await run(handoff(), "smoke", cloud, events.append)
    assert outcome["status"] == "smoke_completed"
    recorded = next(e for e in events if e["type"] == "session_details")
    assert "CPC-1" not in repr(recorded) and "retrieved" not in repr(recorded).lower()
    assert any(e["type"] == "readiness" for e in events)


@pytest.mark.asyncio
async def test_pc_that_answers_only_after_retries_is_ready_and_one_that_never_answers_stops():
    class SlowToAnswer(Cloud):
        attempts = 0

        async def call(self, name, arguments):
            if name == "get_screen_size":
                self.attempts += 1
                if self.attempts < 3:
                    raise ConnectionError("not yet")
            return await super().call(name, arguments)

    cloud = SlowToAnswer()
    outcome = await run(handoff(), "smoke", cloud, lambda e: None, poll_interval=0.001)
    assert outcome["status"] == "smoke_completed" and cloud.attempts == 3

    class NeverAnswers(Cloud):
        async def call(self, name, arguments):
            if name == "get_screen_size":
                raise ConnectionError("not yet")
            return await super().call(name, arguments)

    cloud = NeverAnswers()
    outcome = await run(
        handoff(), "smoke", cloud, lambda e: None, ready_timeout=0.05, poll_interval=0.001
    )
    assert outcome["status"] == "error"
    assert "did not answer" in outcome["message"] and "ConnectionError" in outcome["message"]
    assert cloud.released


@pytest.mark.asyncio
async def test_start_session_timeout_reports_uncertain_allocation_and_safe_code():
    class Slow(Cloud):
        async def call(self, name, arguments):
            if name.endswith("StartSession"):
                raise MCPError(REQUEST_TIMEOUT, "Timed out after 120s waiting for 'tools/call'")
            return await super().call(name, arguments)

    events = []
    cloud = Slow()
    outcome = await run(handoff(), "smoke", cloud, events.append)
    error = next(e for e in events if e["type"] == "error")
    assert outcome["status"] == "error"
    assert outcome["release_status"] == "unknown"
    assert "Start Session did not answer" in outcome["message"]
    assert "uncertain" in outcome["message"]
    assert error["diagnostic"] == {"mcp_error_code": REQUEST_TIMEOUT}
    assert not cloud.released
