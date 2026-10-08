from pathlib import Path

from playwright.sync_api import sync_playwright
from test_contract import handoff


def test_viewer_uses_official_sdk_shape_and_same_session_without_control():
    html = (Path(__file__).resolve().parents[1] / "hosted_claims" / "viewer.html").read_text()
    state = {
        "request_id": "REQ-2024-0042",
        "running": True,
        "interrupted": False,
        "computer": {"session_id": "test-pc-42"},
        "release": None,
        "outcome": None,
        "events": [
            {"type": "plan", "source": "application", "message": "Test fixture - not live."},
            {"type": "explanation", "source": "model", "message": "<script>throw 1</script>"},
        ],
    }
    wrong_session = False
    attachments = []

    def api(route):
        action = route.request.post_data_json["action"]
        if action == "view":
            body = {
                "request_id": "REQ-2024-0042",
                "session_id": "wrong-pc" if wrong_session else "test-pc-42",
                "computer_url": "https://screen.invalid/computers/test-pc-42?api-version=test-v1",
                "viewer_url": "https://sdk.invalid/1.0.0",
                "sdk_url": "https://sdk.invalid/1.0.0/screenshare-embed.js",
                "mode": "viewOnly",
                "token": "test-only-invalid-token",
            }
        else:
            if action == "view_ready":
                attachments.append(route.request.post_data_json)
            body = state
        route.fulfill(json=body)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1080})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("**/*", lambda route: route.abort())
        page.route(
            "http://localhost:8099/",
            lambda route: route.fulfill(
                content_type="text/html",
                body=html.replace("__LIVE_APPROVED__", "true"),
            ),
        )
        page.route("http://localhost:8099/api", api)
        # A browser contract fixture, NOT the Microsoft screen-share bundle or a live stream.
        page.route(
            "https://sdk.invalid/1.0.0/screenshare-embed.js",
            lambda route: route.fulfill(
                content_type="application/javascript",
                body="""window.ScreenShareViewer = class {
              constructor(options) {
                if (!(options.container instanceof HTMLElement)) throw new Error('container is required');
                if (!options.computerUrl) throw new Error('computerUrl is required');
                if (!new URL(options.computerUrl).searchParams.get('api-version')) throw new Error('api-version is required');
                if (!options.viewerUrl) throw new Error('viewerUrl is required');
                window.viewerOptions = {computerUrl:options.computerUrl,viewerUrl:options.viewerUrl,mode:options.mode};
                window.viewerEvents = {};
              }
              on(name, callback) { window.viewerEvents[name] = callback; }
              async connect(token) { window.connectedToken = token; window.connectResolved = true; }
              stop() { window.stopped = true; }
              takeControl() { throw new Error('Control must never be called'); }
            };""",
            ),
        )
        page.route(
            "http://localhost:8099/handoffs",
            lambda route: route.fulfill(
                json={"handoffs": [{"name": "handoff.json", "handoff": handoff()}]}
            ),
        )
        page.goto("http://localhost:8099/")
        page.locator("#handoff").select_option(label="REQ-2024-0042 - handoff.json")
        page.locator("#start").click()
        page.get_by_text("Same Cloud PC session: test-pc-42").wait_for()
        page.locator("#watch").click()
        page.wait_for_function("window.connectResolved === true")
        assert attachments == [], "Iframe readiness must not release the visible-action barrier."
        page.evaluate("window.viewerEvents.statusChanged('connecting', 'Fixture connecting')")
        assert attachments == []
        page.evaluate("window.viewerEvents.statusChanged('view-only', 'Fixture connection only')")
        page.get_by_text("Watching the agent's acquired session. View only.").wait_for()
        assert page.evaluate("window.viewerOptions") == {
            "computerUrl": "https://screen.invalid/computers/test-pc-42?api-version=test-v1",
            "viewerUrl": "https://sdk.invalid/1.0.0",
            "mode": "viewOnly",
        }
        assert attachments == [
            {"action": "view_ready", "request_id": "REQ-2024-0042", "session_id": "test-pc-42"}
        ]
        assert page.evaluate("window.connectedToken") == "test-only-invalid-token"
        assert "<script>throw 1</script>" in page.locator("#activity").inner_text()
        wrong_session = True
        page.locator("#watch").click()
        page.get_by_text("Viewing response does not match this acquired session.").wait_for()
        assert errors == []
        browser.close()


VIEWER_DELIVERY = "X-Viewer-Delivery"
REQUEST = "REQ-2024-0042"


def _start_failure_page(playwright, start_reply):
    """Synthetic /api: `start_reply(route)` answers Start; status reads return an idle run."""
    html = (Path(__file__).resolve().parents[1] / "hosted_claims" / "viewer.html").read_text()
    calls = []

    def api(route):
        body = route.request.post_data_json
        calls.append((body["action"], body["request_id"]))
        if body["action"] == "start":
            start_reply(route)
        else:
            route.fulfill(
                json={
                    "request_id": body["request_id"],
                    "running": True,
                    "interrupted": False,
                    "computer": None,
                    "release": None,
                    "outcome": None,
                    "events": [],
                }
            )

    browser = playwright.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page()
    page.route("**/*", lambda route: route.abort())
    page.route(
        "http://localhost:8099/",
        lambda route: route.fulfill(
            content_type="text/html", body=html.replace("__LIVE_APPROVED__", "true")
        ),
    )
    page.route("http://localhost:8099/api", api)
    page.route(
        "http://localhost:8099/handoffs",
        lambda route: route.fulfill(
            json={"handoffs": [{"name": "handoff.json", "handoff": handoff()}]}
        ),
    )
    page.goto("http://localhost:8099/")
    page.locator("#handoff").select_option(label=f"{REQUEST} - handoff.json")
    return browser, page, calls


def _click_start_and_wait_for_error(page):
    page.locator("#start").click()
    page.wait_for_function("document.getElementById('error').textContent !== ''")


UNCERTAIN_START_REPLIES = {
    "explicit unknown from the viewer": lambda route: route.fulfill(
        status=502,
        headers={VIEWER_DELIVERY: "unknown"},
        json={"error": "Synthetic failure.", "delivery": "unknown"},
    ),
    "error without delivery metadata": lambda route: route.fulfill(
        status=502, json={"error": "Synthetic failure."}
    ),
    "not_sent claimed only in a passed-through body": lambda route: route.fulfill(
        status=500, json={"error": "Synthetic upstream failure.", "delivery": "not_sent"}
    ),
    "non-JSON body": lambda route: route.fulfill(
        status=502, content_type="text/html", body="<html>Synthetic gateway page</html>"
    ),
    "invalid JSON body": lambda route: route.fulfill(
        status=200, content_type="application/json", body="{"
    ),
    "rejected fetch": lambda route: route.abort(),
}


def test_any_failure_after_the_start_fetch_blocks_another_start_but_keeps_watch():
    with sync_playwright() as playwright:
        for name, reply in UNCERTAIN_START_REPLIES.items():
            browser, page, calls = _start_failure_page(playwright, reply)
            _click_start_and_wait_for_error(page)
            assert calls == [("start", REQUEST)], name
            assert page.locator("#start").is_disabled(), name
            assert "result unknown" in page.locator("#connection").inner_text(), name
            assert "do not start another" in page.locator("#notice").inner_text(), name
            assert page.locator("#request").input_value() == REQUEST, name
            page.locator("#handoff").select_option(index=0)
            page.locator("#handoff").select_option(label=f"{REQUEST} - handoff.json")
            assert page.locator("#start").is_disabled(), name
            page.locator("#resume").click()
            page.get_by_text("Live run active").wait_for()
            assert calls == [("start", REQUEST), ("status", REQUEST)], name
            browser.close()


def test_only_the_viewer_reporting_not_sent_lets_the_same_start_be_retried():
    with sync_playwright() as playwright:
        browser, page, calls = _start_failure_page(
            playwright,
            lambda route: route.fulfill(
                status=502,
                headers={VIEWER_DELIVERY: "not_sent"},
                json={"error": "Synthetic not sent.", "delivery": "not_sent"},
            ),
        )
        _click_start_and_wait_for_error(page)
        assert calls == [("start", REQUEST)]
        assert page.locator("#start").is_enabled()
        browser.close()


def test_a_start_refused_before_any_fetch_does_not_consume_the_request():
    with sync_playwright() as playwright:
        browser, page, calls = _start_failure_page(playwright, lambda route: route.abort())
        page.locator("#request").fill("REQ-2024-0043")
        _click_start_and_wait_for_error(page)
        assert calls == []
        assert "must match" in page.locator("#error").inner_text()
        assert page.locator("#start").is_enabled()
        browser.close()
