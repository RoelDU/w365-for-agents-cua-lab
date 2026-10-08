"""A stand-in for the Zava Claims Workstation, for replaying live runs offline.

Positions and automation IDs come from the saved Run F trees (REQ-2026-884675599029). Behaviour
follows apps/legacy-claims-workstation/src: keyboard focus starts in the hidden FNOL narrative
(ui_fnol.c wgm_fnol_show_step), Phone is the default search option (ui_main.c), a search with one
match selects that customer's policy, and Submit refuses when no policy is selected. NOT a live run.
"""

import json

from test_lifecycle import Cloud, result

POLICY = "POL-2024-008341"
PHONE = "(555) 123-4567"
CLAIM_ID = "CLM-2026-000221"
VALUE_CAP = 256  # Run F: the tree cut the review text at 256 characters without flagging it.
STEPS = (
    "Step 1 of 5  -  Incident",
    "Step 2 of 5  -  Vehicles / Property",
    "Step 3 of 5  -  Parties",
    "Step 4 of 5  -  Coverage",
    "Step 5 of 5  -  Review  Submit",
)
TEXT_FIELDS = {"7010", "7610", "7612", "7614"}


def node(role, name, x, y, width, height, automation_id="", value=None, children=()):
    return {"role": role, "name": name, "value": value, "automationId": automation_id,
            "x": x, "y": y, "width": width, "height": height, "children": list(children)}


class ClaimsApp(Cloud):
    def __init__(self, focus_on_click=True):
        super().__init__()
        self.focus_on_click = focus_on_click
        self.focus = "7614"
        self.search_by = "phone"
        self.values = {"7010": "", "7610": "10/04/2026", "7612": "", "7614": ""}
        self.loss_type = "COLLISION"
        self.policy = None
        self.tab = "policy"
        self.step = 0
        self.dialog = None
        self.reads = 0
        self.actions = []
        self.submit_requests = 0
        self.claims = []

    def review(self):
        lines = ["FIRST NOTICE OF LOSS - DRAFT", "----------------------------"]
        if self.policy:
            lines += [f"Policy:        {self.policy} (AUTO)", f"Insured:       Jordan Smith - {PHONE}"]
        lines += [
            f"Loss Date:     {self.values['7610']} 13:02",
            f"Loss Type:     {self.loss_type}",
            f"Loss Location: {self.values['7612']}",
            "Adjuster:      ADJ-NA-0142",
            "Combined Ded:  $0.00",
            "",
            "NARRATIVE:",
            self.values["7614"],
        ]
        return "\r\n".join(lines)[:VALUE_CAP]

    def tree(self):
        if self.dialog == "no_policy":
            return node("Window", "Submit Claim", 332, 310, 368, 149, children=[
                node("Button", "OK", 607, 424, 75, 23, "2"),
                node("Text", "No policy selected. Select a policy before submitting.",
                     397, 369, 272, 15, "65535"),
            ])
        if self.dialog == "add":
            return node("Window", "Add Vehicle / Property", 249, 185, 526, 349, children=[
                node("Edit", "Make:", 364, 271, 384, 28, "6101", ""),
                node("Button", "Cancel", 636, 479, 112, 36, "2"),
            ])
        if self.dialog == "confirm":
            # Dialog layout is illustrative; its contents follow res/claims.rc IDD_CONFIRM_CLAIM.
            return node("Window", "FNOL Submitted", 312, 280, 400, 160, children=[
                node("Text", "Claim submitted successfully. Claim ID:", 330, 320, 250, 16),
                node("Edit", "", 330, 345, 200, 22, "7701", CLAIM_ID),
                node("Button", "OK", 600, 400, 90, 24, "1"),
                node("Button", "Copy to Clipboard", 330, 400, 120, 24, "7702"),
            ])
        rows = [node("ListItem", "CUST-000001", 20, 236, 240, 17)] if self.policy else []
        if self.tab == "policy":
            pane = [
                node("Edit", "Policy #:", 404, 83, 200, 20, "7200", self.policy or ""),
                node("Edit", "Insured Last Name:", 404, 109, 200, 20, "7201",
                     "Smith" if self.policy else ""),
                node("Edit", "Phone:", 704, 109, 140, 20, "7202", PHONE if self.policy else ""),
            ]
        else:
            pane = [
                node("Text", STEPS[self.step], 284, 81, 480, 18, "7600"),
                node("Button", "< Back", 772, 77, 70, 24, "7601"),
                node("Button", "Next >", 848, 77, 70, 24, "7602"),
                node("Button", "Cancel", 924, 77, 70, 24, "7603"),
            ]
            if self.step == 0:
                pane += [
                    node("Edit", "Loss Date (MM/DD/YYYY):", 450, 143, 110, 22, "7610",
                         self.values["7610"]),
                    node("Edit", "Loss Location:", 450, 171, 460, 22, "7612", self.values["7612"]),
                    node("ComboBox", "Loss Type:", 450, 199, 180, 21, "7613", self.loss_type),
                    node("Document", "Narrative (adjuster shorthand):", 280, 247, 700, 240, "7614",
                         self.values["7614"][:VALUE_CAP]),
                ]
            elif self.step in (1, 2):
                pane.append(node("Button", "Add...", 280, 389, 70, 22, "7621"))
            elif self.step == 4:
                pane += [
                    node("Button", "Submit Claim", 772, 105, 110, 24, "7604"),
                    node("Document", "Review the FNOL below, then click Submit Claim:",
                         280, 163, 700, 220, "7650", self.review()),
                ]
        return node("Window", "Zava Mutual - Claims Workstation v1.0", 0, 0, 1024, 720, children=[
            node("StatusBar", "", 8, 692, 1008, 20, "7101", children=[
                node("Text", f" 13:{self.reads // 60:02d}:{self.reads % 60:02d} READY",
                     770, 694, 231, 18)]),
            node("RadioButton", "Phone", 16, 79, 100, 16, "7000"),
            node("RadioButton", "Policy #", 16, 97, 100, 16, "7001"),
            node("Edit", "", 16, 157, 244, 22, "7010", self.values["7010"]),
            node("Button", "Search", 16, 185, 90, 22, "7011"),
            node("Button", "Clear", 116, 185, 60, 22, "7012"),
            node("List", "", 18, 217, 244, 463, "7013", children=rows),
            node("Tab", "", 268, 51, 748, 637, "7100", children=[
                node("TabItem", "Policy", 270, 53, 42, 18),
                node("TabItem", "New FNOL", 412, 53, 65, 18),
            ]),
            node("Pane", "", 272, 73, 740, 611, children=pane),
        ])

    def hit(self, x, y):
        found = []

        def walk(n):
            if n["x"] <= x < n["x"] + n["width"] and n["y"] <= y < n["y"] + n["height"]:
                found.append(n)
            for child in n["children"]:
                walk(child)

        walk(self.tree())
        return min(found, key=lambda n: n["width"] * n["height"], default=None)

    def submit(self):
        self.submit_requests += 1
        if not self.policy:
            self.dialog = "no_policy"
            return
        self.claims.append({"id": CLAIM_ID, "policy": self.policy, "loss_type": self.loss_type,
                            "location": self.values["7612"], "narrative": self.values["7614"]})
        self.dialog = "confirm"

    def press(self, keys):
        if self.dialog:
            return
        on_review = self.tab == "fnol" and self.step == 4
        if keys == ["alt", "n"]:
            self.tab = "fnol"
        elif (keys == ["alt", "u"] and on_review) or (
            keys in (["enter"], ["space"]) and self.focus == "7604"
        ):
            self.submit()

    def click(self, x, y):
        target = self.hit(x, y)
        if target is None:
            return
        name, aid = target["name"], target["automationId"]
        if self.dialog:
            if target["role"] == "Button" and name in ("OK", "Cancel"):
                self.dialog = None
            return
        roles = ("Edit", "Document", "RadioButton", "Button", "TabItem", "ComboBox")
        if target["role"] in roles and (self.focus_on_click or aid not in TEXT_FIELDS):
            self.focus = aid or name
        if aid == "7000":
            self.search_by = "phone"
        elif aid == "7001":
            self.search_by = "policy"
        elif aid == "7011":
            query = self.values["7010"]
            known = POLICY if self.search_by == "policy" else PHONE
            if query and query.lower() in known.lower():
                self.policy = POLICY
        elif aid == "7012":
            self.values["7010"] = ""
        elif name == "New FNOL":
            self.tab = "fnol"
        elif name == "Policy" and target["role"] == "TabItem":
            self.tab = "policy"
        elif aid == "7602":
            self.step = min(self.step + 1, 4)
            if self.step == 4:
                self.focus = "7604"
        elif aid == "7601":
            self.step = max(self.step - 1, 0)
        elif aid == "7604":
            self.submit()
        elif aid == "7621":
            self.dialog = "add"

    async def call(self, name, arguments):
        assert arguments["sessionId"] == "pc-session-1"
        if name == "get_accessibility_tree":
            self.reads += 1
            return result(json.dumps(self.tree()) + f" CorrelationId: read-{self.reads}")
        args = {k: v for k, v in arguments.items() if k != "sessionId"}
        self.actions.append((name, args))
        if name == "click":
            self.click(args["x"], args["y"])
        elif name == "press_keys":
            self.press([str(k).lower() for k in args["keys"]])
        elif name == "type_text":
            # Text goes to whichever control has focus, shown or hidden; buttons ignore it.
            if self.focus in TEXT_FIELDS:
                self.values[self.focus] += args["text"]
            return result(f"Pasted {len(args['text'])} characters CorrelationId: act")
        return result(f"Done {name} CorrelationId: act-{len(self.actions)}")
