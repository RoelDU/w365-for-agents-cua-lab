"""One-session identity or tool-metadata evidence, never desktop/model execution."""

import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any
from uuid import UUID

from azure.ai.agentserver.invocations import InvocationAgentServerHost
from starlette.requests import Request
from starlette.responses import JSONResponse

from .identity import DISCOVERY_SCOPE, AgentIdentity

PROBE_TIMEOUT_SECONDS = 45
TOOLING_TIMEOUT_SECONDS = 90


def error_codes(message: str) -> list[str]:
    return sorted(set(re.findall(r"\bAADSTS[0-9]{4,10}\b", message)))


class SafeAuthDiagnostics(logging.Handler):
    """Keep only public error codes, never SDK payloads, assertions or tokens."""

    def __init__(self) -> None:
        super().__init__()
        self.codes: set[str] = set()
        self.http_statuses: set[int] = set()

    def emit(self, record: logging.LogRecord) -> None:
        self.codes.update(error_codes(record.getMessage()))
        if record.name == "hosted_claims.gateway":
            status = re.fullmatch(
                r"Computer-Use HTTP response status: ([1-5][0-9]{2})", record.getMessage()
            )
            if status:
                self.http_statuses.add(int(status[1]))


def save_receipt(receipt: Path, report: dict[str, Any]) -> None:
    completed = receipt.with_suffix(".tmp")
    completed.write_text(json.dumps(report, indent=2), encoding="utf-8")
    completed.replace(receipt)


async def exchange(
    identity: AgentIdentity, request_id: str, receipt: Path, diagnostics: SafeAuthDiagnostics
) -> None:
    report = json.loads(receipt.read_text(encoding="utf-8"))
    stage = "configuration"
    try:
        authorization, _ = identity.context(request_id)
        stage = "blueprint_exchange"
        report["active_stage"] = stage
        save_receipt(receipt, report)
        blueprint = await authorization.provider.get_agentic_application_token(
            identity.tenant_id, identity.agent_id
        )
        if not blueprint:
            raise RuntimeError("No blueprint token returned.")
        del blueprint
        report["completed_stages"].append(stage)
        stage = "agent_exchange"
        report["active_stage"] = stage
        save_receipt(receipt, report)
        instance, blueprint = await authorization.provider.get_agentic_instance_token(
            identity.tenant_id, identity.agent_id
        )
        if not instance or not blueprint:
            raise RuntimeError("No agent exchange tokens returned.")
        del instance, blueprint
        report["completed_stages"].append(stage)
        stage = "agent_user"
        report["active_stage"] = stage
        save_receipt(receipt, report)
        token = await authorization.provider.get_agentic_user_token(
            identity.tenant_id, identity.agent_id, identity.user_id, [DISCOVERY_SCOPE]
        )
        if not token:
            raise RuntimeError("No agent-user token returned.")
        del token
        report["completed_stages"].append(stage)
        report["status"] = "token_issued"
    except Exception as error:  # noqa: BLE001 - explicit stage failure, never raw SDK errors
        report["status"] = "failed"
        report["failed_stage"] = stage
        report["error_type"] = type(error).__name__
        report["error_codes"] = sorted(set(error_codes(str(error))) | diagnostics.codes)
    report.pop("active_stage", None)
    save_receipt(receipt, report)


def failure_details(error: BaseException) -> list[dict[str, Any]]:
    if isinstance(error, BaseExceptionGroup):
        return [detail for child in error.exceptions for detail in failure_details(child)]
    detail: dict[str, Any] = {
        "error_type": type(error).__name__,
        "error_codes": error_codes(str(error)),
    }
    status = getattr(error, "status_code", None)
    if status is None:
        status = getattr(getattr(error, "response", None), "status_code", None)
    if isinstance(status, int) and 100 <= status <= 599:
        detail["http_status"] = status
    code = getattr(error, "code", None)
    if isinstance(code, int):
        detail["protocol_error_code"] = code
    return [detail]


async def discover_tools(
    identity: AgentIdentity, request_id: str, receipt: Path, diagnostics: SafeAuthDiagnostics
) -> None:
    from .gateway import connect

    report = json.loads(receipt.read_text(encoding="utf-8"))
    report.update(active_stage="computer_use_discovery", discovery_attempted=True)
    save_receipt(receipt, report)
    try:
        async with connect(identity, request_id, approved=True) as computer:
            report["tools"] = sorted(computer.tools)
        report["completed_stages"] = ["computer_use_discovery"]
        report["status"] = "tools_discovered"
    except Exception as error:  # noqa: BLE001 - keep transport/token payloads out of evidence
        report.update(
            status="failed",
            failed_stage="computer_use_discovery",
            errors=failure_details(error),
            error_codes=sorted(diagnostics.codes),
        )
    report["http_statuses"] = sorted(diagnostics.http_statuses)
    report.pop("active_stage", None)
    save_receipt(receipt, report)


async def run_exchange(
    identity: AgentIdentity, request_id: str, receipt: Path, *, tooling: bool = False
) -> None:
    # MSAL can block during metadata discovery. A process deadline also stops that work.
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "hosted_claims.identity_probe",
        "--discover-tools" if tooling else "--exchange", str(receipt),
        env={
            **os.environ,
            (
                "CLAIMS_TOOLING_PROBE_REQUEST_ID" if tooling else "CLAIMS_IDENTITY_PROBE_REQUEST_ID"
            ): request_id,
            "CLAIMS_TENANT_ID": identity.tenant_id,
            "CLAIMS_BLUEPRINT_ID": identity.blueprint_id,
            "CLAIMS_AGENT_ID": identity.agent_id,
            "CLAIMS_AGENT_USER_ID": identity.user_id,
        },
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    failure = None
    try:
        await asyncio.wait_for(
            process.wait(), timeout=TOOLING_TIMEOUT_SECONDS if tooling else PROBE_TIMEOUT_SECONDS
        )
        if process.returncode != 0:
            failure = "WorkerExit"
    except TimeoutError:
        failure = "TimeoutError"
    finally:
        if process.returncode is None:
            process.kill()
            await asyncio.shield(process.wait())
    if failure:
        report = json.loads(receipt.read_text(encoding="utf-8"))
        report.update(
            status="failed",
            failed_stage=report.pop("active_stage", "configuration"),
            error_type=failure,
            error_codes=[],
        )
        save_receipt(receipt, report)


def create_probe_app(
    identity: AgentIdentity,
    request_id: str,
    receipt: Path,
    *,
    tooling: bool = False,
) -> InvocationAgentServerHost:
    app = InvocationAgentServerHost(configure_observability=None)
    lock = asyncio.Lock()
    action = "tooling_probe" if tooling else "identity_probe"
    success = "tools_discovered" if tooling else "token_issued"

    @app.invoke_handler
    async def invoke(request: Request) -> JSONResponse:
        headers = {"Cache-Control": "no-store"}
        if len(await request.body()) > 1024:
            return JSONResponse({"error": "Probe request too large."}, status_code=400)
        try:
            data = await request.json()
        except ValueError:
            return JSONResponse({"error": "Invalid JSON."}, status_code=400)
        if (
            request.state.session_id != request_id
            or not isinstance(data, dict)
            or data != {"action": action, "request_id": request_id}
        ):
            return JSONResponse(
                {"error": "Only the configured one-session probe is available."}, status_code=403
            )
        async with lock:
            if receipt.exists():
                saved = json.loads(receipt.read_text(encoding="utf-8"))
                return JSONResponse(
                    saved, status_code=200 if saved["status"] == success else 502,
                    headers=headers,
                )
            report: dict[str, Any] = {
                "request_id": request_id,
                "status": "interrupted",
                "completed_stages": [],
                "resource": DISCOVERY_SCOPE,
                "downstream_api_called": False,
            }
            if tooling:
                del report["downstream_api_called"]
                report.update(
                    discovery_attempted=False,
                    computer_tool_called=False,
                    model_called=False,
                )
            receipt.parent.mkdir(parents=True, exist_ok=True)
            with receipt.open("x", encoding="utf-8") as file:
                json.dump(report, file)
            try:
                await run_exchange(identity, request_id, receipt, tooling=tooling)
            except OSError as error:
                report.update(
                    status="failed", failed_stage="worker_start",
                    error_type=type(error).__name__, error_codes=[],
                )
                save_receipt(receipt, report)
            report = json.loads(receipt.read_text(encoding="utf-8"))
            return JSONResponse(
                report, status_code=200 if report["status"] == success else 502,
                headers=headers,
            )

    return app


def main() -> None:
    diagnostics = SafeAuthDiagnostics()
    logging.basicConfig(handlers=[diagnostics], level=logging.INFO, force=True)
    for name in ("msal", "microsoft_agents", "urllib3", "azure"):
        library_logger = logging.getLogger(name)
        library_logger.handlers.clear()
        library_logger.propagate = True
    if any(os.getenv(key) != "no" for key in ("LIVE_EXECUTION_APPROVED", "CLAIMS_EXECUTION_APPROVED")):
        raise RuntimeError("Diagnostic mode requires both execution gates explicitly off.")
    identity_request = os.getenv("CLAIMS_IDENTITY_PROBE_REQUEST_ID", "")
    tooling_request = os.getenv("CLAIMS_TOOLING_PROBE_REQUEST_ID", "")
    if bool(identity_request) == bool(tooling_request):
        raise ValueError("Configure exactly one identity or tooling probe, never both.")
    tooling = bool(tooling_request)
    request_id = tooling_request or identity_request
    prefix = "REQ-TOOLS-" if tooling else "REQ-AUTH-"
    if not re.fullmatch(prefix + r"[A-Za-z0-9-]{1,64}", request_id):
        raise ValueError("A bounded probe request ID is required.")
    if os.getenv("FOUNDRY_AGENT_SESSION_ID", request_id) != request_id:
        raise ValueError("This hosted session is not the configured probe session.")
    values = []
    for native, configured in (
        ("FOUNDRY_AGENT_TENANT_ID", "CLAIMS_TENANT_ID"),
        ("FOUNDRY_AGENT_BLUEPRINT_CLIENT_ID", "CLAIMS_BLUEPRINT_ID"),
        ("FOUNDRY_AGENT_INSTANCE_CLIENT_ID", "CLAIMS_AGENT_ID"),
    ):
        expected = str(UUID(os.environ[configured]))
        actual = str(UUID(os.getenv(native, expected)))
        if expected != actual:
            raise ValueError(f"{native} conflicts with the verified deployment identity.")
        values.append(actual)
    user = str(UUID(os.environ["CLAIMS_AGENT_USER_ID"]))
    tenant, blueprint, agent = values
    identity = AgentIdentity(
        tenant, blueprint, agent, user,
        auth_type="identity_proxy_manager", proxy_client_id=blueprint,
    )
    worker_action = "--discover-tools" if tooling else "--exchange"
    if len(sys.argv) == 3 and sys.argv[1] == worker_action:
        worker = discover_tools if tooling else exchange
        asyncio.run(worker(identity, request_id, Path(sys.argv[2]), diagnostics))
        return
    name = "tooling-probe.json" if tooling else "identity-probe.json"
    app = create_probe_app(
        identity, request_id, Path.home() / ".claims-agent" / name, tooling=tooling
    )
    app.run(host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8088")))


if __name__ == "__main__":
    main()
