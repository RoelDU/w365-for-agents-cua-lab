"""Apply the MCS agent configuration in docs/mcs-computer-use-instructions.md and publish.

Writes these things to an existing Copilot Studio agent, then publishes it:
  1. the agent instructions (first ```text block of the document),
  2. the Computer use tool instructions (second ```text block),
  3. the Computer use tool inputs (`inputs` and `inputType`) only if the document has a
     ```yaml block; without one, the tool is left with no inputs.
Everything else in the agent and tool definitions is left as it is: the script checks that
the rewritten definitions differ from the live ones only in those fields before it writes.

Before writing, the live definitions are saved to the backup folder (default
scripts/mcs/backups/, ignored by git). After publishing, both are read back and compared.
Rollback: run again with --restore <backup file> for each component, or paste the previous
texts from the document's "Previous version" section in Copilot Studio and publish.

Usage (from the repository root):
  python scripts/mcs/publish_mcs_agent_config.py --org-url https://<org>.crm.dynamics.com \
      --agent-schema <agent schema name> --dry-run
  python scripts/mcs/publish_mcs_agent_config.py --org-url ... --agent-schema ...

  --agent-schema   The agent's schema name, shown in Copilot Studio under Settings >
                   Advanced > Metadata (for example cr123_ZavaClaimsIntakeCUA).
  --dry-run        Read and compare only; change nothing.
  --restore FILE   Write a saved backup back to its component and publish.

Requires Python 3.10+, PyYAML (pip install pyyaml) and the Azure CLI signed in (az login)
as a user with the System Customizer or System Administrator role in that environment.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / "docs" / "mcs-computer-use-instructions.md"
CU_ACTION = "InvokeComputerUsingAgentTaskAction"


def desired_config(doc_path: Path = DOC) -> dict:
    doc = doc_path.read_text(encoding="utf-8").replace("\r\n", "\n")
    texts = re.findall(r"```text\n(.*?)\n```", doc, re.S)
    yamls = re.findall(r"```yaml\n(.*?)\n```", doc, re.S)
    if len(texts) < 2:
        raise SystemExit(f"{doc_path}: expected the agent and tool ```text blocks.")
    want = {"agent": texts[0], "tool": texts[1], "inputs": None, "inputType": None}
    if yamls:
        inputs = yaml.safe_load(yamls[0])
        names = [i.get("propertyName") for i in inputs.get("inputs", [])]
        props = (inputs.get("inputType") or {}).get("properties") or {}
        if not names or sorted(names) != sorted(props):
            raise SystemExit(f"{doc_path}: inputs and inputType.properties must name the same inputs.")
        want["inputs"], want["inputType"] = inputs["inputs"], inputs["inputType"]
    return want


def expected(kind: str, live: dict, want: dict) -> dict:
    out = copy.deepcopy(live)
    if kind == "agent":
        out["instructions"] = want["agent"]
    else:
        out["action"]["instructions"] = want["tool"]
        if want["inputs"] is None:
            out.pop("inputs", None)
            out["action"].pop("inputType", None)
        else:
            out["inputs"] = want["inputs"]
            out["action"]["inputType"] = want["inputType"]
    return out


def rewrite(kind: str, data: str, want: dict) -> str:
    """New component YAML. Keeps the live formatting when the change can be made in place;
    otherwise re-serialises. Either way the result must parse to exactly the expected value."""
    live = yaml.safe_load(data)
    target = expected(kind, live, want)
    text = data.replace("\r\n", "\n")
    try:
        current = live["instructions"] if kind == "agent" else live["action"]["instructions"]
        literal = json.dumps(current, ensure_ascii=False)
        if text.count(literal) != 1:
            raise ValueError("instructions literal not found exactly once")
        text = text.replace(literal, json.dumps(want[kind], ensure_ascii=False))
        if kind == "tool" and want["inputs"] is not None:
            if "inputs" in live or "inputType" in live["action"]:
                raise ValueError("the tool already has inputs")
            if not text.startswith("kind: TaskDialog\n"):
                raise ValueError("unexpected first line")
            block = yaml.safe_dump({"inputs": want["inputs"]}, sort_keys=False, allow_unicode=True, width=10_000)
            text = text.replace("kind: TaskDialog\n", "kind: TaskDialog\n" + block, 1)
            nested = yaml.safe_dump({"inputType": want["inputType"]}, sort_keys=False, allow_unicode=True, width=10_000)
            nested = "".join("  " + line + "\n" for line in nested.splitlines())
            marker = "  instructions: " + json.dumps(want["tool"], ensure_ascii=False) + "\n"
            if text.count(marker) != 1:
                raise ValueError("tool instructions line not found")
            text = text.replace(marker, marker + nested, 1)
        if yaml.safe_load(text) != target:
            raise ValueError("in-place edit did not give the expected definition")
        return text
    except (ValueError, KeyError, TypeError):
        text = yaml.safe_dump(target, sort_keys=False, allow_unicode=True, width=10_000)
        if yaml.safe_load(text) != target:
            raise SystemExit(f"{kind}: could not build a definition that parses as expected.") from None
        return text


class Dataverse:
    def __init__(self, org_url: str) -> None:
        self.org = org_url.rstrip("/")
        out = subprocess.run(
            ["az", "account", "get-access-token", "--resource", self.org, "--query", "accessToken", "-o", "tsv"],
            capture_output=True, text=True, timeout=120, shell=sys.platform == "win32",
        )
        if out.returncode != 0 or not out.stdout.strip():
            raise SystemExit("Azure CLI could not get a Dataverse token. Run az login with an account in that environment.")
        self.token = out.stdout.strip()

    def call(self, method: str, path: str, body: dict | None = None, headers: dict | None = None):
        req = urllib.request.Request(
            f"{self.org}/api/data/v9.2/{urllib.parse.quote(path, safe='/?$=&,()._-:@')}", method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json",
                     "Content-Type": "application/json", "OData-Version": "4.0", **(headers or {})},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                text = resp.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as err:
            raise SystemExit(f"Dataverse {method} {path.split('?')[0]} failed: HTTP {err.code} {err.read()[:300]!r}") from None


def find(dv: Dataverse, schema: str) -> tuple[dict, dict]:
    if not re.fullmatch(r"[A-Za-z0-9_]+", schema):
        raise SystemExit("The agent schema name may contain only letters, digits and underscores.")
    bots = dv.call("GET", f"bots?$select=botid,name,publishedon&$filter=schemaname eq '{schema}'")["value"]
    if len(bots) != 1:
        raise SystemExit(f"Expected one agent with schema name {schema!r}; found {len(bots)}.")
    bot = bots[0]
    rows = dv.call(
        "GET",
        "botcomponents?$select=botcomponentid,schemaname,data,modifiedon"
        f"&$filter=_parentbotid_value eq {bot['botid']}",
    )["value"]
    agents = [r for r in rows if (r.get("schemaname") or "").endswith(".gpt.default")]
    tools = []
    for r in rows:
        try:
            parsed = yaml.safe_load(r.get("data") or "")
        except yaml.YAMLError:
            continue
        if isinstance(parsed, dict) and (parsed.get("action") or {}).get("kind") == CU_ACTION:
            tools.append(r)
    if len(agents) != 1 or len(tools) != 1:
        raise SystemExit(f"Expected one agent definition and one Computer use tool; found {len(agents)} and {len(tools)}.")
    return bot, {"agent": agents[0], "tool": tools[0]}


def publish(dv: Dataverse, bot: dict) -> dict:
    before = bot.get("publishedon") or ""
    dv.call("POST", f"bots({bot['botid']})/Microsoft.Dynamics.CRM.PvaPublish", {})
    for _ in range(36):
        now = dv.call("GET", f"bots({bot['botid']})?$select=publishedon,synchronizationstatus")
        if (now.get("publishedon") or "") > before:
            return now
        time.sleep(10)
    raise SystemExit("Publish was requested but the agent's publish time did not change within 6 minutes. Check Copilot Studio.")


def changed_fields(old: str, new: str) -> list[str]:
    a, b = yaml.safe_load(old), yaml.safe_load(new)
    top = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
    if "action" in top:
        top.remove("action")
        top += [f"action.{k}" for k in sorted(set(a["action"]) | set(b["action"])) if a["action"].get(k) != b["action"].get(k)]
    return top


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--org-url", required=True)
    parser.add_argument("--agent-schema", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--restore", type=Path)
    parser.add_argument("--backup-dir", type=Path, default=ROOT / "scripts" / "mcs" / "backups")
    args = parser.parse_args()

    dv = Dataverse(args.org_url)
    bot, live = find(dv, args.agent_schema)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    receipt: dict = {"agent": bot["name"], "started": stamp, "dry_run": args.dry_run, "components": {}}

    if args.restore:
        saved = json.loads(args.restore.read_text(encoding="utf-8"))
        plans = [(saved["kind"], live[saved["kind"]], saved["data"])]
    else:
        want = desired_config()
        plans = []
        for kind, row in live.items():
            parsed = yaml.safe_load(row["data"])
            if parsed == expected(kind, parsed, want):
                receipt["components"][kind] = "already as documented"
                continue
            plans.append((kind, row, rewrite(kind, row["data"], want)))

    for kind, row, new in plans:
        receipt["components"][kind] = {"will_change": changed_fields(row["data"], new)}
    if args.dry_run or not plans:
        print(json.dumps(receipt, indent=2))
        return

    args.backup_dir.mkdir(parents=True, exist_ok=True)
    for kind, row, new in plans:
        backup = args.backup_dir / f"{kind}-{row['botcomponentid']}-{stamp}.json"
        backup.write_text(json.dumps({"kind": kind, "botcomponentid": row["botcomponentid"],
                                      "modifiedon": row["modifiedon"], "data": row["data"]}), encoding="utf-8")
        receipt["components"][kind]["backup"] = str(backup)
        dv.call("PATCH", f"botcomponents({row['botcomponentid']})", {"data": new}, {"If-Match": row["@odata.etag"]})
    receipt["published"] = publish(dv, bot)

    _, after = find(dv, args.agent_schema)
    ok = True
    for kind, _row, new in plans:
        same = yaml.safe_load(after[kind]["data"]) == yaml.safe_load(new)
        receipt["components"][kind]["live_matches"] = same
        ok = ok and same
    (args.backup_dir / f"receipt-{stamp}.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps(receipt, indent=2))
    if not ok:
        raise SystemExit("The live definition does not match what was written. Check Copilot Studio.")


if __name__ == "__main__":
    main()
