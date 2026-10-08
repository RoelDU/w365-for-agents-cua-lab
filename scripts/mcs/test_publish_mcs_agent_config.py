"""Offline checks for publish_mcs_agent_config.py. Run: python -m pytest scripts/mcs"""

import importlib.util
from pathlib import Path

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
