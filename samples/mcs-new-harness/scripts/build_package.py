"""Allowlisted auth-only zip; Azure Oryx restores the pinned Linux dependencies."""

import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]


def build(output, include_delay=False):
    files = {
        f"mcs_new_harness/{name}": ROOT / "mcs_new_harness" / name
        for name in (
            "__init__.py", "stage_app.py", "auth_stage.py",
            "request_host.py", "transport_candidate.py",
        )
    }
    for name in ("host.json", "auth_endpoint/__init__.py", "auth_endpoint/function.json"):
        files[name] = ROOT / "deploy" / name
    files["requirements.txt"] = ROOT / "requirements.txt"
    if include_delay:
        files["mcs_new_harness/no_pc_delay.py"] = ROOT / "mcs_new_harness" / "no_pc_delay.py"
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", ZIP_DEFLATED) as package:
        for name, source in sorted(files.items()):
            package.writestr(name, source.read_bytes())
    manifest = {
        "archive": output.name,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "files": sorted(files),
        "w365_sdk_packaged": False,
        "delay_probe_packaged": include_delay,
        "delay_probe_enabled_by_default": False,
        "gateway_and_registration_disabled": True,
    }
    output.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".build" / "auth-only.zip")
    parser.add_argument("--include-delay", action="store_true",
                        help="Package the reviewed no-PC diagnostic; flag still defaults off.")
    args = parser.parse_args()
    print(json.dumps(build(args.output, args.include_delay), indent=2))
