import asyncio
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from azure.ai.agentserver.invocations import InvocationAgentServerHost
from azure.ai.projects.aio import AIProjectClient
from azure.identity.aio import ManagedIdentityCredential
from jsonschema import ValidationError
from starlette.requests import Request
from starlette.responses import JSONResponse

from .contract import accept_handoff, validate_contract
from .engine import Computer, now, run, text_content
from .gateway import connect, prepare
from .identity import VIEW_SCOPE, AgentIdentity
from .model import FoundryModel
from .store import RunStore

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Settings:
    live_approved: bool = False
    claims_approved: bool = False
    identity: AgentIdentity | None = None
    project_endpoint: str = ""
    deployment: str = "gpt-4.1-mini"
    screen_sdk_url: str = ""

    @classmethod
    def from_env(cls) -> "Settings":
        approved = os.getenv("LIVE_EXECUTION_APPROVED") == "yes"
        identity = None
        if approved:

            def hosted_id(runtime_name: str, setting_name: str) -> str:
                native = os.getenv(runtime_name, "").strip()
                configured = os.getenv(setting_name, "").strip()
                if native and configured and native.casefold() != configured.casefold():
                    raise ValueError(f"{setting_name} conflicts with the hosted runtime identity.")
                if not (native or configured):
                    raise ValueError(f"{runtime_name} or verified {setting_name} is required.")
                return native or configured

            blueprint_id = hosted_id("FOUNDRY_AGENT_BLUEPRINT_CLIENT_ID", "CLAIMS_BLUEPRINT_ID")
            auth_type = os.environ["CLAIMS_AUTH_TYPE"]
            proxy_id = ""
            if auth_type == "identity_proxy_manager":
                proxy_id = os.getenv("CLAIMS_PROXY_CLIENT_ID", "") or blueprint_id
                if proxy_id.casefold() != blueprint_id.casefold():
                    raise ValueError(
                        "The identity-proxy client must match the hosted blueprint client."
                    )
            identity = AgentIdentity(
                tenant_id=hosted_id("FOUNDRY_AGENT_TENANT_ID", "CLAIMS_TENANT_ID"),
                blueprint_id=blueprint_id,
                agent_id=hosted_id("FOUNDRY_AGENT_INSTANCE_CLIENT_ID", "CLAIMS_AGENT_ID"),
                user_id=os.environ["CLAIMS_AGENT_USER_ID"],
                assertion_file=os.getenv("CLAIMS_FEDERATED_TOKEN_FILE", ""),
                auth_type=auth_type,
                proxy_client_id=proxy_id,
            )
        return cls(
            live_approved=approved,
            identity=identity,
            claims_approved=os.getenv("CLAIMS_EXECUTION_APPROVED") == "yes",
            project_endpoint=os.getenv("FOUNDRY_PROJECT_ENDPOINT", ""),
            deployment=os.getenv("AZURE_AI_MODEL_DEPLOYMENT_NAME", "gpt-4.1-mini"),
            screen_sdk_url=os.getenv("SCREEN_SHARE_SDK_URL", ""),
        )


@asynccontextmanager
async def live_connection(settings: Settings, request_id: str) -> AsyncIterator[Computer]:
    async with connect(settings.identity, request_id, approved=settings.live_approved) as computer:
        yield computer


ConnectionFactory = Callable[[Settings, str], AbstractAsyncContextManager[Computer]]
PrepareFactory = Callable[[Settings, str], Awaitable[None]]


async def live_prepare(settings: Settings, request_id: str) -> None:
    await prepare(settings.identity, request_id, approved=settings.live_approved)


def create_app(
    settings: Settings,
    store: RunStore,
    connection_factory: ConnectionFactory = live_connection,
    prepare_factory: PrepareFactory = live_prepare,
) -> InvocationAgentServerHost:
    app = InvocationAgentServerHost()
    tasks: dict[str, asyncio.Task[None]] = {}
    viewers: dict[str, asyncio.Event] = {}
    preparing: dict[str, asyncio.Task[None]] = {}

    async def warm(request_id: str) -> None:
        try:
            await prepare_factory(settings, request_id)
        except Exception as error:  # noqa: BLE001 - preparation is optional; start repeats every step
            logger.warning("Preparation skipped (%s) request=%s", type(error).__name__, request_id)

    async def execute(
        handoff: dict[str, Any],
        operation: str,
        host_session: str,
    ) -> None:
        request_id = handoff["request_id"]
        try:
            async with connection_factory(settings, request_id) as computer:
                if operation == "smoke":
                    await run(
                        handoff,
                        operation,
                        computer,
                        store.append,
                        wait_for_viewer=viewers[request_id].wait,
                    )
                else:
                    async with (
                        ManagedIdentityCredential() as credential,
                        AIProjectClient(
                            endpoint=settings.project_endpoint,
                            credential=credential,
                        ) as project,
                        project.get_openai_client() as client,
                    ):
                        await run(
                            handoff,
                            operation,
                            computer,
                            store.append,
                            model=FoundryModel(client, settings.deployment),
                            wait_for_viewer=viewers[request_id].wait,
                        )
        except (Exception, asyncio.CancelledError) as error:  # noqa: BLE001 - detached task failures must become durable correlated errors
            message = f"Hosted execution stopped ({type(error).__name__}). No automatic retry."
            logger.error("%s request=%s", message, request_id)
            store.append(
                {
                    "type": "error",
                    "request_id": request_id,
                    "timestamp": now(),
                    "source": "application",
                    "message": message,
                }
            )
            if store.snapshot(request_id, host_session)["outcome"] is None:
                result = {
                    "request_id": request_id,
                    "status": "error",
                    "error_code": "UNKNOWN",
                    "message": message,
                    "timestamp": now(),
                }
                validate_contract("error", result)
                store.append(
                    {
                        "type": "outcome",
                        "request_id": request_id,
                        "timestamp": now(),
                        "source": "application",
                        "status": "error",
                        "execution_mode": "live",
                        "release_status": "unknown",
                        "message": message,
                        "result": result,
                    }
                )

    @app.invoke_handler
    async def invoke(request: Request) -> JSONResponse:
        try:
            if not settings.live_approved:
                raise PermissionError(
                    "Cloud approval is required. No credentials or services were used."
                )
            if len(await request.body()) > 32_000:
                raise ValueError("Invocation is too large.")
            data = await request.json()
            if not isinstance(data, dict):
                raise TypeError("Invocation must be a JSON object.")
            action = data.get("action")
            request_id = data.get("request_id")
            if not isinstance(request_id, str):
                raise TypeError("request_id is required.")
            host_session = request.state.session_id
            if host_session != request_id:
                raise ValueError(
                    "Use request_id as agent_session_id so a retry cannot allocate another sandbox."
                )
            if action == "prepare":
                # Called while the person reads the transfer confirmation: this request's
                # sandbox starts and signs in now. No Cloud PC, no run, no store record.
                if request_id not in preparing and request_id not in tasks:
                    preparing[request_id] = asyncio.create_task(warm(request_id))
                return JSONResponse({"request_id": request_id, "prepared": True}, status_code=202)
            if action == "start":
                operation = data.get("operation")
                if operation not in ("smoke", "claims"):
                    raise ValueError("operation must be smoke or claims.")
                if operation == "claims" and not settings.claims_approved:
                    raise PermissionError(
                        "Claims execution requires approval after a successful live smoke run."
                    )
                handoff = accept_handoff(data.get("handoff"), request_id)
                if any(not task.done() for key, task in tasks.items() if key != request_id):
                    raise ValueError("This hosted sandbox already has an active run.")
                started = store.begin(handoff, operation, host_session)
                if started:
                    viewers[request_id] = asyncio.Event()
                    tasks[request_id] = asyncio.create_task(
                        execute(handoff, operation, host_session)
                    )
                snapshot = store.snapshot(request_id, host_session)
                return JSONResponse(snapshot, status_code=202 if started else 200)
            snapshot = store.snapshot(request_id, host_session)
            task = tasks.get(request_id)
            snapshot["running"] = task is not None and not task.done()
            snapshot["interrupted"] = not snapshot["running"] and snapshot["outcome"] is None
            if action == "status":
                # Zava sends the last event sequence it has, so each poll carries only newer
                # events (Run K: the full replay reached ~200 KB). computer/outcome/release stay.
                after = data.get("after_sequence")
                if isinstance(after, int) and not isinstance(after, bool) and after >= 0:
                    snapshot["events"] = [e for e in snapshot["events"] if e["sequence"] > after]
                return JSONResponse(snapshot)
            if action == "view_ready":
                computer = snapshot["computer"]
                if (
                    not snapshot["running"]
                    or not computer
                    or snapshot["release"]
                    or data.get("session_id") != computer["session_id"]
                ):
                    raise ValueError("Viewer attachment does not match an active acquired session.")
                store.append(
                    {
                        "type": "viewer_connected",
                        "request_id": request_id,
                        "timestamp": now(),
                        "source": "viewer",
                        "session_id": computer["session_id"],
                        "message": "Viewer reported SDK connection to this session; not independent video verification.",
                    }
                )
                viewers[request_id].set()
                return JSONResponse({"request_id": request_id, "viewer_ready": True})
            if action == "view":
                computer = snapshot["computer"]
                if not snapshot["running"] or not computer or snapshot["release"]:
                    raise ValueError("No currently acquired session is available for viewing.")
                if not settings.identity:
                    raise ValueError("Agent-user identity is not configured.")
                sdk = urlsplit(settings.screen_sdk_url)
                if (
                    sdk.scheme != "https"
                    or not sdk.netloc
                    or sdk.username
                    or sdk.password
                    or sdk.query
                    or sdk.fragment
                    or not sdk.path.endswith("/screenshare-embed.js")
                ):
                    raise ValueError(
                        "The official HTTPS screenshare-embed.js bundle URL is required."
                    )
                link = computer.get("screen_share_url")
                screen = urlsplit(link) if isinstance(link, str) else urlsplit("")
                if (
                    screen.scheme != "https"
                    or not screen.netloc
                    or screen.username
                    or screen.password
                    or screen.fragment
                    or not screen.path.endswith("/screenshare")
                    or not parse_qs(screen.query, keep_blank_values=True)
                    .get("api-version", [""])[0]
                    .strip()
                ):
                    raise ValueError(
                        "Start Session did not return a usable versioned HTTPS screenShareUrl."
                    )
                # Match Microsoft's Playground transformation; preserve the service's query.
                computer_url = screen._replace(
                    path=screen.path.removesuffix("/screenshare")
                ).geturl()
                viewer_url = sdk._replace(
                    path=sdk.path.removesuffix("/screenshare-embed.js")
                ).geturl()
                auth, context = settings.identity.context(request_id)
                token = await auth.exchange_token(context, [VIEW_SCOPE], "agent")
                # Recheck after token acquisition; the run may have ended while it was awaited.
                if (
                    task is None
                    or task.done()
                    or store.snapshot(request_id, host_session)["release"]
                ):
                    raise ValueError("The Cloud PC session ended before viewing could begin.")
                return JSONResponse(
                    {
                        "request_id": request_id,
                        "session_id": computer["session_id"],
                        "computer_url": computer_url,
                        "viewer_url": viewer_url,
                        "sdk_url": settings.screen_sdk_url,
                        "token": token.token,
                        "mode": "viewOnly",
                    },
                    headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
                )
            if action == "cancel":
                if task and not task.done() and not task.cancelling():
                    task.cancel()
                return JSONResponse(
                    {"request_id": request_id, "cancellation_requested": bool(task)}
                )
            if action == "recover":
                if snapshot["running"]:
                    raise ValueError("Cancel the active run first; recovery is release-only.")
                if snapshot["release"] and snapshot["release"]["status"] == "accepted":
                    return JSONResponse(snapshot)
                computer = snapshot["computer"]
                if not computer:
                    raise ValueError(
                        "No session ID was recorded, so whether the Cloud PC is still allocated "
                        "is unknown. Check the pool; Administrator allocation cleanup may be needed."
                    )
                session_id = computer["session_id"]
                try:
                    async with connection_factory(settings, request_id) as recovery:
                        text_content(await recovery.release_existing(session_id))
                except Exception as error:  # noqa: BLE001 - record cleanup failure without exposing token-bearing SDK diagnostics
                    logger.error(
                        "Release recovery failed (%s) request=%s", type(error).__name__, request_id
                    )
                    store.append(
                        {
                            "type": "release",
                            "request_id": request_id,
                            "timestamp": now(),
                            "source": "application",
                            "session_id": session_id,
                            "status": "failed",
                            "message": f"Recovery failed ({type(error).__name__}); administrator cleanup required.",
                        }
                    )
                    return JSONResponse(store.snapshot(request_id, host_session), status_code=502)
                store.append(
                    {
                        "type": "release",
                        "request_id": request_id,
                        "timestamp": now(),
                        "source": "tool",
                        "session_id": session_id,
                        "status": "accepted",
                        "message": "Recovery End Session accepted; cleanup is asynchronous.",
                    }
                )
                if snapshot["outcome"] is None:
                    message = "Execution was interrupted. Only release was recovered; no task was repeated."
                    result = {
                        "request_id": request_id,
                        "status": "error",
                        "error_code": "UNKNOWN",
                        "message": message,
                        "timestamp": now(),
                    }
                    validate_contract("error", result)
                    store.append(
                        {
                            "type": "outcome",
                            "request_id": request_id,
                            "timestamp": now(),
                            "execution_mode": "live",
                            "source": "application",
                            "status": "error",
                            "message": message,
                            "result": result,
                            "release_status": "accepted",
                        }
                    )
                return JSONResponse(store.snapshot(request_id, host_session))
            raise ValueError("Unknown action.")
        except PermissionError as error:
            return JSONResponse({"error": str(error)}, status_code=403)
        except (ValueError, TypeError, ValidationError) as error:
            # ValidationError messages can include the full caller transcript.
            message = (
                "Handoff does not match the shared contract."
                if isinstance(error, ValidationError)
                else str(error)
            )
            return JSONResponse({"error": message}, status_code=400)
        except KeyError:
            return JSONResponse({"error": "Run or required setting not found."}, status_code=404)

    async def shutdown() -> None:
        for warming in preparing.values():
            warming.cancel()
        active = [task for task in tasks.values() if not task.done()]
        for task in active:
            if not task.cancelling():
                task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)

    app.shutdown_handler(shutdown)
    return app


def main() -> None:
    app = create_app(
        Settings.from_env(),
        RunStore(
            Path(os.getenv("CLAIMS_STATE_DIR", str(Path.home() / ".claims-agent"))) / "runs.sqlite"
        ),
    )
    app.run(host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8088")))


if __name__ == "__main__":
    main()
