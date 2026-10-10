import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { RightRail } from "@/components/workflow/RightRail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthStore } from "@/stores/useAuthStore";
import { useCallStore } from "@/stores/useCallStore";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { SAMPLE_AGENT } from "./fixtures/agent";
import { resetTransferRecorderForTests } from "@/lib/handoffRecovery";

vi.mock("@/lib/msalLogin", () => ({
  acquireHandoffAccessToken: vi.fn(async () => "user-token")
}));

const API = "http://svc.test/api";
const NH = "http://nh.test/api";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let standardCalls = 0;

beforeEach(() => {
  standardCalls = 0;
  useAuthStore.setState({ agent: SAMPLE_AGENT });
  useSettingsStore.setState({
    backend: "mcs",
    orchestratorUrl: API,
    cuaMode: false,
    cuaRunBaseUrl: API,
    newHarnessBaseUrl: NH,
    directLineTokenUrl: "",
    activeRegionId: "au"
  });
  useHandoffStore.getState().reset();
  useCallStore.getState().reset();
  useCallStore.getState().startRinging();
  useCallStore.getState().answerCall();
  useCallStore.getState().appendTranscriptLine();
});

/** The standard MCS trigger and Foundry starts must never be reached from the third button. */
function standardRoutes() {
  const count = () => { standardCalls += 1; return HttpResponse.json({ error: "wrong route" }, { status: 500 }); };
  return [
    http.get(`${API}/foundry-claims/availability`, () => HttpResponse.json({ configured: false, ready: false, message: "Foundry hosted agent is not configured for this service." })),
    http.post(`${API}/cua-run`, count),
    http.post(`${API}/foundry-claims/start`, count),
    http.post(`${API}/handoff`, count)
  ];
}

function nhAvailable(ready: boolean, message = ready ? "MCS new harness (experimental) is available." : "New-harness host (nh-auth-only-v1) is authentication-only: desktop control is not enabled.") {
  return http.get(`${NH}/nh-claims/availability`, () => HttpResponse.json({ configured: true, ready, stage: "nh-auth-only-v1", desktop: ready, registration: ready, invocation: ready, message }));
}

async function openNewHarness() {
  render(<TooltipProvider><RightRail /></TooltipProvider>);
  fireEvent.click(screen.getByTestId("open-transfer-directory"));
  const button = await screen.findByTestId("handoff-to-ai-mcs-new-harness");
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  return screen.findByTestId("handoff-confirm");
}

describe("third destination: MCS new harness (mock HTTP, not live proof)", () => {
  it("is a separate third button that says honestly why it cannot take transfers yet", async () => {
    server.use(...standardRoutes(), nhAvailable(false));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    const nh = await screen.findByTestId("handoff-to-ai-mcs-new-harness");
    expect(nh).toHaveTextContent("MCS - new harness (experimental)");
    expect(screen.getByTestId("handoff-to-ai-mcs")).not.toBeDisabled();
    expect(screen.getByTestId("handoff-to-ai-foundry")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("handoff-new-harness-availability"))
      .toHaveTextContent(/desktop control is not enabled/i));
    expect(nh).toBeDisabled();
  });

  it("stays disabled without a configured new-harness service and never asks another route", async () => {
    useSettingsStore.setState({ newHarnessBaseUrl: "" });
    server.use(...standardRoutes());
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    const nh = await screen.findByTestId("handoff-to-ai-mcs-new-harness");
    expect(nh).toBeDisabled();
    expect(screen.getByTestId("handoff-new-harness-availability")).toHaveTextContent(/not configured/i);
  });

  it("does not auto-pick the unready new harness in unattended mode", async () => {
    useSettingsStore.setState({ backend: "mcs-new-harness", cuaMode: true });
    server.use(...standardRoutes(), nhAvailable(false));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await screen.findByTestId("handoff-new-harness-availability");
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.queryByTestId("handoff-confirm")).toBeNull();
  });

  it("registers one request with the signed-in user's token and returns only the host-verified result to this interaction", async () => {
    const starts: { body: Record<string, unknown>; auth: string | null }[] = [];
    let polls = 0;
    server.use(
      ...standardRoutes(),
      nhAvailable(true),
      http.post(`${NH}/nh-claims/start`, async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        starts.push({ body, auth: request.headers.get("authorization") });
        return HttpResponse.json({ request_id: body.request_id, nh_request_id: "opaque-1", dispatch_id: "row-1", state: "dispatched" }, { status: 202 });
      }),
      http.post(`${NH}/nh-claims/status`, async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        expect(body).toEqual({ request_id: starts[0].body.request_id, nh_request_id: "opaque-1", dispatch_id: "row-1" });
        polls += 1;
        const events = [{ sequence: 1, type: "tool", tool: "computer_acquire", message: "Cloud PC acquired." },
          { sequence: 2, type: "tool", tool: "computer_click", message: "Clicked Submit Claim." }];
        if (polls < 2) return HttpResponse.json({ host_state: "observable", workflow_status: "dispatched", events: events.slice(0, 1), release: null, outcome: null, running: true });
        return HttpResponse.json({ host_state: "release_accepted", workflow_status: "agent_completed", agent_response: "Filed it.", events,
          release: { state: "released" }, outcome: { status: "submitted", claim_id: "CLM-2026-000321" }, running: false });
      })
    );
    fireEvent.click(await openNewHarness());

    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id")).toHaveTextContent("CLM-2026-000321"), { timeout: 6000 });
    expect(starts).toHaveLength(1);
    expect(starts[0].auth).toBe("Bearer user-token");
    expect(starts[0].body).toMatchObject({ operation: "claims", handoff: { target_backend: "mcs-new-harness", request_id: starts[0].body.request_id } });
    expect(String(starts[0].body.request_id)).toMatch(/^REQ-[0-9]{4}-[0-9]{4,}$/);
    expect(useHandoffStore.getState().release?.state).toBe("released");
    const log = useHandoffStore.getState().activity.map((a) => a.message).join("\n");
    expect(log).toContain("computer_click: Clicked Submit Claim.");
    expect(log).toMatch(/not verification/i);
    expect(log).not.toContain("user-token");
    expect(useHandoffStore.getState().callContext?.target_backend).toBe("mcs-new-harness");
    expect(standardCalls).toBe(0);
  }, 12000);

  it("starts only once when confirmed twice and shows a refusal without retrying or falling through", async () => {
    let starts = 0;
    server.use(
      ...standardRoutes(),
      nhAvailable(true),
      http.post(`${NH}/nh-claims/start`, () => {
        starts += 1;
        return HttpResponse.json({ error: "New-harness host (nh-auth-only-v1) is authentication-only: desktop control is not enabled." }, { status: 503 });
      })
    );
    const confirm = await openNewHarness();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(useHandoffStore.getState().errorMessage).toMatch(/desktop control is not enabled/));
    await new Promise((r) => setTimeout(r, 2500));
    expect(starts).toBe(1);
    expect(standardCalls).toBe(0);
    expect(useHandoffStore.getState().claimId).toBeNull();
  });

  it("reports an agent that finished without verified claim evidence as an error, not a claim", async () => {
    server.use(
      ...standardRoutes(),
      nhAvailable(true),
      http.post(`${NH}/nh-claims/start`, async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ request_id: body.request_id, nh_request_id: "opaque-2", dispatch_id: "row-2", state: "dispatched" }, { status: 202 });
      }),
      http.post(`${NH}/nh-claims/status`, () => HttpResponse.json({ host_state: "release_accepted", workflow_status: "agent_completed",
        agent_response: "Claim CLM-2026-000999 filed.", events: [], release: { state: "released" },
        outcome: { status: "error", error_code: "UNKNOWN", message: "The new-harness agent finished, but the host has no verified claim evidence." }, running: false }))
    );
    fireEvent.click(await openNewHarness());
    await waitFor(() => expect(useHandoffStore.getState().errorMessage).toMatch(/no verified claim evidence/), { timeout: 4500 });
    expect(useHandoffStore.getState().claimId).toBeNull();
  });

  it("cancels the owned request once when the interaction is reset mid-run", async () => {
    const cancels: unknown[] = [];
    server.use(
      ...standardRoutes(),
      nhAvailable(true),
      http.post(`${NH}/nh-claims/start`, async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ request_id: body.request_id, nh_request_id: "opaque-3", dispatch_id: "row-3", state: "dispatched" }, { status: 202 });
      }),
      http.post(`${NH}/nh-claims/status`, () => HttpResponse.json({ host_state: "observable", workflow_status: "dispatched", events: [], release: null, outcome: null, running: true })),
      http.post(`${NH}/nh-claims/cancel`, async ({ request }) => { cancels.push(await request.json()); return HttpResponse.json({ state: "release_accepted" }); })
    );
    fireEvent.click(await openNewHarness());
    await waitFor(() => expect(useHandoffStore.getState().activity.some((a) => /opaque-3/.test(a.message))).toBe(true));
    const requestId = useHandoffStore.getState().callContext?.request_id;
    await act(async () => { window.dispatchEvent(new Event("ccaas:reset-demo")); });
    await waitFor(() => expect(cancels).toHaveLength(1));
    expect(cancels[0]).toEqual({ request_id: requestId, nh_request_id: "opaque-3" });
    await new Promise((r) => setTimeout(r, 2500));
    expect(cancels).toHaveLength(1);
  }, 10000);
});

// Spec re-check of release QA R6 (8 Oct 2026): this destination is another Copilot Studio agent
// that can file a claim, so it is blocked like the others while an earlier request may have.
describe("new harness while an earlier request may have filed a claim (mock HTTP, not live proof)", () => {
  it.each(["mcs", "foundry"])("is not offered while a %s request is unresolved", async (backend) => {
    sessionStorage.setItem("ccaas:last-transfer", JSON.stringify({
      request_id: "REQ-2026-777788889999", backend, state: "stopped", message: "A claim may or may not have been filed.",
      started_at: "2026-10-08T07:02:00.000Z", updated_at: "2026-10-08T07:02:01.000Z",
      handoff: { request_id: "REQ-2026-777788889999", target_backend: backend, summary: "s" }
    }));
    resetTransferRecorderForTests();
    server.use(...standardRoutes(), nhAvailable(true));
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    const nh = await screen.findByTestId("handoff-to-ai-mcs-new-harness");
    await waitFor(() => expect(screen.getByTestId("handoff-new-harness-availability")).toHaveTextContent(/may already have filed a claim/));
    expect(nh).toBeDisabled();
    expect(standardCalls).toBe(0);
  });
});