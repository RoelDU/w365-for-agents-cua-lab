"""Offline checks for publish_mcs_agent_config.py. Run: python -m pytest scripts/mcs"""

import importlib.util
import json
from pathlib import Path

import pytest
import yaml

spec = importlib.util.spec_from_file_location("publish", Path(__file__).with_name("publish_mcs_agent_config.py"))
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)

TOOL = '''kind: TaskDialog
modelDisplayName: Computer use
modelDescription: "Files the claim."
action:
  kind: InvokeComputerUsingAgentTaskAction
  connectionReference: example.shared_computeroperator.0000
  connectionProperties:
    mode: Maker

  operationId: ComputerOperatorInvokeMcpCua
  instructions: "Old tool text.\\nSecond line."
  model:
    modelNameHint: sonnet4-5

  initializeContext:
    enforceHttps: true
'''

AGENT = '''kind: GptComponentMetadata
instructions: "Old agent text."
gptCapabilities:
  webBrowsing: false
'''


def test_document_defines_agent_and_tool_text_and_no_inputs():
    want = publish.desired_config()
    assert "Call the Computer use tool first" in want["agent"]
    assert "press Windows key + R once" in want["tool"]
    assert 'Double-click the desktop icon "Zava Claims Agent Launch" once' in want["tool"]
    assert "This call's handoff (JSON): {System.Activity.Text}" in want["tool"]
    assert want["inputs"] is None and want["inputType"] is None


INPUTS_DOC = """```text
Agent text.
```

```yaml
inputs:
  - kind: AutomaticTaskInput
    propertyName: request
    name: request
    description: The handoff.
inputType:
  properties:
    request:
      displayName: request
      description: The handoff.
      isRequired: true
      type: String
```

```text
Tool text.
```
"""


def with_inputs(tmp_path):
    doc = tmp_path / "doc.md"
    doc.write_text(INPUTS_DOC, encoding="utf-8")
    return publish.desired_config(doc)


def test_tool_rewrite_keeps_everything_else_and_live_formatting(tmp_path):
    want = with_inputs(tmp_path)
    new = publish.rewrite("tool", TOOL, want)
    parsed, old = yaml.safe_load(new), yaml.safe_load(TOOL)
    assert parsed["action"]["instructions"] == want["tool"]
    assert parsed["inputs"] == want["inputs"]
    assert parsed["action"]["inputType"] == want["inputType"]
    for key in ("modelDisplayName", "modelDescription"):
        assert parsed[key] == old[key]
    for key in ("kind", "connectionReference", "connectionProperties", "operationId", "model", "initializeContext"):
        assert parsed["action"][key] == old["action"][key]
    # Made in place: untouched lines keep their original text.
    assert '  connectionReference: example.shared_computeroperator.0000\n' in new
    assert new.startswith("kind: TaskDialog\ninputs:\n")


def test_agent_rewrite_changes_only_the_instructions():
    want = publish.desired_config()
    new = publish.rewrite("agent", AGENT, want)
    parsed = yaml.safe_load(new)
    assert parsed == {**yaml.safe_load(AGENT), "instructions": want["agent"]}
    assert "gptCapabilities:\n  webBrowsing: false\n" in new


def test_changed_fields_names_the_nested_tool_fields(tmp_path):
    want = with_inputs(tmp_path)
    assert publish.changed_fields(TOOL, publish.rewrite("tool", TOOL, want)) == [
        "inputs", "action.inputType", "action.instructions"]


def test_a_document_without_inputs_removes_live_inputs_and_keeps_the_rest(tmp_path):
    with_tool_inputs = publish.rewrite("tool", TOOL, with_inputs(tmp_path))
    want = publish.desired_config()
    new = publish.rewrite("tool", with_tool_inputs, want)
    parsed = yaml.safe_load(new)
    assert "inputs" not in parsed and "inputType" not in parsed["action"]
    assert parsed["action"]["instructions"] == want["tool"]
    assert parsed["action"]["connectionReference"] == "example.shared_computeroperator.0000"


def test_without_inputs_only_the_instructions_change_in_place():
    want = publish.desired_config()
    new = publish.rewrite("tool", TOOL, want)
    assert publish.changed_fields(TOOL, new) == ["action.instructions"]
    assert new.startswith("kind: TaskDialog\nmodelDisplayName: Computer use\n")


# ---- Publication is handled independently of the texts (QA S3) --------------------------


class FakeDataverse:
    """Offline stand-in for the Dataverse Web API used by main()."""

    def __init__(self, texts_match=True, publishedon="2026-10-01T00:00:00Z", latest="2026-10-02T00:00:00Z", fail_publish=False):
        want = publish.desired_config()
        self.agent = publish.rewrite("agent", AGENT, want) if texts_match else AGENT
        self.tool = publish.rewrite("tool", TOOL, want) if texts_match else TOOL
        self.publishedon, self.latest, self.fail_publish = publishedon, latest, fail_publish
        self.calls = []

    def __call__(self, org_url):
        return self

    def call(self, method, path, body=None, headers=None):
        self.calls.append((method, path.split("?")[0]))
        if method == "GET" and path.startswith("bots?"):
            return {"value": [{"botid": "b1", "name": "Agent", "publishedon": self.publishedon}]}
        if method == "GET" and path.startswith("botcomponents?$select=modifiedon"):
            return {"value": [{"modifiedon": self.latest}, {"modifiedon": "2026-09-01T00:00:00Z"}]}
        if method == "GET" and path.startswith("botcomponents?"):
            return {"value": [
                {"botcomponentid": "a1", "schemaname": "x.gpt.default", "data": self.agent, "modifiedon": self.latest, "@odata.etag": "1"},
                {"botcomponentid": "t1", "schemaname": "x.topic.CU", "data": self.tool, "modifiedon": self.latest, "@odata.etag": "1"},
            ]}
        if method == "POST" and path.endswith("PvaPublish"):
            if self.fail_publish:
                raise SystemExit("Dataverse POST bots(b1)/Microsoft.Dynamics.CRM.PvaPublish failed: HTTP 500")
            self.publishedon = "2026-10-09T00:00:00Z"
            return None
        if method == "GET" and path.startswith("bots(b1)?"):
            return {"publishedon": self.publishedon, "synchronizationstatus": None}
        if method == "PATCH":
            return None
        raise AssertionError(f"unexpected call {method} {path}")


def run_main(monkeypatch, tmp_path, fake, *flags):
    monkeypatch.setattr(publish, "Dataverse", fake)
    monkeypatch.setattr(publish.time, "sleep", lambda _s: None)
    monkeypatch.setattr("sys.argv", ["x", "--org-url", "https://org.test", "--agent-schema", "x_Agent",
                                     "--backup-dir", str(tmp_path), *flags])
    publish.main()
    return [c for c in fake.calls if c[0] in ("POST", "PATCH")]


def test_dry_run_reports_unpublished_changes(monkeypatch, tmp_path, capsys):
    run_main(monkeypatch, tmp_path, FakeDataverse(), "--dry-run")
    out = json.loads(capsys.readouterr().out)
    assert out["publication"]["unpublished_changes"] is True
    assert out["components"] == {"agent": "already as documented", "tool": "already as documented"}


def test_matching_texts_without_publish_only_still_do_not_publish(monkeypatch, tmp_path):
    assert run_main(monkeypatch, tmp_path, FakeDataverse()) == []


def test_publish_only_publishes_once_when_texts_match_and_changes_are_unpublished(monkeypatch, tmp_path):
    writes = run_main(monkeypatch, tmp_path, FakeDataverse(), "--publish-only")
    assert writes == [("POST", "bots(b1)/Microsoft.Dynamics.CRM.PvaPublish")]


def test_publish_only_does_nothing_when_already_current(monkeypatch, tmp_path, capsys):
    fake = FakeDataverse(publishedon="2026-10-05T00:00:00Z", latest="2026-10-02T00:00:00Z")
    assert run_main(monkeypatch, tmp_path, fake, "--publish-only") == []
    assert json.loads(capsys.readouterr().out)["published"] == "not needed"


def test_published_after_makes_an_older_publish_out_of_date(monkeypatch, tmp_path):
    fake = FakeDataverse(publishedon="2026-10-05T00:00:00Z", latest="2026-10-02T00:00:00Z")
    writes = run_main(monkeypatch, tmp_path, fake, "--publish-only", "--published-after", "2026-10-06T00:00:00Z")
    assert writes == [("POST", "bots(b1)/Microsoft.Dynamics.CRM.PvaPublish")]


def test_publish_only_refuses_when_texts_differ(monkeypatch, tmp_path):
    fake = FakeDataverse(texts_match=False)
    with pytest.raises(SystemExit, match="texts differ"):
        run_main(monkeypatch, tmp_path, fake, "--publish-only")
    assert [c for c in fake.calls if c[0] in ("POST", "PATCH")] == []


def test_failed_publish_then_resume_publishes_without_rewriting(monkeypatch, tmp_path):
    fake = FakeDataverse(texts_match=False, fail_publish=True)
    with pytest.raises(SystemExit, match="PvaPublish failed"):
        run_main(monkeypatch, tmp_path, fake)
    # The texts were saved before the publish failed; the next run sees them as documented.
    want = publish.desired_config()
    fake.agent, fake.tool = publish.rewrite("agent", AGENT, want), publish.rewrite("tool", TOOL, want)
    fake.fail_publish, fake.calls = False, []
    writes = run_main(monkeypatch, tmp_path, fake, "--publish-only")
    assert writes == [("POST", "bots(b1)/Microsoft.Dynamics.CRM.PvaPublish")]


def test_times_are_compared_as_times_not_text():
    bot = {"botid": "b1", "publishedon": "2026-10-09T09:09:59Z"}
    fake = FakeDataverse(publishedon=bot["publishedon"], latest="2026-10-09T09:00:00Z")
    assert publish.publication_state(fake, bot)["unpublished_changes"] is False
    assert publish.publication_state(fake, bot, "2026-10-09T09:10:11+00:00")["unpublished_changes"] is True
    assert publish.publication_state(fake, bot, "2026-10-09T09:00:00Z")["unpublished_changes"] is False


def test_a_time_that_is_not_iso_is_refused_not_ignored():
    bot = {"botid": "b1", "publishedon": "2026-10-09T09:09:59Z"}
    with pytest.raises(SystemExit, match="Not an ISO 8601 time"):
        publish.publication_state(FakeDataverse(), bot, "10/09/2026 11:22:33")
