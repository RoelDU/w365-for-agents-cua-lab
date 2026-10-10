import pytest
from test_contract import handoff

from hosted_claims.store import RunStore


def test_repeated_request_is_not_reexecuted_after_restart_and_conflicting_payload_is_rejected(
    tmp_path,
):
    path = tmp_path / "runs.sqlite"
    first = RunStore(path)
    assert first.begin(handoff(), "smoke", "host-session-1")
    first.append(
        {
            "type": "computer",
            "request_id": "REQ-2024-0042",
            "session_id": "cloud-pc-1",
            "session_link": "https://view.invalid/same-session",
        }
    )
    reopened = RunStore(path)
    assert reopened.begin(handoff(), "smoke", "host-session-1") is False
    snapshot = reopened.snapshot("REQ-2024-0042", "host-session-1")
    assert snapshot["computer"]["session_id"] == "cloud-pc-1"
    with pytest.raises(ValueError, match="different"):
        reopened.begin({**handoff(), "summary": "Changed task"}, "smoke", "host-session-1")
    with pytest.raises(PermissionError, match="session"):
        reopened.snapshot("REQ-2024-0042", "another-host-session")
