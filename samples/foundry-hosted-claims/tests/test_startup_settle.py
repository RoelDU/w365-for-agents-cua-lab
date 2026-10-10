"""The start-up wait before any input (REQ-2026-693651046301, 10 Oct 2026).

Microsoft Defender process records for every Foundry Cloud PC (2-10 Oct 2026) show the Windows 365
tool server, DesktopControl.Mcp.exe, starting a remote-controlled Edge window (about:blank) in about
half of the sessions, 14.4-16.9 s after Start Session returned to this agent in the affected runs,
whatever the agent was doing. In the failed run it took the front and received the pasted policy
number. The Edge screen used here is the one Windows 365 returned in that run. NOT a live run.
"""

import asyncio

import pytest
from claims_app import EDGE, ClaimsApp
from test_claims import FILED, JOURNEY, Script
from test_contract import handoff
from test_lifecycle import result

from hosted_claims import engine
from hosted_claims.engine import run

SETTLE = 0.4
POLL = 0.05
ACTIVATE = ("activate_window", {"title": "Claims Workstation"})


class Hosted(ClaimsApp):
    """The whole hosted run against the Claims stand-in, with the time of every call."""

    def __init__(self):
        super().__init__()
        self.times = []
        self.started = None

    async def call(self, name, arguments):
        self.times.append((asyncio.get_running_loop().time(), name))
        self.full_reads = getattr(self, "full_reads", [])
        if name == "get_accessibility_tree" and arguments.get("maxDepth") == 6:
            self.full_reads.append(asyncio.get_running_loop().time())
        if name == "mcp_W365ComputerUse_StartSession":
            self.started = asyncio.get_running_loop().time()
            return result('{"sessionId":"pc-session-1","screenShareUrl":"https://pc.example/s"}')
        if name in ("mcp_W365ComputerUse_GetSessionDetails", "get_screen_size", "launch_application"):
            return result("{}")
        if name == "mcp_W365ComputerUse_EndSession":
            self.released = True
            return result("Accepted")
        return await super().call(name, arguments)

    def first_input(self):
        return next(t for t, n in self.times if n in ("click", "type_text", "press_keys"))


def edge_at_poll(n):
    """Edge comes to the front at the n-th small screen read of the start-up wait."""
    def when(calls, name, args):
        polls = [c for c in calls if c[0] == "get_accessibility_tree" and c[1].get("maxDepth") == 2]
        return name == "get_accessibility_tree" and args.get("maxDepth") == 2 and len(polls) == n - 1
    return when


async def hosted_run(app, model, events, settle=SETTLE):
    return await run(
        handoff(), "claims", app, events.append, model=model,
        poll_interval=0.001, setup_poll_interval=0.001,
        settle_seconds=settle, settle_poll_interval=POLL,
    )


def checks(events):
    return [e["message"] for e in events if e["type"] == "check"]


def test_the_wait_covers_every_service_browser_seen_in_the_defender_records(monkeypatch):
    monkeypatch.undo()  # the real value, not the tests' zero
    # Latest Edge start 26.9 s after the tool server started, which was at least 5.5 s before
    # Start Session returned (21.4 s), plus up to ~4 s for that window to take the front.
    assert engine.SERVICE_BROWSER_SETTLE_SECONDS >= 21.4 + 4
    assert engine.SERVICE_BROWSER_SETTLE_SECONDS <= 30  # the 20-minute status window is unchanged


@pytest.mark.asyncio
async def test_nothing_is_clicked_or_typed_before_the_wait_ends_and_the_claim_is_filed_once():
    app = Hosted()
    events = []
    outcome = await hosted_run(app, Script(*JOURNEY, FILED), events)
    assert outcome["status"] == "submitted" and app.submit_requests == 1
    assert app.first_input() >= app.started + SETTLE
    plans = [e["message"] for e in events if e["type"] == "plan"]
    assert any("nothing is clicked or typed for another" in p for p in plans)
    assert "The Cloud PC has finished starting and Claims Workstation is in front; input can begin." in checks(events)
    assert outcome["release_status"] == "accepted" and app.released


@pytest.mark.asyncio
async def test_the_service_browser_opening_during_the_wait_is_sent_back_and_nothing_reaches_it():
    app = Hosted()
    app.cover_when = edge_at_poll(2)
    events = []
    outcome = await hosted_run(app, Script(*JOURNEY, FILED), events)
    assert outcome["status"] == "submitted" and outcome["result"]["claim_id"] == "CLM-2026-000221"
    assert app.submit_requests == 1 and app.values["7010"] == "POL-2024-008341"
    assert app.cover_input == []
    # Claims was brought back during the wait, before the model's first action ran.
    activate = app.actions.index(ACTIVATE)
    assert all(a[0] not in ("click", "type_text") for a in app.actions[:activate])
    assert app.first_input() >= app.started + SETTLE
    assert any("came in front of Claims Workstation while the Cloud PC finished starting, before "
               "any input" in m and "about:blank" in m for m in checks(events))


@pytest.mark.asyncio
async def test_run_693651046301_timing_edge_after_the_model_chose_its_first_click_gets_no_input():
    # Live: the model chose the Policy # click from a screen with Claims in front; Edge came up
    # while it was deciding. Now that click waits; Edge comes up at the last read of the wait.
    app = Hosted()
    reads = {"n": 0}

    def at_final_read(calls, name, args):
        if name == "get_accessibility_tree" and args.get("maxDepth") == 6:
            reads["n"] += 1
            return reads["n"] == 2  # the first is the launch check; the second ends the wait
        return False

    app.cover_when = at_final_read
    events = []
    outcome = await hosted_run(app, Script(*JOURNEY, FILED), events)
    assert outcome["status"] == "submitted" and app.submit_requests == 1
    assert app.cover_input == [] and app.values["7010"] == "POL-2024-008341"
    assert app.actions.index(ACTIVATE) < app.actions.index(("click", {"x": 66, "y": 105}))


@pytest.mark.asyncio
async def test_a_service_browser_that_will_not_leave_stops_before_any_input_and_releases():
    app = Hosted()
    app.cover_when = edge_at_poll(1)
    app.cover_stays = True
    events = []
    outcome = await hosted_run(app, Script(*JOURNEY, FILED), events)
    assert outcome["status"] == "error"
    assert "Nothing was clicked or typed and no Submit was sent." in outcome["message"]
    assert app.cover_input == [] and app.submit_requests == 0
    assert not [a for a in app.actions if a[0] in ("click", "type_text", "press_keys")]
    assert app.actions.count(ACTIVATE) == 1  # confirmed not to work, so not asked again
    assert outcome["release_status"] == "accepted" and app.released


@pytest.mark.asyncio
async def test_a_slow_switch_back_is_confirmed_before_another_is_requested():
    class SlowSwitch(Hosted):
        lag = 0

        async def call(self, name, arguments):
            if name == "activate_window":
                self.lag = 2  # Claims comes forward only at the second read after the request
                self.actions.append(("activate_window", {"title": arguments["title"]}))
                return result("Done activate_window")
            if name == "get_accessibility_tree" and self.lag:
                self.lag -= 1
                if not self.lag:
                    self.cover = None
            return await super().call(name, arguments)

    app = SlowSwitch()
    app.cover_when = edge_at_poll(1)
    app.cover_stays = True
    events = []
    outcome = await hosted_run(app, Script(*JOURNEY, FILED), events)
    assert outcome["status"] == "submitted" and app.submit_requests == 1
    assert app.actions.count(ACTIVATE) == 1 and app.cover_input == []


@pytest.mark.asyncio
async def test_a_first_turn_finish_claim_is_not_checked_before_the_wait_ends():
    app = Hosted()
    events = []
    await hosted_run(app, Script(FILED), events)
    launch_check, *later = app.full_reads
    assert launch_check < app.started + SETTLE
    # The wait's own final read, then the finish_claim screen check: both only after the wait.
    assert len(later) >= 2 and all(t >= app.started + SETTLE for t in later)
    assert "The Cloud PC has finished starting and Claims Workstation is in front; input can begin." in checks(events)


@pytest.mark.asyncio
async def test_a_wait_already_over_still_checks_claims_is_in_front_once():
    class SlowLaunch(Hosted):
        async def call(self, name, arguments):
            if name == "launch_application":
                await asyncio.sleep(0.1)
            return await super().call(name, arguments)

    app = SlowLaunch()
    events = []
    outcome = await hosted_run(app, Script(*JOURNEY, FILED), events, settle=0.02)
    assert outcome["status"] == "submitted"
    assert not any("nothing is clicked or typed for another" in e.get("message", "") for e in events)
    assert "The Cloud PC has finished starting and Claims Workstation is in front; input can begin." in checks(events)


def test_edge_fixture_is_the_saved_live_screen():
    assert EDGE["processName"] == "msedge" and "about:blank" in EDGE["name"]
