import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse, delay } from "msw";
import { setupServer } from "msw/node";
import { RightRail } from "@/components/workflow/RightRail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthStore } from "@/stores/useAuthStore";
import { useCallStore } from "@/stores/useCallStore";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { SAMPLE_AGENT } from "./fixtures/agent";
import { resetTransferRecorderForTests, isUnresolved, useRecoveryStore } from "@/lib/handoffRecovery";

/*
 * Cloud PC capacity gate in the transfer directory (mock HTTP, not live proof). The 20 s
 * refresh is shortened to 300 ms here; everything else is the shipped code path.
 */

vi.mock("@/lib/msalLogin", () => ({
  acquireHandoffAccessToken: vi.fn(async () => "user-token"),
  getSignedInAccount: vi.fn(async () => ({ homeAccountId: "o.t", tenantId: "t", username: "tu1@contoso.example" })),
  startHandoffReconnect: vi.fn(async () => { await new Promise(() => undefined); })
}));
vi.mock("@/components/workflow/useFoundryCapacity", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/components/workflow/useFoundryCapacity")>();
  return { ...m, useFoundryCapacity: (active: boolean, baseUrl: string | null) => m.useFoundryCapacity(active, baseUrl, 300) };
});

const API = "http://svc.test/api";

type Cap = "available" | "none" | "unknown" | "http500";
const cap = { next: "available" as Cap, reason: "graph_permission_denied", calls: 0, inflight: 0, maxInflight: 0, delayMs: 0 };
const starts: Record<string, unknown>[] = [];
const statusCalls: unknown[] = [];
const cancels: unknown[] = [];

const server = setupServer(
  http.get(`${API}/foundry-claims/availability`, () =>
    HttpResponse.json({ configured: true, ready: true, message: "Foundry hosted agent is available.", capacity_gate: true })),
  http.get(`${API}/foundry-claims/capacity`, async ({ request }) => {
    cap.calls += 1;
    cap.inflight += 1;
    cap.maxInflight = Math.max(cap.maxInflight, cap.inflight);
    try {
      expect(request.headers.get("authorization")).toBe("Bearer user-token");
      if (cap.delayMs) await delay(cap.delayMs);
      if (cap.next === "http500") return HttpResponse.json({ error: "x" }, { status: 500 });
      return HttpResponse.json({ gate: true, state: cap.next, checked_at: new Date().toISOString(),
        ...(cap.next === "unknown" ? { reason: cap.reason } : {}) });
    } finally {
      cap.inflight -= 1;
    }
  }),
  http.post(`${API}/foundry-claims/prepare`, () => HttpResponse.json({ prepared: true }, { status: 202 })),
  http.post(`${API}/foundry-claims/start`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    starts.push(body);
    const computer = { type: "computer", sequence: 1, session_id: "sess-1" };
    return HttpResponse.json({ request_id: body.request_id, events: [computer], computer, outcome: null, release: null }, { status: 202 });
  }),
  http.post(`${API}/foundry-claims/status`, async ({ request }) => {
    statusCalls.push(await request.json());
    return HttpResponse.json({ events: [], computer: null, outcome: null, release: null, running: true, interrupted: false });
  }),
  http.post(`${API}/foundry-claims/view`, () => HttpResponse.json({ error: "not yet" }, { status: 409 })),
  http.post(`${API}/foundry-claims/cancel`, async ({ request }) => {
    cancels.push(await request.json());
    return HttpResponse.json({ ok: true });
  })
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { cleanup(); server.resetHandlers(); });
afterAll(() => server.close());

beforeEach(() => {
  Object.assign(cap, { next: "available", reason: "graph_permission_denied", calls: 0, inflight: 0, maxInflight: 0, delayMs: 0 });
  starts.length = 0;
  statusCalls.length = 0;
  cancels.length = 0;
  sessionStorage.clear();
  resetTransferRecorderForTests();
  useAuthStore.setState({ agent: SAMPLE_AGENT });
  useSettingsStore.setState({
    backend: "mcs", orchestratorUrl: API, cuaMode: false, cuaRunBaseUrl: API, directLineTokenUrl: "", activeRegionId: "au"
  });
  useHandoffStore.getState().reset();
  useCallStore.getState().reset();
  useCallStore.getState().startRinging();
  useCallStore.getState().answerCall();
  useCallStore.getState().appendTranscriptLine();
});

const card = () => screen.getByTestId("handoff-to-ai-foundry");
const note = () => screen.queryByTestId("handoff-foundry-availability");
function openDirectory() {
  fireEvent.click(screen.getByTestId("open-transfer-directory"));
}
function renderRail() {
  render(<TooltipProvider><RightRail /></TooltipProvider>);
}

describe("Cloud PC capacity gate for new Foundry transfers (mock HTTP, not live proof)", () => {
  it("is grey with 'Checking Cloud PC availability…' until a reading arrives, then enabled when one is free", async () => {
    cap.delayMs = 400;
    renderRail();
    openDirectory();
    await waitFor(() => expect(note()).toHaveTextContent("Checking Cloud PC availability…"));
    expect(card()).toBeDisabled();
    await waitFor(() => expect(card()).not.toBeDisabled());
    expect(note()).toBeNull();
    // MCS is not gated on Foundry capacity.
    expect(screen.getByTestId("handoff-to-ai-mcs")).not.toBeDisabled();
  });

  it("is grey with 'No Cloud PC available yet.' and re-enables by itself when capacity is reported again", async () => {
    cap.next = "none";
    renderRail();
    openDirectory();
    await waitFor(() => expect(note()).toHaveTextContent("No Cloud PC available yet."));
    expect(card()).toBeDisabled();
    expect(screen.queryByTestId("handoff-foundry-capacity-refresh")).toBeNull();
    expect(note()).not.toHaveTextContent(/reset|minute|second/i);
    const before = cap.calls;
    cap.next = "available";
    await waitFor(() => expect(card()).not.toBeDisabled(), { timeout: 2000 });
    expect(cap.calls).toBeGreaterThan(before);
  });

  it("a failed permission read is 'Unable to check', never available or zero, and Check again recovers", async () => {
    cap.next = "unknown";
    renderRail();
    openDirectory();
    await waitFor(() => expect(note()).toHaveTextContent("Unable to check Cloud PC availability."));
    expect(card()).toBeDisabled();
    expect(note()).not.toHaveTextContent(/No Cloud PC/);
    expect(note()).toHaveAttribute("title", "graph_permission_denied");
    cap.next = "available";
    fireEvent.click(screen.getByTestId("handoff-foundry-capacity-refresh"));
    await waitFor(() => expect(card()).not.toBeDisabled());
    expect(screen.queryByTestId("handoff-foundry-capacity-refresh")).toBeNull();
  });

  it("an HTTP failure of the relay is also 'Unable to check' and keeps the card grey", async () => {
    cap.next = "http500";
    renderRail();
    openDirectory();
    await waitFor(() => expect(note()).toHaveTextContent("Unable to check Cloud PC availability."));
    expect(card()).toBeDisabled();
    expect(screen.getByTestId("handoff-foundry-capacity-refresh")).toBeInTheDocument();
  });

  it("never overlaps reads, stops when the directory closes, and drops a late answer from before", async () => {
    cap.delayMs = 700; // longer than the 300 ms test refresh
    renderRail();
    openDirectory();
    await waitFor(() => expect(cap.calls).toBe(1));
    await new Promise((r) => setTimeout(r, 1000));
    expect(cap.maxInflight).toBe(1);
    // Close while the second read is in flight; its "available" must not be shown later.
    await waitFor(() => expect(cap.inflight).toBe(1));
    cap.next = "none";
    fireEvent.keyDown(screen.getByTestId("transfer-directory"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("transfer-directory")).toBeNull());
    const atClose = cap.calls;
    await new Promise((r) => setTimeout(r, 1200));
    expect(cap.calls).toBe(atClose);
    cap.delayMs = 400;
    openDirectory();
    await waitFor(() => expect(note()).toHaveTextContent("Checking Cloud PC availability…"));
    expect(card()).toBeDisabled();
    await waitFor(() => expect(note()).toHaveTextContent("No Cloud PC available yet."));
  });

  it("Confirm-time capacity loss keeps the call, confirmation and request ID, and starts nothing", async () => {
    renderRail();
    openDirectory();
    await waitFor(() => expect(card()).not.toBeDisabled());
    fireEvent.click(card());
    const confirm = await screen.findByTestId("handoff-confirm");
    const requestId = (await screen.findByTestId("handoff-modal")).textContent?.match(/REQ-\d{4}-\d{4,}/)?.[0];
    expect(requestId).toBeTruthy();
    cap.next = "none";
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByTestId("handoff-capacity-notice")).toHaveTextContent(/No Cloud PC available yet\. Nothing was started/));
    expect(screen.getByTestId("handoff-modal")).toBeInTheDocument();
    expect(starts).toHaveLength(0);
    expect(useHandoffStore.getState().status).toBe("idle");
    expect(useCallStore.getState().phase).toBe("talking");
    expect(isUnresolved(useRecoveryStore.getState().record)).toBe(false);
    // A person confirms again once a Cloud PC is free: the same request ID is started once.
    cap.next = "available";
    fireEvent.click(screen.getByTestId("handoff-confirm"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0].request_id).toBe(requestId);
  });

  it("an unreadable capacity at Confirm is shown as such and starts nothing", async () => {
    renderRail();
    openDirectory();
    await waitFor(() => expect(card()).not.toBeDisabled());
    fireEvent.click(card());
    const confirm = await screen.findByTestId("handoff-confirm");
    cap.next = "unknown";
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByTestId("handoff-capacity-notice")).toHaveTextContent(/Unable to check Cloud PC availability/));
    expect(starts).toHaveLength(0);
  });

  it("confirming twice checks once and starts once", async () => {
    renderRail();
    openDirectory();
    await waitFor(() => expect(card()).not.toBeDisabled());
    fireEvent.click(card());
    const confirm = await screen.findByTestId("handoff-confirm");
    cap.delayMs = 200;
    const before = cap.calls;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(starts).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 500));
    expect(starts).toHaveLength(1);
    expect(cap.calls - before).toBe(1);
  });

  it("unattended: waits while no Cloud PC is free, then auto-selects and starts exactly once", async () => {
    useSettingsStore.setState({ backend: "foundry", cuaMode: true });
    cap.next = "none";
    renderRail();
    openDirectory();
    await waitFor(() => expect(note()).toHaveTextContent("No Cloud PC available yet."));
    await new Promise((r) => setTimeout(r, 1200));
    expect(screen.queryByTestId("handoff-modal")).toBeNull();
    expect(starts).toHaveLength(0);
    cap.next = "available";
    await waitFor(() => expect(starts).toHaveLength(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 800));
    expect(starts).toHaveLength(1);
  }, 10000);

  it("unattended: a Confirm-time refusal is not retried automatically", async () => {
    useSettingsStore.setState({ backend: "foundry", cuaMode: true });
    renderRail();
    openDirectory();
    await screen.findByTestId("handoff-modal", undefined, { timeout: 3000 });
    cap.next = "none";
    await waitFor(() => expect(screen.getByTestId("handoff-capacity-notice")).toBeInTheDocument(), { timeout: 3000 });
    const after = cap.calls;
    cap.next = "available";
    await new Promise((r) => setTimeout(r, 2500));
    expect(cap.calls).toBe(after);
    expect(starts).toHaveLength(0);
    expect(screen.getByTestId("handoff-modal")).toBeInTheDocument();
  }, 10000);

  it("a start the relay refuses for capacity (raced) is 'not sent' on the same request ID, never unresolved", async () => {
    server.use(http.post(`${API}/foundry-claims/start`, async ({ request }) => {
      starts.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ error: "No Cloud PC is available for the Foundry agent yet. Nothing was started and this request ID was not used.", capacity: "none" }, { status: 503 });
    }));
    renderRail();
    openDirectory();
    await waitFor(() => expect(card()).not.toBeDisabled());
    fireEvent.click(card());
    fireEvent.click(await screen.findByTestId("handoff-confirm"));
    await waitFor(() => expect(useHandoffStore.getState().failure?.outcome).toBe("not_sent"));
    expect(screen.getByTestId("ai-status-error-message")).toHaveTextContent(/this request ID was not used/);
    expect(screen.getByTestId("handoff-send-again")).toBeInTheDocument();
    expect(isUnresolved(useRecoveryStore.getState().record)).toBe(false);
    await new Promise((r) => setTimeout(r, 800));
    expect(starts).toHaveLength(1);
    expect(statusCalls).toHaveLength(0);
  });

  it("a started run keeps its status and cancel even though its own Cloud PC leaves none free", async () => {
    renderRail();
    openDirectory();
    await waitFor(() => expect(card()).not.toBeDisabled());
    fireEvent.click(card());
    fireEvent.click(await screen.findByTestId("handoff-confirm"));
    await waitFor(() => expect(starts).toHaveLength(1));
    cap.next = "none";
    const atStart = cap.calls;
    await waitFor(() => expect(statusCalls.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(cap.calls).toBe(atStart);
    expect(useHandoffStore.getState().status).not.toBe("idle");
    expect(useHandoffStore.getState().failure ?? null).toBeNull();
    const requestId = starts[0].request_id;
    window.dispatchEvent(new Event("ccaas:reset-demo"));
    useHandoffStore.getState().reset();
    await waitFor(() => expect(cancels).toContainEqual({ request_id: requestId }));
    expect(cap.calls).toBe(atStart);
  }, 10000);
});
