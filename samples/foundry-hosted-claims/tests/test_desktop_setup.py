"""Smoke 02d (REQ-2026-10010005): the live video showed Windows "Setting up for work or school"
(Account setup: Working on it) after get_screen_size answered. launch_application completed, but
Claims Workstation never appeared in the foreground-only accessibility tree. Whether a Claims
window existed at all is unknown; the list_windows diagnostic is there to tell on a later run.

NOT LIVE: every accessibility-tree text below is a synthetic fixture. The live run captured the
screen text in video, not the tree reply, so the node shape is invented.
"""

import asyncio

import pytest
from mcp.types import CallToolResult, TextContent
from test_contract import handoff
from test_lifecycle import Cloud, result

from hosted_claims.engine import RunError, run

SETUP_TREE = (
    '{"role":"Window","name":"","children":[{"role":"Text","name":"Setting up for work or school"},'
    '{"role":"Text","name":"Account setup"},{"role":"Text","name":"Working on it..."}]}'
)
FAST = {"poll_interval": 0.001, "setup_poll_interval": 0.001}


class SetupScreen(Cloud):
    """Windows enrollment setup is in front for ``setup_observations`` tree reads."""

    def __init__(self, setup_observations):
        super().__init__()
        self.setup_observations = setup_observations
        self.launched_during_setup = False
        self.calls = []

    async def call(self, name, arguments):
        self.calls.append(name)
        if name == "launch_application" and self.setup_observations > 0:
            self.launched_during_setup = True
        if name == "get_accessibility_tree" and self.setup_observations > 0:
            self.setup_observations -= 1
            return result(SETUP_TREE)
        return await super().call(name, arguments)


class UnreadableScreen(Cloud):
    """The tree read stalls past every bound before returning any screen evidence."""

    def __init__(self):
        super().__init__()
        self.calls = []

    async def call(self, name, arguments):
        self.calls.append(name)
        if name == "get_accessibility_tree":
            await asyncio.sleep(60)
        if name == "list_windows":
            return CallToolResult(content=[TextContent(type="text", text="[]")])
        return await super().call(name, arguments)


def error_event(events):
    return next(e for e in events if e["type"] == "error")


@pytest.mark.asyncio
async def test_02d_replay_confirmed_setup_is_named_promptly_and_claims_is_not_launched():
    cloud = SetupScreen(setup_observations=10**6)
    events = []
    outcome = await run(handoff(), "smoke", cloud, events.append, setup_timeout=0.05, **FAST)
    assert outcome["status"] == "error"
    assert "launch_application" not in cloud.calls
    assert "Setting up for work or school" in outcome["message"]
    assert "TimeoutError" not in outcome["message"]
    assert error_event(events)["diagnostic"] == {"setup_screen_observed": True}
    assert outcome["release_status"] == "accepted"
    assert cloud.released


@pytest.mark.asyncio
async def test_unreadable_screen_before_launch_does_not_claim_windows_setup():
    cloud = UnreadableScreen()
    events = []
    outcome = await run(handoff(), "smoke", cloud, events.append, setup_timeout=0.05, **FAST)
    assert outcome["status"] == "error"
    assert "launch_application" not in cloud.calls
    assert "could not be read" in outcome["message"]
    assert "Setting up for work or school" not in outcome["message"]
    assert "account setup" not in outcome["message"].lower()
    assert error_event(events)["diagnostic"] == {"setup_screen_observed": False}
    assert outcome["release_status"] == "accepted"


def test_ordinary_setup_grace_is_short():
    from hosted_claims.engine import DESKTOP_SETUP_GRACE_SECONDS

    assert DESKTOP_SETUP_GRACE_SECONDS <= 60


@pytest.mark.asyncio
async def test_setup_screen_that_clears_is_reported_then_claims_opens():
    cloud = SetupScreen(setup_observations=2)
    events = []
    outcome = await run(
        handoff(), "smoke", cloud, events.append, setup_timeout=5, window_timeout=5, **FAST
    )
    assert outcome["status"] == "smoke_completed"
    assert not cloud.launched_during_setup
    plans = [e["message"] for e in events if e["type"] == "plan"]
    assert sum("Setting up for work or school" in p for p in plans) == 1
    assert cloud.released


@pytest.mark.asyncio
async def test_claims_window_not_in_foreground_is_named_instead_of_a_bare_timeout():
    class Background(Cloud):
        async def call(self, name, arguments):
            if name == "get_accessibility_tree":
                return result('{"role":"Window","name":"Desktop"}')
            if name == "list_windows":
                return CallToolResult(
                    content=[TextContent(type="text", text='[{"title":"Program Manager"}]')]
                )
            if name == "activate_window":
                return CallToolResult(
                    content=[TextContent(type="text", text="No matching window")], isError=True
                )
            return await super().call(name, arguments)

    events = []
    outcome = await run(
        handoff(),
        "smoke",
        Background(),
        events.append,
        setup_timeout=1,
        window_timeout=0.05,
        **FAST,
    )
    assert outcome["status"] == "error"
    assert "Claims Workstation" in outcome["message"]
    assert "TimeoutError" not in outcome["message"]
    assert outcome["release_status"] == "accepted"
    assert error_event(events)["diagnostic"] == {
        "screen_observed": True,
        "setup_screen_foreground": False,
        "claims_window_listed": False,
        "claims_activation": "window_not_found",
    }


EDGE_TREE = '{"role":"Window","name":"about:blank - Microsoft Edge","children":[]}'
CLAIMS_TREE = '{"role":"Window","name":"Zava Mutual - Claims Workstation v1.0","children":[]}'
NOT_FOUND = "No window found matching 'Claims Workstation'"
APPROVAL = "Computer-Use requires additional input or approval; no automatic bypass."


class CoveredByEdge(Cloud):
    """Live smoke (3 Oct 2026): after launch_application a blank Edge window opened at first
    sign-in stayed in front of Claims. NOT LIVE: tree texts and error texts are fixtures.

    ``replies`` drives activate_window: "ok", ("error", text) or an exception to raise."""

    def __init__(self, replies=("ok",), activation_works=True):
        super().__init__()
        self.replies = list(replies)
        self.activation_works = activation_works
        self.claims_in_front = False
        self.activations = []
        self.calls = []

    async def call(self, name, arguments):
        self.calls.append(name)
        if name == "activate_window":
            self.activations.append(arguments)
            reply = self.replies.pop(0) if self.replies else "ok"
            if isinstance(reply, Exception):
                raise reply
            if isinstance(reply, tuple):
                return CallToolResult(content=[TextContent(type="text", text=reply[1])], isError=True)
            if self.activation_works:
                self.claims_in_front = True
            return result('{"activated":true}')
        if name == "get_accessibility_tree" and "launch_application" in self.calls:
            return result(CLAIMS_TREE if self.claims_in_front else EDGE_TREE)
        if name == "list_windows":
            return result('[{"title":"about:blank - Microsoft Edge"},{"title":"Claims Workstation"}]')
        return await super().call(name, arguments)


async def covered_run(cloud, window_timeout=5):
    events = []
    outcome = await run(
        handoff(), "smoke", cloud, events.append, setup_timeout=1, window_timeout=window_timeout, **FAST
    )
    return outcome, events


@pytest.mark.asyncio
async def test_claims_behind_edge_is_activated_then_observed_in_front_without_claiming_activation():
    cloud = CoveredByEdge()
    outcome, events = await covered_run(cloud)
    assert outcome["status"] == "smoke_completed"
    assert cloud.activations == [{"sessionId": "pc-session-1", "title": "Claims Workstation"}]
    assert "Claims Workstation" in next(e for e in events if e["type"] == "observation")["message"]
    plans = " ".join(e["message"] for e in events if e["type"] == "plan")
    assert "observed in the foreground" in plans
    assert "brought" not in plans
    assert cloud.released


@pytest.mark.asyncio
async def test_activation_without_effect_is_requested_once_then_stops_named_and_releases():
    cloud = CoveredByEdge(activation_works=False)
    outcome, events = await covered_run(cloud, window_timeout=0.05)
    assert outcome["status"] == "error"
    assert "not seen as the foreground window" in outcome["message"]
    assert len(cloud.activations) == 1
    diagnostic = error_event(events)["diagnostic"]
    assert diagnostic["claims_activation"] == "requested"
    assert diagnostic["claims_window_listed"] is True
    assert outcome["release_status"] == "accepted"
    assert cloud.released


@pytest.mark.asyncio
async def test_only_a_window_not_found_reply_is_retried_within_the_bound():
    cloud = CoveredByEdge(replies=[("error", NOT_FOUND), ("error", NOT_FOUND), "ok"])
    outcome, _ = await covered_run(cloud)
    assert outcome["status"] == "smoke_completed"
    assert len(cloud.activations) == 3
    assert cloud.released


@pytest.mark.asyncio
async def test_approval_required_during_activation_stops_without_retry_and_releases():
    cloud = CoveredByEdge(replies=[RunError(APPROVAL)])
    outcome, _ = await covered_run(cloud)
    assert outcome["status"] == "error"
    assert "approval" in outcome["message"]
    assert len(cloud.activations) == 1
    assert outcome["release_status"] == "accepted"
    assert cloud.released


@pytest.mark.asyncio
async def test_other_rejected_activation_stops_without_retry_and_releases():
    cloud = CoveredByEdge(replies=[("error", "Access denied by policy")])
    outcome, _ = await covered_run(cloud)
    assert outcome["status"] == "error"
    assert "rejected" in outcome["message"]
    assert "not seen as the foreground window" not in outcome["message"]
    assert len(cloud.activations) == 1
    assert outcome["release_status"] == "accepted"
    assert cloud.released


@pytest.mark.asyncio
async def test_session_guard_error_during_activation_stops_without_retry_and_releases():
    cloud = CoveredByEdge(replies=[ValueError("Tool call does not match the acquired Cloud PC session.")])
    outcome, _ = await covered_run(cloud)
    assert outcome["status"] == "error"
    assert len(cloud.activations) == 1
    assert outcome["release_status"] == "accepted"
    assert cloud.released