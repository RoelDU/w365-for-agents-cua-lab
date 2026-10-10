"""REQ-2026-576139834574 (8 Oct): the run ended with "The Computer-Use service rejected the tool
call. See service diagnostics." but the rejection's own reason, the tool and the step were
dropped, so whether Claims or Submit was reached could not be told from the record.

NOT LIVE: the rejection bodies below are synthetic; the live reply was not kept.
"""

import json

import pytest
from claims_app import ClaimsApp
from mcp.types import CallToolResult, TextContent
from test_claims import FILED, JOURNEY, Script
from test_contract import handoff
from test_lifecycle import Cloud, result

from hosted_claims.claims import perform_claims
from hosted_claims.engine import ToolRejected, run, service_diagnostic

JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eXoxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVlLTEyMzQ1"
VIEW_URL = "https://pc.example/computers/pc-42/screenshare?api-version=v1&token=abc"
REJECTION = json.dumps(
    {
        "error": {
            "code": "SessionNotReady",
            "message": f"Session is not ready. Bearer {JWT} see {VIEW_URL} sig=secretvalue",
            "correlationId": "0f8c2a1e-6b7d-4c1a-9e2f-123456789abc",
        }
    }
)


def rejected(text=REJECTION):
    return CallToolResult(content=[TextContent(type="text", text=text)], isError=True)


def error_event(events):
    return next(e for e in events if e["type"] == "error")


class RejectsOnce(Cloud):
    def __init__(self, tool):
        super().__init__()
        self.tool = tool

    async def call(self, name, arguments):
        if name == self.tool:
            return rejected()
        return await super().call(name, arguments)


class RejectsReads(Cloud):
    """The first ``times`` screen reads are rejected (inferred, from timing, to be
    REQ-2026-576139834574's failing step)."""

    def __init__(self, times):
        super().__init__()
        self.times = times
        self.calls = []

    async def call(self, name, arguments):
        self.calls.append(name)
        if name == "get_accessibility_tree" and self.times > 0:
            self.times -= 1
            return rejected()
        return await super().call(name, arguments)


FAST = {"poll_interval": 0.001, "setup_poll_interval": 0.001}


@pytest.mark.asyncio
async def test_req_576_a_rejected_first_screen_read_is_retried_and_claims_then_opens():
    cloud = RejectsReads(times=2)
    events = []
    outcome = await run(handoff(), "smoke", cloud, events.append, **FAST)
    assert outcome["status"] == "smoke_completed"
    assert "launch_application" in cloud.calls and cloud.released
    failed = [e for e in events if e["type"] == "tool_failed"]
    assert len(failed) == 2
    assert failed[0]["tool"] == "get_accessibility_tree"
    assert failed[0]["diagnostic"]["service_code"] == "SessionNotReady"
    assert "eyJ" not in json.dumps(events) and "secretvalue" not in json.dumps(events)


@pytest.mark.asyncio
async def test_screen_reads_rejected_for_the_whole_check_name_the_reason_and_no_submit():
    cloud = RejectsReads(times=10**6)
    events = []
    outcome = await run(handoff(), "smoke", cloud, events.append, setup_timeout=0.05, **FAST)
    message = outcome["message"]
    assert message.startswith(
        "Windows 365 rejected every screen read for 0 seconds after the Cloud PC answered "
        "(Session is not ready."
    )
    assert message.endswith("so Claims was not opened and no Submit was sent.")
    assert "launch_application" not in cloud.calls
    error = error_event(events)
    assert error["diagnostic"]["setup_screen_observed"] is False
    assert error["diagnostic"]["last_rejection"]["service_code"] == "SessionNotReady"
    assert (
        error["diagnostic"]["last_rejection"]["service_correlation_id"]
        == "0f8c2a1e-6b7d-4c1a-9e2f-123456789abc"
    )
    assert error["context"] == {
        "stage": "desktop_setup_check",
        "last_tool_started": "get_accessibility_tree",
        "submit_sent": False,
    }
    record = json.dumps(events)
    assert JWT not in record and "eyJ" not in record
    assert "https://" not in json.dumps(error) and "secretvalue" not in record
    assert outcome["result"]["error_code"] == "UNKNOWN"
    assert outcome["release_status"] == "accepted"


@pytest.mark.asyncio
async def test_a_rejected_screen_read_after_claims_opened_still_stops_with_tool_step_and_reason():
    class RejectsAfterLaunch(Cloud):
        async def call(self, name, arguments):
            if name == "get_accessibility_tree" and self.visible:
                return rejected()
            return await super().call(name, arguments)

    events = []
    outcome = await run(handoff(), "smoke", RejectsAfterLaunch(), events.append)
    assert outcome["message"].startswith(
        "Windows 365 Computer-Use rejected get_accessibility_tree during the check that Claims "
        "is in front (service code SessionNotReady; Session is not ready."
    )
    assert "this run sent no Submit Claim" in outcome["message"]
    assert error_event(events)["context"]["stage"] == "bring_claims_to_front"
    assert outcome["release_status"] == "accepted"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool", "stage"),
    [
        ("mcp_W365ComputerUse_GetSessionDetails", "confirm_session"),
        ("launch_application", "launch_claims"),
    ],
)
async def test_each_step_is_recorded_with_the_rejected_tool_and_the_session_is_released(
    tool, stage
):
    cloud = RejectsOnce(tool)
    events = []
    outcome = await run(handoff(), "smoke", cloud, events.append)
    assert f"rejected {tool} during" in outcome["message"]
    assert error_event(events)["context"]["stage"] == stage
    assert error_event(events)["context"]["last_tool_started"] == tool
    assert cloud.released and outcome["release_status"] == "accepted"


@pytest.mark.asyncio
async def test_readiness_that_only_ever_saw_rejections_keeps_the_last_reason():
    events = []
    outcome = await run(
        handoff(),
        "smoke",
        RejectsOnce("get_screen_size"),
        events.append,
        ready_timeout=0.05,
        poll_interval=0.001,
    )
    assert "did not answer" in outcome["message"]
    assert error_event(events)["diagnostic"]["service_code"] == "SessionNotReady"
    assert error_event(events)["context"]["stage"] == "wait_until_ready"


def test_plain_text_rejection_is_bounded_and_opaque_blobs_are_removed():
    service = service_diagnostic(rejected("Denied " + "A" * 80 + " " + "x " * 400))
    assert len(service["service_message"]) <= 300
    assert "A" * 60 not in service["service_message"]
    assert service["service_message"].startswith("Denied [redacted]")
    assert "service_code" not in service


def test_a_rejection_without_text_still_says_the_service_gave_no_reason():
    with pytest.raises(ToolRejected) as caught:
        from hosted_claims.engine import text_content

        text_content(CallToolResult(content=[], isError=True))
    assert caught.value.diagnostic == {"content_types": [], "text_length": 0}


# Scout QA 8 Oct (qa-foundry-diagnostic-repair-20261008): three synthetic replies kept a secret.
SENTINEL = "SYNTHETIC_SENTINEL"


def assert_no_sentinel(service):
    assert SENTINEL not in json.dumps(service)
    assert "SYNTHETIC" not in json.dumps(service)


@pytest.mark.parametrize(
    "message",
    [
        f'Rejected password="{SENTINEL}"',
        f"Rejected password='{SENTINEL}'",
        f'Rejected password: "{SENTINEL}"',
        f'Rejected "password":"{SENTINEL}"',
        f'Rejected password=\\"{SENTINEL}\\"',
        f'Rejected client_secret = "{SENTINEL} with spaces"',
        f'Rejected token is "{SENTINEL}"',
        f"Rejected the secret value was '{SENTINEL}'",
        f'Rejected api-key "{SENTINEL}"',
        "Rejected Authorization: Basic U1lOVEhFVElDX1NFTlRJTkVM",
    ],
)
def test_quoted_secret_values_in_a_service_message_are_redacted(message):
    reply = json.dumps({"error": {"code": "Denied", "message": message}})
    service = service_diagnostic(rejected(reply))
    assert_no_sentinel(service)
    assert "U1lOVEhFVElDX1NFTlRJTkVM" not in json.dumps(service)
    assert service["service_code"] == "Denied"
    assert service["service_message"].startswith("Rejected ")
    assert "[redacted]" in service["service_message"]


def test_quoted_secret_in_a_plain_text_rejection_is_redacted_and_the_rest_kept():
    service = service_diagnostic(rejected(f'Denied: password="{SENTINEL}" for the agent user'))
    assert_no_sentinel(service)
    assert service["service_message"] == "Denied: password=[redacted] for the agent user"


def test_ordinary_words_near_secret_names_are_not_redacted():
    message = "The key vault is unavailable and the token expired; retry later."
    service = service_diagnostic(rejected(json.dumps({"error": {"message": message}})))
    assert service["service_message"] == message


@pytest.mark.parametrize(
    ("text", "code"),
    [
        (json.dumps({"error": {"code": "Denied", "details": {"password": SENTINEL}}}), "Denied"),
        (json.dumps({"code": "Denied", "data": {"nested": [{"secret": SENTINEL}]}}), "Denied"),
        (
            json.dumps(
                {"error": {"code": "Denied", "message": json.dumps({"password": SENTINEL})}}
            ),
            "Denied",
        ),
        (
            f'Request failed: {{"code": "Denied", "credentials": {{"value": "{SENTINEL}"}}}}',
            "Denied",
        ),
        (f'{{"code": "Denied", "password": "{SENTINEL}"', None),  # cut-off JSON that does not parse
        (f'["Denied", "{SENTINEL}"]', None),
    ],
    ids=[
        "nested-details",
        "nested-list",
        "json-in-message",
        "json-in-prose",
        "broken-json",
        "array",
    ],
)
def test_structured_reply_without_a_safe_message_is_never_dumped(text, code):
    service = service_diagnostic(rejected(text))
    assert_no_sentinel(service)
    assert "service_message" not in service
    assert service["service_message_withheld"] is True
    assert service["text_length"] == len(text)
    assert service.get("service_code") == code


@pytest.mark.asyncio
async def test_a_withheld_reason_is_said_plainly_in_the_run_message():
    class Nested(Cloud):
        async def call(self, name, arguments):
            if name == "launch_application":
                return rejected(json.dumps({"error": {"details": {"password": SENTINEL}}}))
            return await super().call(name, arguments)

    events = []
    outcome = await run(handoff(), "smoke", Nested(), events.append)
    assert SENTINEL not in json.dumps(events)
    assert (
        "the service's reason could not be recorded safely, so it was withheld"
        in outcome["message"]
    )


OPAQUE_70 = "Zx9" + "aB3cD4eF5gH6" * 5 + "Qw7rT8y"


@pytest.mark.parametrize(
    "error",
    [
        {"code": "Denied", "correlationId": OPAQUE_70},
        {"code": "Denied", "requestId": "k3J9xQ2mP8vL4nR7tY1wZ5"},
        {"code": OPAQUE_70[:48], "status": OPAQUE_70[:20]},
        {"code": "eyJhbGciOiJ9.eyJzdWIiOiJ4In0.c2ln", "traceId": "https://pc.example/x?sig=1"},
        {"code": "token=abc", "status": "password:x", "correlationId": "Bearer abcdefgh"},
        {"code": True, "status": {"value": SENTINEL}, "correlationId": ["x"]},
    ],
    ids=[
        "opaque-correlation",
        "mixed-request-id",
        "opaque-code",
        "jwt-and-url",
        "secret-pairs",
        "types",
    ],
)
def test_code_status_and_correlation_fields_never_carry_opaque_or_secret_values(error):
    service = service_diagnostic(rejected(json.dumps({"error": {**error, "message": "Denied."}})))
    kept = {k: service.get(k) for k in ("service_code", "service_status", "service_correlation_id")}
    for value in kept.values():
        assert value in (None, "Denied")
    assert OPAQUE_70 not in json.dumps(service)
    assert service["service_message"] == "Denied."


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            {
                "code": "SessionNotReady",
                "status": 409,
                "correlationId": "0f8c2a1e-6b7d-4c1a-9e2f-123456789abc",
            },
            {
                "service_code": "SessionNotReady",
                "service_status": "409",
                "service_correlation_id": "0f8c2a1e-6b7d-4c1a-9e2f-123456789abc",
            },
        ),
        (
            {"code": -32602, "status": "Forbidden", "traceId": "6b5965904cd3c8ef985a5b69bd26d424"},
            {
                "service_code": "-32602",
                "service_status": "Forbidden",
                "service_correlation_id": "6b5965904cd3c8ef985a5b69bd26d424",
            },
        ),
        (
            {"errorCode": "W365.Session.NotFound", "requestId": "ecae103f8a5ed766"},
            {"service_code": "W365.Session.NotFound", "service_correlation_id": "ecae103f8a5ed766"},
        ),
        (
            {"code": "AADSTS160021", "status": "SessionNotFoundInPool", "requestId": "req-abc123"},
            {
                "service_code": "AADSTS160021",
                "service_status": "SessionNotFoundInPool",
                "service_correlation_id": "req-abc123",
            },
        ),
    ],
)
def test_legitimate_codes_statuses_and_correlation_ids_are_kept(error, expected):
    message = "Session 0f8c2a1e-6b7d-4c1a-9e2f-123456789abc is not ready."
    service = service_diagnostic(rejected(json.dumps({"error": {**error, "message": message}})))
    assert {k: service[k] for k in expected} == expected
    assert service["service_message"] == message


class FullRun(ClaimsApp):
    """The whole hosted run against the Claims fixture; the Submit click itself is rejected."""

    async def call(self, name, arguments):
        if name == "mcp_W365ComputerUse_StartSession":
            return result('{"sessionId":"pc-session-1","screenShareUrl":"' + VIEW_URL + '"}')
        if name in (
            "mcp_W365ComputerUse_GetSessionDetails",
            "get_screen_size",
            "launch_application",
        ):
            return result("{}")
        if name == "mcp_W365ComputerUse_EndSession":
            self.released = True
            return result("Accepted")
        reply = await super().call(name, arguments)
        if name == "click" and self.submit_requests:
            return rejected()
        return reply


@pytest.mark.asyncio
async def test_a_rejection_after_submit_was_sent_says_the_claim_may_have_been_filed():
    app = FullRun()
    events = []
    outcome = await run(handoff(), "claims", app, events.append, model=Script(*JOURNEY, FILED))
    assert app.submit_requests == 1
    assert "rejected click during the Claims task" in outcome["message"]
    assert (
        "Submit Claim had already been sent, so the claim may have been filed" in outcome["message"]
    )
    assert error_event(events)["context"] == {
        "stage": "claims_task",
        "last_tool_started": "click",
        "submit_sent": True,
    }
    assert outcome["release_status"] == "accepted"


@pytest.mark.asyncio
async def test_perform_claims_marks_submit_only_when_it_is_actually_sent():
    state = {"submit_sent": False}
    app = ClaimsApp()
    await perform_claims(
        handoff(), "pc-session-1", app, Script(*JOURNEY, FILED), lambda e: None, state=state
    )
    assert state == {"submit_sent": True} and app.submit_requests == 1

    theft = {**handoff(), "intent": "auto_theft"}
    state = {"submit_sent": False}
    with pytest.raises(Exception, match="refused twice"):
        await perform_claims(
            theft,
            "pc-session-1",
            ClaimsApp(),
            Script(*JOURNEY, JOURNEY[-1]),
            lambda e: None,
            state=state,
        )
    assert state == {"submit_sent": False}


class FullRunNoRejection(FullRun):
    """The whole hosted run against the Claims fixture with nothing rejected."""

    async def call(self, name, arguments):
        if name == "click":
            return await ClaimsApp.call(self, name, arguments)
        return await super().call(name, arguments)


class ConfirmationNotShown(FullRunNoRejection):
    """Submit files the claim, but no confirmation dialog appears."""

    def submit(self):
        super().submit()
        self.dialog = None


AFTER_SUBMIT_ERROR = ("finish_claim", {"status": "error", "error_code": "UNKNOWN", "message": "Unsure."})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("app", "turns", "status", "sent"),
    [
        (FullRunNoRejection, (*JOURNEY, FILED), "submitted", True),
        (FullRun, (*JOURNEY, FILED), "error", True),
        # Release QA R5: the model's own error report after Submit gave no sign of the Submit.
        (ConfirmationNotShown, (*JOURNEY, AFTER_SUBMIT_ERROR), "error", True),
        (FullRunNoRejection, (AFTER_SUBMIT_ERROR,), "error", False),
    ],
)
async def test_every_claims_outcome_says_whether_submit_was_sent(app, turns, status, sent):
    outcome = await run(handoff(), "claims", app(), lambda e: None, model=Script(*turns))
    assert outcome["status"] == status
    assert outcome["submit_sent"] is sent
    assert outcome["release_status"] == "accepted"


@pytest.mark.asyncio
async def test_a_run_that_stops_before_claims_says_submit_was_not_sent():
    outcome = await run(handoff(), "smoke", RejectsReads(times=10**6), lambda e: None, setup_timeout=0.05, **FAST)
    assert outcome["status"] == "error" and outcome["submit_sent"] is False
