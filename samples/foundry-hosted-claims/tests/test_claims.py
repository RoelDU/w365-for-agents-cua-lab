import asyncio
import json

import pytest
from claims_app import ClaimsApp
from mcp.types import CallToolResult, TextContent
from test_contract import handoff
from test_lifecycle import Cloud, result

from hosted_claims.claims import perform_claims


class Model:
    async def respond(self, messages, tools, max_output_tokens=None):
        return {
            "status": "completed",
            "output": [
                {
                    "type": "function_call",
                    "name": "finish_claim",
                    "call_id": "c1",
                    "arguments": '{"status":"submitted","claim_id":"CLM-2024-000999","message":"Filed"}',
                }
            ],
        }


class Computer(Cloud):
    def model_tools(self):
        return []

    async def call(self, name, arguments):
        if name == "get_accessibility_tree":
            return result('{"name":"Search results","value":"CLM-2024-000999"}')
        return await super().call(name, arguments)


def confirmation():
    return {
        "role": "Window",
        "name": "FNOL Submitted",
        "children": [
            {"role": "Text", "name": "Claim submitted successfully. Claim ID:"},
            {"role": "Edit", "value": "CLM-2024-000999"},
            {"role": "Button", "name": "OK"},
            {"role": "Button", "name": "Copy to Clipboard"},
        ],
    }


@pytest.mark.asyncio
async def test_model_claim_number_without_submission_confirmation_is_not_success():
    with pytest.raises(Exception, match="confirmation"):
        await perform_claims(handoff(), "pc-session-1", Computer(), Model(), lambda e: None)


@pytest.mark.asyncio
async def test_tool_loop_returns_only_observed_confirmation_and_actual_model_explanation():
    class Steps(Model):
        turn = 0

        async def respond(self, messages, tools, max_output_tokens=None):
            self.turn += 1
            if self.turn == 1:
                return {
                    "status": "completed",
                    "output": [
                        {
                            "type": "message",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "The review matches; submitting this FNOL.",
                                },
                            ],
                        },
                        {
                            "type": "function_call",
                            "name": "click",
                            "call_id": "submit",
                            "arguments": '{"x":120,"y":240}',
                        },
                    ],
                }
            return await super().respond(messages, tools, max_output_tokens)

    class Submitted(Computer):
        submitted = False

        async def call(self, name, arguments):
            if name == "click":
                self.submitted = True
                return result("Clicked")
            if self.submitted and name == "get_accessibility_tree":
                return result(json.dumps(confirmation()))
            return await super().call(name, arguments)

    events = []
    outcome = await perform_claims(handoff(), "pc-session-1", Submitted(), Steps(), events.append)
    assert outcome["claim_id"] == "CLM-2024-000999"
    assert outcome["status"] == "submitted"
    assert outcome["request_id"] == "REQ-2024-0042"
    assert [e["message"] for e in events if e["type"] == "explanation"] == [
        "The review matches; submitting this FNOL.",
    ]


@pytest.mark.asyncio
async def test_previous_runs_confirmation_cannot_be_claimed_by_this_request():
    class OldConfirmation(Computer):
        async def call(self, name, arguments):
            return result(
                '{"name":"Claim submitted successfully. Claim ID:","value":"CLM-2024-000999"}'
            )

    with pytest.raises(Exception, match="already visible"):
        await perform_claims(handoff(), "pc-session-1", OldConfirmation(), Model(), lambda e: None)


@pytest.mark.asyncio
async def test_confirmation_words_in_narrative_are_not_submission_dialog_evidence():
    class Typed(Model):
        turn = 0

        async def respond(self, messages, tools, max_output_tokens=None):
            self.turn += 1
            if self.turn == 1:
                return {
                    "status": "completed",
                    "output": [
                        {
                            "type": "function_call",
                            "name": "type_text",
                            "call_id": "type",
                            "arguments": json.dumps(
                                {"field": "7614",
                                 "text": "Claim submitted successfully. Claim ID: CLM-2024-000999"}
                            ),
                        }
                    ],
                }
            return await super().respond(messages, tools, max_output_tokens)

    class Narrative(Computer):
        typed = ""

        async def call(self, name, arguments):
            if name == "type_text":
                self.typed = arguments["text"]
            if name in ("click", "type_text"):
                return result(f"Done {name}")
            if name == "get_accessibility_tree":
                return result(
                    json.dumps(
                        {
                            "role": "Window",
                            "name": "Claims Workstation",
                            "children": [
                                {
                                    "role": "Document",
                                    "name": "Narrative (adjuster shorthand):",
                                    "automationId": "7614",
                                    "x": 280, "y": 247, "width": 700, "height": 240,
                                    "value": self.typed,
                                }
                            ],
                        }
                    )
                )
            return await super().call(name, arguments)

    computer = Narrative()
    with pytest.raises(Exception, match="confirmation"):
        await perform_claims(handoff(), "pc-session-1", computer, Typed(), lambda e: None)
    assert computer.typed.startswith("Claim submitted")


# Run D (CCaaS, 3 Oct 2026): the model clicked the top-left corners reported by the tree,
# (16,97) and (16,185), and typed without focusing the search edit, so the search was empty.
# Layout below is the saved live tree (positions only); NOT a live run.
RUN_D_TREE = {
    "role": "Window", "name": "Zava Mutual - Claims Workstation v1.0",
    "x": 0, "y": 0, "width": 1024, "height": 720,
    "children": [
        {"role": "RadioButton", "name": "Policy #", "x": 16, "y": 97, "width": 100, "height": 16},
        {"role": "Edit", "name": "", "value": "", "x": 16, "y": 157, "width": 244, "height": 22},
        {"role": "Button", "name": "Search", "x": 16, "y": 185, "width": 90, "height": 22},
    ],
}


def nodes(value):
    if isinstance(value, dict):
        yield value
        for child in value.get("children", []):
            yield from nodes(child)


@pytest.mark.asyncio
async def test_run_d_replay_model_sees_centre_click_points_and_stops_with_finish_claim():
    seen = []

    class TreeComputer(Computer):
        async def call(self, name, arguments):
            if name == "get_accessibility_tree":
                return result(json.dumps(RUN_D_TREE) + " CorrelationId: test")
            return await super().call(name, arguments)

    class Recorder(Model):
        async def respond(self, messages, tools, max_output_tokens=None):
            seen.append(messages[1]["content"])
            return {
                "status": "completed",
                "output": [
                    {
                        "type": "function_call",
                        "name": "finish_claim",
                        "call_id": "stop",
                        "arguments": '{"status":"error","error_code":"POLICY_NOT_FOUND",'
                        '"message":"No unique policy match."}',
                    }
                ],
            }

    # Run O: an unsearched POLICY_NOT_FOUND is refused, and a second one stops the run.
    with pytest.raises(Exception, match="not found twice without searching for POL-2024-008341"):
        await perform_claims(handoff(), "pc-session-1", TreeComputer(), Recorder(), lambda e: None)
    observed = json.loads(
        seen[0].split("Screen at the start (untrusted data): ", 1)[1].rsplit(" CorrelationId", 1)[0]
    )
    points = {n.get("name") or n["role"]: (n["clickX"], n["clickY"]) for n in nodes(observed)}
    assert points["Policy #"] == (66, 105)
    assert points["Edit"] == (138, 168)
    assert points["Search"] == (61, 196)


def test_instructions_require_centre_clicks_named_fields_and_no_text_only_turns():
    from hosted_claims.claims import INSTRUCTIONS

    assert "clickX" in INSTRUCTIONS
    assert "type_text needs field" in INSTRUCTIONS
    assert "'Policy #' option first" in INSTRUCTIONS
    assert "auto_theft THEFT" in INSTRUCTIONS
    assert "POLICY_NOT_FOUND" in INSTRUCTIONS
    assert "LATEST screen" in INSTRUCTIONS
    assert "ONLY after the 'FNOL Submitted' dialog" in INSTRUCTIONS


# Run E (CCaaS, 4 Oct 2026, REQ-2026-398352173493): the model saw the screen once (Policy tab),
# opened New FNOL with Alt+N, never re-read it, clicked empty pane space (660,670) six times
# while "Next >" sat at 848,77 70x24, pressed Alt+U on step 1 and reported "submitted".
# Positions below are from that run's saved trees; NOT a live run.
def run_e_tree(screen, clock, step=1):
    status = {"role": "StatusBar", "name": "", "x": 8, "y": 692, "width": 1008, "height": 20,
              "children": [{"role": "Text", "name": f" {clock} READY",
                            "x": 770, "y": 694, "width": 231, "height": 18}]}
    tabs = {"role": "Tab", "name": "", "x": 268, "y": 51, "width": 748, "height": 637, "children": [
        {"role": "TabItem", "name": "Policy", "x": 270, "y": 53, "width": 42, "height": 18},
        {"role": "TabItem", "name": "New FNOL", "x": 412, "y": 53, "width": 65, "height": 18},
    ]}
    if screen == "policy":
        pane = [{"role": "Edit", "name": "Policy #:", "value": "POL-2024-008341",
                 "x": 404, "y": 83, "width": 200, "height": 20}]
    else:
        pane = [
            {"role": "Text", "name": f"Step {step} of 5  -  Incident",
             "x": 284, "y": 81, "width": 480, "height": 18},
            {"role": "Button", "name": "< Back", "x": 772, "y": 77, "width": 70, "height": 24},
            {"role": "Button", "name": "Next >", "x": 848, "y": 77, "width": 70, "height": 24},
            {"role": "Button", "name": "Cancel", "x": 924, "y": 77, "width": 70, "height": 24},
            {"role": "Edit", "name": "Loss Location:", "value": "",
             "x": 450, "y": 171, "width": 460, "height": 22},
        ]
        if step == 5:  # Submit is shown only on Review; this position is illustrative.
            pane.append({"role": "Button", "name": "Submit Claim",
                         "x": 772, "y": 105, "width": 110, "height": 24})
            pane.append({"role": "Document", "name": "Review the FNOL below",
                         "x": 280, "y": 163, "width": 700, "height": 220,
                         "value": "FIRST NOTICE OF LOSS - DRAFT\r\nPolicy:        POL-2024-008341"
                         " (AUTO)\r\nLoss Type:     COLLISION\r\nLoss Location: 5th and Main"
                         "\r\n\r\nNARRATIVE:\r\nRear-ended at"
                         " intersection of 5th and Main, no injuries reported, both vehicles"
                         " drivable.\r\n"})
    tree = {"role": "Window", "name": "Zava Mutual - Claims Workstation v1.0",
            "x": 0, "y": 0, "width": 1024, "height": 720, "children": [
                status, tabs,
                {"role": "Pane", "name": "", "x": 272, "y": 73, "width": 740, "height": 611,
                 "children": pane}]}
    return json.dumps(tree)


class RunEComputer(Computer):
    """Claims after policy search (Policy # shows it). Each read has a new clock and ID."""

    def __init__(self):
        super().__init__()
        self.screen = "policy"
        self.step = 1
        self.reads = 0
        self.actions = []

    async def call(self, name, arguments):
        assert arguments["sessionId"] == "pc-session-1"
        if name == "get_accessibility_tree":
            self.reads += 1
            clock = f"09:51:{10 + self.reads:02d}"
            return result(
                run_e_tree(self.screen, clock, self.step)
                + f"\nCorrelationId: read-{self.reads}, TimeStamp: 2026-10-04_{clock}"
            )
        self.actions.append((name, {k: v for k, v in arguments.items() if k != "sessionId"}))
        if name == "press_keys" and arguments["keys"] == ["alt", "n"]:
            self.screen = "fnol"
        if name == "click" and self.screen == "fnol" and (arguments["x"], arguments["y"]) == (883, 89):
            self.step += 1
        return result(f"Done {name} CorrelationId: act-{len(self.actions)}")


class Script(Model):
    """Plays tool calls in order, then reports a business error. Keeps every prompt it saw."""

    def __init__(self, *calls):
        self.calls = list(calls)
        self.seen = []
        self.limits = []

    async def respond(self, messages, tools, max_output_tokens=None):
        self.seen.append(list(messages))
        self.limits.append(max_output_tokens)
        if self.calls:
            name, arguments = self.calls.pop(0)
        else:
            name, arguments = "finish_claim", {
                "status": "error", "error_code": "UNKNOWN", "message": "Scripted stop."}
        return {"status": "completed", "output": [{
            "type": "function_call", "name": name, "call_id": f"c{len(self.seen)}",
            "arguments": json.dumps(arguments)}]}


def latest_screen(messages):
    """The most recent tree the model was given, as parsed JSON."""
    for message in reversed(messages):
        text = message.get("output") or message.get("content")
        if isinstance(text, str) and '"role"' in text:
            start = text.index('{"role"')
            return json.JSONDecoder().raw_decode(text[start:])[0]
    raise AssertionError("The model was never given a screen layout.")


@pytest.mark.asyncio
async def test_run_e_opening_new_fnol_gives_the_model_the_new_next_button_centre():
    model = Script(("press_keys", {"keys": ["alt", "n"]}))
    computer = RunEComputer()
    await perform_claims(handoff(), "pc-session-1", computer, model, lambda e: None)
    after_open = latest_screen(model.seen[1])
    points = {n.get("name"): (n.get("clickX"), n.get("clickY")) for n in nodes(after_open)}
    assert points["Next >"] == (883, 89)


@pytest.mark.asyncio
async def test_run_e_repeated_clicks_on_empty_space_stop_after_three_despite_clock_changes():
    empty = ("click", {"x": 660, "y": 670})
    model = Script(("press_keys", {"keys": ["alt", "n"]}), *[empty] * 6)
    computer = RunEComputer()
    with pytest.raises(Exception, match="no visible change"):
        await perform_claims(handoff(), "pc-session-1", computer, model, lambda e: None)
    assert computer.actions.count(empty) == 3


@pytest.mark.asyncio
async def test_repeating_an_action_that_moves_the_form_on_is_not_stopped():
    next_button = ("click", {"x": 883, "y": 89})
    model = Script(("press_keys", {"keys": ["alt", "n"]}), *[next_button] * 4)
    computer = RunEComputer()
    outcome = await perform_claims(handoff(), "pc-session-1", computer, model, lambda e: None)
    assert outcome["status"] == "error" and outcome["message"] == "Scripted stop."
    assert computer.step == 5


@pytest.mark.asyncio
async def test_tabbing_between_fields_is_not_mistaken_for_no_progress():
    tab = ("press_keys", {"keys": ["tab"]})
    model = Script(("press_keys", {"keys": ["alt", "n"]}), *[tab] * 4)
    computer = RunEComputer()
    outcome = await perform_claims(handoff(), "pc-session-1", computer, model, lambda e: None)
    assert outcome["message"] == "Scripted stop."
    assert computer.actions.count(tab) == 4


@pytest.mark.asyncio
async def test_tabs_between_ineffective_clicks_do_not_reset_the_repeat_count():
    empty, tab = ("click", {"x": 660, "y": 670}), ("press_keys", {"keys": ["tab"]})
    model = Script(("press_keys", {"keys": ["alt", "n"]}), empty, tab, empty, tab, empty, tab, empty)
    computer = RunEComputer()
    with pytest.raises(Exception, match="no visible change"):
        await perform_claims(handoff(), "pc-session-1", computer, model, lambda e: None)
    assert computer.actions.count(empty) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failed_read",
    [
        CallToolResult(content=[TextContent(type="text", text="busy")], isError=True),
        result("Accessibility tree unavailable CorrelationId: x"),
    ],
    ids=["service-error", "no-layout"],
)
async def test_failed_screen_read_after_an_action_stops_before_the_model_decides_again(failed_read):
    class Blind(RunEComputer):
        async def call(self, name, arguments):
            if name == "get_accessibility_tree" and self.actions:
                return failed_read
            return await super().call(name, arguments)

    model = Script(("press_keys", {"keys": ["alt", "n"]}), ("click", {"x": 883, "y": 89}))
    computer = Blind()
    with pytest.raises(Exception, match="could not be re-read"):
        await perform_claims(handoff(), "pc-session-1", computer, model, lambda e: None)
    assert len(model.seen) == 1
    assert computer.actions == [("press_keys", {"keys": ["alt", "n"]})]


@pytest.mark.asyncio
async def test_cancelling_during_the_screen_reread_is_still_a_cancellation():
    class Cancelled(RunEComputer):
        async def call(self, name, arguments):
            if name == "get_accessibility_tree" and self.actions:
                raise asyncio.CancelledError
            return await super().call(name, arguments)

    model = Script(("press_keys", {"keys": ["alt", "n"]}))
    with pytest.raises(asyncio.CancelledError):
        await perform_claims(handoff(), "pc-session-1", Cancelled(), model, lambda e: None)
    assert len(model.seen) == 1


@pytest.mark.asyncio
async def test_run_e_submitted_report_without_the_confirmation_dialog_is_rejected():
    model = Script(
        ("press_keys", {"keys": ["alt", "n"]}),
        ("press_keys", {"keys": ["alt", "u"]}),
        ("finish_claim", {"status": "submitted", "claim_id": "CLM-2024-000999",
                          "message": "Claim submitted successfully."}),
    )
    with pytest.raises(Exception, match="confirmation"):
        await perform_claims(handoff(), "pc-session-1", RunEComputer(), model, lambda e: None)


ALT_U = ("press_keys", {"keys": ["alt", "u"]})
SUBMIT_CLICK = ("click", {"x": 827, "y": 117})
ENTER = ("press_keys", {"keys": ["enter"]})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "first, second",
    [(ALT_U, ALT_U), (SUBMIT_CLICK, ALT_U), (ALT_U, SUBMIT_CLICK), (SUBMIT_CLICK, ENTER)],
    ids=["alt-u-twice", "click-then-alt-u", "alt-u-then-click", "click-then-enter"],
)
async def test_a_second_submit_attempt_is_refused_and_never_sent(first, second):
    class Review(RunEComputer):
        def __init__(self):
            super().__init__()
            self.screen, self.step = "fnol", 5

    model = Script(first, second)
    computer = Review()
    with pytest.raises(Exception, match="never repeated"):
        await perform_claims(handoff(), "pc-session-1", computer, model, lambda e: None)
    assert computer.actions == [first]


def test_click_points_leave_non_json_replies_and_trailing_text_unchanged():
    from hosted_claims.claims import with_click_points

    assert with_click_points("Clicked Left at (16, 97) CorrelationId: x") == "Clicked Left at (16, 97) CorrelationId: x"
    assert with_click_points("[] CorrelationId: y") == "[] CorrelationId: y"
    listed = json.loads(with_click_points('[{"name":"Row","x":10,"y":20,"width":30,"height":4}]'))
    assert (listed[0]["clickX"], listed[0]["clickY"]) == (25, 22)


# Run F (CCaaS, 4 Oct 2026, REQ-2026-884675599029), load-bearing steps only: the model typed the
# policy number without choosing a field (it landed in the hidden FNOL narrative), searched an empty
# box, opened New FNOL with no policy, walked to Review and clicked Submit -> "No policy selected".
RUN_F = (
    ("type_text", {"text": "POL-2024-008341"}),
    ("click", {"x": 61, "y": 196}),
    ("click", {"x": 444, "y": 62}),
    *[("click", {"x": 883, "y": 89})] * 4,
    ("click", {"x": 827, "y": 117}),
)


@pytest.mark.asyncio
async def test_run_f_replay_never_sends_submit_without_a_selected_policy():
    app = ClaimsApp()
    with pytest.raises(Exception, match="no visible change"):
        await perform_claims(handoff(), "pc-session-1", app, Script(*RUN_F), lambda e: None)
    assert app.submit_requests == 0
    assert app.values["7614"] == ""


SUMMARY = handoff()["summary"]


# Run I (CCaaS, 6 Oct 2026, REQ-2026-525694604027): the model typed the policy number into the
# search box (its tree name is empty), then tried New FNOL five times and clicked an empty results
# list twice before clicking Search at step 14. Load-bearing steps, replayed on the stand-in app.
RUN_I = (
    ("click", {"x": 66, "y": 105}),
    ("type_text", {"field": "7010", "text": "POL-2024-008341"}),
    ("click", {"x": 444, "y": 62}),
    ("click", {"x": 140, "y": 448}),
    ("click", {"x": 444, "y": 62}),
)
SEARCH_STEP = "click the 'Search' button (automationId 7011) at clickX,clickY 61,196"


def outputs(messages):
    return [m["output"] for m in messages if m.get("type") == "function_call_output"]


@pytest.mark.asyncio
async def test_run_i_typed_search_text_is_reported_as_not_a_selected_policy_with_search_next():
    app = ClaimsApp()
    model = Script(*RUN_I)
    await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert app.tab == "policy" and app.policy is None  # New FNOL was never sent
    refused = outputs(model.seen[3])[-1]
    assert refused.startswith("Not sent: New FNOL opens only after the Policy tab shows POL-2024-008341.")
    assert "is NOT selected: the Policy tab's 'Policy #:' field shows ''" in refused
    assert "holds 'POL-2024-008341'. That is typed search text only; it does not select a policy" in refused
    assert "shows 0 row(s); there is no result to click" in refused
    assert SEARCH_STEP in refused
    # The newest screen carries the same facts; it does not depend on a refusal.
    after_empty_click = outputs(model.seen[4])[-1]
    assert SEARCH_STEP in after_empty_click and "0 row(s)" in after_empty_click
    assert after_empty_click.index(SEARCH_STEP) < after_empty_click.index('{"role"')


@pytest.mark.asyncio
async def test_after_search_the_selected_policy_is_stated_and_the_claim_is_filed_once():
    steps = (*RUN_I[:2], ("click", {"x": 61, "y": 196}), ("click", {"x": 444, "y": 62}), *JOURNEY_FROM_FNOL)
    app = ClaimsApp()
    model = Script(*steps, FILED)
    outcome = await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert outcome["claim_id"] == "CLM-2026-000221" and app.submit_requests == 1
    after_search = outputs(model.seen[3])[-1]
    assert "'Policy #:' field shows POL-2024-008341, so the requested policy is selected. New FNOL is allowed now." in after_search
    assert SEARCH_STEP not in after_search
    # Once past the Policy tab, no policy note is added to later screens.
    assert "Application check" not in outputs(model.seen[5])[-1]
    # Only the newest screen carries a note; replaced screens keep just their one-line result.
    final = model.seen[-1]
    assert sum("Application check" in str(m.get("output") or m.get("content")) for m in final) == 0


@pytest.mark.asyncio
async def test_a_search_that_lists_nothing_says_so_instead_of_asking_for_search_again():
    app = ClaimsApp()
    model = Script(
        ("click", {"x": 66, "y": 105}),
        ("type_text", {"field": "7010", "text": "POL-2024-008341"}),
        ("click", {"x": 61, "y": 196}),
    )
    app.click = lambda x, y, original=app.click: None if (x, y) == (61, 196) else original(x, y)
    await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    note = outputs(model.seen[3])[-1]
    assert "Search was clicked for this text and no row is listed" in note
    assert SEARCH_STEP not in note


@pytest.mark.asyncio
async def test_search_text_that_differs_from_the_policy_points_to_clear_and_by_phone_uses_phone():
    app = ClaimsApp()
    app.values["7010"] = "(555) 123"
    model = Script()
    await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    start = model.seen[0][1]["content"]
    assert "holds '(555) 123', not POL-2024-008341; typing would add to it, so click Clear " \
        "(automationId 7012) at clickX,clickY 146,196 first." in start
    assert start.index("Application check") < start.index("Screen at the start")

    by_phone = Script()
    await perform_claims({**handoff(), "policy_number": None}, "pc-session-1", ClaimsApp(), by_phone, lambda e: None)
    assert "the requested caller phone (555) 123-4567 is NOT selected: the Policy tab's 'Phone:'" \
        in by_phone.seen[0][1]["content"]


JOURNEY_FROM_FNOL = (
    ("type_text", {"field": "7612", "text": "5th and Main"}),
    ("type_text", {"field": "7614", "text": SUMMARY}),
    *[("click", {"x": 883, "y": 89})] * 4,
    ("click", {"x": 827, "y": 117}),
)
JOURNEY = (
    ("click", {"x": 66, "y": 105}),
    ("type_text", {"field": "7010", "text": "POL-2024-008341"}),
    ("click", {"x": 61, "y": 196}),
    ("click", {"x": 444, "y": 62}),
    ("type_text", {"field": "7612", "text": "5th and Main"}),
    ("type_text", {"field": "7614", "text": SUMMARY}),
    *[("click", {"x": 883, "y": 89})] * 4,
    ("click", {"x": 827, "y": 117}),
)
FILED = ("finish_claim", {"status": "submitted", "claim_id": "CLM-2026-000221", "message": "Filed."})


@pytest.mark.asyncio
async def test_full_journey_files_one_claim_with_the_supplied_facts_and_returns_its_number():
    app = ClaimsApp()
    events = []
    outcome = await perform_claims(handoff(), "pc-session-1", app, Script(*JOURNEY, FILED), events.append)
    assert outcome["status"] == "submitted" and outcome["claim_id"] == "CLM-2026-000221"
    assert app.submit_requests == 1
    assert app.claims == [{"id": "CLM-2026-000221", "policy": "POL-2024-008341",
                           "loss_type": "COLLISION", "location": "5th and Main",
                           "narrative": SUMMARY}]
    # The field was clicked at its centre right before each typing step.
    typed = [i for i, (name, _) in enumerate(app.actions) if name == "type_text"]
    assert [app.actions[i - 1] for i in typed] == [
        ("click", {"x": 138, "y": 168}),
        ("click", {"x": 680, "y": 182}),
        ("click", {"x": 630, "y": 367}),
    ]


@pytest.mark.asyncio
async def test_text_that_does_not_reach_the_named_field_stops_before_any_submit():
    app = ClaimsApp(focus_on_click=False)  # the click leaves focus in the hidden narrative
    with pytest.raises(Exception, match="did not reach"):
        await perform_claims(handoff(), "pc-session-1", app, Script(*JOURNEY, FILED), lambda e: None)
    assert app.actions[-1] == ("type_text", {"text": "POL-2024-008341"})
    assert app.submit_requests == 0


@pytest.mark.asyncio
async def test_review_that_differs_from_the_supplied_facts_is_never_submitted():
    theft = {**handoff(), "intent": "auto_theft"}
    submit = ("click", {"x": 827, "y": 117})
    app = ClaimsApp()
    model = Script(*JOURNEY, submit)
    with pytest.raises(Exception, match="refused twice.*Loss Type shows 'COLLISION', not THEFT"):
        await perform_claims(theft, "pc-session-1", app, model, lambda e: None)
    assert app.submit_requests == 0
    assert "Submit not sent: Loss Type shows 'COLLISION', not THEFT." in json.dumps(model.seen[-1])


@pytest.mark.asyncio
async def test_optional_vehicle_entry_is_skipped_and_the_claim_is_still_filed():
    add = ("click", {"x": 315, "y": 400})
    steps = list(JOURNEY)
    steps.insert(7, add)  # on the Vehicles step, as Run F did
    app = ClaimsApp()
    outcome = await perform_claims(handoff(), "pc-session-1", app, Script(*steps, FILED), lambda e: None)
    assert outcome["claim_id"] == "CLM-2026-000221"
    assert add not in app.actions


@pytest.mark.asyncio
async def test_a_field_that_already_holds_other_text_is_not_typed_into():
    app = ClaimsApp()
    app.values["7010"] = "(555) 123"
    model = Script(("type_text", {"field": "7010", "text": "POL-2024-008341"}))
    await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert app.actions == [] and app.values["7010"] == "(555) 123"
    assert "typing would add to it" in json.dumps(model.seen[-1])


@pytest.mark.asyncio
async def test_without_a_policy_number_the_caller_phone_selects_and_checks_the_customer():
    by_phone = {**handoff(), "policy_number": None}
    steps = [("type_text", {"field": "7010", "text": "(555) 123-4567"}), *JOURNEY[2:]]
    app = ClaimsApp()
    outcome = await perform_claims(by_phone, "pc-session-1", app, Script(*steps, FILED), lambda e: None)
    assert outcome["claim_id"] == "CLM-2026-000221"
    assert app.claims[0]["policy"] == "POL-2024-008341"


def with_location(text):
    return tuple(
        ("type_text", {"field": "7612", "text": text}) if a.get("field") == "7612" else (n, a)
        for n, a in JOURNEY
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("location", ["Completely invented location", ""])
async def test_a_location_not_found_in_the_supplied_facts_is_never_submitted(location):
    steps = [s for s in with_location(location) if s[1].get("text") != ""]
    submit = ("click", {"x": 827, "y": 117})
    app = ClaimsApp()
    model = Script(*steps, submit, FILED)
    with pytest.raises(Exception, match="refused twice.*Loss Location"):
        await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert app.submit_requests == 0 and app.claims == []


@pytest.mark.asyncio
async def test_a_location_taken_from_the_transcript_is_accepted():
    app = ClaimsApp()
    model = Script(*with_location("the light at 5th and Main"), FILED)
    outcome = await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert outcome["claim_id"] == "CLM-2026-000221"
    assert app.claims[0]["location"] == "the light at 5th and Main"


def explained(steps):
    return tuple(
        (name, {**args, "explanation": f"Step {i}: {name} as planned."})
        for i, (name, args) in enumerate(steps, 1)
    )


@pytest.mark.asyncio
async def test_each_step_publishes_the_models_own_explanation_and_never_sends_it_to_the_pc():
    app = ClaimsApp()
    events = []
    steps = explained(JOURNEY)
    outcome = await perform_claims(handoff(), "pc-session-1", app, Script(*steps, FILED), events.append)
    assert outcome["claim_id"] == "CLM-2026-000221"
    said = [e for e in events if e["type"] == "explanation"]
    assert [e["message"] for e in said] == [args["explanation"] for _, args in steps]
    assert {e["source"] for e in said} == {"model"}
    assert all("explanation" not in args for _, args in app.actions)
    # Each explanation is published before the first PC action of its step.
    kinds = [(e["type"], e.get("message")) for e in events if e["type"] in ("explanation", "tool_started")]
    for _, args in steps:
        at = kinds.index(("explanation", args["explanation"]))
        assert kinds[at + 1][0] == "tool_started"


@pytest.mark.asyncio
async def test_a_step_without_an_explanation_still_runs_and_none_is_invented():
    app = ClaimsApp()
    events = []
    outcome = await perform_claims(handoff(), "pc-session-1", app, Script(*JOURNEY, FILED), events.append)
    assert outcome["claim_id"] == "CLM-2026-000221"
    assert [e for e in events if e["type"] == "explanation"] == []


def test_every_desktop_tool_asks_the_model_for_a_short_explanation():
    from hosted_claims.claims import claims_tools

    class Tools:
        def model_tools(self):
            return [
                {"type": "function", "name": "click", "parameters": {
                    "type": "object", "properties": {"x": {}, "y": {}}, "required": ["x", "y"]}},
                {"type": "function", "name": "type_text", "parameters": {
                    "type": "object", "properties": {"text": {}}, "required": ["text"]}},
            ]

    tools = {t["name"]: t["parameters"] for t in claims_tools(Tools())}
    for name in ("click", "type_text"):
        assert "explanation" in tools[name]["properties"]
        assert "explanation" in tools[name]["required"]
    assert "explanation" not in tools["finish_claim"]["properties"]


# Run H (5 Oct 2026, REQ-2026-121795891351) element format from W365; values are illustrative.
W365_NODE = {
    "role": "Edit", "name": "Policy #:", "value": "POL-2024-008341", "automationId": "7200",
    "isInteractive": True, "isPassword": False, "processName": "claims",
    "x": 404, "y": 83, "width": 200, "height": 20, "truncated": False, "children": [],
}


def test_model_screen_keeps_every_element_detail_and_drops_only_empty_parts():
    from hosted_claims.claims import model_screen

    long_value = "FIRST NOTICE OF LOSS - DRAFT " + "x" * 300
    tree = {
        "role": "Window", "name": "Zava Mutual - Claims Workstation v1.0", "value": None,
        "automationId": "", "isInteractive": False, "isPassword": False, "processName": "claims",
        "x": 0, "y": 0, "width": 1024, "height": 720, "truncated": False, "children": [
            W365_NODE,
            {**W365_NODE, "role": "Edit", "name": "", "value": "", "automationId": "7010",
             "isPassword": True, "processName": "other"},
            {**W365_NODE, "role": "Document", "name": "Review", "value": long_value,
             "automationId": "7650", "truncated": True},
        ],
    }
    raw = json.dumps(tree) + "\nCorrelationId: abc, TimeStamp: 2026-10-05_11:38:22"
    shown = model_screen(raw)
    window = json.loads(shown)
    policy, empty, review = window["children"]
    assert shown.startswith('{"role":"Window"')
    assert policy == {"role": "Edit", "name": "Policy #:", "value": "POL-2024-008341",
                      "automationId": "7200", "isInteractive": True, "x": 404, "y": 83,
                      "width": 200, "height": 20, "clickX": 504, "clickY": 93}
    # An empty field still shows it is empty; true flags and another process are kept.
    assert empty["value"] == "" and empty["automationId"] == "7010"
    assert empty["isPassword"] is True and empty["processName"] == "other"
    assert review["value"] == long_value and review["truncated"] is True
    assert window["processName"] == "claims" and "isInteractive" not in window
    assert "CorrelationId" not in shown
    # Anything else after the tree is kept; non-tree text is unchanged.
    assert model_screen(json.dumps(W365_NODE) + " WARNING: x").endswith(" WARNING: x")
    assert model_screen("Accessibility tree unavailable") == "Accessibility tree unavailable"


@pytest.mark.asyncio
async def test_only_the_latest_screen_is_sent_in_full_and_every_call_keeps_its_output():
    from hosted_claims.claims import EARLIER_SCREEN

    app = ClaimsApp()
    events = []
    model = Script(*JOURNEY, FILED)
    outcome = await perform_claims(handoff(), "pc-session-1", app, model, events.append)
    assert outcome["claim_id"] == "CLM-2026-000221"
    # The application read the confirmation from the post-Submit screen; the model was not
    # asked again, so its last prompt is the one that led to Submit.
    assert len(model.seen) == len(JOURNEY)
    last = model.seen[-1]
    texts = [m.get("output") or m.get("content") for m in last]
    screens = [t for t in texts if isinstance(t, str) and '{"role"' in t]
    assert len(screens) == 1 and "FIRST NOTICE" in screens[0]
    assert sum(isinstance(t, str) and EARLIER_SCREEN in t for t in texts) == len(JOURNEY) - 1
    calls = [m["call_id"] for m in last if m.get("type") == "function_call"]
    outputs = [m["call_id"] for m in last if m.get("type") == "function_call_output"]
    assert calls == outputs and len(calls) == len(JOURNEY) - 1
    # Results and checks of earlier steps stay; earlier prompts the model saw are unchanged.
    assert sum("shows exactly the typed text" in str(t) for t in texts) == 3
    assert '{"role"' in model.seen[1][-1]["output"]
    # The full raw screens remain in the activity record.
    raw = [e["message"] for e in events if e["type"] == "tool_completed"
           and e.get("tool") == "get_accessibility_tree"]
    assert raw and all("CorrelationId: read-" in m for m in raw)


@pytest.mark.asyncio
async def test_a_newer_screen_replaces_an_earlier_screenshot():
    from mcp.types import ImageContent

    from hosted_claims.claims import EARLIER_IMAGE

    class Screenshots(ClaimsApp):
        async def call(self, name, arguments):
            if name == "take_screenshot":
                return CallToolResult(content=[ImageContent(type="image", data="AAAA",
                                                            mimeType="image/png")])
            return await super().call(name, arguments)

    shot = ("take_screenshot", {})
    model = Script(shot, shot, ("click", {"x": 66, "y": 105}))
    await perform_claims(handoff(), "pc-session-1", Screenshots(), model, lambda e: None)
    def images(msgs):
        return [m for m in msgs if isinstance(m.get("content"), list)]

    assert len(images(model.seen[2])) == 1
    assert sum(m.get("content") == EARLIER_IMAGE for m in model.seen[2]) == 1
    assert images(model.seen[3]) == []


def test_output_limit_fits_the_longest_permitted_narrative_and_short_steps():
    from hosted_claims.claims import TURN_TOKENS, output_token_limit

    assert output_token_limit(handoff()) == TURN_TOKENS + len(json.dumps(SUMMARY))
    assert output_token_limit(handoff()) < 4096 // 2
    longest = {**handoff(), "summary": "a" * 1000}
    assert output_token_limit(longest) >= TURN_TOKENS + 1000
    # Every token is at least one byte, so even an all-emoji summary cannot be cut off.
    emoji = {**handoff(), "summary": "\U0001F697" * 1000}
    assert output_token_limit(emoji) >= TURN_TOKENS + len("\U0001F697".encode()) * 1000


@pytest.mark.asyncio
async def test_each_turn_uses_the_handoffs_output_limit():
    from hosted_claims.claims import output_token_limit

    model = Script(("click", {"x": 66, "y": 105}))
    await perform_claims(handoff(), "pc-session-1", ClaimsApp(), model, lambda e: None)
    assert model.limits == [output_token_limit(handoff())] * 2


@pytest.mark.asyncio
async def test_a_reply_cut_off_at_the_output_limit_sends_nothing_to_the_pc():
    class CutOff(Model):
        async def respond(self, messages, tools, max_output_tokens=None):
            return {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"},
                    "output": [{"type": "function_call", "name": "type_text", "call_id": "c1",
                                "arguments": '{"field":"7614","text":"Rear-ended at'}]}

    app = ClaimsApp()
    with pytest.raises(Exception, match="output limit and was cut off; nothing from it was sent"):
        await perform_claims(handoff(), "pc-session-1", app, CutOff(), lambda e: None)
    assert app.actions == []


def test_explanations_are_asked_to_be_short_and_not_describe_the_whole_screen():
    from hosted_claims.claims import EXPLANATION, INSTRUCTIONS

    assert "8-20 words" in INSTRUCTIONS and "8-20 words" in EXPLANATION["description"]
    assert "Do not describe the" in INSTRUCTIONS


def test_only_the_exact_fnol_submitted_dialog_yields_a_claim_id():
    from hosted_claims.claims import submitted_claim_id

    dialog = {
        "role": "Window", "name": "FNOL Submitted",
        "children": [
            {"role": "Text", "name": "Claim submitted successfully. Claim ID:"},
            {"role": "Edit", "value": "CLM-2026-000221"},
            {"role": "Button", "name": "OK"},
        ],
    }
    assert submitted_claim_id(json.dumps(dialog) + "\nCorrelationId: x") == "CLM-2026-000221"
    for broken in (
        {**dialog, "name": "Zava Mutual - Claims Workstation v1.0"},
        {**dialog, "children": dialog["children"][:2]},
        {**dialog, "children": [*dialog["children"], {"role": "Edit", "value": "CLM-2026-000222"}]},
        {**dialog, "children": [dialog["children"][0], {"role": "Edit", "value": "CLM-26"}, dialog["children"][2]]},
    ):
        assert submitted_claim_id(json.dumps(broken)) is None
    assert submitted_claim_id("Claim submitted successfully. Claim ID: CLM-2026-000221") is None


def test_instructions_say_type_text_focuses_the_field_itself():
    from hosted_claims.claims import FIELD, INSTRUCTIONS

    assert "never click an\nEdit or Document to focus it before typing" in INSTRUCTIONS
    assert "do not click the field yourself first" in FIELD["description"]


# ---------------------------------------------------------------------------
# Several actions per model turn (Run K: 11 turns at ~2.9 s, three of them only Next >).
# Each action still runs against a freshly read screen; a later one must also still match
# what the model saw when it chose it.
# ---------------------------------------------------------------------------
class Turns(Model):
    """Plays a list of tool calls per turn, then reports a business error."""

    def __init__(self, *turns):
        self.turns = list(turns)
        self.seen = []

    async def respond(self, messages, tools, max_output_tokens=None):
        self.seen.append(list(messages))
        turn = self.turns.pop(0) if self.turns else [("finish_claim", {
            "status": "error", "error_code": "UNKNOWN", "message": "Scripted stop."})]
        return {"status": "completed", "output": [
            {"type": "function_call", "name": name, "call_id": f"t{len(self.seen)}-{i}",
             "arguments": json.dumps(arguments)}
            for i, (name, arguments) in enumerate(turn)]}


RADIO, SEARCH, NEW_FNOL = ("click", {"x": 66, "y": 105}), ("click", {"x": 61, "y": 196}), ("click", {"x": 444, "y": 62})
NEXT, SUBMIT = ("click", {"x": 883, "y": 89}), ("click", {"x": 827, "y": 117})
TYPE_POLICY = ("type_text", {"field": "7010", "text": "POL-2024-008341"})
TYPE_LOCATION = ("type_text", {"field": "7612", "text": "5th and Main"})
TYPE_NARRATIVE = ("type_text", {"field": "7614", "text": SUMMARY})


def answered(messages):
    calls = {m["call_id"] for m in messages if m.get("type") == "function_call"}
    outs = {m["call_id"] for m in messages if m.get("type") == "function_call_output"}
    return calls, outs


@pytest.mark.asyncio
async def test_batched_turns_file_one_claim_with_the_supplied_facts_in_five_model_turns():
    app = ClaimsApp()
    model = Turns(
        [RADIO, TYPE_POLICY, SEARCH],
        [NEW_FNOL],
        [TYPE_LOCATION, TYPE_NARRATIVE],
        [NEXT, NEXT, NEXT, NEXT],
        [SUBMIT],
    )
    outcome = await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert outcome["status"] == "submitted" and outcome["claim_id"] == "CLM-2026-000221"
    assert len(model.seen) == 5 and app.submit_requests == 1
    assert app.claims == [{"id": "CLM-2026-000221", "policy": "POL-2024-008341",
                           "loss_type": "COLLISION", "location": "5th and Main",
                           "narrative": SUMMARY}]
    calls, outs = answered(model.seen[-1])
    assert calls == outs  # every call of every turn got its own output
    # The screen was re-read after each of the 11 model actions, not once per turn.
    assert app.reads >= 11


@pytest.mark.asyncio
async def test_a_later_click_whose_control_was_not_on_the_seen_screen_is_not_sent():
    app = ClaimsApp()
    model = Turns([RADIO, TYPE_POLICY, SEARCH], [NEW_FNOL, NEXT])
    await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert app.tab == "fnol" and app.step == 0  # New FNOL ran; the blind Next did not
    assert outputs(model.seen[2])[-1].startswith("Not sent: the screen changed")


@pytest.mark.asyncio
async def test_a_later_type_text_into_a_field_the_model_never_saw_is_not_typed():
    app = ClaimsApp()
    model = Turns([RADIO, TYPE_POLICY, SEARCH], [NEW_FNOL, TYPE_LOCATION])
    await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert app.tab == "fnol" and app.values["7612"] == ""
    assert outputs(model.seen[2])[-1].startswith("Not typed: field '7612' was not on the screen you saw")


@pytest.mark.asyncio
async def test_submit_is_never_sent_as_part_of_a_batch():
    app = ClaimsApp()
    model = Turns(
        [RADIO, TYPE_POLICY, SEARCH], [NEW_FNOL], [TYPE_LOCATION, TYPE_NARRATIVE],
        [NEXT, NEXT, NEXT], [NEXT, SUBMIT], [SUBMIT],
    )
    outcome = await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert outcome["claim_id"] == "CLM-2026-000221" and app.submit_requests == 1
    assert outputs(model.seen[5])[-1].startswith("Submit not sent: Submit Claim is always alone")


@pytest.mark.asyncio
async def test_a_refused_action_skips_the_rest_of_its_turn():
    app = ClaimsApp()
    model = Turns([NEW_FNOL, RADIO])  # New FNOL before a policy is selected is refused
    await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert app.tab == "policy" and RADIO not in app.actions
    refused, skipped = outputs(model.seen[1])[-2:]
    assert refused.startswith("Not sent: New FNOL opens only after the Policy tab shows")
    assert skipped.startswith("Not run: an earlier action in this turn was not sent")


@pytest.mark.parametrize("turn", [
    [RADIO, ("finish_claim", {"status": "error", "error_code": "X", "message": "Stop."})],
    [RADIO, TYPE_POLICY, SEARCH, NEW_FNOL, NEXT, NEXT, NEXT],
])
@pytest.mark.asyncio
async def test_a_turn_mixing_finish_claim_or_holding_too_many_actions_runs_nothing(turn):
    app = ClaimsApp()
    model = Turns(turn)
    await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert not [a for a in app.actions if a[0] in ("click", "type_text")]
    notes = outputs(model.seen[1])
    assert len(notes) == len(turn) and all(n.startswith("Not run: a turn holds at most 6 actions") for n in notes)


@pytest.mark.asyncio
async def test_the_grouped_journey_files_one_claim_in_three_model_turns():
    app = ClaimsApp()
    model = Turns(
        [RADIO, TYPE_POLICY, SEARCH, NEW_FNOL],
        [TYPE_LOCATION, TYPE_NARRATIVE, NEXT, NEXT, NEXT, NEXT],
        [SUBMIT],
    )
    outcome = await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert outcome["claim_id"] == "CLM-2026-000221" and app.submit_requests == 1
    assert len(model.seen) == 3
    assert app.claims[0]["location"] == "5th and Main" and app.claims[0]["narrative"] == SUMMARY
    calls, outs = answered(model.seen[-1])
    assert calls == outs


def test_instructions_name_the_grouped_turns_and_keep_submit_alone():
    from hosted_claims.claims import INSTRUCTIONS, TURN_ACTIONS

    assert TURN_ACTIONS == 6
    assert "then Next > four times to reach Review" in INSTRUCTIONS
    assert "Submit Claim and\nfinish_claim are always alone in their turn." in INSTRUCTIONS or \
        "Submit Claim and finish_claim are always alone in their turn." in INSTRUCTIONS.replace("\n", " ")

# Run O (REQ-2026-231013307528, 8 Oct, v25): from the empty start screen the model pressed Alt+N,
# was told New FNOL waits for the policy and that the empty list had 0 rows, and then reported
# POLICY_NOT_FOUND without ever searching. The run ended with no claim and no search.
NOT_FOUND = ("finish_claim", {"status": "error", "error_code": "POLICY_NOT_FOUND",
                              "message": "The policy number POL-2024-008341 could not be found in the system."})


@pytest.mark.asyncio
async def test_run_o_unsearched_policy_not_found_is_refused_and_the_claim_is_then_filed():
    app = ClaimsApp()
    events = []
    model = Script(("press_keys", {"keys": ["alt", "n"]}), NOT_FOUND, *JOURNEY, FILED)
    outcome = await perform_claims(handoff(), "pc-session-1", app, model, events.append)
    assert outcome["status"] == "submitted" and outcome["claim_id"] == "CLM-2026-000221"
    assert app.submit_requests == 1
    refused = outputs(model.seen[2])[-1]
    assert refused.startswith("Not accepted: POLICY_NOT_FOUND needs a Search for POL-2024-008341")
    assert "No search has been run yet, so the empty list does not mean the policy is missing." in refused
    assert any(e["type"] == "check" and e.get("tool") == "finish_claim" for e in events)


@pytest.mark.asyncio
async def test_run_o_the_first_screen_says_no_search_has_been_run_and_names_the_next_step():
    model = Script(NOT_FOUND, NOT_FOUND)
    with pytest.raises(Exception, match="not found twice without searching"):
        await perform_claims(handoff(), "pc-session-1", ClaimsApp(), model, lambda e: None)
    start = model.seen[0][1]["content"]
    assert ("No search has been run yet, so the empty list does not mean the policy is missing. "
            "The step not yet taken: choose the 'Policy #' option, type POL-2024-008341 into the "
            "search box (automationId 7010), then click 'Search' (automationId 7011) at clickX,clickY 61,196.") in start
    phone = Script(NOT_FOUND, NOT_FOUND)
    with pytest.raises(Exception, match=r"without searching for \(555\) 123-4567"):
        await perform_claims({**handoff(), "policy_number": None}, "pc-session-1", ClaimsApp(), phone, lambda e: None)
    assert "choose the 'Phone' option, type (555) 123-4567" in phone.seen[0][1]["content"]


@pytest.mark.asyncio
async def test_policy_not_found_after_a_search_that_listed_nothing_is_still_reported():
    app = ClaimsApp()
    app.click = lambda x, y, original=app.click: None if (x, y) == (61, 196) else original(x, y)
    model = Script(
        ("click", {"x": 66, "y": 105}),
        ("type_text", {"field": "7010", "text": "POL-2024-008341"}),
        ("click", {"x": 61, "y": 196}),
        NOT_FOUND,
    )
    outcome = await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert outcome["status"] == "error" and outcome["error_code"] == "POLICY_NOT_FOUND"
    assert app.submit_requests == 0


# REQ-2026-693651046301 (10 Oct 2026): Claims was in front and the search box was clicked; Edge
# then came to the front and received the pasted policy number; the run stopped safely. These
# tests bring the saved Edge screen from that run in front of the stand-in Claims app at each
# moment around typing. Windows 365 type_text cannot be aimed at a window, so Claims must be in
# front just before the paste, and a field is read back from Claims itself before it is trusted.
FOCUS_POLICY = ("click", {"x": 138, "y": 168})  # the application's focus click on the search box
GROUPED = ([RADIO, TYPE_POLICY, SEARCH, NEW_FNOL], [TYPE_LOCATION, TYPE_NARRATIVE, NEXT, NEXT, NEXT, NEXT], [SUBMIT])
EDGE_NAME = "'about:blank - Work - Microsoft Edge', msedge"


@pytest.fixture(autouse=True)
def no_activation_pause(monkeypatch):
    monkeypatch.setattr("hosted_claims.claims.ACTIVATION_PAUSE_SECONDS", 0)


def read_after(action):
    """Edge comes to the front at the first screen read after this action."""
    return lambda calls, name, args: (
        name == "get_accessibility_tree" and bool(calls) and calls[-1] == action
    )


def before_input(calls, name, args=None):
    """The read just before input: the second read after the radio click (the model chose from
    the first, with Claims in front)."""
    return (
        name == "get_accessibility_tree" and len(calls) >= 2 and calls[-2] == RADIO
        and calls[-1][0] == "get_accessibility_tree"
    )


def checks(events):
    return [e["message"] for e in events if e["type"] == "check"]


def assert_filed_once_with_nothing_in_edge(app, outcome):
    assert outcome["status"] == "submitted" and outcome["claim_id"] == "CLM-2026-000221"
    assert app.submit_requests == 1 and len(app.claims) == 1
    assert app.claims[0]["policy"] == "POL-2024-008341"
    assert app.values["7010"] == "POL-2024-008341"  # typed once, not doubled
    assert [a for a in app.actions if a[0] == "type_text"] == [
        ("type_text", {"text": t}) for t in ("POL-2024-008341", "5th and Main", SUMMARY)
    ]
    assert app.cover_input == []


@pytest.mark.asyncio
async def test_edge_in_front_before_the_focus_click_brings_claims_back_and_files_once():
    app = ClaimsApp()
    # The model chose from a screen with Claims in front; Edge came forward before input.
    app.cover_when = before_input
    events = []
    outcome = await perform_claims(handoff(), "pc-session-1", app, Turns(*GROUPED), events.append)
    assert_filed_once_with_nothing_in_edge(app, outcome)
    # Claims was brought back before the search box was clicked; nothing went to Edge.
    activate = app.actions.index(("activate_window", {"title": "Claims Workstation"}))
    assert app.actions[activate - 1] == RADIO and app.actions[activate + 1] == FOCUS_POLICY
    assert f"Another window ({EDGE_NAME}) was in front of Claims Workstation before the field was clicked." in checks(events)[0]


@pytest.mark.asyncio
async def test_edge_in_front_between_focus_click_and_typing_reclicks_in_claims_then_types_once():
    app = ClaimsApp()
    app.cover_when = read_after(FOCUS_POLICY)  # the click reached Claims; Edge came up after it
    events = []
    outcome = await perform_claims(handoff(), "pc-session-1", app, Turns(*GROUPED), events.append)
    assert_filed_once_with_nothing_in_edge(app, outcome)
    typed = app.actions.index(("type_text", {"text": "POL-2024-008341"}))
    assert app.actions[typed - 3:typed] == [
        FOCUS_POLICY, ("activate_window", {"title": "Claims Workstation"}), FOCUS_POLICY,
    ]
    assert any("after the field was clicked (that click may have reached the other window)" in m
               for m in checks(events))


@pytest.mark.asyncio
async def test_a_focus_click_that_lands_in_edge_is_disclosed_and_nothing_is_typed_there():
    app = ClaimsApp()
    app.cover_when = lambda calls, name, args: (name, args) == FOCUS_POLICY
    outcome = await perform_claims(handoff(), "pc-session-1", app, Turns(*GROUPED), lambda e: None)
    assert outcome["claim_id"] == "CLM-2026-000221" and app.submit_requests == 1
    assert app.values["7010"] == "POL-2024-008341"
    assert app.cover_input == [FOCUS_POLICY]  # only the one click; no text reached Edge


@pytest.mark.asyncio
async def test_edge_in_front_after_the_text_reached_claims_is_read_back_and_never_retyped():
    app = ClaimsApp()
    app.cover_when = lambda calls, name, args: (
        name == "get_accessibility_tree" and bool(calls) and calls[-1] == ("type_text", {"text": "POL-2024-008341"})
    )
    events = []
    outcome = await perform_claims(handoff(), "pc-session-1", app, Turns(*GROUPED), events.append)
    assert_filed_once_with_nothing_in_edge(app, outcome)
    assert (
        f"Another window ({EDGE_NAME}) came to the front during typing. After Claims Workstation was "
        "brought back, field 7010 shows exactly the typed text, so it was not typed again."
    ) in checks(events)


@pytest.mark.asyncio
async def test_run_693651046301_replay_text_pasted_into_edge_stops_without_retyping_or_submit():
    app = ClaimsApp()
    app.cover_when = lambda calls, name, args: name == "type_text"  # Edge took focus mid-paste
    events = []
    with pytest.raises(Exception) as stopped:
        await perform_claims(handoff(), "pc-session-1", app, Turns([RADIO, TYPE_POLICY, SEARCH]), events.append)
    assert str(stopped.value) == (
        f"Another window ({EDGE_NAME}) came to the front while the text was being typed. After "
        "Claims Workstation was brought back, field 7010 shows '', so the text may have gone into "
        "that window. It was not typed again; stopped before filing a claim. No claim was verified."
    )
    assert app.cover_input == [("type_text", {"text": "POL-2024-008341"})]
    assert app.values["7010"] == ""
    assert [a for a in app.actions if a[0] == "type_text"] == [("type_text", {"text": "POL-2024-008341"})]
    assert SEARCH not in app.actions and app.submit_requests == 0
    # As in the live run, Claims was in front at the check made just before the paste.
    typed = app.calls.index(("type_text", {"text": "POL-2024-008341"}))
    assert app.calls[typed - 2:typed] == [FOCUS_POLICY, app.calls[typed - 1]]
    assert app.calls[typed - 1][0] == "get_accessibility_tree"


@pytest.mark.asyncio
async def test_edge_that_stays_in_front_stops_the_run_with_nothing_clicked_or_typed():
    app = ClaimsApp()
    app.cover_stays = True
    app.cover_when = before_input
    with pytest.raises(Exception, match=r"stayed in front after one request to bring Claims "
                       r"Workstation back before the field was clicked\. Nothing was typed"):
        await perform_claims(handoff(), "pc-session-1", app, Turns(*GROUPED), lambda e: None)
    assert app.cover_input == [] and FOCUS_POLICY not in app.actions
    assert app.actions.count(("activate_window", {"title": "Claims Workstation"})) == 1
    assert not [a for a in app.actions if a[0] == "type_text"] and app.submit_requests == 0


@pytest.mark.asyncio
async def test_edge_that_returns_after_claims_was_brought_back_once_stops_before_typing():
    app = ClaimsApp()
    app.cover_when = read_after(FOCUS_POLICY)
    original = app.call

    async def call(name, arguments):  # Edge comes forward again after the second focus click
        args = {k: v for k, v in arguments.items() if k != "sessionId"}
        if (name, args) == FOCUS_POLICY and app.actions.count(FOCUS_POLICY) == 1:
            app.cover_when = lambda calls, n, a: n == "get_accessibility_tree"
        return await original(name, arguments)

    app.call = call
    with pytest.raises(Exception, match="came in front of Claims Workstation again after the field "
                       "was clicked. Nothing was typed"):
        await perform_claims(handoff(), "pc-session-1", app, Turns(*GROUPED), lambda e: None)
    assert not [a for a in app.actions if a[0] == "type_text"] and app.cover_input == []
    assert app.actions.count(("activate_window", {"title": "Claims Workstation"})) == 1


@pytest.mark.asyncio
async def test_a_field_that_changed_while_claims_was_covered_is_refused_with_the_new_screen():
    app = ClaimsApp()

    def cover(calls, name, args):  # someone typed in the box while Edge was in front
        if before_input(calls, name):
            app.values["7010"] = "(555) 123"
            return True
        return False

    app.cover_when = cover
    model = Turns([RADIO, TYPE_POLICY, SEARCH])
    await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert FOCUS_POLICY not in app.actions and app.values["7010"] == "(555) 123"
    refused, skipped = outputs(model.seen[1])[-2:]
    assert refused.startswith("Nothing typed: field 7010 already holds '(555) 123'; typing would add to it.")
    assert '"automationId":"7010"' in refused and '"value":"(555) 123"' in refused  # the screen now
    assert skipped.startswith("Not run: an earlier action in this turn was not sent")


@pytest.mark.asyncio
async def test_a_submit_click_that_lands_in_edge_is_never_sent_again():
    app = ClaimsApp()
    app.cover_when = lambda calls, name, args: (name, args) == SUBMIT
    activate = ("activate_window", {"title": "Claims Workstation"})
    model = Turns(*GROUPED[:2], [SUBMIT], [activate], [SUBMIT])
    with pytest.raises(Exception, match="A second Submit was requested"):
        await perform_claims(handoff(), "pc-session-1", app, model, lambda e: None)
    assert app.cover_input == [SUBMIT] and app.submit_requests == 0
    assert app.actions.count(SUBMIT) == 1
