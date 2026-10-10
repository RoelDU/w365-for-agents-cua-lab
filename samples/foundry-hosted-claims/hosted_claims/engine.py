import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Protocol
from uuid import NAMESPACE_URL, uuid5

from mcp import MCPError
from mcp.types import REQUEST_TIMEOUT, CallToolResult

from .contract import accept_handoff, validate_contract

if TYPE_CHECKING:
    from .claims import Reasoner

START = "mcp_W365ComputerUse_StartSession"
DETAILS = "mcp_W365ComputerUse_GetSessionDetails"
END = "mcp_W365ComputerUse_EndSession"
SCREEN_SIZE = "get_screen_size"
# Learn: checkout "may take up to 30 seconds"; run 02c took longer than 35 s and still allocated.
START_TIMEOUT_SECONDS = 120
# Smoke 02d: after get_screen_size answered, the live video still showed Windows enrollment
# account setup (Intune Enrollment Status Page) in front. Pool image locale is en-US.
SETUP_MARKERS = ("Setting up for work or school",)
# Confirmed setup is reported promptly rather than waited out behind the caller's window.
DESKTOP_SETUP_GRACE_SECONDS = 30
WINDOW_TIMEOUT_SECONDS = 15
CLAIMS_TIMEOUT_SECONDS = 15 * 60
CLAIMS_WINDOW = "Claims Workstation"
# Microsoft Defender process records for every Foundry Cloud PC, 2-10 Oct 2026: in about half the
# sessions the Windows 365 tool server itself (DesktopControl.Mcp.exe) starts a remote-controlled
# Edge window (about:blank) 21.3-26.9 s after it starts, whatever this agent is doing. It starts at
# least 5.5 s before Start Session returns here, so that Edge starts at most ~21.4 s after the
# return, and it takes the front within ~4 s. In REQ-2026-693651046301 it did so 14.7 s after the
# return and received the pasted policy number. Nothing is clicked or typed until this many
# seconds after Start Session returned, with Claims seen in front; the model plans meanwhile.
SERVICE_BROWSER_SETTLE_SECONDS = 27
SETTLE_POLL_SECONDS = 1
SETTLE_ACTIVATIONS = 2
ACTIVATION_CONFIRM_READS = 4
# Only these activate_window rejections are treated as "window not there yet" and retried.
WINDOW_NOT_FOUND = re.compile(
    r"\bno (matching )?window\b|\bwindow\b[^.\n]{0,60}\bnot found\b|\bnot find\b[^.\n]{0,60}\bwindow\b",
    re.IGNORECASE,
)
CLAIMS_EXE = r"C:\Program Files\Business Applications\Zava Claims Workstation\claims.exe"
CLAIMS_ARGS = ["--no-splash", "--fast-auth", "--stable-host", "--idle-timeout=0", "--demo-pin=1234"]
logger = logging.getLogger(__name__)


class Computer(Protocol):
    async def call(self, name: str, arguments: dict[str, Any]) -> CallToolResult: ...
    def model_tools(self) -> list[dict[str, Any]]: ...
    async def release_existing(self, session_id: str) -> CallToolResult: ...


class RunError(Exception):
    """A safe, operator-facing error with no raw authentication details."""

    diagnostic: dict[str, Any] | None = None


def setup_screen(tree: str) -> bool:
    return any(marker.lower() in tree.lower() for marker in SETUP_MARKERS)


def claims_window_listed(value: CallToolResult) -> bool | None:
    # list_windows is documented as an array of {title, processName, ...}; only a boolean is kept.
    try:
        windows = json.loads(text_content(value))
    except (RunError, ValueError):
        return None
    if not isinstance(windows, list):
        return None
    return any(
        CLAIMS_WINDOW in str(window.get("title", ""))
        for window in windows
        if isinstance(window, dict)
    )


SERVICE_TEXT_LIMIT = 300
SECRET_WORDS = (
    r"(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|"
    r"authorization|credentials?|password|passwd|pwd|passphrase|secret|token|assertion|"
    r"signature|sig|cookie|sas|key)"
)
# A secret-named field and its value, in any of: name=value, name: value, "name": "value",
# name "value", or name=\"value\" (escaped quotes inside text that was itself JSON). The
# name is kept and only the value is replaced.
SECRET_PAIR = re.compile(
    rf"(?P<name>(?<![A-Za-z0-9]){SECRET_WORDS}(?![A-Za-z0-9])\\?[\"']?"
    r"(?:\s*[:=]\s*|\s+(?:[A-Za-z]+\s+){0,2}(?=\\?[\"'])))"
    r"(?:(?:Bearer|Basic|Digest|SharedAccessSignature)\s+)?"
    r"(?:\\?\"(?:[^\"\\]|\\(?!\")|\\\"(?!\s|$|[,;})\]]))*\\?\"|\\?'[^']*\\?'|[^\s&,;}\]]+)",
    re.IGNORECASE,
)
UUID_TEXT = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)
OPAQUE = re.compile(r"[A-Za-z0-9+/_=.~-]{33,}")
# JWTs, bearer and basic credentials, and any URL (screen-share and viewer links carry
# access) are always removed. Long opaque values are removed too, except GUIDs, which are
# correlation IDs.
SECRET_TEXT = re.compile(
    r"eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*|\bBearer\s+\S+|\bBasic\s+[A-Za-z0-9+/=]{8,}"
    r"|\b[a-z][a-z0-9+.-]*://\S+",
    re.IGNORECASE,
)
# Codes and statuses are short identifiers such as SessionNotReady, Forbidden, 403 or -32602.
SERVICE_CODE = re.compile(
    r"^(?:-?\d{1,6}|[A-Za-z][A-Za-z0-9]{0,39}(?:[_.:-][A-Za-z0-9]{1,24}){0,4})$"
)
# Correlation IDs: a GUID, a hex ID (W3C trace IDs are 32 hex characters) or a short word ID.
SERVICE_ID = re.compile(
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|[0-9a-f]{8,32}|[A-Za-z0-9][A-Za-z0-9_.:-]{0,31})$",
    re.IGNORECASE,
)
WORD_PART = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+")
CODE_KEYS = ("code", "errorCode", "error_code")
STATUS_KEYS = ("status", "statusCode", "status_code", "httpStatus")
MESSAGE_KEYS = ("message", "error_description", "detail", "title", "error")
ID_KEYS = ("correlationId", "correlation_id", "requestId", "request_id", "traceId", "activityId")


def redact(text: object, limit: int = SERVICE_TEXT_LIMIT) -> str:
    cleaned = SECRET_TEXT.sub("[redacted]", str(text))
    cleaned = SECRET_PAIR.sub(r"\g<name>[redacted]", cleaned)
    cleaned = OPAQUE.sub(
        lambda m: m.group(0) if UUID_TEXT.match(m.group(0)) else "[redacted]", cleaned
    )
    cleaned = " ".join(cleaned.split())
    return cleaned if len(cleaned) <= limit else cleaned[: limit - 1] + "…"


def identifier(value: object, pattern: re.Pattern[str]) -> str | None:
    """A code, status or correlation ID kept only if it is a short identifier, not a secret."""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    text = str(value)
    if not pattern.match(text) or redact(text) != text:
        return None
    if UUID_TEXT.match(text) or re.fullmatch(r"-?\d+|[0-9a-f]+", text, re.IGNORECASE):
        return text
    # Readable codes split into words and numbers (SessionNotReady, AADSTS160021,
    # W365.Session.NotFound); random keys split into many single letters.
    if sum(len(part) == 1 and part.isalpha() for part in WORD_PART.findall(text)) > 2:
        return None
    return text


def reply_object(text: str) -> Any:
    try:
        return json.loads(text)
    except ValueError:
        start = text.find("{")
        try:
            return json.JSONDecoder().raw_decode(text[start:])[0] if start >= 0 else None
        except ValueError:
            return None


def service_diagnostic(value: CallToolResult) -> dict[str, Any]:
    """Only selected, redacted fields of a rejected tool reply; never the raw reply.

    A structured reply contributes only its code, status, correlation ID and message fields.
    Plain text is kept (redacted) only when it does not look like structured data.
    """
    text = "\n".join(block.text for block in value.content if block.type == "text")
    data: Any = value.structured_content
    if not isinstance(data, dict):
        data = reply_object(text)
    found: dict[str, Any] = {}
    if isinstance(data, dict):
        layers = [data] + [data[k] for k in ("error", "details") if isinstance(data.get(k), dict)]
        for layer in layers:
            for key in CODE_KEYS:
                if code := identifier(layer.get(key), SERVICE_CODE):
                    found.setdefault("service_code", code)
            for key in STATUS_KEYS:
                if status := identifier(layer.get(key), SERVICE_CODE):
                    found.setdefault("service_status", status)
            for key in MESSAGE_KEYS:
                message = layer.get(key)
                if isinstance(message, str) and message.strip() and reply_object(message) is None:
                    found.setdefault("service_message", redact(message))
            for key in ID_KEYS:
                if ident := identifier(layer.get(key), SERVICE_ID):
                    found.setdefault("service_correlation_id", ident)
    elif text.strip() and not re.search(r"[{\[]\s*\"|\"\s*:", text):
        found["service_message"] = redact(text)
    if text.strip() and "service_message" not in found:
        found["service_message_withheld"] = True
    found["content_types"] = [block.type for block in value.content]
    found["text_length"] = len(text)
    return found


class ToolRejected(RunError):
    """Windows 365 answered a tool call with isError; ``diagnostic`` keeps its redacted reason."""

    def __init__(self, service: dict[str, Any]) -> None:
        super().__init__("The Computer-Use service rejected the tool call.")
        self.diagnostic = service


def text_content(value: CallToolResult) -> str:
    if value.is_error:
        raise ToolRejected(service_diagnostic(value))
    return "\n".join(block.text for block in value.content if block.type == "text")


class UnreadableReply(RunError):
    """A tool reply that could not be read; ``shape`` describes it without any values."""

    def __init__(self, message: str, shape: dict[str, Any]) -> None:
        super().__init__(message)
        self.shape = shape


UUID = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE
)
FIELDS = {"sessionid": "sessionId", "status": "status", "screenshareurl": "screenShareUrl"}
FIELD = re.compile(
    r'"?\b(session[ _-]?id|status|screen[ _-]?share[ _-]?url)\b"?\s*[:=]\s*"?([^\s",}]+)',
    re.IGNORECASE,
)


def field_name(key: object) -> str:
    return FIELDS.get(re.sub(r"[^a-z]", "", str(key).lower()), str(key))


def reply_shape(value: CallToolResult) -> dict[str, Any]:
    text = "\n".join(block.text for block in value.content if block.type == "text")
    shape: dict[str, Any] = {
        "content_types": [block.type for block in value.content],
        "structured": type(value.structured_content).__name__
        if value.structured_content is not None
        else None,
        "text_length": len(text),
        "id_count": len(set(UUID.findall(text))),
        "names_session_id": "sessionid" in text.lower(),
    }
    try:
        parsed = json.loads(text)
        shape["json"] = type(parsed).__name__
        if isinstance(parsed, dict):
            shape["json_keys"] = sorted(str(key) for key in parsed)[:20]
    except ValueError:
        shape["json"] = None
    return shape


def object_content(value: CallToolResult) -> dict[str, Any]:
    # The documented MCP contract names the fields but not the text format, so
    # accept structured content, JSON, JSON inside prose, or "name: value" text.
    text = text_content(value)
    if isinstance(value.structured_content, dict):
        return value.structured_content
    try:
        data = json.loads(text)
    except ValueError:
        start = text.find("{")
        try:
            data = json.JSONDecoder().raw_decode(text[start:])[0] if start >= 0 else None
        except ValueError:
            data = None
    if isinstance(data, dict):
        return {field_name(key): item for key, item in data.items()}
    fields = {field_name(m.group(1)): m.group(2).rstrip(".;:)'") for m in FIELD.finditer(text)}
    if fields:
        return fields
    raise UnreadableReply(
        "Computer-Use returned a reply this run could not read.", reply_shape(value)
    )


def session_id_from(value: CallToolResult) -> tuple[str, dict[str, Any]]:
    # Only an explicitly named sessionId counts; an unlabelled ID is never assumed to be one.
    try:
        data = object_content(value)
    except UnreadableReply:
        data = {}
    session_id = data.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        raise UnreadableReply(
            "Start Session reply had no explicitly named sessionId; whether the Cloud PC is "
            "still allocated is unknown. Check the pool; administrator cleanup may be needed.",
            reply_shape(value),
        )
    return session_id, data


STAGES = {
    "start_session": "Start Session",
    "confirm_session": "the session check",
    "wait_until_ready": "the Cloud PC readiness check",
    "desktop_setup_check": "the desktop check before Claims was opened",
    "wait_for_viewer": "the wait for the live viewer",
    "launch_claims": "the Claims launch",
    "bring_claims_to_front": "the check that Claims is in front",
    "claims_task": "the Claims task",
}


def submission_note(stage: str, submit_sent: bool) -> str:
    if submit_sent:
        return (
            "Submit Claim had already been sent, so the claim may have been filed. Check Claims "
            "before any retry; do not repeat it."
        )
    if stage == "claims_task":
        return "This run had not sent Submit Claim."
    return "The Claims task had not started, so this run sent no Submit Claim."


async def activate_claims_window(
    computer: Computer, session_id: str, emit: Callable[..., None]
) -> str:
    """Ask Windows 365 to bring Claims Workstation to the front, once.

    Returns "requested", or "window_not_found" when the reply positively says the window is not
    there. Any other rejection stops the run; approval-required and guard errors propagate.
    """
    emit("tool_started", tool="activate_window", source="tool")
    value = await computer.call(
        "activate_window", {"sessionId": session_id, "title": CLAIMS_WINDOW}
    )
    if value.is_error:
        if WINDOW_NOT_FOUND.search(
            "\n".join(block.text for block in value.content if block.type == "text")
        ):
            emit(
                "tool_failed",
                tool="activate_window",
                source="tool",
                message="The Claims Workstation window was not found yet.",
            )
            return "window_not_found"
        stopped = RunError(
            "Windows 365 rejected the request to bring Claims Workstation to the front; "
            "the run stopped without retrying."
        )
        stopped.diagnostic = service_diagnostic(value)
        raise stopped
    emit("tool_completed", tool="activate_window", source="tool")
    return "requested"


def start_key(request_id: str) -> str:
    return str(uuid5(NAMESPACE_URL, request_id))


def now() -> str:
    return datetime.now(UTC).isoformat()


async def run(
    handoff: dict[str, Any],
    operation: str,
    computer: Computer,
    publish: Callable[[dict[str, Any]], None],
    *,
    model: "Reasoner | None" = None,
    ready_timeout: float = 35,
    poll_interval: float = 2,
    setup_timeout: float = DESKTOP_SETUP_GRACE_SECONDS,
    setup_poll_interval: float = 5,
    window_timeout: float = WINDOW_TIMEOUT_SECONDS,
    wait_for_viewer: Callable[[], Awaitable[object]] | None = None,
    settle_seconds: float | None = None,
    settle_poll_interval: float = SETTLE_POLL_SECONDS,
) -> dict[str, Any]:
    if settle_seconds is None:
        settle_seconds = SERVICE_BROWSER_SETTLE_SECONDS
    handoff = accept_handoff(handoff, handoff["request_id"])
    if operation not in ("smoke", "claims") or (operation == "claims" and model is None):
        raise ValueError("Operation must be smoke, or claims with a configured model.")
    request_id = handoff["request_id"]
    session_id: str | None = None
    release_status = "not_acquired"
    outcome: dict[str, Any] = {"request_id": request_id, "execution_mode": "live"}
    stage = "start_session"
    last_tool: str | None = None
    claims_state = {"submit_sent": False}

    def record(event: dict[str, Any]) -> None:
        nonlocal last_tool
        if event.get("type") == "tool_started":
            last_tool = event.get("tool")
        publish(event)

    def emit(kind: str, **data: Any) -> None:
        record({"type": kind, "request_id": request_id, "timestamp": now(), **data})

    async def call(name: str, args: dict[str, Any]) -> CallToolResult:
        emit("tool_started", tool=name, source="tool")
        value = await computer.call(name, args)
        text_content(value)
        emit("tool_completed", tool=name, source="tool")
        return value

    try:
        emit(
            "plan",
            source="application",
            message="Acquire, confirm the session, wait until the Cloud PC answers, open Claims, observe, release.",
        )
        release_status = "unknown"
        emit("tool_started", tool=START, source="tool")
        session_id, acquired = session_id_from(
            await computer.call(
                START,
                {
                    "idempotencyKey": start_key(request_id),
                },
            )
        )
        release_status = "pending"
        settle_until = asyncio.get_running_loop().time() + settle_seconds
        emit("tool_completed", tool=START, source="tool")
        emit(
            "computer",
            source="tool",
            session_id=session_id,
            screen_share_url=acquired.get("screenShareUrl"),
        )
        # Microsoft documents no reply format or status values for Get Session Details,
        # so it is used only to confirm the session; readiness is proven by a real call.
        stage = "confirm_session"
        details = await call(DETAILS, {"sessionId": session_id})
        try:
            state = object_content(details)
        except UnreadableReply:
            state = {}
        if state.get("sessionId") not in (None, session_id):
            raise RunError("Get Session Details described a different session.")
        status = state.get("status")
        emit(
            "session_details",
            source="tool",
            status=status if isinstance(status, str) else None,
            diagnostic=reply_shape(details),
        )
        last_failure = "no reply"
        last_rejection: dict[str, Any] | None = None
        stage = "wait_until_ready"
        try:
            async with asyncio.timeout(ready_timeout):
                while True:
                    try:
                        await call(SCREEN_SIZE, {"sessionId": session_id})
                        break
                    except ValueError:
                        raise
                    except Exception as error:  # noqa: BLE001 - not yet answering; retried until the bound
                        last_failure = type(error).__name__
                        if isinstance(error, ToolRejected):
                            last_rejection = error.diagnostic
                        await asyncio.sleep(poll_interval)
        except TimeoutError:
            not_ready = RunError(
                f"Cloud PC did not answer within {ready_timeout:.0f} seconds ({last_failure})."
            )
            not_ready.diagnostic = last_rejection
            raise not_ready from None
        emit("readiness", source="tool", message="Cloud PC answered a get_screen_size call.")
        if wait_for_viewer is not None:
            emit(
                "plan",
                source="application",
                message="Cloud PC ready. Click Watch this Cloud PC to allow the visible action.",
            )

        async def foreground(depth: int, elements: int = 500) -> str:
            return text_content(
                await call(
                    "get_accessibility_tree",
                    {"sessionId": session_id, "maxDepth": depth, "maxElements": elements},
                )
            )

        async def activate_claims() -> str:
            assert session_id is not None
            return await activate_claims_window(computer, session_id, emit)

        # A Cloud PC that answers get_screen_size can still be in Windows account setup (02d).
        # Confirmed setup gets only a short grace, then a named stop; the check shares the
        # Claims budget so the caller's 20-minute status window is not extended.
        gate_started = asyncio.get_running_loop().time()
        stage = "desktop_setup_check"
        setup_seen: bool | None = None  # None until a screen reading actually returns
        setup_reported = False
        # REQ-2026-576139834574: a tool call was rejected and the run ended at once. From the
        # timing (release seconds after Start Session) it was inferred, not proven, to be the
        # first screen read after readiness. A rejected read here is treated like an unreadable
        # screen: it is shown, retried within the same grace, and named if it never clears.
        # It is read-only.
        last_rejection = None
        tree: str | None = None
        try:
            async with asyncio.timeout(setup_timeout):
                while True:
                    try:
                        tree = await foreground(10)
                    except ToolRejected as rejected:
                        last_rejection = rejected.diagnostic
                        emit(
                            "tool_failed",
                            tool="get_accessibility_tree",
                            source="tool",
                            message="Windows 365 did not let the screen be read yet; retrying "
                            f"within the {setup_timeout:.0f}-second desktop check.",
                            diagnostic=last_rejection,
                        )
                        await asyncio.sleep(setup_poll_interval)
                        continue
                    setup_seen = setup_screen(tree)
                    if not setup_seen:
                        break
                    if not setup_reported:
                        setup_reported = True
                        emit(
                            "plan",
                            source="application",
                            message='Windows is still finishing account setup on the Cloud PC ("Setting '
                            'up for work or school"). Claims opens only when the desktop is ready.',
                        )
                    await asyncio.sleep(setup_poll_interval)
        except TimeoutError:
            if setup_seen:
                stopped = RunError(
                    'Windows on the Cloud PC was in account setup ("Setting up for work or school") '
                    f"at the last screen reading and had not finished within {setup_timeout:.0f} "
                    "seconds, so Claims was not opened. This is Windows enrollment setup for the "
                    "agent account, not a Claims failure. Use a new request after setup can finish, "
                    "or review the pool's enrollment setup."
                )
            elif last_rejection is not None:
                reason = last_rejection.get("service_message") or last_rejection.get(
                    "service_code", "no reason given"
                )
                stopped = RunError(
                    f"Windows 365 rejected every screen read for {setup_timeout:.0f} seconds after "
                    f"the Cloud PC answered ({reason}), so Claims was not opened and no Submit was "
                    "sent."
                )
            else:
                stopped = RunError(
                    f"The Cloud PC screen could not be read within {setup_timeout:.0f} seconds, so "
                    "Claims was not opened. Whether Windows setup was showing is unknown."
                )
            stopped.diagnostic = {"setup_screen_observed": bool(setup_seen)}
            if last_rejection is not None and not setup_seen:
                stopped.diagnostic["last_rejection"] = last_rejection
            raise stopped from None
        gate_seconds = asyncio.get_running_loop().time() - gate_started
        if setup_reported:
            emit(
                "plan",
                source="application",
                message="Windows account setup finished. Opening Claims.",
            )
        # The setup check above only reads the screen, so it runs while the viewer connects
        # (Run J: the viewer took 9.8 s). Nothing visible happens before the viewer is ready.
        if wait_for_viewer is not None:
            stage = "wait_for_viewer"
            async with asyncio.timeout(120):
                await wait_for_viewer()
        stage = "launch_claims"
        await call(
            "launch_application",
            {
                "sessionId": session_id,
                "path": CLAIMS_EXE,
                "args": CLAIMS_ARGS,
            },
        )
        tree = None
        # Another window can be in front of the launched Claims window (seen live: a blank Edge
        # window, which Defender records show the Windows 365 tool server opening itself). Request activation once; retry only a reply that positively
        # says the window is not found yet. Anything else (approval required, other rejection,
        # session/guard errors) ends the run through the normal release path.
        activation = "not_needed"
        stage = "bring_claims_to_front"
        try:
            async with asyncio.timeout(window_timeout):
                while True:
                    # Claims reads the same full screen first, so this one is passed on to it.
                    tree = await foreground(6, 1000) if operation == "claims" else await foreground(3)
                    if CLAIMS_WINDOW in tree:
                        break
                    if activation in ("not_needed", "window_not_found"):
                        activation = await activate_claims()
                    await asyncio.sleep(poll_interval)
        except TimeoutError:
            covered = tree is not None and setup_screen(tree)
            if tree is None:
                detail = "; the screen could not be read in that time."
            elif covered:
                detail = ' (Windows account setup "Setting up for work or school" was in front).'
            else:
                detail = "."
            stopped = RunError(
                f"Launch completed, but {CLAIMS_WINDOW} was not seen as the foreground window "
                f"within {window_timeout:.0f} seconds{detail}"
            )
            try:
                listed = claims_window_listed(
                    await asyncio.wait_for(
                        computer.call("list_windows", {"sessionId": session_id}), timeout=10
                    )
                )
            except Exception:  # noqa: BLE001 - diagnostic only; the window failure is reported regardless
                listed = None
            stopped.diagnostic = {
                "screen_observed": tree is not None,
                "setup_screen_foreground": covered,
                "claims_window_listed": listed,
                "claims_activation": activation,
            }
            raise stopped from None
        if activation != "not_needed":
            emit(
                "plan",
                source="application",
                message="Another window was in front of Claims. Activation of Claims Workstation "
                "was requested, and Claims Workstation was then observed in the foreground.",
            )
        emit("observation", source="tool", message=tree)
        if operation == "claims":
            from .claims import claims_in_front, front_label, perform_claims

            async def settle_desktop() -> str:
                """Watch the Cloud PC until the settle time, keeping Claims in front; no input.

                Runs while the model plans its first step. Returns a fresh full screen read with
                Claims in front, or stops the run before anything was clicked or typed.
                """
                loop = asyncio.get_running_loop()
                remaining = settle_until - loop.time()
                if remaining > 0:
                    emit(
                        "plan",
                        source="application",
                        message="Claims is open. On a new Cloud PC, Windows 365 can still open "
                        "its own browser window up to about "
                        f"{SERVICE_BROWSER_SETTLE_SECONDS} seconds after the session starts, "
                        f"so nothing is clicked or typed for another {remaining:.0f} seconds. "
                        "The agent plans its first step meanwhile.",
                    )
                activations = 0
                stopped = "Nothing was clicked or typed and no Submit was sent."

                async def send_back(screen: str) -> None:
                    nonlocal activations
                    if activations >= SETTLE_ACTIVATIONS:
                        raise RunError(
                            f"{front_label(screen)} kept coming in front of Claims Workstation "
                            f"while the Cloud PC finished starting. {stopped}"
                        )
                    activations += 1
                    emit(
                        "check",
                        source="application",
                        message=f"{front_label(screen)} came in front of Claims Workstation "
                        "while the Cloud PC finished starting, before any input. Claims "
                        "Workstation is being brought back to the front; that window is not "
                        "used.",
                    )
                    if await activate_claims() == "window_not_found":
                        raise RunError(
                            f"Claims Workstation could not be found to bring back. {stopped}"
                        )
                    # Confirm it took effect before any further request is counted.
                    pause = min(0.5, settle_poll_interval)
                    for _ in range(ACTIVATION_CONFIRM_READS):
                        await asyncio.sleep(pause)
                        screen = await foreground(2, 50)
                        if claims_in_front(screen):
                            return
                    raise RunError(
                        f"{front_label(screen)} stayed in front after Claims Workstation was "
                        f"asked back. {stopped}"
                    )

                while (remaining := settle_until - loop.time()) > 0:
                    await asyncio.sleep(min(settle_poll_interval, remaining))
                    screen = await foreground(2, 50)
                    if not claims_in_front(screen):
                        await send_back(screen)
                screen = await foreground(6, 1000)
                if not claims_in_front(screen):
                    await send_back(screen)
                    screen = await foreground(6, 1000)
                    if not claims_in_front(screen):
                        raise RunError(
                            f"{front_label(screen)} came in front of Claims Workstation again "
                            f"at the end of the start-up wait. {stopped}"
                        )
                emit(
                    "check",
                    source="application",
                    message="The Cloud PC has finished starting and Claims Workstation is in "
                    "front; input can begin.",
                )
                return screen

            settle = (
                asyncio.create_task(settle_desktop())
                if settle_seconds > 0
                else None
            )
            assert model is not None
            stage = "claims_task"
            try:
                async with asyncio.timeout(CLAIMS_TIMEOUT_SECONDS - gate_seconds):
                    result = await perform_claims(
                        handoff,
                        session_id,
                        computer,
                        model,
                        record,
                        initial=tree,
                        state=claims_state,
                        before_first_action=(lambda: settle) if settle else None,
                    )
            finally:
                if settle is not None:
                    if not settle.done():
                        settle.cancel()
                    # Not awaited directly: an outer cancellation must still propagate. The
                    # wait's own failure already reached perform_claims, which awaits it before
                    # any action or finish check; otherwise perform_claims failed first.
                    await asyncio.wait({settle})
                    if not settle.cancelled():
                        settle.exception()
            outcome.update(status=result["status"], result=result)
        else:
            outcome["status"] = "smoke_completed"
    except (Exception, asyncio.CancelledError) as error:  # noqa: BLE001 - terminal boundary reports failure and releases for any SDK exception
        message = (
            str(error)
            if isinstance(error, RunError)
            else (
                "Run cancelled."
                if isinstance(error, asyncio.CancelledError)
                else f"Run stopped ({type(error).__name__}); no successful task outcome was verified."
            )
        )
        if isinstance(error, MCPError) and session_id is None and release_status == "unknown":
            waited = (
                f"did not answer within {START_TIMEOUT_SECONDS} seconds"
                if error.code == REQUEST_TIMEOUT
                else "returned an error"
            )
            message = (
                f"Start Session {waited}. Windows 365 may still have assigned a Cloud PC; "
                "no session ID was recorded, so the allocation is uncertain. Check the pool. "
                "No automatic retry."
            )
        if isinstance(error, ToolRejected):
            service = error.diagnostic or {}
            service_code = service.get("service_code")
            service_status = service.get("service_status")
            reason = "; ".join(
                part
                for part in (
                    f"service code {service_code}" if service_code else "",
                    f"status {service_status}" if service_status else "",
                    service.get("service_message", ""),
                )
                if part
            )
            message = (
                f"Windows 365 Computer-Use rejected {last_tool or 'a tool call'} during "
                f"{STAGES.get(stage, stage)}"
                + (
                    f" ({reason})."
                    if reason
                    else " (the service's reason could not be recorded safely, so it was withheld)."
                    if service.get("service_message_withheld")
                    else " (the service gave no reason)."
                )
                + " "
                + submission_note(stage, claims_state["submit_sent"])
            )
        # Where the run was when it stopped; never tokens, URLs or screen content.
        context = {
            "stage": stage,
            "last_tool_started": last_tool,
            "submit_sent": claims_state["submit_sent"],
        }
        if isinstance(error, UnreadableReply):
            logger.warning(
                "Unreadable Computer-Use reply shape=%s context=%s request=%s",
                error.shape,
                context,
                request_id,
            )
            emit(
                "error",
                source="application",
                message=message,
                diagnostic=error.shape,
                context=context,
            )
        elif isinstance(error, MCPError):
            logger.warning(
                "Computer-Use MCP error code=%d context=%s request=%s",
                error.code,
                context,
                request_id,
            )
            emit(
                "error",
                source="application",
                message=message,
                diagnostic={"mcp_error_code": error.code},
                context=context,
            )
        elif isinstance(error, RunError) and error.diagnostic is not None:
            logger.warning(
                "Run stopped diagnostic=%s context=%s request=%s",
                error.diagnostic,
                context,
                request_id,
            )
            emit(
                "error",
                source="application",
                message=message,
                diagnostic=error.diagnostic,
                context=context,
            )
        else:
            logger.warning(
                "Run stopped (%s) context=%s request=%s", type(error).__name__, context, request_id
            )
            emit("error", source="application", message=message, context=context)
        outcome.update(status="error", message=message)
        result = {
            "request_id": request_id,
            "status": "error",
            "error_code": "USER_CANCELLED"
            if isinstance(error, asyncio.CancelledError)
            else "UNKNOWN",
            "message": message,
            "timestamp": now(),
        }
        validate_contract("error", result)
        outcome["result"] = result
    finally:
        if session_id:
            try:
                # Cancellation of work must not cancel the independent, bounded release attempt.
                release = asyncio.create_task(
                    asyncio.wait_for(
                        computer.call(END, {"sessionId": session_id}),
                        timeout=35,
                    )
                )
                while True:
                    try:
                        response = await asyncio.shield(release)
                        break
                    except asyncio.CancelledError:
                        if release.cancelled():
                            raise
                text_content(response)
                release_status = "accepted"
                emit(
                    "release",
                    source="tool",
                    session_id=session_id,
                    status="accepted",
                    message="End Session accepted; Windows 365 completes cleanup asynchronously.",
                )
            except (Exception, asyncio.CancelledError) as error:  # noqa: BLE001 - failed cleanup must remain an explicit outcome
                release_status = "failed"
                extra = (
                    {"diagnostic": error.diagnostic}
                    if isinstance(error, ToolRejected) and error.diagnostic
                    else {}
                )
                if extra:
                    logger.warning(
                        "End Session rejected diagnostic=%s request=%s",
                        extra["diagnostic"],
                        request_id,
                    )
                emit(
                    "release",
                    source="application",
                    session_id=session_id,
                    status="failed",
                    message=f"Release not confirmed ({type(error).__name__}); administrator cleanup required.",
                    **extra,
                )
        outcome["release_status"] = release_status
        # Release QA R5: callers decide whether a new transfer is safe from this, not from text.
        outcome["submit_sent"] = claims_state["submit_sent"]
        emit("outcome", source="application", **outcome)
    return outcome
