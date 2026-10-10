import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { RightRail } from "@/components/workflow/RightRail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthStore } from "@/stores/useAuthStore";
import { useCallStore } from "@/stores/useCallStore";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { SAMPLE_AGENT } from "./fixtures/agent";
import { finishReconnect, resetTransferRecorderForTests, useRecoveryStore } from "@/lib/handoffRecovery";

// The relay now requires the signed-in user's existing Handoff.Access token on every action.
// fail: every call fails; failAfter: calls after the first N fail; interaction: Microsoft
// says the person must interact; pending: hold calls until released.
const tokenMock = vi.hoisted(() => ({
  fail: false,
  failAfter: -1,
  interaction: false,
  calls: 0,
  reconnects: 0,
  noAccount: false,
  reconnectArgs: [] as unknown[],
  pending: null as Promise<void> | null
}));
vi.mock("@/lib/msalLogin", () => ({
  acquireHandoffAccessToken: vi.fn(async () => {
    tokenMock.calls += 1;
    const call = tokenMock.calls;
    if (tokenMock.pending) await tokenMock.pending;
    if (tokenMock.fail || (tokenMock.failAfter >= 0 && call > tokenMock.failAfter)) {
      throw Object.assign(new Error(tokenMock.interaction
        ? "Microsoft needs you to confirm your sign-in before an AI agent transfer (login_required)."
        : "Sign in again."), {
        code: tokenMock.interaction ? "login_required" : "",
        interactionRequired: tokenMock.interaction
      });
    }
    return "user-token";
  }),
  getSignedInAccount: vi.fn(async () => (tokenMock.noAccount ? null : ME)),
  startHandoffReconnect: vi.fn(async (opts?: unknown) => {
    tokenMock.reconnects += 1;
    tokenMock.reconnectArgs.push(opts);
    await new Promise(() => undefined); // a real redirect leaves the page
  })
}));

const ME = { homeAccountId: "oid-1.tid-1", tenantId: "tid-1", username: "tu1@contoso.example" };

const API = "http://svc.test/api";
const SDK = "https://packages.global.cloudinferenceplatform.azure.com/screenshare-sdk/1.0.0/screenshare-embed.js";

type Handler = (...args: unknown[]) => unknown;
class FakeViewer {
  static all: FakeViewer[] = [];
  handlers: Record<string, Handler> = {};
  token: string | null = null;
  stopped = false;
  constructor(public opts: Record<string, unknown>) { FakeViewer.all.push(this); }
  on(event: string, fn: Handler) { this.handlers[event] = fn; }
  async connect(token: string) { this.token = token; }
  async updateToken(token: string) { this.token = token; }
  stop() { this.stopped = true; }
  emit(event: string, ...args: unknown[]) { return this.handlers[event]?.(...args); }
}

// Every test may prepare: the confirmation asks the relay to prepare its request once.
const prepared: unknown[] = [];
const server = setupServer(
  http.post(`${API}/foundry-claims/prepare`, async ({ request }) => {
    prepared.push(await request.json());
    return HttpResponse.json({ request_id: "x", prepared: true }, { status: 202 });
  })
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  Object.assign(tokenMock, { fail: false, failAfter: -1, interaction: false, calls: 0, reconnects: 0, noAccount: false, reconnectArgs: [], pending: null });
  sessionStorage.clear();
  prepared.length = 0;
  resetTransferRecorderForTests();
  FakeViewer.all = [];
  (window as unknown as { ScreenShareViewer: unknown }).ScreenShareViewer = FakeViewer;
  useAuthStore.setState({ agent: SAMPLE_AGENT });
  useSettingsStore.setState({
    backend: "mcs",
    orchestratorUrl: `${API}`,
    cuaMode: false,
    cuaRunBaseUrl: API,
    directLineTokenUrl: "",
    activeRegionId: "au"
  });
  useHandoffStore.getState().reset();
  useCallStore.getState().reset();
  useCallStore.getState().startRinging();
  useCallStore.getState().answerCall();
  useCallStore.getState().appendTranscriptLine();
});

function available(ready: boolean, message = ready ? "Foundry hosted agent is available." : "Foundry Claims runs are not enabled for CCaaS yet.") {
  return http.get(`${API}/foundry-claims/availability`, () => HttpResponse.json({ configured: true, ready, message }));
}

function ev(sequence: number, type: string, extra: Record<string, unknown> = {}) {
  return { type, sequence, timestamp: `2026-10-02T01:00:${String(sequence).padStart(2, "0")}Z`, source: "application", ...extra };
}

async function openFoundry() {
  render(<TooltipProvider><RightRail /></TooltipProvider>);
  fireEvent.click(screen.getByTestId("open-transfer-directory"));
  const button = await screen.findByTestId("handoff-to-ai-foundry");
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  return screen.findByTestId("handoff-confirm");
}

describe("separate Foundry hosted transfer (mock HTTP and a fake viewer, not live proof)", () => {
  it("offers MCS and Foundry as separate destinations and says honestly when Foundry is not enabled", async () => {
    server.use(available(false));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    expect(await screen.findByTestId("handoff-to-ai-mcs")).not.toBeDisabled();
    const foundry = screen.getByTestId("handoff-to-ai-foundry");
    await waitFor(() => expect(screen.getByTestId("handoff-foundry-availability"))
      .toHaveTextContent(/not enabled for CCaaS yet/i));
    expect(foundry).toBeDisabled();
  });

  it("describes the Copilot Studio route that is actually used (trigger flow, not Direct Line)", async () => {
    server.use(available(false));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    const mcs = await screen.findByTestId("handoff-to-ai-mcs");
    expect(mcs).toHaveTextContent(/trigger flow/i);
    expect(mcs).not.toHaveTextContent(/Direct Line/i);
    fireEvent.click(mcs);
    const modal = await screen.findByTestId("handoff-modal");
    expect(modal).toHaveTextContent(/trigger flow/i);
    expect(modal).not.toHaveTextContent(/Direct Line/i);
  });

  it("asks status only for events after the last one it already has, and still shows the result", async () => {
    let start: Record<string, unknown> | undefined;
    const bodies: Record<string, unknown>[] = [];
    const acquired = [
      ev(1, "plan", { message: "Acquire a Cloud PC, then open Claims." }),
      ev(2, "computer", { session_id: "sess-1", screen_share_url: "https://screen" })
    ];
    const later = (id: unknown) => [
      ev(3, "explanation", { explanation_type: "assistant_text", message: "Search for the caller's policy.", source: "model" }),
      ev(4, "release", { session_id: "sess-1", status: "accepted" }),
      ev(5, "outcome", { request_id: id, status: "submitted", submit_sent: true, release_status: "accepted",
        result: { request_id: id, status: "submitted", claim_id: "CLM-2026-000321", agent_id: "C1001", timestamp: "2026-10-02T01:01:00Z" } })
    ];
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, async ({ request }) => {
        start = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ request_id: start.request_id, events: acquired, computer: acquired[1], outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/view`, () => HttpResponse.json({
        request_id: start?.request_id, session_id: "sess-1", computer_url: "https://computer", viewer_url: "https://viewer",
        sdk_url: SDK, token: "view-secret", mode: "viewOnly"
      })),
      http.post(`${API}/foundry-claims/status`, async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        bodies.push(body);
        const after = typeof body.after_sequence === "number" ? body.after_sequence : 0;
        const tail = later(body.request_id);
        const events = [...acquired, ...tail].filter((e) => (e.sequence ?? 0) > after);
        return HttpResponse.json({ events, computer: acquired[1], outcome: tail[2], release: tail[1], running: false, interrupted: false });
      })
    );
    fireEvent.click(await openFoundry());

    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id")).toHaveTextContent("CLM-2026-000321"), { timeout: 4500 });
    expect(bodies[0]).toEqual({ request_id: start?.request_id, after_sequence: 2 });
    const log = useHandoffStore.getState().activity.map((a) => a.message).join("\n");
    expect(log).toContain("Search for the caller's policy.");
  });

  it("starts one Claims run, connects the view-only screen, and returns the real result to this interaction", async () => {
    let start: Record<string, unknown> | undefined;
    let starts = 0;
    let viewReady: Record<string, unknown> | undefined;
    const acquired = [
      ev(1, "plan", { message: "Acquire a Cloud PC, then open Claims." }),
      ev(2, "computer", { session_id: "sess-1", screen_share_url: "https://screen" }),
      ev(3, "session_details", { session_id: "sess-1", message: "Cloud PC session details received." }),
      ev(4, "readiness", { message: "The Cloud PC is ready for the agent." })
    ];
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, async ({ request }) => {
        starts += 1;
        start = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ request_id: start.request_id, events: acquired, computer: acquired[1], outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/view`, () => HttpResponse.json({
        request_id: start?.request_id, session_id: "sess-1", computer_url: "https://computer", viewer_url: "https://viewer",
        sdk_url: SDK, token: "view-secret", mode: "viewOnly"
      })),
      http.post(`${API}/foundry-claims/view_ready`, async ({ request }) => {
        viewReady = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
      http.post(`${API}/foundry-claims/status`, () => {
        if (!viewReady) return HttpResponse.json({ events: acquired, computer: acquired[1], outcome: null, release: null, running: true, interrupted: false });
        const events = [...acquired,
          ev(5, "viewer_connected", { session_id: "sess-1", source: "viewer" }),
          ev(6, "explanation", { explanation_type: "model_summary", message: "The FNOL form is open; I will enter the loss date.", source: "model" }),
          ev(7, "release", { session_id: "sess-1", status: "accepted" }),
          ev(8, "outcome", { status: "submitted", release_status: "accepted",
            result: { request_id: start?.request_id, status: "submitted", claim_id: "CLM-2026-000321", agent_id: "foundry", timestamp: "2026-10-02T01:01:00Z" } })];
        return HttpResponse.json({ events, computer: acquired[1], outcome: events[7], release: events[6], running: false, interrupted: false });
      })
    );
    fireEvent.click(await openFoundry());

    await waitFor(() => expect(FakeViewer.all).toHaveLength(1));
    const viewer = FakeViewer.all[0];
    expect(viewer.opts).toMatchObject({ computerUrl: "https://computer", viewerUrl: "https://viewer", mode: "viewOnly" });
    await waitFor(() => expect(viewer.token).toBe("view-secret"));
    expect(starts).toBe(1);
    expect(start).toMatchObject({ operation: "claims", handoff: { target_backend: "foundry", request_id: start?.request_id } });
    expect(String(start?.request_id)).toMatch(/^REQ-[0-9]{4}-[0-9]{4,}$/);
    expect(new TextEncoder().encode(JSON.stringify({ action: "start", ...start })).length).toBeLessThan(32000);

    await act(async () => { await viewer.emit("statusChanged", "connected"); await viewer.emit("statusChanged", "view-only"); });
    await waitFor(() => expect(viewReady).toEqual({ request_id: start?.request_id, session_id: "sess-1" }));

    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id")).toHaveTextContent("CLM-2026-000321"), { timeout: 4500 });
    expect(screen.getByTestId("ai-live-explanation")).toHaveTextContent("The FNOL form is open; I will enter the loss date.");
    expect(screen.getByTestId("ai-live-explanation-label")).toHaveTextContent(/reasoning summary/i);
    expect(screen.getByTestId("ai-status-release")).toHaveTextContent(/released/i);
    const log = useHandoffStore.getState().activity.map((a) => a.message);
    expect(log.some((m) => /Application plan: Acquire a Cloud PC/.test(m))).toBe(true);
    expect(log).toContain("Cloud PC readiness: The Cloud PC is ready for the agent.");
    expect(log.join("\n")).not.toMatch(/readiness: unknown/);
    expect(log.join("\n")).not.toContain("view-secret");
    expect(useHandoffStore.getState().callContext?.target_backend).toBe("foundry");
    expect(useCallStore.getState().phase).toBe("talking");
    expect(starts).toBe(1);
  }, 12000);

  it("stops viewing and reports an error if the screen switches to control mode", async () => {
    const acquired = [ev(1, "computer", { session_id: "sess-2" }), ev(2, "readiness", { message: "The Cloud PC is ready for the agent." })];
    let viewReady = 0;
    let requestId = "";
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, async ({ request }) => {
        requestId = String((await request.json() as Record<string, unknown>).request_id);
        return HttpResponse.json({ events: acquired, computer: acquired[0], outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/view`, () => HttpResponse.json({ request_id: requestId, session_id: "sess-2",
        computer_url: "https://computer", viewer_url: "https://viewer", sdk_url: SDK, token: "t", mode: "viewOnly" })),
      http.post(`${API}/foundry-claims/view_ready`, () => { viewReady += 1; return HttpResponse.json({}); }),
      http.post(`${API}/foundry-claims/status`, () => HttpResponse.json({ events: acquired, computer: acquired[0], outcome: null, release: null, running: true, interrupted: false }))
    );
    fireEvent.click(await openFoundry());
    await waitFor(() => expect(FakeViewer.all).toHaveLength(1));
    await act(async () => { await FakeViewer.all[0].emit("statusChanged", "controlling"); });
    expect(FakeViewer.all[0].stopped).toBe(true);
    expect(screen.getByTestId("foundry-viewer-status")).toHaveTextContent(/takeover is not approved/i);
    expect(screen.getByTestId("foundry-viewer-watch")).toBeInTheDocument();
    expect(viewReady).toBe(0);
  });

  it("reconnects the view-only screen once when it disconnects while the run is still running", async () => {
    const acquired = [ev(1, "computer", { session_id: "sess-3" }), ev(2, "readiness", { message: "The Cloud PC is ready for the agent." })];
    let viewRequests = 0;
    let requestId = "";
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, async ({ request }) => {
        requestId = String((await request.json() as Record<string, unknown>).request_id);
        return HttpResponse.json({ events: acquired, computer: acquired[0], outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/view`, () => {
        viewRequests += 1;
        return HttpResponse.json({ request_id: requestId, session_id: "sess-3",
          computer_url: "https://computer", viewer_url: "https://viewer", sdk_url: SDK, token: `t${viewRequests}`, mode: "viewOnly" });
      }),
      http.post(`${API}/foundry-claims/view_ready`, () => HttpResponse.json({})),
      http.post(`${API}/foundry-claims/status`, () => HttpResponse.json({ events: acquired, computer: acquired[0], outcome: null, release: null, running: true, interrupted: false }))
    );
    fireEvent.click(await openFoundry());
    await waitFor(() => expect(FakeViewer.all).toHaveLength(1));
    await act(async () => { await FakeViewer.all[0].emit("statusChanged", "disconnected"); });
    expect(FakeViewer.all[0].stopped).toBe(true);
    await waitFor(() => expect(FakeViewer.all).toHaveLength(2));
    await waitFor(() => expect(FakeViewer.all[1].token).toBe("t2"));
    expect(viewRequests).toBe(2);

    // A screen that keeps connecting and then dropping stops after the limit.
    for (let i = 1; i <= 3; i++) {
      await waitFor(() => expect(FakeViewer.all).toHaveLength(i + 1));
      await act(async () => { await FakeViewer.all[i].emit("statusChanged", "connected"); });
      await act(async () => { await FakeViewer.all[i].emit("statusChanged", "disconnected"); });
    }
    await waitFor(() => expect(screen.getByTestId("foundry-viewer-status")).toHaveTextContent(/disconnected/i));
    expect(FakeViewer.all).toHaveLength(4);
    expect(viewRequests).toBe(4);
  });

  it("expands the live screen in place without disconnecting it, and closes with the button or Escape", async () => {
    const acquired = [ev(1, "computer", { session_id: "sess-4" }), ev(2, "readiness", { message: "The Cloud PC is ready for the agent." }),
      ev(3, "explanation", { explanation_type: "model_summary", message: "I am opening the policy search.", source: "model" })];
    let viewRequests = 0;
    let requestId = "";
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, async ({ request }) => {
        requestId = String((await request.json() as Record<string, unknown>).request_id);
        return HttpResponse.json({ events: acquired, computer: acquired[0], outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/view`, () => {
        viewRequests += 1;
        return HttpResponse.json({ request_id: requestId, session_id: "sess-4",
          computer_url: "https://computer", viewer_url: "https://viewer", sdk_url: SDK, token: "t", mode: "viewOnly" });
      }),
      http.post(`${API}/foundry-claims/view_ready`, () => HttpResponse.json({})),
      http.post(`${API}/foundry-claims/status`, () => HttpResponse.json({ events: acquired, computer: acquired[0], outcome: null, release: null, running: true, interrupted: false }))
    );
    fireEvent.click(await openFoundry());
    await waitFor(() => expect(FakeViewer.all).toHaveLength(1));
    const viewer = FakeViewer.all[0];
    await act(async () => { await viewer.emit("statusChanged", "connected"); });
    const screenNode = screen.getByTestId("foundry-viewer-screen");
    expect(viewer.opts.container).toBe(screenNode);

    const panel = screen.getByTestId("ai-foundry-hosted");
    expect(panel).toHaveAttribute("data-expanded", "false");
    fireEvent.click(screen.getByTestId("ai-foundry-expand"));
    expect(panel).toHaveAttribute("data-expanded", "true");
    expect(panel.className).toMatch(/\bfixed\b/);
    await waitFor(() => expect(screen.getByTestId("ai-live-explanation")).toHaveTextContent("I am opening the policy search."));
    expect(screen.getByTestId("ai-live-explanation").className).toMatch(/text-2xl/);
    // Same viewer, same screen element: expanding must not drop the live stream.
    expect(screen.getByTestId("foundry-viewer-screen")).toBe(screenNode);
    expect(FakeViewer.all).toHaveLength(1);
    expect(viewer.stopped).toBe(false);
    expect(viewRequests).toBe(1);

    fireEvent.click(screen.getByTestId("ai-foundry-collapse"));
    expect(panel).toHaveAttribute("data-expanded", "false");
    fireEvent.click(screen.getByTestId("ai-foundry-expand"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel).toHaveAttribute("data-expanded", "false");
    expect(screen.getByTestId("foundry-viewer-screen")).toBe(screenNode);
    expect(viewer.stopped).toBe(false);
    expect(viewRequests).toBe(1);
  });
  it("does not offer the Foundry button when the service has no Foundry agent and this build names no other", async () => {
    server.use(http.get(`${API}/foundry-claims/availability`, () =>
      HttpResponse.json({ configured: false, ready: false, message: "Foundry hosted agent is not configured for this service." })));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await waitFor(() => expect(screen.getByTestId("handoff-foundry-availability"))
      .toHaveTextContent(/not configured for this service/i));
    expect(screen.getByTestId("handoff-to-ai-foundry")).toBeDisabled();
  });

  it("shows a gate refusal in the same interaction without retrying", async () => {
    let starts = 0;
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () => {
        starts += 1;
        return HttpResponse.json({ error: "Claims execution is not enabled in this version." }, { status: 403 });
      })
    );
    fireEvent.click(await openFoundry());
    await waitFor(() => expect(useHandoffStore.getState().errorMessage).toMatch(/Claims execution is not enabled/));
    await new Promise((r) => setTimeout(r, 2500));
    expect(starts).toBe(1);
    expect(useCallStore.getState().phase).toBe("talking");
  });

  it("starts only once when the transfer is confirmed twice", async () => {
    let starts = 0;
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () => {
        starts += 1;
        return HttpResponse.json({ error: "Claims execution is not enabled in this version." }, { status: 403 });
      })
    );
    const confirm = await openFoundry();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(useHandoffStore.getState().errorMessage).toBeTruthy());
    expect(starts).toBe(1);
  });

  it("releases the Cloud PC once when the run was interrupted, without repeating the task", async () => {
    const recovered: unknown[] = [];
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () => HttpResponse.json({ events: [], computer: null, outcome: null, release: null }, { status: 202 })),
      http.post(`${API}/foundry-claims/status`, () => HttpResponse.json({ events: [], computer: null, outcome: null, release: null, running: false, interrupted: true })),
      http.post(`${API}/foundry-claims/recover`, async ({ request }) => {
        recovered.push(await request.json());
        const release = ev(1, "release", { session_id: "s", status: "accepted" });
        const outcome = ev(2, "outcome", { status: "error", release_status: "accepted",
          result: { status: "error", error_code: "UNKNOWN", message: "The run was interrupted.", timestamp: "2026-10-02T01:02:00Z" } });
        return HttpResponse.json({ events: [release, outcome], release, outcome, running: false, interrupted: true });
      })
    );
    fireEvent.click(await openFoundry());
    await waitFor(() => expect(useHandoffStore.getState().errorMessage).toMatch(/interrupted/i), { timeout: 4500 });
    expect(recovered).toHaveLength(1);
    expect(useHandoffStore.getState().release?.state).toBe("released");
    expect(useHandoffStore.getState().claimId).toBeNull();
  });

  it.each([
    ["a malformed claim number", (id: unknown) => ({ request_id: id, status: "submitted", submit_sent: true, result: { request_id: id, status: "submitted", claim_id: "CLM-1", agent_id: "C1001", timestamp: "2026-10-02T01:01:00Z" } }), "UNKNOWN"],
    ["an error code outside the contract", (id: unknown) => ({ request_id: id, status: "error", submit_sent: false, result: { request_id: id, status: "error", error_code: "NOT_A_CODE", message: "Bad.", timestamp: "2026-10-02T01:01:00Z" } }), "UNKNOWN"],
    ["a contract error code", (id: unknown) => ({ request_id: id, status: "error", submit_sent: false, result: { request_id: id, status: "error", error_code: "POLICY_NOT_FOUND", message: "No policy.", timestamp: "2026-10-02T01:01:00Z" } }), "POLICY_NOT_FOUND"]
  ])("checks the Foundry result against the shared status schema: %s", async (_name, extra, code) => {
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () => HttpResponse.json({ events: [], computer: null, outcome: null, release: null }, { status: 202 })),
      http.post(`${API}/foundry-claims/status`, async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        const outcome = ev(1, "outcome", extra(body.request_id));
        return HttpResponse.json({ events: [outcome], computer: null, outcome, release: null, running: false, interrupted: false });
      })
    );
    fireEvent.click(await openFoundry());
    await waitFor(() => expect(useHandoffStore.getState().errorCode).toBe(code), { timeout: 4500 });
    expect(useHandoffStore.getState().claimId).toBeNull();
  });

  it("sends the user's sign-in token on every Foundry relay action", async () => {
    const auth: Record<string, string | null> = {};
    let requestId = "";
    const acquired = [ev(1, "computer", { session_id: "sess-a" }), ev(2, "readiness", { message: "ready" })];
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, async ({ request }) => {
        auth.start = request.headers.get("authorization");
        requestId = String((await request.json() as Record<string, unknown>).request_id);
        return HttpResponse.json({ events: acquired, computer: acquired[0], outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/view`, ({ request }) => {
        auth.view = request.headers.get("authorization");
        return HttpResponse.json({ request_id: requestId, session_id: "sess-a", computer_url: "https://computer",
          viewer_url: "https://viewer", sdk_url: SDK, token: "t", mode: "viewOnly" });
      }),
      http.post(`${API}/foundry-claims/status`, ({ request }) => {
        auth.status = request.headers.get("authorization");
        return HttpResponse.json({ events: acquired, computer: acquired[0], outcome: null, release: null, running: true, interrupted: false });
      })
    );
    fireEvent.click(await openFoundry());
    await waitFor(() => expect(auth.view).toBeDefined(), { timeout: 4500 });
    await waitFor(() => expect(auth.status).toBeDefined(), { timeout: 4500 });
    expect(auth).toEqual({ start: "Bearer user-token", view: "Bearer user-token", status: "Bearer user-token" });
  });

  it("checks the Microsoft sign-in before offering Foundry, and sends nothing when it cannot be used", async () => {
    tokenMock.fail = true;
    let starts = 0;
    server.use(available(true), http.post(`${API}/foundry-claims/start`, () => { starts += 1; return HttpResponse.json({}); }));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await waitFor(() => expect(screen.getByTestId("handoff-foundry-availability"))
      .toHaveTextContent(/sign-in could not be used.*Sign in again\./i));
    expect(screen.getByTestId("handoff-to-ai-foundry")).toBeDisabled();
    expect(screen.queryByTestId("handoff-foundry-reconnect")).toBeNull();
    expect(starts).toBe(0);
  });

  it("keeps Foundry unavailable while the sign-in is being checked, then offers it", async () => {
    let release = () => undefined as void;
    tokenMock.pending = new Promise<void>((r) => { release = r; });
    server.use(available(true));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await waitFor(() => expect(screen.getByTestId("handoff-foundry-availability"))
      .toHaveTextContent(/Checking your Microsoft sign-in/i));
    expect(screen.getByTestId("handoff-to-ai-foundry")).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByTestId("handoff-to-ai-foundry")).not.toBeDisabled());
  });

  it("offers one Reconnect only when Microsoft needs the person, keeps the call and sends nothing", async () => {
    tokenMock.fail = true;
    tokenMock.interaction = true;
    let starts = 0;
    server.use(available(true), http.post(`${API}/foundry-claims/start`, () => { starts += 1; return HttpResponse.json({}); }));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    const reconnect = await screen.findByTestId("handoff-foundry-reconnect");
    expect(screen.getByTestId("handoff-to-ai-foundry")).toBeDisabled();
    expect(screen.getByTestId("handoff-foundry-availability")).toHaveTextContent(/login_required/);
    const before = useCallStore.getState();
    fireEvent.click(reconnect);
    fireEvent.click(reconnect);
    await waitFor(() => expect(tokenMock.reconnects).toBe(1));
    expect(screen.getByTestId("handoff-foundry-reconnect")).toBeDisabled();
    const saved = JSON.parse(sessionStorage.getItem("ccaas:reconnect-call") ?? "null");
    expect(saved).toMatchObject({ version: 2, account: ME, stage: "precheck" });
    expect(saved.call).toMatchObject({ phase: "talking", nextLineIdx: before.nextLineIdx, notes: before.notes });
    expect(saved.call.transcript).toHaveLength(before.transcript.length);
    expect(useCallStore.getState().phase).toBe("talking");
    expect(useHandoffStore.getState().status).toBe("idle");
    expect(starts).toBe(0);
  });

  it("E2: with no cached Microsoft account, Reconnect saves the call for the signed-in agent and asks Microsoft for that account", async () => {
    tokenMock.fail = true;
    tokenMock.interaction = true;
    tokenMock.noAccount = true;
    let starts = 0;
    server.use(available(true), http.post(`${API}/foundry-claims/start`, () => { starts += 1; return HttpResponse.json({}); }));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    fireEvent.click(await screen.findByTestId("handoff-foundry-reconnect"));
    await waitFor(() => expect(tokenMock.reconnects).toBe(1));
    expect(tokenMock.reconnectArgs).toEqual([{ loginHint: SAMPLE_AGENT.email }]);
    const saved = JSON.parse(sessionStorage.getItem("ccaas:reconnect-call") ?? "null");
    expect(saved).toMatchObject({ version: 2, stage: "precheck", owner: { agent_id: SAMPLE_AGENT.agent_id, username: SAMPLE_AGENT.email } });
    expect(saved).not.toHaveProperty("account");
    expect(saved.call).toMatchObject({ phase: "talking" });
    expect(useRecoveryStore.getState().authDiag?.code).not.toBe("no_account");
    expect(starts).toBe(0);
  });

  it("shows why Foundry was not started and the request ID above the live screen", async () => {
    tokenMock.failAfter = 1; // the readiness check succeeds; the start's own token request fails
    server.use(available(true));
    fireEvent.click(await openFoundry());
    const error = await screen.findByTestId("ai-status-error");
    const requestId = useHandoffStore.getState().callContext?.request_id ?? "";
    expect(requestId).toMatch(/^REQ-/);
    expect(error).toHaveTextContent("Foundry start was not sent: Sign in again.");
    expect(within(error).getByTestId("ai-status-error-code")).toHaveTextContent("NOT SENT");
    expect(within(error).getByTestId("ai-status-request-id")).toHaveTextContent(requestId);
    expect(screen.getAllByTestId("ai-status-request-id")).toHaveLength(1);
    const viewer = screen.getByTestId("ai-foundry-hosted");
    expect(error.compareDocumentPosition(viewer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const record = JSON.parse(sessionStorage.getItem("ccaas:last-transfer") ?? "null");
    expect(record).toMatchObject({ request_id: requestId, backend: "foundry", state: "not_sent", error_code: "UNKNOWN" });
    expect(record.message).toContain("Foundry start was not sent");
  });

  it("R1: a start that needs Microsoft sign-in keeps the exact handoff, reconnects, then sends that same request once", async () => {
    tokenMock.failAfter = 1; // readiness check passes; the start's token needs the person
    tokenMock.interaction = true;
    const starts: Record<string, unknown>[] = [];
    let release = () => undefined as void;
    const held = new Promise<void>((r) => { release = r; });
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, async ({ request }) => {
        starts.push(await request.json() as Record<string, unknown>);
        return HttpResponse.json({ events: [], computer: null, outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/status`, async () => {
        await held;
        return HttpResponse.json({ events: [], computer: null, outcome: null, release: null, running: true, interrupted: false });
      })
    );
    const confirm = await openFoundry();
    fireEvent.change(screen.getByTestId("handoff-summary"), { target: { value: "Edited: rear-ended at 5th and Main, minor bumper damage." } });
    fireEvent.click(confirm);
    const error = await screen.findByTestId("ai-status-error");
    const requestId = useHandoffStore.getState().callContext?.request_id ?? "";
    expect(within(error).getByTestId("ai-status-error-code")).toHaveTextContent("NOT SENT");
    expect(screen.queryByTestId("handoff-retry")).toBeNull(); // no fresh request ID
    expect(starts).toHaveLength(0);
    const record = JSON.parse(sessionStorage.getItem("ccaas:last-transfer") ?? "null");
    expect(record).toMatchObject({ request_id: requestId, state: "not_sent" });
    expect(record.handoff.summary).toBe("Edited: rear-ended at 5th and Main, minor bumper damage.");

    fireEvent.click(within(error).getByTestId("handoff-reconnect"));
    await waitFor(() => expect(tokenMock.reconnects).toBe(1));
    expect(JSON.parse(sessionStorage.getItem("ccaas:reconnect-call") ?? "null"))
      .toMatchObject({ stage: "start", request_id: requestId, account: ME });

    // The page comes back from Microsoft signed in as the same account.
    cleanup();
    Object.assign(tokenMock, { failAfter: -1, interaction: false });
    useHandoffStore.getState().reset();
    useCallStore.getState().reset();
    resetTransferRecorderForTests();
    await expect(finishReconnect({ account: ME, redirect: { account: ME }, checkToken: async () => "t" })).resolves.toBe("recovered");
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    expect(useCallStore.getState().phase).toBe("talking");
    expect(screen.getByTestId("reconnect-notice")).toHaveTextContent(requestId);
    const note = screen.getByTestId("previous-transfer");
    expect(note).toHaveAttribute("data-state", "not_sent");
    fireEvent.click(within(note).getByTestId("previous-transfer-send"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toMatchObject({ request_id: requestId, handoff: { request_id: requestId, summary: "Edited: rear-ended at 5th and Main, minor bumper damage." } });
    expect(useHandoffStore.getState().callContext?.request_id).toBe(requestId);
    release();
  });

  it("R1: when watching a started run needs Microsoft sign-in, it reconnects and resumes that request's status without a new start", async () => {
    tokenMock.failAfter = 3; // readiness check, prepare and start pass; the status read needs the person
    tokenMock.interaction = true;
    let starts = 0;
    const statusIds: unknown[] = [];
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () => {
        starts += 1;
        return HttpResponse.json({ events: [], computer: null, outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/status`, async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        statusIds.push(body.request_id);
        const outcome = ev(1, "outcome", { status: "submitted", release_status: "accepted",
          result: { request_id: body.request_id, status: "submitted", claim_id: "CLM-2026-000777", agent_id: "foundry", timestamp: "2026-10-02T01:01:00Z" } });
        return HttpResponse.json({ events: [outcome], computer: null, outcome, release: null, running: false, interrupted: false });
      })
    );
    fireEvent.click(await openFoundry());
    const error = await screen.findByTestId("ai-status-error", {}, { timeout: 4500 });
    const requestId = useHandoffStore.getState().callContext?.request_id ?? "";
    expect(within(error).getByTestId("ai-status-error-code")).toHaveTextContent("OUTCOME UNKNOWN");
    expect(screen.queryByTestId("handoff-retry")).toBeNull();
    expect(starts).toBe(1);
    fireEvent.click(within(error).getByTestId("handoff-reconnect"));
    await waitFor(() => expect(tokenMock.reconnects).toBe(1));
    expect(JSON.parse(sessionStorage.getItem("ccaas:reconnect-call") ?? "null")).toMatchObject({ stage: "status", request_id: requestId });

    cleanup();
    Object.assign(tokenMock, { failAfter: -1, interaction: false });
    useHandoffStore.getState().reset();
    useCallStore.getState().reset();
    resetTransferRecorderForTests();
    await finishReconnect({ account: ME, redirect: { account: ME }, checkToken: async () => "t" });
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id")).toHaveTextContent("CLM-2026-000777"), { timeout: 4500 });
    expect(statusIds).toEqual([requestId]);
    expect(starts).toBe(1);
  }, 12000);

  it("R2: a start whose answer was lost stays on its request ID; no new transfer until its status is checked", async () => {
    let starts = 0;
    const statusIds: unknown[] = [];
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () => { starts += 1; return HttpResponse.error(); }),
      http.post(`${API}/foundry-claims/status`, async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        statusIds.push(body.request_id);
        const outcome = ev(1, "outcome", { status: "submitted", release_status: "accepted",
          result: { request_id: body.request_id, status: "submitted", claim_id: "CLM-2026-000888", agent_id: "foundry", timestamp: "2026-10-02T01:01:00Z" } });
        return HttpResponse.json({ events: [outcome], computer: null, outcome, release: null, running: false, interrupted: false });
      })
    );
    fireEvent.click(await openFoundry());
    const error = await screen.findByTestId("ai-status-error");
    const requestId = useHandoffStore.getState().callContext?.request_id ?? "";
    expect(within(error).getByTestId("ai-status-error-code")).toHaveTextContent("OUTCOME UNKNOWN");
    expect(screen.queryByTestId("handoff-retry")).toBeNull();
    expect(within(error).getByTestId("handoff-check-status")).toBeInTheDocument();

    // Falling back to manual keeps the request unresolved and blocks a second Foundry start.
    fireEvent.click(within(error).getByTestId("handoff-fallback"));
    const note = await screen.findByTestId("previous-transfer");
    expect(note).toHaveAttribute("data-state", "unknown");
    expect(within(note).queryByTestId("previous-transfer-dismiss")).toBeNull();
    window.dispatchEvent(new CustomEvent("ccaas:reset-demo"));
    expect(screen.getByTestId("previous-transfer")).toHaveTextContent(requestId);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await waitFor(() => expect(screen.getByTestId("handoff-foundry-availability")).toHaveTextContent(new RegExp(`${requestId}.*outcome is unknown`)));
    expect(screen.getByTestId("handoff-to-ai-foundry")).toBeDisabled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.click(within(screen.getByTestId("previous-transfer")).getByTestId("previous-transfer-check"));
    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id")).toHaveTextContent("CLM-2026-000888"));
    expect(statusIds).toEqual([requestId]);
    expect(starts).toBe(1);
    expect(JSON.parse(sessionStorage.getItem("ccaas:last-transfer") ?? "null")).toMatchObject({ request_id: requestId, state: "submitted" });
  });

  it("E1: the relay's ownership refusal is not proof of never started; the request stays unresolved on its own ID", async () => {
    sessionStorage.setItem("ccaas:last-transfer", JSON.stringify({
      request_id: "REQ-2026-123456789012", backend: "foundry", state: "started",
      started_at: "2026-10-06T07:02:00.000Z", updated_at: "2026-10-06T07:02:01.000Z",
      handoff: { request_id: "REQ-2026-123456789012", target_backend: "foundry", summary: "s",
        requested_by: { agent_id: SAMPLE_AGENT.agent_id, display_name: SAMPLE_AGENT.display_name } }
    }));
    resetTransferRecorderForTests();
    let starts = 0;
    let ownerRecorded = false; // the original start may still be recording its owner
    const statusIds: unknown[] = [];
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () => { starts += 1; return HttpResponse.json({}); }),
      http.post(`${API}/foundry-claims/status`, async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        statusIds.push(body.request_id);
        if (!ownerRecorded) return HttpResponse.json({ error: "This Foundry run is not one you started." }, { status: 403 });
        const outcome = ev(1, "outcome", { status: "submitted", release_status: "accepted",
          result: { request_id: body.request_id, status: "submitted", claim_id: "CLM-2026-000999", agent_id: "foundry", timestamp: "2026-10-02T01:01:00Z" } });
        return HttpResponse.json({ events: [outcome], computer: null, outcome, release: null, running: false, interrupted: false });
      })
    );
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    const note = await screen.findByTestId("previous-transfer");
    fireEvent.click(within(note).getByTestId("previous-transfer-check"));
    const error = await screen.findByTestId("ai-status-error");
    expect(within(error).getByTestId("ai-status-error-code")).toHaveTextContent("OUTCOME UNKNOWN");
    expect(within(error).getByTestId("ai-status-error-code")).not.toHaveTextContent(/never started/i);
    expect(error).toHaveTextContent("did not confirm that REQ-2026-123456789012 belongs to this account");
    expect(error).toHaveTextContent("This does not mean it never started");
    expect(within(error).getByTestId("ai-status-request-id")).toHaveTextContent("REQ-2026-123456789012");
    // No fresh request ID is offered; only the same request's status.
    expect(within(error).queryByTestId("handoff-retry")).toBeNull();
    expect(within(error).getByTestId("handoff-check-status")).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem("ccaas:last-transfer") ?? "null"))
      .toMatchObject({ request_id: "REQ-2026-123456789012", state: "unknown" });

    // Falling back keeps the block: Foundry cannot be chosen, and the note cannot be dismissed.
    fireEvent.click(within(error).getByTestId("handoff-fallback"));
    const kept = await screen.findByTestId("previous-transfer");
    expect(kept).toHaveAttribute("data-state", "unknown");
    expect(within(kept).queryByTestId("previous-transfer-dismiss")).toBeNull();
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await waitFor(() => expect(screen.getByTestId("handoff-foundry-availability"))
      .toHaveTextContent(/REQ-2026-123456789012.*outcome is unknown/));
    expect(screen.getByTestId("handoff-to-ai-foundry")).toBeDisabled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    // Once the relay can answer for this request, the same ID is reconciled through status.
    ownerRecorded = true;
    fireEvent.click(within(screen.getByTestId("previous-transfer")).getByTestId("previous-transfer-check"));
    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id")).toHaveTextContent("CLM-2026-000999"));
    expect(statusIds).toEqual(["REQ-2026-123456789012", "REQ-2026-123456789012"]);
    expect(starts).toBe(0);
  });

  it("R2: a run that stopped without an outcome blocks Foundry until a person confirms they checked the claims system", async () => {
    let recovers = 0;
    let starts = 0;
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () => {
        starts += 1;
        return HttpResponse.json({ events: [], computer: null, outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/status`, () =>
        HttpResponse.json({ events: [], computer: null, outcome: null, release: null, running: false, interrupted: true })),
      http.post(`${API}/foundry-claims/recover`, () => {
        recovers += 1;
        return HttpResponse.json({ events: [], computer: null, outcome: null, release: null, running: false, interrupted: true });
      })
    );
    fireEvent.click(await openFoundry());
    const error = await screen.findByTestId("ai-status-error", {}, { timeout: 4500 });
    expect(within(error).getByTestId("ai-status-error-code")).toHaveTextContent("STOPPED - OUTCOME UNKNOWN");
    expect(within(error).queryByTestId("handoff-retry")).toBeNull();
    expect(within(error).queryByTestId("handoff-check-status")).toBeNull();
    fireEvent.click(within(error).getByTestId("handoff-fallback"));
    const note = await screen.findByTestId("previous-transfer");
    expect(note).toHaveAttribute("data-state", "stopped");
    expect(within(note).queryByTestId("previous-transfer-check")).toBeNull();
    expect(within(note).queryByTestId("previous-transfer-dismiss")).toBeNull();
    window.dispatchEvent(new CustomEvent("ccaas:reset-demo"));
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await waitFor(() => expect(screen.getByTestId("handoff-foundry-availability")).toHaveTextContent(/outcome is unknown/));
    expect(screen.getByTestId("handoff-to-ai-foundry")).toBeDisabled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.click(within(screen.getByTestId("previous-transfer")).getByTestId("previous-transfer-acknowledge"));
    expect(screen.queryByTestId("previous-transfer")).toBeNull();
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await waitFor(() => expect(screen.getByTestId("handoff-to-ai-foundry")).not.toBeDisabled());
    expect(recovers).toBe(1);
    expect(starts).toBe(1);
  }, 12000);

  it("R2/R3: a request started by another account is not checked or resent here; the person can mark it checked", async () => {
    const other = { agent_id: "entra-someone-else", display_name: "Other Agent" };
    sessionStorage.setItem("ccaas:last-transfer", JSON.stringify({
      request_id: "REQ-2026-555566667777", backend: "foundry", state: "unknown", message: "Network error.",
      started_at: "2026-10-06T07:02:00.000Z", updated_at: "2026-10-06T07:02:01.000Z",
      handoff: { request_id: "REQ-2026-555566667777", target_backend: "foundry", summary: "s", requested_by: other }
    }));
    resetTransferRecorderForTests();
    let calls = 0;
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () => { calls += 1; return HttpResponse.json({}); }),
      http.post(`${API}/foundry-claims/status`, () => { calls += 1; return HttpResponse.json({}); })
    );
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    const note = await screen.findByTestId("previous-transfer");
    expect(within(note).getByTestId("previous-transfer-other-account")).toHaveTextContent("Other Agent");
    expect(within(note).queryByTestId("previous-transfer-check")).toBeNull();
    fireEvent.click(within(note).getByTestId("previous-transfer-acknowledge"));
    expect(screen.queryByTestId("previous-transfer")).toBeNull();
    expect(calls).toBe(0);
  });

  it("R1: a never-sent transfer recorded for another account is not sent under this sign-in", async () => {
    sessionStorage.setItem("ccaas:last-transfer", JSON.stringify({
      request_id: "REQ-2026-444455556666", backend: "foundry", state: "not_sent", message: "Foundry start was not sent.",
      started_at: "2026-10-06T07:02:00.000Z", updated_at: "2026-10-06T07:02:01.000Z",
      handoff: { request_id: "REQ-2026-444455556666", target_backend: "foundry", summary: "s",
        requested_by: { agent_id: "entra-someone-else", display_name: "Other Agent" } }
    }));
    resetTransferRecorderForTests();
    let starts = 0;
    server.use(available(true), http.post(`${API}/foundry-claims/start`, () => { starts += 1; return HttpResponse.json({}); }));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(within(await screen.findByTestId("previous-transfer")).getByTestId("previous-transfer-send"));
    await new Promise((r) => setTimeout(r, 200));
    expect(starts).toBe(0);
    expect(useHandoffStore.getState().status).toBe("idle");
  });

  it("R4: when the call cannot be saved, Zava stays on the page, keeps the call and says why", async () => {
    tokenMock.fail = true;
    tokenMock.interaction = true;
    server.use(available(true));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    const reconnect = await screen.findByTestId("handoff-foundry-reconnect");
    const before = useCallStore.getState();
    const original = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === "ccaas:reconnect-call") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return original.call(this, key, value);
    });
    fireEvent.click(reconnect);
    await waitFor(() => expect(useRecoveryStore.getState().authDiag?.code).toBe("call_not_saved"));
    spy.mockRestore();
    expect(tokenMock.reconnects).toBe(0);
    expect(useRecoveryStore.getState().authDiag?.detail).toMatch(/could not save this call .*quota.*stayed on this page/i);
    expect(useCallStore.getState()).toMatchObject({ phase: "talking", nextLineIdx: before.nextLineIdx, notes: before.notes });
    expect(screen.getByTestId("handoff-foundry-reconnect")).not.toBeDisabled();
  });

  it("R5: a pre-transfer sign-in failure is shown in full and kept, redacted, across a reload", async () => {
    tokenMock.fail = true;
    server.use(available(true));
    const { acquireHandoffAccessToken } = await import("@/lib/msalLogin");
    vi.mocked(acquireHandoffAccessToken).mockRejectedValueOnce(Object.assign(
      new Error("Could not get a sign-in token for the AI agent transfer (monitor_window_timeout). Trace ID: 7f1c Bearer abc.def.ghi"),
      { code: "monitor_window_timeout", interactionRequired: false }
    ));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await waitFor(() => expect(screen.getByTestId("handoff-foundry-availability")).toHaveTextContent(/Trace ID: 7f1c/));
    expect(screen.getByTestId("handoff-foundry-availability")).not.toHaveTextContent(/abc\.def/);
    const stored = JSON.parse(sessionStorage.getItem("ccaas:auth-diagnostic") ?? "null");
    expect(stored).toMatchObject({ stage: "precheck", code: "monitor_window_timeout" });
    expect(stored.detail).toContain("Trace ID: 7f1c");
    expect(JSON.stringify(stored)).not.toContain("abc.def");
    expect(sessionStorage.getItem("ccaas:last-transfer")).toBeNull(); // no transfer was made up

    cleanup();
    resetTransferRecorderForTests(); // the page is reloaded
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    const diag = screen.getByTestId("auth-diagnostic");
    expect(diag).toHaveTextContent("Trace ID: 7f1c");
    expect(diag).toHaveTextContent("monitor_window_timeout");
  });

  it.each([
    ["a relay refusal", { error: "Foundry Claims runs are not enabled for CCaaS yet." }, 503,
      "Foundry Claims runs are not enabled for CCaaS yet. (Foundry start, HTTP 503)"],
    ["a Foundry error object", { error: { code: "PermissionDenied", message: "No access." } }, 403,
      "{\"code\":\"PermissionDenied\",\"message\":\"No access.\"} (Foundry start, HTTP 403)"],
    ["an empty reply", {}, 502, "Foundry start failed (Foundry start, HTTP 502)"]
  ])("names the step and HTTP status when the relay refuses the start: %s", async (_name, body, status, message) => {
    server.use(available(true), http.post(`${API}/foundry-claims/start`, () => HttpResponse.json(body, { status })));
    fireEvent.click(await openFoundry());
    await waitFor(() => expect(useHandoffStore.getState().errorMessage).toBe(message));
    expect(await screen.findByTestId("ai-status-error")).toHaveTextContent(message);
  });

  it("lets the transfer panel scroll so the error and its buttons are never cut off", () => {
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    expect(screen.getByTestId("right-rail-content").className).toMatch(/\bmin-h-0\b/);
    expect(screen.getByTestId("right-rail-content").className).toMatch(/\boverflow-y-auto\b/);
  });
});
describe("Foundry start latency (mock HTTP and a fake viewer, not live proof)", () => {
  it("prepares the confirmation's exact request once, before and without a start", async () => {
    let start: Record<string, unknown> | undefined;
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, async ({ request }) => {
        start = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ events: [], computer: null, outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/status`, () =>
        HttpResponse.json({ events: [], computer: null, outcome: null, release: null, running: true, interrupted: false }))
    );
    const confirm = await openFoundry();
    await waitFor(() => expect(prepared).toHaveLength(1));
    expect(start).toBeUndefined();
    const previewId = (prepared[0] as { request_id: string }).request_id;
    expect(prepared[0]).toEqual({ request_id: previewId });
    expect(previewId).toMatch(/^REQ-[0-9]{4}-[0-9]{4,}$/);
    fireEvent.click(confirm);
    await waitFor(() => expect(start).toBeDefined());
    expect(start?.request_id).toBe(previewId);
    expect(prepared).toHaveLength(1);
  });

  it("a failed prepare changes nothing: the transfer is still offered and started once", async () => {
    let starts = 0;
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/prepare`, () => HttpResponse.json({ error: "down" }, { status: 502 })),
      http.post(`${API}/foundry-claims/start`, () => {
        starts += 1;
        return HttpResponse.json({ events: [], computer: null, outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/status`, () =>
        HttpResponse.json({ events: [], computer: null, outcome: null, release: null, running: true, interrupted: false }))
    );
    fireEvent.click(await openFoundry());
    await waitFor(() => expect(starts).toBe(1));
    expect(screen.queryByTestId("ai-status-error")).toBeNull();
  });

  it("fetches the view details when the Cloud PC is acquired and connects with them only at readiness", async () => {
    let views = 0;
    let readinessServed = false;
    let viewBeforeReadiness = false;
    let polls = 0;
    const acquired = [
      ev(1, "plan", { message: "Acquire a Cloud PC, then open Claims." }),
      ev(2, "computer", { session_id: "sess-1", screen_share_url: "https://screen" })
    ];
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () =>
        HttpResponse.json({ events: acquired, computer: acquired[1], outcome: null, release: null }, { status: 202 })),
      http.post(`${API}/foundry-claims/view`, () => {
        views += 1;
        if (!readinessServed) viewBeforeReadiness = true;
        return HttpResponse.json({ request_id: useHandoffStore.getState().callContext?.request_id, session_id: "sess-1",
          computer_url: "https://computer", viewer_url: "https://viewer", sdk_url: SDK, token: "view-secret", mode: "viewOnly" });
      }),
      http.post(`${API}/foundry-claims/status`, () => {
        polls += 1;
        const events = polls < 2 ? acquired : [...acquired, ev(3, "readiness", { message: "Cloud PC answered." })];
        if (polls >= 2) readinessServed = true;
        return HttpResponse.json({ events, computer: acquired[1], outcome: null, release: null, running: true, interrupted: false });
      })
    );
    fireEvent.click(await openFoundry());
    await waitFor(() => expect(views).toBe(1));
    expect(FakeViewer.all).toHaveLength(0);
    await waitFor(() => expect(FakeViewer.all).toHaveLength(1), { timeout: 4500 });
    await waitFor(() => expect(FakeViewer.all[0].token).toBe("view-secret"));
    expect(viewBeforeReadiness).toBe(true);
    expect(views).toBe(1);
  }, 12000);
});

// Release QA R4/R5 (8 Oct 2026). The hosted agent's own result must belong to this request
// before it is shown, and an error after Submit may have been sent must keep the request
// unresolved: no new transfer until a person has checked the claims system.
describe("Foundry result correlation and submission uncertainty (mock HTTP, not live proof)", () => {
  const OTHER_REQUEST = "REQ-2026-999999999999";

  function finishWith(build: (requestId: string) => { outcome: Record<string, unknown>; events?: Record<string, unknown>[] }) {
    const counts = { starts: 0 };
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () => {
        counts.starts += 1;
        return HttpResponse.json({ events: [], computer: null, outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/status`, async ({ request }) => {
        const body = await request.json() as { request_id: string };
        const built = build(body.request_id);
        const before = (built.events ?? []).map((e, i) => ({ ...e, sequence: i + 1 }));
        const outcome = ev(before.length + 1, "outcome", { release_status: "accepted", ...built.outcome });
        return HttpResponse.json({ events: [...before, outcome], computer: null, outcome, release: null, running: false, interrupted: false });
      })
    );
    return counts;
  }

  const submitted = (requestId: string) => ({
    request_id: requestId, status: "submitted", claim_id: "CLM-2026-000432", agent_id: "C1001", timestamp: "2026-10-08T10:00:00Z"
  });
  const failed = (requestId: string, code: string, message: string) => ({
    request_id: requestId, status: "error", error_code: code, message, timestamp: "2026-10-08T10:00:00Z"
  });

  async function expectUnresolved() {
    const error = await screen.findByTestId("ai-status-error", {}, { timeout: 4500 });
    expect(within(error).getByTestId("ai-status-error-code")).toHaveTextContent("STOPPED - OUTCOME UNKNOWN");
    expect(within(error).queryByTestId("handoff-retry")).toBeNull();
    expect(useHandoffStore.getState().status).toBe("error");
    expect(useHandoffStore.getState().claimId).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("ccaas:last-transfer") ?? "null")).toMatchObject({ state: "stopped" });
  }

  it("shows a claim only when the agent's own result names this request", async () => {
    finishWith((id) => ({ outcome: { request_id: id, status: "submitted", submit_sent: true, result: submitted(id) } }));
    fireEvent.click(await openFoundry());
    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id")).toHaveTextContent("CLM-2026-000432"), { timeout: 4500 });
    expect(JSON.parse(sessionStorage.getItem("ccaas:last-transfer") ?? "null")).toMatchObject({ state: "submitted", claim_id: "CLM-2026-000432" });
  });

  it.each([
    ["names another request", (id: string) => ({ request_id: id, status: "submitted", result: submitted(OTHER_REQUEST) })],
    ["has no request ID", (id: string) => {
      const { request_id: _drop, ...rest } = submitted(id);
      return { request_id: id, status: "submitted", result: rest };
    }],
    ["comes in an envelope for another request", (id: string) => ({ request_id: OTHER_REQUEST, status: "submitted", result: submitted(id) })]
  ])("never shows SUBMITTED when the reported claim result %s, and keeps the request unresolved", async (_name, outcome) => {
    finishWith((id) => ({ outcome: outcome(id) }));
    fireEvent.click(await openFoundry());
    await expectUnresolved();
  });

  it("keeps an error after Submit was sent unresolved through reset and reload, with no Retry", async () => {
    const counts = finishWith((id) => ({ outcome: { request_id: id, status: "error", submit_sent: true,
      result: failed(id, "UNKNOWN", "No matching fresh submission confirmation is visible; success is unverified.") } }));
    fireEvent.click(await openFoundry());
    await expectUnresolved();
    fireEvent.click(screen.getByTestId("handoff-fallback"));
    window.dispatchEvent(new CustomEvent("ccaas:reset-demo"));
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await waitFor(() => expect(screen.getByTestId("handoff-to-ai-foundry")).toBeDisabled());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    cleanup();
    useHandoffStore.getState().reset();
    resetTransferRecorderForTests();
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    const note = await screen.findByTestId("previous-transfer");
    expect(note).toHaveAttribute("data-state", "stopped");
    expect(within(note).queryByTestId("previous-transfer-dismiss")).toBeNull();
    expect(counts.starts).toBe(1);
  }, 12000);

  it("offers Retry for an error the agent reports before any Submit", async () => {
    finishWith((id) => ({ outcome: { request_id: id, status: "error", submit_sent: false,
      result: failed(id, "POLICY_NOT_FOUND", "No unique match for the policy.") } }));
    fireEvent.click(await openFoundry());
    const error = await screen.findByTestId("ai-status-error", {}, { timeout: 4500 });
    expect(within(error).getByTestId("ai-status-error-code")).toHaveTextContent("POLICY_NOT_FOUND");
    expect(within(error).getByTestId("handoff-retry")).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem("ccaas:last-transfer") ?? "null")).toMatchObject({ state: "error" });
  });

  it("from an agent that does not report submit_sent, trusts only its error event's context", async () => {
    finishWith((id) => ({
      events: [ev(0, "error", { message: "Stopped before Claims.", context: { stage: "launch_claims", submit_sent: false } })],
      outcome: { request_id: id, status: "error", result: failed(id, "UNKNOWN", "Stopped before Claims.") }
    }));
    fireEvent.click(await openFoundry());
    const error = await screen.findByTestId("ai-status-error", {}, { timeout: 4500 });
    expect(within(error).getByTestId("handoff-retry")).toBeInTheDocument();
  });

  it("from an agent that does not report submit_sent, treats an error with no such evidence as possibly filed", async () => {
    finishWith((id) => ({ outcome: { request_id: id, status: "error", result: failed(id, "POLICY_NOT_FOUND", "Not found.") } }));
    fireEvent.click(await openFoundry());
    await expectUnresolved();
  });
});

// Release QA follow-up R5 (9 Oct 2026): a Foundry claim that may have been filed must also stop a
// new standard Copilot Studio (MCS) transfer: switching backend, resetting or reloading is not
// proof that nothing was filed. Only the existing "I checked the claims system" clears it.
describe("an uncertain Foundry request blocks every claim-capable destination (mock HTTP, not live proof)", () => {
  function uncertainFoundryThenMcs() {
    const counts = { foundryStarts: 0, mcsStarts: 0 };
    server.use(
      available(true),
      http.post(`${API}/foundry-claims/start`, () => {
        counts.foundryStarts += 1;
        return HttpResponse.json({ events: [], computer: null, outcome: null, release: null }, { status: 202 });
      }),
      http.post(`${API}/foundry-claims/status`, async ({ request }) => {
        const body = await request.json() as { request_id: string };
        const outcome = ev(1, "outcome", { request_id: body.request_id, status: "error", submit_sent: true, release_status: "accepted",
          result: { request_id: body.request_id, status: "error", error_code: "UNKNOWN", message: "No matching fresh submission confirmation is visible; success is unverified.", timestamp: "2026-10-09T00:00:00Z" } });
        return HttpResponse.json({ events: [outcome], computer: null, outcome, release: null, running: false, interrupted: false });
      }),
      http.post(`${API}/cua-run`, () => {
        counts.mcsStarts += 1;
        return HttpResponse.json({ runId: "mcs-after" });
      }),
      http.get(`${API}/cua-run/mcs-after/progress`, () => HttpResponse.json({ status: "running", steps: [] }))
    );
    return counts;
  }

  async function reload() {
    cleanup();
    useHandoffStore.getState().reset();
    resetTransferRecorderForTests();
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    await screen.findByTestId("previous-transfer");
  }

  it("keeps standard MCS closed after reset and reload, by hand and in unattended mode", async () => {
    const counts = uncertainFoundryThenMcs();
    fireEvent.click(await openFoundry());
    await screen.findByTestId("ai-status-error", {}, { timeout: 4500 });
    fireEvent.click(screen.getByTestId("handoff-fallback"));
    window.dispatchEvent(new CustomEvent("ccaas:reset-demo"));
    await reload();

    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    const mcs = await screen.findByTestId("handoff-to-ai-mcs");
    await waitFor(() => expect(mcs).toBeDisabled());
    expect(screen.getByTestId("handoff-mcs-availability")).toHaveTextContent(/may already have filed a claim/);
    fireEvent.click(mcs);
    expect(screen.queryByTestId("handoff-confirm")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    // Unattended mode picks and confirms the selected destination by itself.
    useSettingsStore.setState({ backend: "mcs", cuaMode: true });
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await new Promise((r) => setTimeout(r, 1500));
    expect(screen.queryByTestId("handoff-confirm")).toBeNull();
    expect(counts.mcsStarts).toBe(0);
    expect(counts.foundryStarts).toBe(1);
    expect(JSON.parse(sessionStorage.getItem("ccaas:last-transfer") ?? "null")).toMatchObject({ backend: "foundry", state: "stopped" });
  }, 15000);

  it("refuses an MCS start whose confirmation was already open when the Foundry request became uncertain", async () => {
    const counts = uncertainFoundryThenMcs();
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    fireEvent.click(await screen.findByTestId("handoff-to-ai-mcs"));
    const confirm = await screen.findByTestId("handoff-confirm");
    useRecoveryStore.setState({ record: {
      request_id: "REQ-2026-121212121212", backend: "foundry", state: "stopped", message: "A claim may have been filed.",
      started_at: "2026-10-09T00:00:00.000Z", updated_at: "2026-10-09T00:00:01.000Z"
    } });
    fireEvent.click(confirm);
    await new Promise((r) => setTimeout(r, 300));
    expect(counts.mcsStarts).toBe(0);
  });

  it("allows a normal MCS transfer again after 'I checked the claims system'", async () => {
    const counts = uncertainFoundryThenMcs();
    fireEvent.click(await openFoundry());
    await screen.findByTestId("ai-status-error", {}, { timeout: 4500 });
    fireEvent.click(screen.getByTestId("handoff-fallback"));
    await reload();
    fireEvent.click(within(screen.getByTestId("previous-transfer")).getByTestId("previous-transfer-acknowledge"));
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    const mcs = await screen.findByTestId("handoff-to-ai-mcs");
    await waitFor(() => expect(mcs).not.toBeDisabled());
    fireEvent.click(mcs);
    fireEvent.click(await screen.findByTestId("handoff-confirm"));
    await waitFor(() => expect(counts.mcsStarts).toBe(1));
  }, 12000);
});