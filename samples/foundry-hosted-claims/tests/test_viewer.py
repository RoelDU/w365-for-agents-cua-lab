import errno
import json
from types import SimpleNamespace

import httpcore2
import httpx2
import pytest

from hosted_claims.viewer import create_viewer


@pytest.mark.asyncio
async def test_local_viewer_opens_without_cloud_access_and_rejects_external_origins():
    app = create_viewer()
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app),
        base_url="http://localhost:8099",
    ) as client:
        page = await client.get("/")
        assert page.status_code == 200
        for label in ("Plan", "Computer", "Activity", "Outcome", "Not connected"):
            assert label in page.text
        cross_site = await client.post(
            "/api", json={"action": "view"}, headers={"Origin": "https://attacker.invalid"}
        )
        assert cross_site.status_code == 403
        disabled = await client.post(
            "/api", json={"action": "start"}, headers={"Origin": "http://localhost:8099"}
        )
        assert disabled.status_code == 403
        assert "approval" in disabled.text


@pytest.mark.asyncio
async def test_prepared_requests_are_listed_from_the_folder_without_a_file_picker(
    monkeypatch, tmp_path
):
    from test_contract import handoff

    (tmp_path / "smoke.json").write_text(json.dumps(handoff()), encoding="utf-8")
    (tmp_path / "deployment-result.json").write_text('{"version": "10"}', encoding="utf-8")
    (tmp_path / "broken.json").write_text("{", encoding="utf-8")
    not_foundry = handoff() | {"target_backend": "mcs"}
    (tmp_path / "mcs.json").write_text(json.dumps(not_foundry), encoding="utf-8")
    monkeypatch.setenv("HANDOFF_DIR", str(tmp_path))
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=create_viewer()), base_url="http://localhost:8099"
    ) as client:
        listed = (await client.get("/handoffs")).json()["handoffs"]
    assert [(item["name"], item["handoff"]["request_id"]) for item in listed] == [
        ("smoke.json", "REQ-2024-0042")
    ]
    monkeypatch.setenv("HANDOFF_DIR", str(tmp_path / "missing"))
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=create_viewer()), base_url="http://localhost:8099"
    ) as client:
        missing = await client.get("/handoffs")
    assert missing.status_code == 503 and "HANDOFF_DIR" in missing.text


@pytest.mark.asyncio
async def test_viewer_proxies_attachment_to_exact_hosted_request_session(monkeypatch):
    monkeypatch.setenv("LIVE_EXECUTION_APPROVED", "yes")
    monkeypatch.setenv("CLAIMS_TENANT_ID", "test-tenant")
    monkeypatch.setenv(
        "HOSTED_AGENT_ENDPOINT",
        "https://test.services.ai.azure.com/api/projects/p/agents/a/endpoint/protocols/invocations",
    )
    from types import SimpleNamespace

    from hosted_claims import viewer

    class Credential:
        def __init__(self, **kwargs):
            assert kwargs["tenant_id"] == "test-tenant"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get_token(self, scope):
            assert scope == "https://ai.azure.com/.default"
            return SimpleNamespace(token="invalid-test-only")

    calls = []

    def upstream(request):
        calls.append(request)
        return httpx2.Response(
            200, json={"viewer_ready": True}, headers={"X-Viewer-Delivery": "not_sent"}
        )

    client_class = httpx2.AsyncClient
    app_client = client_class(
        transport=httpx2.ASGITransport(app=viewer.create_viewer()),
        base_url="http://localhost:8099",
    )
    monkeypatch.setattr(viewer, "AzureCliCredential", Credential)
    monkeypatch.setattr(
        viewer.httpx2,
        "AsyncClient",
        lambda **kwargs: client_class(
            transport=httpx2.MockTransport(upstream),
            **kwargs,
        ),
    )
    async with app_client as client:
        response = await client.post(
            "/api",
            json={
                "action": "view_ready",
                "request_id": "REQ-2024-0042",
                "session_id": "pc-42",
            },
            headers={"Origin": "http://localhost:8099"},
        )
    assert response.status_code == 200, response.text
    assert calls[0].url.params["agent_session_id"] == "REQ-2024-0042"
    assert "x-viewer-delivery" not in response.headers, "Only the local viewer sets delivery."


class _Credential:
    """Synthetic Azure CLI credential; never runs the Azure CLI."""

    def __init__(self, error=None):
        self.error = error
        self.created = []

    def __call__(self, **kwargs):
        self.created.append(kwargs)
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get_token(self, scope):
        if self.error:
            raise self.error
        return SimpleNamespace(token="invalid-test-only")


class _Stream(httpcore2.AsyncNetworkStream):
    """Synthetic socket: fails at the named network step with a raw OS error."""

    def __init__(self, fail_at, sent):
        self.fail_at, self.sent = fail_at, sent

    async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        if self.fail_at == "tls":
            # The shape truststore raises when Windows certificate verification fails.
            raise OSError(errno.EIO, "synthetic certificate store failure")
        return self

    async def write(self, buffer, timeout=None):
        self.sent.append(buffer)

    async def read(self, max_bytes, timeout=None):
        raise OSError(errno.EIO, "synthetic read failure")

    async def aclose(self):
        pass

    def get_extra_info(self, info):
        return None


class _Backend(httpcore2.AsyncNetworkBackend):
    def __init__(self, fail_at):
        self.fail_at, self.sent = fail_at, []

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        return _Stream(self.fail_at, self.sent)


async def _post_through_viewer(monkeypatch, action, *, credential=None, backend=None):
    from hosted_claims import viewer

    monkeypatch.setenv("LIVE_EXECUTION_APPROVED", "yes")
    monkeypatch.setenv("CLAIMS_TENANT_ID", "test-tenant")
    monkeypatch.setenv(
        "HOSTED_AGENT_ENDPOINT",
        "https://test.services.ai.azure.com/api/projects/p/agents/a/endpoint/protocols/invocations",
    )
    monkeypatch.setattr(viewer, "AzureCliCredential", credential or _Credential())
    client_class = httpx2.AsyncClient
    app_client = client_class(
        transport=httpx2.ASGITransport(app=viewer.create_viewer()),
        base_url="http://localhost:8099",
    )

    def upstream_client(**kwargs):
        # Real httpx2/httpcore2 request path over a synthetic network backend.
        transport = httpx2.AsyncHTTPTransport()
        transport._pool = httpcore2.AsyncConnectionPool(network_backend=backend)
        return client_class(transport=transport, **kwargs)

    monkeypatch.setattr(viewer.httpx2, "AsyncClient", upstream_client)
    async with app_client as client:
        return await client.post(
            "/api",
            json={"action": action, "request_id": "REQ-2024-0042"},
            headers={"Origin": "http://localhost:8099"},
        )


@pytest.mark.asyncio
async def test_raw_os_error_during_tls_reports_that_the_request_was_never_sent(monkeypatch):
    backend = _Backend("tls")
    response = await _post_through_viewer(monkeypatch, "start", backend=backend)
    assert response.status_code == 502
    body = response.json()
    assert backend.sent == []
    assert body["phase"] == "tls"
    assert body["delivery"] == "not_sent"
    assert response.headers["x-viewer-delivery"] == "not_sent"
    assert body["error_type"] == "OSError"
    assert body["errno"] == errno.EIO
    assert "was not sent" in body["error"]
    assert "synthetic certificate store failure" not in response.text


@pytest.mark.asyncio
async def test_failure_after_the_request_was_sent_reports_an_unknown_result(monkeypatch):
    backend = _Backend("read")
    response = await _post_through_viewer(monkeypatch, "start", backend=backend)
    assert response.status_code == 502
    body = response.json()
    assert backend.sent, "The synthetic socket must have received the request bytes."
    assert body["phase"] == "receive"
    assert body["delivery"] == "unknown"
    assert response.headers["x-viewer-delivery"] == "unknown"
    assert body["error_type"] == "OSError"
    assert "result is unknown" in body["error"]
    assert "do not start another" in body["error"]
    assert "synthetic read failure" not in response.text
    assert b"invalid-test-only" not in response.content


@pytest.mark.asyncio
async def test_slow_or_failed_cli_sign_in_is_reported_before_anything_is_sent(monkeypatch):
    from azure.identity import CredentialUnavailableError

    backend = _Backend("never")
    credential = _Credential(CredentialUnavailableError("synthetic cli stderr secret-ish"))
    response = await _post_through_viewer(
        monkeypatch, "start", credential=credential, backend=backend
    )
    assert response.status_code == 502
    body = response.json()
    assert backend.sent == []
    assert body["phase"] == "auth"
    assert body["delivery"] == "not_sent"
    assert response.headers["x-viewer-delivery"] == "not_sent"
    assert body["error_type"] == "CredentialUnavailableError"
    assert "secret-ish" not in response.text
    assert credential.created == [{"tenant_id": "test-tenant", "process_timeout": 45}]


@pytest.mark.asyncio
async def test_preflight_checks_sign_in_and_tls_with_a_read_only_agent_get(monkeypatch):
    from hosted_claims import viewer

    monkeypatch.setenv("LIVE_EXECUTION_APPROVED", "yes")
    monkeypatch.setenv("CLAIMS_TENANT_ID", "test-tenant")
    monkeypatch.setenv(
        "HOSTED_AGENT_ENDPOINT",
        "https://test.services.ai.azure.com/api/projects/p/agents/a/endpoint/protocols/invocations",
    )
    monkeypatch.setattr(viewer, "AzureCliCredential", _Credential())
    calls = []

    def upstream(request):
        calls.append(request)
        return httpx2.Response(200, json={"name": "a", "secret_looking": "not-forwarded"})

    client_class = httpx2.AsyncClient
    monkeypatch.setattr(
        viewer.httpx2,
        "AsyncClient",
        lambda **kwargs: client_class(transport=httpx2.MockTransport(upstream), **kwargs),
    )
    async with client_class(
        transport=httpx2.ASGITransport(app=viewer.create_viewer()),
        base_url="http://localhost:8099",
    ) as client:
        cross_site = await client.post("/preflight", headers={"Origin": "https://x.invalid"})
        response = await client.post("/preflight", headers={"Origin": "http://localhost:8099"})
    assert cross_site.status_code == 403
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True and body["status"] == 200
    assert "not-forwarded" not in response.text
    assert [(c.method, c.url.path, c.url.params["api-version"]) for c in calls] == [
        ("GET", "/api/projects/p/agents/a", "v1")
    ]
