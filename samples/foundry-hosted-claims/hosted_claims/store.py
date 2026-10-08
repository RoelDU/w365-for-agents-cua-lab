import json
import sqlite3
from pathlib import Path
from typing import Any

from .contract import accept_handoff


class RunStore:
    """Append-only run evidence in the hosted session's persistent HOME."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS runs (
                    request_id TEXT PRIMARY KEY, handoff TEXT NOT NULL,
                    operation TEXT NOT NULL, host_session TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    request_id TEXT NOT NULL, body TEXT NOT NULL
                );
            """)

    def begin(self, handoff: dict[str, Any], operation: str, host_session: str) -> bool:
        handoff = accept_handoff(handoff, handoff["request_id"])
        serialized = json.dumps(handoff, sort_keys=True)
        with sqlite3.connect(self.path) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT handoff, operation, host_session FROM runs WHERE request_id=?",
                (handoff["request_id"],),
            ).fetchone()
            if row:
                if row != (serialized, operation, host_session):
                    raise ValueError(
                        "This request ID already belongs to a different payload or session."
                    )
                return False
            db.execute(
                "INSERT INTO runs VALUES (?, ?, ?, ?)",
                (
                    handoff["request_id"],
                    serialized,
                    operation,
                    host_session,
                ),
            )
            return True

    def append(self, event: dict[str, Any]) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute(
                "INSERT INTO events(request_id,body) VALUES (?,?)",
                (
                    event["request_id"],
                    json.dumps(event),
                ),
            )

    def snapshot(self, request_id: str, host_session: str) -> dict[str, Any]:
        with sqlite3.connect(self.path) as db:
            row = db.execute(
                "SELECT operation,host_session FROM runs WHERE request_id=?",
                (request_id,),
            ).fetchone()
            if not row:
                raise KeyError("Run was not found in this hosted session.")
            if row[1] != host_session:
                raise PermissionError("Run belongs to another hosted session.")
            events = [
                {**json.loads(body), "sequence": seq}
                for seq, body in db.execute(
                    "SELECT seq,body FROM events WHERE request_id=? ORDER BY seq",
                    (request_id,),
                )
            ]
        computer = next((e for e in reversed(events) if e["type"] == "computer"), None)
        outcome = next((e for e in reversed(events) if e["type"] == "outcome"), None)
        release = next((e for e in reversed(events) if e["type"] == "release"), None)
        return {
            "request_id": request_id,
            "operation": row[0],
            "execution_mode": "live",
            "events": events,
            "computer": computer,
            "outcome": outcome,
            "release": release,
        }
