import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

import httpx2
from azure.identity.aio import AzureCliCredential
from hypercorn.asyncio import serve
from hypercorn.config import Config
from hypercorn.typing import ASGIFramework
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Route

from .contract import accept_handoff

_LOGGER = logging.getLogger(__name__)

# The SDK default of 10 s timed out an Azure CLI token request during a live smoke.
CLI_AUTH_TIMEOUT_SECONDS = 45
FOUNDRY_SCOPE = "https://ai.azure.com/.default"
INVOCATIONS_SUFFIX = "/endpoint/protocols/invocations"
# Set only by this viewer, never copied from upstream, so the page can trust it.
DELIVERY_HEADER = "X-Viewer-Delivery"

# httpcore trace step -> viewer phase. Once request bytes may have left this
# machine, the hosted agent may have acted on them.
_TRACE_PHASES = {
    "connect_tcp": "connect",
    "start_tls": "tls",
    "send_request_headers": "send",
    "send_request_body": "send",
    "receive_response_headers": "receive",
    "receive_response_body": "receive",
}
_NOT_SENT_PHASES = ("auth", "connect", "tls")
_PHASE_LABELS = {
    "auth": "Azure CLI sign-in",
    "connect": "connection",
    "tls": "TLS handshake",
    "send": "sending the request",
    "receive": "waiting for the response",
}


class HostedCallFailed(Exception):
    """A hosted call failed; ``details`` holds only browser-safe diagnostics."""

    def __init__(self, details: dict[str, Any]) -> None:
        super().__init__(details["error"])
        self.details = details


def _error_codes(error: BaseException) -> dict[str, Any]:
    # Type names and numeric codes only: exception text can carry CLI output or tokens.
    codes: dict[str, Any] = {"type": type(error).__name__}
    for name in ("errno", "winerror"):
        value = getattr(error, name, None)
        if isinstance(value, int):
            codes[name] = value
    return codes


def _failure(phase: str, error: Exception, elapsed_ms: int) -> HostedCallFailed:
    codes = _error_codes(error)
    causes: list[dict[str, Any]] = []
    seen = error.__cause__ or error.__context__
    while seen is not None and len(causes) < 3:
        causes.append(_error_codes(seen))
        seen = seen.__cause__ or seen.__context__
    detail = ", ".join(
        [codes["type"]]
        + [f"{name} {codes[name]}" for name in ("errno", "winerror") if name in codes]
    )
    delivery = "not_sent" if phase in _NOT_SENT_PHASES else "unknown"
    if delivery == "not_sent":
        message = (
            f"The hosted request was not sent: {_PHASE_LABELS[phase]} failed ({detail}). "
            "The hosted agent did not receive this request."
        )
    else:
        message = (
            f"Hosted connection failed while {_PHASE_LABELS[phase]} ({detail}). "
            "The request may have reached the hosted agent, so the result is unknown. "
            "Use Watch existing run; do not start another request."
        )
    return HostedCallFailed(
        {
            "error": message,
            "phase": phase,
            "delivery": delivery,
            "error_type": codes["type"],
            **{name: codes[name] for name in ("errno", "winerror") if name in codes},
            "causes": causes,
            "elapsed_ms": elapsed_ms,
        }
    )


async def _call_hosted(
    tenant: str,
    method: str,
    url: str,
    *,
    params: dict[str, str],
    json: object = None,
) -> httpx2.Response:
    """Send one authenticated request; never retries, so a start is never replayed."""
    started = time.monotonic()
    phase = "auth"

    async def trace(name: str, info: dict[str, Any]) -> None:
        nonlocal phase
        parts = name.split(".")
        if len(parts) == 3 and parts[2] == "started" and parts[1] in _TRACE_PHASES:
            phase = _TRACE_PHASES[parts[1]]

    try:
        async with AzureCliCredential(
            tenant_id=tenant, process_timeout=CLI_AUTH_TIMEOUT_SECONDS
        ) as credential:
            token = await credential.get_token(FOUNDRY_SCOPE)
        phase = "connect"
        async with httpx2.AsyncClient(timeout=50, follow_redirects=False) as client:
            return await client.request(
                method,
                url,
                params=params,
                json=json,
                headers={"Authorization": "Bearer " + token.token},
                extensions={"trace": trace},
            )
    except Exception as error:  # noqa: BLE001 - converted to an explicit, redacted failure, never success
        raise _failure(phase, error, int((time.monotonic() - started) * 1000)) from None


def create_viewer() -> Starlette:
    approved = os.getenv("LIVE_EXECUTION_APPROVED") == "yes"
    endpoint = os.getenv("HOSTED_AGENT_ENDPOINT", "")
    tenant = os.getenv("CLAIMS_TENANT_ID", "")

    async def page(request: Request) -> Response:
        html = Path(__file__).with_name("viewer.html").read_text(encoding="utf-8")
        return HTMLResponse(
            html.replace("__LIVE_APPROVED__", "true" if approved else "false"),
            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
        )

    def guard(request: Request) -> Response | None:
        origin = f"{request.url.scheme}://{request.url.netloc}"
        if (
            request.url.hostname not in ("localhost", "127.0.0.1")
            or request.headers.get("origin") != origin
        ):
            return JSONResponse(
                {"error": "Only this local viewer may issue requests."}, status_code=403
            )
        if not approved:
            return JSONResponse(
                {"error": "Cloud approval is pending; no live request was sent."}, status_code=403
            )
        target = urlsplit(endpoint)
        if (
            target.scheme != "https"
            or not (target.hostname or "").endswith(".services.ai.azure.com")
            or target.username
            or target.password
            or target.query
            or target.fragment
            or target.port not in (None, 443)
            or not target.path.endswith(INVOCATIONS_SUFFIX)
            or not tenant
        ):
            return JSONResponse(
                {"error": "Configure the exact approved hosted endpoint and tenant."},
                status_code=503,
            )
        return None

    async def preflight(request: Request) -> Response:
        """Read-only check of sign-in, TLS and agent reachability; never invokes the agent."""
        if refused := guard(request):
            return refused
        started = time.monotonic()
        try:
            response = await _call_hosted(
                tenant,
                "GET",
                endpoint.removesuffix(INVOCATIONS_SUFFIX),
                params={"api-version": "v1"},
            )
        except HostedCallFailed as failure:
            _LOGGER.warning("Preflight failed: %s", json.dumps(failure.details))
            return JSONResponse({"ok": False, **failure.details}, status_code=502)
        return JSONResponse(
            {
                "ok": response.status_code == 200,
                "status": response.status_code,
                "elapsed_ms": int((time.monotonic() - started) * 1000),
            },
            headers={"Cache-Control": "no-store"},
        )

    async def api(request: Request) -> Response:
        if refused := guard(request):
            return refused
        try:
            if len(await request.body()) > 32_000:
                raise ValueError("Request exceeds the handoff size limit.")
            data = await request.json()
            if not isinstance(data, dict) or data.get("action") not in (
                "start",
                "status",
                "view",
                "view_ready",
                "cancel",
                "recover",
            ):
                raise ValueError("Unknown viewer action.")
            request_id = data.get("request_id", "")
            if not isinstance(request_id, str) or not re.fullmatch(r"REQ-\d{4}-\d{4,}", request_id):
                raise ValueError("A valid request_id is required.")
        except ValueError as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        try:
            response = await _call_hosted(
                tenant,
                "POST",
                endpoint,
                params={"agent_session_id": request_id, "api-version": "v1"},
                json=data,
            )
        except HostedCallFailed as failure:
            _LOGGER.warning(
                "Hosted %s for %s failed: %s",
                data["action"],
                request_id,
                json.dumps(failure.details),
            )
            return JSONResponse(
                failure.details,
                status_code=502,
                headers={DELIVERY_HEADER: failure.details["delivery"]},
            )
        return Response(
            response.content,
            status_code=response.status_code,
            media_type="application/json",
            headers={"Cache-Control": "no-store"},
        )

    async def handoffs(request: Request) -> Response:
        if request.url.hostname not in ("localhost", "127.0.0.1"):
            return JSONResponse(
                {"error": "Only this local viewer may issue requests."}, status_code=403
            )
        folder = os.getenv("HANDOFF_DIR", "")
        if not folder or not Path(folder).is_dir():
            return JSONResponse(
                {"error": "Set HANDOFF_DIR to the folder of prepared request files."},
                status_code=503,
            )
        items = []
        for path in sorted(Path(folder).glob("*.json")):
            try:
                if path.stat().st_size > 32_000:
                    continue
                value = json.loads(path.read_text(encoding="utf-8"))
                items.append(
                    {"name": path.name, "handoff": accept_handoff(value, value["request_id"])}
                )
            except Exception:  # noqa: BLE001, S112 - files that are not valid Foundry handoffs are not offered
                continue
        return JSONResponse({"handoffs": items}, headers={"Cache-Control": "no-store"})

    return Starlette(
        routes=[
            Route("/", page),
            Route("/handoffs", handoffs),
            Route("/api", api, methods=["POST"]),
            Route("/preflight", preflight, methods=["POST"]),
        ]
    )


def main() -> None:
    config = Config()
    config.bind = [f"127.0.0.1:{int(os.getenv('VIEWER_PORT', '8099'))}"]
    asyncio.run(serve(cast(ASGIFramework, create_viewer()), config))


if __name__ == "__main__":
    main()
