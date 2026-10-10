import asyncio
import json
from contextlib import asynccontextmanager

import httpx2
import pytest
from microsoft_agents.authentication.msal import MsalAuth
from test_contract import handoff
from test_lifecycle import Cloud, result

from hosted_claims.host import Settings, create_app
from hosted_claims.identity import AgentIdentity
from hosted_claims.store import RunStore


@pytest.mark.asyncio
async def test_official_host_runs_smoke_once_and_replays_correlated_events(tmp_path):
    clouds = []

    @asynccontextmanager
    async def connection(settings, request_id):
        cloud = Cloud()
        clouds.append(cloud)
        yield cloud

    app = create_app(Settings(live_approved=True), RunStore(tmp_path / "runs.sqlite"), connection)
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app),
        base_url="http://localhost",
    ) as client:
        url = "/invocations?agent_session_id=REQ-2024-0042"
        payload = {
            "action": "start",
            "operation": "smoke",
            "request_id": "REQ-2024-0042",
            "handoff": handoff(),
        }
        started = await client.post(url, json=payload)
        assert started.status_code == 202, started.text
        for _ in range(20):
            poll = await client.post(url, json={"action": "status", "request_id": "REQ-2024-0042"})
            if poll.json().get("outcome"):
                break
            if poll.json().get("computer"):
                await client.post(
                    url,
                    json={
                        "action": "view_ready",
                        "request_id": "REQ-2024-0042",
                        "session_id": "pc-session-1",
                    },
                )
            await asyncio.sleep(0.01)
        assert poll.json()["outcome"]["status"] == "smoke_completed"
        assert poll.json()["computer"]["session_id"] == "pc-session-1"
        replay = await client.post(url, json=payload)
        assert replay.status_code == 200
        assert len(clouds) == 1
        assert clouds[0].released


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "screen_url,accepted",
    [
        ("https://pc.example/computers/pc-42/screenshare?api-version=test-v1&value=a%2Fb", True),
        ("https://pc.example/computers/pc-42/screenshare", False),
        ("https://pc.example/computers/pc-42/screenshare?api-version=", False),
        ("https://pc.example/computers/pc-42/screenshare?api-version=&api-version=test-v1", False),
        ("https://pc.example/unexpected?api-version=test-v1", False),
        ("https://user:password@pc.example/screenshare?api-version=test-v1", False),
    ],
)
async def test_viewing_token_is_only_for_the_same_currently_acquired_session(
    tmp_path, monkeypatch, screen_url, accepted
):
    ready = asyncio.Event()
    release_wait = asyncio.Event()
    scopes_used = []

    class Waiting(Cloud):
        async def call(self, name, arguments):
            if name.endswith("StartSession"):
                return result(
                    json.dumps({"sessionId": "pc-session-1", "screenShareUrl": screen_url})
                )
            if name.endswith("GetSessionDetails"):
                ready.set()
                await release_wait.wait()
            return await super().call(name, arguments)

    @asynccontextmanager
    async def connection(settings, request_id):
        yield Waiting()

    async def token(self, tenant, agent, user, scopes):
        scopes_used.extend(scopes)
        return "test-only-screen-token"

    monkeypatch.setattr(MsalAuth, "get_agentic_user_token", token)
    identity = AgentIdentity("tenant", "blueprint", "agent", "agent-user", "unused")
    app = create_app(
        Settings(
            live_approved=True,
            identity=identity,
            screen_sdk_url="https://sdk.invalid/1.0.0/screenshare-embed.js",
        ),
        RunStore(tmp_path / "runs.sqlite"),
        connection,
    )
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app),
        base_url="http://localhost",
    ) as client:
        url = "/invocations?agent_session_id=REQ-2024-0042"
        await client.post(
            url,
            json={
                "action": "start",
                "request_id": "REQ-2024-0042",
                "operation": "smoke",
                "handoff": handoff(),
            },
        )
        await asyncio.wait_for(ready.wait(), 2)
        view = await client.post(url, json={"action": "view", "request_id": "REQ-2024-0042"})
        release_wait.set()
        if not accepted:
            assert view.status_code == 400, view.text
            assert "screenShareUrl" in view.json()["error"]
            assert scopes_used == [], "Reject unusable targets before requesting any token."
            await client.post(url, json={"action": "cancel", "request_id": "REQ-2024-0042"})
            await asyncio.sleep(0.02)
            return
        assert view.status_code == 200, view.text
        assert view.json()["session_id"] == "pc-session-1"
        assert view.json()["computer_url"] == (
            "https://pc.example/computers/pc-42?api-version=test-v1&value=a%2Fb"
        )
        assert view.json()["viewer_url"] == "https://sdk.invalid/1.0.0"
        assert view.json()["sdk_url"] == "https://sdk.invalid/1.0.0/screenshare-embed.js"
        assert view.json()["token"] == "test-only-screen-token"
        assert scopes_used == ["90ecec28-f5a6-42b3-9bde-dae1ca98f8b5/Computer.See"]
        await client.post(
            url,
            json={
                "action": "view_ready",
                "request_id": "REQ-2024-0042",
                "session_id": "pc-session-1",
            },
        )
        for _ in range(20):
            status = await client.post(
                url, json={"action": "status", "request_id": "REQ-2024-0042"}
            )
            if status.json().get("outcome"):
                break
            await asyncio.sleep(0.01)
        stale = await client.post(url, json={"action": "view", "request_id": "REQ-2024-0042"})
        assert stale.status_code == 400


@pytest.mark.asyncio
async def test_interrupted_run_can_release_recorded_session_without_repeating_task(tmp_path):
    store = RunStore(tmp_path / "runs.sqlite")
    store.begin(handoff(), "smoke", "REQ-2024-0042")
    store.append({"type": "computer", "request_id": "REQ-2024-0042", "session_id": "pc-session-1"})
    cloud = Cloud()

    async def release_existing(session_id):
        return await cloud.call("mcp_W365ComputerUse_EndSession", {"sessionId": session_id})

    cloud.release_existing = release_existing

    @asynccontextmanager
    async def connection(settings, request_id):
        yield cloud

    app = create_app(Settings(live_approved=True), store, connection)
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        response = await client.post(
            "/invocations?agent_session_id=REQ-2024-0042",
            json={
                "action": "recover",
                "request_id": "REQ-2024-0042",
            },
        )
    assert response.status_code == 200, response.text
    assert cloud.released and not cloud.acquired and not cloud.visible
    assert response.json()["release"]["status"] == "accepted"
    assert response.json()["outcome"]["status"] == "error"


def unread_start(store, request_id="REQ-2024-0042"):
    store.begin(handoff(), "smoke", request_id)
    store.append(
        {
            "type": "tool_started",
            "request_id": request_id,
            "timestamp": "2026-10-02T06:00:38+00:00",
            "source": "tool",
            "tool": "mcp_W365ComputerUse_StartSession",
        }
    )
    store.append(
        {
            "type": "outcome",
            "request_id": request_id,
            "timestamp": "2026-10-02T06:01:06+00:00",
            "source": "application",
            "execution_mode": "live",
            "status": "error",
            "message": "Run stopped (JSONDecodeError); no successful task outcome was verified.",
            "release_status": "unknown",
        }
    )


class Recovery:
    def __init__(self):
        self.ended = []

    async def release_existing(self, session_id):
        self.ended.append(session_id)
        return result("Accepted")


async def recover(store, recovery):
    @asynccontextmanager
    async def connection(settings, request_id):
        yield recovery

    app = create_app(Settings(live_approved=True), store, connection)
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        return await client.post(
            "/invocations?agent_session_id=REQ-2024-0042",
            json={"action": "recover", "request_id": "REQ-2024-0042"},
        )


@pytest.mark.asyncio
async def test_unread_start_reply_is_never_released_under_a_derived_session_id(tmp_path):
    store = RunStore(tmp_path / "runs.sqlite")
    unread_start(store)
    recovery = Recovery()
    response = await recover(store, recovery)
    assert response.status_code == 400, response.text
    assert "Administrator allocation cleanup" in response.json()["error"]
    assert "unknown" in response.json()["error"] and "minutes" not in response.json()["error"]
    assert recovery.ended == []


@pytest.mark.asyncio
async def test_recovery_without_any_start_attempt_still_refuses(tmp_path):
    store = RunStore(tmp_path / "runs.sqlite")
    store.begin(handoff(), "smoke", "REQ-2024-0042")
    recovery = Recovery()
    response = await recover(store, recovery)
    assert response.status_code == 400, response.text
    assert recovery.ended == []


@pytest.mark.asyncio
async def test_failed_authentication_returns_shared_correlated_error_before_acquisition(tmp_path):
    @asynccontextmanager
    async def connection(settings, request_id):
        raise PermissionError("external credentials rejected")
        yield

    app = create_app(Settings(live_approved=True), RunStore(tmp_path / "runs.sqlite"), connection)
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        url = "/invocations?agent_session_id=REQ-2024-0042"
        await client.post(
            url,
            json={
                "action": "start",
                "request_id": "REQ-2024-0042",
                "operation": "smoke",
                "handoff": handoff(),
            },
        )
        await asyncio.sleep(0.02)
        status = await client.post(url, json={"action": "status", "request_id": "REQ-2024-0042"})
    assert status.json()["outcome"]["result"]["request_id"] == "REQ-2024-0042"
    assert status.json()["outcome"]["result"]["status"] == "error"


@pytest.mark.asyncio
async def test_request_cannot_be_replayed_in_another_hosted_sandbox(tmp_path):
    app = create_app(Settings(live_approved=True), RunStore(tmp_path / "runs.sqlite"))
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        response = await client.post(
            "/invocations?agent_session_id=other-session",
            json={
                "action": "start",
                "operation": "smoke",
                "request_id": "REQ-2024-0042",
                "handoff": handoff(),
            },
        )
    assert response.status_code == 400
    assert "session" in response.text


@pytest.mark.asyncio
async def test_prepare_warms_this_sandbox_once_and_records_no_run(tmp_path):
    prepared = []

    async def prepare(settings, request_id):
        prepared.append(request_id)

    async def failing(settings, request_id):
        raise RuntimeError("token service unavailable")

    @asynccontextmanager
    async def connection(settings, request_id):
        yield Cloud()

    for factory in (prepare, failing):
        app = create_app(
            Settings(live_approved=True), RunStore(tmp_path / f"{factory.__name__}.sqlite"),
            connection, prepare_factory=factory,
        )
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
        ) as client:
            url = "/invocations?agent_session_id=REQ-2024-0042"
            for _ in range(2):
                answer = await client.post(url, json={"action": "prepare", "request_id": "REQ-2024-0042"})
                assert answer.status_code == 202, answer.text
                assert answer.json() == {"request_id": "REQ-2024-0042", "prepared": True}
            await asyncio.sleep(0.01)
            # Preparing is not starting: there is still no run for this request.
            status = await client.post(url, json={"action": "status", "request_id": "REQ-2024-0042"})
            assert status.status_code == 404
            started = await client.post(url, json={
                "action": "start", "operation": "smoke", "request_id": "REQ-2024-0042",
                "handoff": handoff(),
            })
            assert started.status_code == 202, started.text
            await client.post(url, json={"action": "cancel", "request_id": "REQ-2024-0042"})
            await asyncio.sleep(0.02)
    assert prepared == ["REQ-2024-0042"]


@pytest.mark.asyncio
async def test_prepare_for_another_sandbox_is_refused(tmp_path):
    app = create_app(Settings(live_approved=True), RunStore(tmp_path / "runs.sqlite"))
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        answer = await client.post(
            "/invocations?agent_session_id=REQ-2024-0001",
            json={"action": "prepare", "request_id": "REQ-2024-0042"},
        )
    assert answer.status_code == 400


@pytest.mark.asyncio
async def test_status_after_a_sequence_returns_only_newer_events_and_the_same_summary(tmp_path):
    @asynccontextmanager
    async def connection(settings, request_id):
        yield Cloud()

    app = create_app(Settings(live_approved=True), RunStore(tmp_path / "runs.sqlite"), connection)
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        url = "/invocations?agent_session_id=REQ-2024-0042"
        status = {"action": "status", "request_id": "REQ-2024-0042"}
        await client.post(url, json={"action": "start", "operation": "smoke",
                                     "request_id": "REQ-2024-0042", "handoff": handoff()})
        for _ in range(20):
            full = (await client.post(url, json=status)).json()
            if full.get("outcome"):
                break
            if full.get("computer"):
                await client.post(url, json={"action": "view_ready", "request_id": "REQ-2024-0042",
                                             "session_id": "pc-session-1"})
            await asyncio.sleep(0.01)
        sequences = [e["sequence"] for e in full["events"]]
        assert len(sequences) > 2
        middle = sequences[len(sequences) // 2]
        newer = (await client.post(url, json={**status, "after_sequence": middle})).json()
        assert [e["sequence"] for e in newer["events"]] == [s for s in sequences if s > middle]
        assert {k: newer[k] for k in ("computer", "outcome", "release")} == {
            k: full[k] for k in ("computer", "outcome", "release")}
        none_newer = (await client.post(url, json={**status, "after_sequence": sequences[-1]})).json()
        assert none_newer["events"] == [] and none_newer["outcome"] == full["outcome"]
        for ignored in (-1, "3", True, None):
            same = (await client.post(url, json={**status, "after_sequence": ignored})).json()
            assert [e["sequence"] for e in same["events"]] == sequences
