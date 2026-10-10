import json
from pathlib import Path

from hosted_claims.contract import accept_handoff

SCHEMAS = Path(__file__).resolve().parents[3] / "schemas"


def handoff():
    return json.loads((SCHEMAS / "call-context.schema.json").read_text())["examples"][0]


def test_accepts_existing_handoff_without_losing_identity_or_context():
    source = handoff()
    accepted = accept_handoff(source, source["request_id"])
    assert accepted == {
        "request_id": "REQ-2024-0042",
        "caller_phone": "(555) 123-4567",
        "policy_number": "POL-2024-008341",
        "intent": "auto_collision",
        "summary": "Rear-ended at intersection of 5th and Main, no injuries reported, both vehicles drivable.",
        "transcript_excerpt": "Caller: ...about 2:30 this afternoon, I was stopped at the light at 5th and Main and a Honda Civic rear-ended me. No one was hurt. Both cars can still be driven.",
        "requested_by": {
            "agent_id": "csr-acarter",
            "display_name": "A. Carter",
            "email": "acarter@zavamutual.demo",
        },
        "timestamp": "2024-04-15T18:32:11Z",
        "target_backend": "foundry",
    }
