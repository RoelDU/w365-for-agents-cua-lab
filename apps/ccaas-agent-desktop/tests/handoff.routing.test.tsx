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
import type { CallContext } from "@/types/contracts";
import { SAMPLE_AGENT } from "./fixtures/agent";

// These routing tests run as a build that names a local Foundry orchestrator.
vi.mock("@/stores/useSettingsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/useSettingsStore")>()),
  BACKEND_SELECTABLE: true
}));

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  useAuthStore.setState({ agent: SAMPLE_AGENT });
  useSettingsStore.setState({
    backend: "foundry",
    orchestratorUrl: "http://foundry.test",
    cuaMode: false,
    cuaRunBaseUrl: "",
    directLineTokenUrl: "",
    activeRegionId: ""
  });
  useHandoffStore.getState().reset();
  useCallStore.getState().reset();
  useCallStore.getState().startRinging();
  useCallStore.getState().answerCall();
  useCallStore.getState().appendTranscriptLine();
});

async function transfer() {
  render(<TooltipProvider><RightRail /></TooltipProvider>);
  fireEvent.click(screen.getByTestId("open-transfer-directory"));
  const backend = useSettingsStore.getState().backend;
  const destination = await screen.findByTestId(`handoff-to-ai-${backend}`);
  await waitFor(() => expect(destination).not.toBeDisabled());
  fireEvent.click(destination);
  fireEvent.click(await screen.findByTestId("handoff-confirm"));
}

describe("selected backend routing (mock HTTP, not a live agent)", () => {
  it("accepts the existing MCS HTTP acknowledgement and polls its handoff to completion", async () => {
    useSettingsStore.setState({ backend: "mcs", orchestratorUrl: "http://mcs.test/api" });
    let posted: CallContext | undefined;
    let polls = 0;
    server.use(
      http.post("http://mcs.test/api/handoff", async ({ request }) => {
        posted = await request.json() as CallContext;
        // apps/handoff-orchestrator/src/functions/http.js: accepted()
        return HttpResponse.json({
          handoff_id: "handoff-existing-mcs",
          status: "queued",
          disposition: "started",
          status_url: "http://mcs.test/api/handoff/handoff-existing-mcs/status"
        }, { status: 202 });
      }),
      http.get("http://mcs.test/api/handoff/handoff-existing-mcs/status", () => {
        polls += 1;
        return HttpResponse.json({
          request_id: posted?.request_id, status: "submitted", claim_id: "CLM-2024-000099"
        });
      })
    );
    await transfer();
    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id"))
      .toHaveTextContent("CLM-2024-000099"));
    expect(polls).toBeGreaterThan(0);
    expect(posted?.target_backend).toBe("mcs");
    expect(useHandoffStore.getState().callContext).toEqual(posted);
    expect(useCallStore.getState().phase).toBe("talking");
  });

  it("rejects a conflicting polled request after the existing MCS acknowledgement", async () => {
    useSettingsStore.setState({ backend: "mcs", orchestratorUrl: "http://mcs.test/api" });
    server.use(
      http.post("http://mcs.test/api/handoff", () => HttpResponse.json({
        handoff_id: "handoff-existing-mcs", status: "queued", disposition: "reused",
        status_url: "http://mcs.test/api/handoff/handoff-existing-mcs/status"
      }, { status: 202 })),
      http.get("http://mcs.test/api/handoff/handoff-existing-mcs/status", () =>
        HttpResponse.json({ request_id: "REQ-2024-9999", status: "submitted", claim_id: "CLM-2024-999999" }))
    );
    await transfer();
    await waitFor(() => expect(useHandoffStore.getState().status).toBe("error"));
    expect(useHandoffStore.getState().errorMessage).toMatch(/does not match/);
    expect(useHandoffStore.getState().claimId).toBeNull();
  });

  it("retains the MCS trigger path and returns its activity and result to the interaction", async () => {
    useSettingsStore.setState({ backend: "mcs", cuaRunBaseUrl: "http://mcs.test/api", activeRegionId: "au" });
    let posted: CallContext | undefined;
    let postedRegion: string | undefined;
    server.use(
      http.post("http://mcs.test/api/cua-run", async ({ request }) => {
        const body = await request.json() as { callContext: CallContext; regionId?: string };
        posted = body.callContext;
        postedRegion = body.regionId;
        return HttpResponse.json({ runId: "mcs-run" });
      }),
      http.get("http://mcs.test/api/cua-run/mcs-run/progress", () =>
        HttpResponse.json({
          status: "succeeded", claimId: "CLM-2024-000099",
          activity: { state: "verified" }, release: { state: "released", at: "2026-06-01T07:26:28Z" },
          steps: [{ index: 0, explanation: "Logged CUA explanation", action: "Click", application: "ZavaClaims",
            at: "2026-06-01T07:20:00Z", screenshotUrl: "https://mcs.test/screen.png" }]
        }))
    );
    await transfer();
    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id"))
      .toHaveTextContent("CLM-2024-000099"), { timeout: 4500 });
    expect(posted?.target_backend).toBe("mcs");
    expect(postedRegion).toBe("au");
    expect(useHandoffStore.getState().callContext).toEqual(posted);
    expect(screen.getByTestId("ai-live-explanation")).toHaveTextContent("Logged CUA explanation");
    expect(screen.getByTestId("ai-live-screenshot")).toHaveAttribute("src", "https://mcs.test/screen.png");
    expect(screen.queryByTestId("ai-execution-mode")).not.toBeInTheDocument();
  });

  it("shows an unavailable Foundry error without starting MCS or leaving the interaction", async () => {
    server.use(http.post("http://foundry.test/handoff", () =>
      HttpResponse.json({ error: "Foundry runner unavailable. Start the runner with the same HANDOFF_DIR." }, { status: 503 })));
    await transfer();
    await waitFor(() => expect(useHandoffStore.getState().activity[0]?.message).toMatch(/Foundry runner unavailable/));
    expect(screen.getByTestId("handoff-modal")).toBeInTheDocument();
    expect(useCallStore.getState().phase).toBe("talking");
    expect(useSettingsStore.getState().backend).toBe("foundry");
    expect(useHandoffStore.getState().claimId).toBeNull();
  });

  it("keeps a rejected region transfer in the same interaction with a refresh message and no retry", async () => {
    useSettingsStore.setState({ backend: "mcs", cuaRunBaseUrl: "http://mcs.test/api", activeRegionId: "us" });
    let starts = 0;
    server.use(http.post("http://mcs.test/api/cua-run", () => {
      starts += 1;
      return HttpResponse.json({
        code: "REGION_MISMATCH",
        error: "The selected region does not match this service. Refresh the app."
      }, { status: 409 });
    }));

    await transfer();
    await waitFor(() => expect(useHandoffStore.getState().errorMessage).toMatch(/region.*refresh/i));
    expect(starts).toBe(1);
    expect(useHandoffStore.getState().claimId).toBeNull();
    expect(useCallStore.getState().phase).toBe("talking");
  });

  it("rejects another interaction's result and activity", async () => {
    server.use(
      http.post("http://foundry.test/handoff", async ({ request }) => {
        const body = await request.json() as CallContext;
        return HttpResponse.json({
          request_id: body.request_id, handoff_id: "wrong-result", status: "queued", execution_mode: "simulation"
        });
      }),
      http.get("http://foundry.test/handoff/wrong-result/status", () =>
        HttpResponse.json({
          request_id: "REQ-2024-9999", status: "submitted", claim_id: "CLM-2024-999999",
          execution_mode: "simulation", activity: [{
            id: "other", ts_iso: "2026-09-29T13:00:00Z", level: "info", message: "Another interaction"
          }]
        }))
    );
    await transfer();
    await waitFor(() => expect(useHandoffStore.getState().status).toBe("error"));
    expect(useHandoffStore.getState().errorMessage).toMatch(/does not match/);
    expect(useHandoffStore.getState().claimId).toBeNull();
    expect(useHandoffStore.getState().activity.some((entry) => entry.id === "other")).toBe(false);
  });

  it.each(["trigger", "direct-line"])("keeps Foundry selected when MCS %s is configured", async (path) => {
    useSettingsStore.setState(path === "trigger"
      ? { cuaRunBaseUrl: "http://mcs.test/api" }
      : { directLineTokenUrl: "http://mcs.test/token" });
    let posted: CallContext | undefined;
    let mcsRequests = 0;
    server.use(
      // The shared service reports no hosted Foundry agent, so the local Foundry path applies.
      http.get("http://mcs.test/api/foundry-claims/availability", () =>
        HttpResponse.json({ configured: false, ready: false, message: "not configured" })),
      http.all("http://mcs.test/*", () => {
        mcsRequests += 1;
        return HttpResponse.json({ error: "Wrong backend" }, { status: 503 });
      }),
      http.post("http://foundry.test/handoff", async ({ request }) => {
        posted = await request.json() as CallContext;
        return HttpResponse.json({
          request_id: posted.request_id, handoff_id: "foundry-job", status: "queued",
          execution_mode: "simulation"
        }, { status: 202 });
      }),
      http.get("http://foundry.test/handoff/foundry-job/status", () =>
        HttpResponse.json({ request_id: posted?.request_id, status: "prefilled", execution_mode: "simulation" }))
    );
    await transfer();
    await waitFor(() => expect(posted, JSON.stringify(useHandoffStore.getState().activity)).toBeDefined());
    expect(mcsRequests).toBe(0);
    expect(posted).toMatchObject({
      target_backend: "foundry",
      policy_number: "POL-2024-008341",
      requested_by: { agent_id: SAMPLE_AGENT.agent_id },
      transcript_excerpt: useCallStore.getState().getTranscriptExcerpt(30_000)
    });
    expect(useHandoffStore.getState().callContext).toEqual(posted);
    expect(useCallStore.getState().phase).toBe("talking");
  });

  it("keeps polling the original endpoint and labels simulation after the selector changes", async () => {
    let posted: CallContext | undefined;
    let complete = false;
    server.use(
      http.post("http://foundry.test/handoff", async ({ request }) => {
        posted = await request.json() as CallContext;
        return HttpResponse.json({
          request_id: posted.request_id, handoff_id: "foundry-job", status: "prefilled",
          execution_mode: "simulation"
        }, { status: 202 });
      }),
      http.get("http://foundry.test/handoff/foundry-job/status", () =>
        HttpResponse.json({
          request_id: posted?.request_id, status: complete ? "submitted" : "prefilled",
          execution_mode: "simulation",
          ...(complete ? { claim_id: "CLM-2024-000042", agent_id: "csr-test" } : {}),
          activity: [{ id: "activity-1", ts_iso: "2026-09-29T13:00:00Z", level: "info",
            message: "Simulation: no Cloud PC was used." }]
        }))
    );
    await transfer();
    await screen.findByTestId("ai-status-card");
    expect(screen.getByTestId("ai-execution-mode")).toHaveTextContent(/simulation/i);
    expect(screen.queryByTestId("ai-live-desktop")).not.toBeInTheDocument();
    act(() => useSettingsStore.getState().setBackend("mcs"));
    complete = true;
    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id"))
      .toHaveTextContent("CLM-2024-000042"), { timeout: 4000 });
    expect(useHandoffStore.getState().callContext?.request_id).toBe(posted?.request_id);
    expect(useHandoffStore.getState().activity.filter((entry) => entry.id === "activity-1")).toHaveLength(1);
    expect(useHandoffStore.getState().callContext?.target_backend).toBe("foundry");
  });
});
