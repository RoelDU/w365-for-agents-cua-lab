import copy
import json
import os
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

SCHEMAS = Path(os.getenv("CLAIMS_SCHEMA_DIR", str(Path(__file__).resolve().parents[3] / "schemas")))


def validate_contract(name: str, value: Any) -> None:
    schema = json.loads((SCHEMAS / f"{name}.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)


def accept_handoff(value: Any, request_id: str) -> dict[str, Any]:
    validate_contract("call-context", value)
    if value["request_id"] != request_id:
        raise ValueError("Request identity does not match the claims handoff.")
    if value.get("target_backend") != "foundry":
        raise ValueError("This hosted agent requires an explicitly Foundry-addressed handoff.")
    return copy.deepcopy(value)
