"""Build and run the public artifact with synthetic settings; no cloud calls."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from uuid import uuid4
from zipfile import ZipFile

import pytest


SAMPLE = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("include_delay", [False, True])
def test_auth_package_runs_without_source_tree_or_private_configuration(include_delay):
    work = SAMPLE / ".build" / f"fixture-{uuid4().hex}"
    work.mkdir(parents=True)
    try:
        built = subprocess.run(
            [sys.executable, str(SAMPLE / "scripts" / "build_package.py"),
             "--output", str(work / "auth.zip")] + (["--include-delay"] if include_delay else []),
            cwd=work, check=True, capture_output=True, text=True,
        )
        manifest = json.loads(built.stdout)
        assert manifest["gateway_and_registration_disabled"] is True
        assert manifest["delay_probe_packaged"] is include_delay
        assert manifest["w365_sdk_packaged"] is False
        with ZipFile(work / "auth.zip") as package:
            expected = {
                "host.json", "requirements.txt",
                "auth_endpoint/__init__.py", "auth_endpoint/function.json",
                "mcs_new_harness/__init__.py", "mcs_new_harness/stage_app.py",
                "mcs_new_harness/auth_stage.py", "mcs_new_harness/request_host.py",
                "mcs_new_harness/transport_candidate.py",
            }
            if include_delay:
                expected.add("mcs_new_harness/no_pc_delay.py")
            assert set(package.namelist()) == expected
            package.extractall(work / "extracted")
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("NH_", "ZAVA_", "WEBSITE_", "PYTHONPATH"))}
        env.update(
            PYTHONDONTWRITEBYTECODE="1",
            NH_PUBLIC_ORIGIN="https://fixture.invalid",
            NH_TENANT_ID="11111111-1111-1111-1111-111111111111",
            NH_API_AUDIENCE="22222222-2222-2222-2222-222222222222",
            NH_MCP_CLIENT_ID="33333333-3333-3333-3333-333333333333",
            NH_USE_SCOPE="Fixture.Access",
        )
        run = subprocess.run(
            [sys.executable, "-c", """
import asyncio, json
from pathlib import Path
import httpx2
import auth_endpoint
from mcs_new_harness import stage_app
assert Path(stage_app.__file__).resolve().is_relative_to(Path.cwd())
async def verify():
    async with stage_app.app.router.lifespan_context(stage_app.app):
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=stage_app.app),
            base_url="https://fixture.invalid",
        ) as http:
            metadata = await http.get("/api/.well-known/oauth-protected-resource")
            assert metadata.status_code == 200
            assert metadata.json()["resource"] == "https://fixture.invalid/api/mcp"
            assert metadata.json()["scopes_supported"] == [
                "api://22222222-2222-2222-2222-222222222222/Fixture.Access"]
            denied = await http.post("/api/mcp", json={})
            assert denied.status_code == 401
            assert denied.headers["x-zava-gateway"] == "disabled"
            assert denied.headers["x-zava-request-registration"] == "disabled"
            assert (await http.post("/api/requests", json={})).status_code == 403
    print(json.dumps({"metadata": 200, "unauthenticated": 401, "registration": 403}))
asyncio.run(verify())
"""],
            cwd=work / "extracted", env=env, capture_output=True, text=True,
        )
        assert run.returncode == 0, run.stderr
        assert json.loads(run.stdout)["unauthenticated"] == 401
    finally:
        shutil.rmtree(work)
