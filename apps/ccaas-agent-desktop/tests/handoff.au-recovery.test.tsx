import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { resetTransferRecorderForTests } from "@/lib/handoffRecovery";

// The shared service also answers the Foundry availability check when the directory opens.
const server = setupServer(
  http.get("http://mcs.test/api/foundry-claims/availability", () =>
    HttpResponse.json({ configured: true, ready: false, message: "Foundry Claims runs are not enabled for CCaaS yet." }))
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  useAuthStore.setState({ agent: SAMPLE_AGENT });
  useSettingsStore.setState({
    backend: "mcs",
    orchestratorUrl: "http://mcs.test/api",
    cuaMode: false,
    cuaRunBaseUrl: "http://mcs.test/api",
    directLineTokenUrl: "",
    activeRegionId: "au"
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
  fireEvent.click(await screen.findByTestId("handoff-to-ai-mcs"));
  fireEvent.click(await screen.findByTestId("handoff-confirm"));
}

describe("AU recovery on the reconstructed release (mock HTTP, not live proof)", () => {
  it("sends the displayed region and retains the result and activity in the same interaction", async () => {
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
          activity: { state: "verified", conversationId: "conv-1" },
          release: { state: "pending" },
          steps: [{ index: 0, explanation: "I can see the claims form is open.", action: "LeftClick",
            application: "Claims.exe", at: "2026-06-23T07:20:00Z", screenshotUrl: "https://mcs.test/screen.png" }]
        }))
    );
    await transfer();
    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id"))
      .toHaveTextContent("CLM-2024-000099"), { timeout: 4500 });
    expect(postedRegion).toBe("au");
    expect(useHandoffStore.getState().callContext).toEqual(posted);
    expect(screen.getByTestId("ai-live-explanation")).toHaveTextContent("I can see the claims form is open.");
    expect(screen.getByTestId("ai-live-screenshot")).toHaveAttribute("src", "https://mcs.test/screen.png");
    expect(useCallStore.getState().phase).toBe("talking");
  });

  it("shows a refresh message for a rejected US selection without resubmission", async () => {
    useSettingsStore.setState({ activeRegionId: "us" });
    let starts = 0;
    server.use(http.post("http://mcs.test/api/cua-run", () => {
      starts += 1;
      return HttpResponse.json({ code: "REGION_MISMATCH" }, { status: 409 });
    }));
    await transfer();
    await waitFor(() => expect(useHandoffStore.getState().errorMessage).toMatch(/region.*refresh/i));
    expect(starts).toBe(1);
    expect(useHandoffStore.getState().claimId).toBeNull();
    expect(useCallStore.getState().phase).toBe("talking");
  });

  it("labels the agent's own explanation with its action, application and exact screenshot", async () => {
    let poll = 0;
    server.use(
      http.post("http://mcs.test/api/cua-run", () => HttpResponse.json({ runId: "r1" })),
      http.get("http://mcs.test/api/cua-run/r1/progress", () => {
        poll += 1;
        return HttpResponse.json(poll === 1
          ? { status: "running", activity: { state: "attributed", conversationId: "c1" }, release: { state: "pending" },
              steps: [{ index: 0, explanation: "The Start menu has opened.", action: "LeftClick", application: "StartMenuExperienceHost",
                at: "2026-06-23T07:25:21Z", screenshotUrl: "/api/cua-run/r1/shot/b0" }] }
          : { status: "running", activity: { state: "attributed", conversationId: "c1" }, release: { state: "pending" },
              steps: [
                { index: 0, explanation: "The Start menu has opened.", action: "LeftClick", application: "StartMenuExperienceHost",
                  at: "2026-06-23T07:25:21Z", screenshotUrl: "/api/cua-run/r1/shot/b0" },
                { index: 1, explanation: null, action: "Type", application: "Claims", at: "2026-06-23T07:25:30Z",
                  screenshotUrl: "/api/cua-run/r1/shot/b1" }] });
      })
    );
    await transfer();
    await waitFor(() => expect(screen.getByTestId("ai-live-explanation"))
      .toHaveTextContent("The Start menu has opened."), { timeout: 4500 });
    expect(screen.getByTestId("ai-live-explanation-label")).toHaveTextContent(/agent's explanation/i);
    expect(screen.getByTestId("ai-live-step-meta")).toHaveTextContent("LeftClick");
    expect(screen.getByTestId("ai-live-step-meta")).toHaveTextContent("StartMenuExperienceHost");
    expect(screen.getByTestId("ai-live-screenshot")).toHaveAttribute("src", "http://mcs.test/api/cua-run/r1/shot/b0");
    await waitFor(() => expect(screen.getByTestId("ai-live-explanation"))
      .toHaveTextContent(/no explanation was logged for this action/i), { timeout: 4500 });
    expect(screen.getByTestId("ai-live-screenshot")).toHaveAttribute("src", "http://mcs.test/api/cua-run/r1/shot/b1");
    expect(useHandoffStore.getState().claimId).toBeNull();
  }, 12000);

  it("never takes a claim id from explanation text; only the receipt result counts", async () => {
    server.use(
      http.post("http://mcs.test/api/cua-run", () => HttpResponse.json({ runId: "r2" })),
      http.get("http://mcs.test/api/cua-run/r2/progress", () => HttpResponse.json({
        status: "running", activity: { state: "attributed", conversationId: "c2" }, release: { state: "pending" },
        steps: [{ index: 0, explanation: "I will look for CLM-2024-123456 later.", action: "Screenshot",
          application: "Claims", at: "2026-06-23T07:20:00Z", screenshotUrl: null }]
      }))
    );
    await transfer();
    await waitFor(() => expect(screen.getByTestId("ai-live-explanation"))
      .toHaveTextContent("CLM-2024-123456"), { timeout: 4500 });
    expect(useHandoffStore.getState().claimId).toBeNull();
    expect(screen.queryByTestId("ai-status-claim-id")).toBeNull();
  });

  it("explains unattributed activity instead of an endless acquiring spinner", async () => {
    server.use(
      http.post("http://mcs.test/api/cua-run", () => HttpResponse.json({ runId: "r3" })),
      http.get("http://mcs.test/api/cua-run/r3/progress", () => HttpResponse.json({
        status: "running", steps: [], release: { state: "unknown" },
        activity: { state: "unattributed", message: "Another Computer Use run is active." }
      }))
    );
    await transfer();
    await waitFor(() => expect(screen.getByTestId("ai-live-activity-note"))
      .toHaveTextContent(/another computer use run is active/i), { timeout: 4500 });
    expect(screen.queryByText(/acquiring a secure/i)).toBeNull();
  });

  it("withdraws shown activity when the receipt proves it belonged to another conversation", async () => {
    let poll = 0;
    server.use(
      http.post("http://mcs.test/api/cua-run", () => HttpResponse.json({ runId: "r4" })),
      http.get("http://mcs.test/api/cua-run/r4/progress", () => {
        poll += 1;
        return HttpResponse.json(poll === 1
          ? { status: "running", activity: { state: "attributed", conversationId: "other" }, release: { state: "pending" },
              steps: [{ index: 0, explanation: "Opening the claims app.", action: "LeftClick", application: "Claims",
                at: "2026-06-23T07:20:00Z", screenshotUrl: "/api/cua-run/r4/shot/x" }] }
          : { status: "succeeded", claimId: "CLM-2024-000777", steps: [], release: { state: "unknown" },
              activity: { state: "mismatch", message: "The activity shown did not belong to this handoff's conversation and has been withdrawn." } });
      })
    );
    await transfer();
    await waitFor(() => expect(screen.getByTestId("ai-live-explanation")).toBeInTheDocument(), { timeout: 4500 });
    await waitFor(() => expect(screen.getByTestId("ai-live-activity-note"))
      .toHaveTextContent(/withdrawn/i), { timeout: 4500 });
    expect(screen.queryByTestId("ai-live-explanation")).toBeNull();
    expect(screen.queryByTestId("ai-live-screenshot")).toBeNull();
    expect(useHandoffStore.getState().activity.some((e) => e.message.includes("Opening the claims app."))).toBe(false);
    expect(screen.getByTestId("ai-status-claim-id")).toHaveTextContent("CLM-2024-000777");
  }, 12000);

  it("does not call the Cloud PC released when the session ended without a recorded sign-out", async () => {
    server.use(
      http.post("http://mcs.test/api/cua-run", () => HttpResponse.json({ runId: "r7" })),
      http.get("http://mcs.test/api/cua-run/r7/progress", () => HttpResponse.json({
        status: "succeeded", claimId: "CLM-2024-000556", steps: [],
        activity: { state: "verified", conversationId: "c7" }, release: { state: "ended", at: "2026-06-23T07:26:28Z" }
      }))
    );
    await transfer();
    await waitFor(() => expect(screen.getByTestId("ai-status-release")).toHaveTextContent(/no sign-out was recorded/i), { timeout: 4500 });
    expect(screen.getByTestId("ai-status-release")).not.toHaveTextContent(/released at/i);
  }, 12000);

  it("reports the Cloud PC release separately from the claim", async () => {
    let poll = 0;
    server.use(
      http.post("http://mcs.test/api/cua-run", () => HttpResponse.json({ runId: "r5" })),
      http.get("http://mcs.test/api/cua-run/r5/progress", () => {
        poll += 1;
        const base = { activity: { state: "verified", conversationId: "c5" }, steps: [] };
        return HttpResponse.json(poll === 1
          ? { ...base, status: "succeeded", claimId: "CLM-2024-000555", release: { state: "pending" } }
          : { ...base, status: "succeeded", claimId: "CLM-2024-000555", release: { state: "released", at: "2026-06-23T07:26:28Z" } });
      })
    );
    await transfer();
    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id")).toHaveTextContent("CLM-2024-000555"), { timeout: 4500 });
    expect(screen.getByTestId("ai-status-release")).toHaveTextContent(/release not yet confirmed/i);
    await waitFor(() => expect(screen.getByTestId("ai-status-release")).toHaveTextContent(/released/i), { timeout: 8000 });
    expect(screen.getByTestId("ai-status-release")).not.toHaveTextContent(/not yet/i);
  }, 12000);

  it("labels simulated progress as a simulation with no agent explanation", async () => {
    server.use(
      http.post("http://mcs.test/api/cua-run", () => HttpResponse.json({ runId: "r6" })),
      http.get("http://mcs.test/api/cua-run/r6/progress", () => HttpResponse.json({
        status: "running", simulated: true,
        steps: [{ index: 0, explanation: null, note: "Opening the claims application", screenshotUrl: null }]
      }))
    );
    await transfer();
    await waitFor(() => expect(screen.getByTestId("ai-live-simulated")).toHaveTextContent(/simulat/i), { timeout: 4500 });
    expect(screen.queryByTestId("ai-live-explanation-label")).toBeNull();
  });
});

// Release QA R6 (8 Oct 2026): the service says when a claim may or may not have been filed.
describe("MCS result the service cannot prove (mock HTTP, not live proof)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetTransferRecorderForTests();
  });

  function failWith(body: Record<string, unknown>) {
    server.use(
      http.post("http://mcs.test/api/cua-run", () => HttpResponse.json({ runId: "r-uncertain" })),
      http.get("http://mcs.test/api/cua-run/r-uncertain/progress", () => HttpResponse.json({
        status: "failed", claimId: null, steps: [], activity: { state: "verified", conversationId: "c9" },
        release: { state: "pending" }, ...body
      }))
    );
  }

  it("offers no Retry when a claim may or may not have been filed", async () => {
    failWith({ outcome: "uncertain", errorMessage: "The agent's reply does not confirm a filed claim. A claim may or may not have been filed. Check its run record; do not submit another handoff." });
    await transfer();
    const error = await screen.findByTestId("ai-status-error", {}, { timeout: 4500 });
    expect(error).toHaveTextContent("STOPPED - OUTCOME UNKNOWN");
    expect(error).toHaveTextContent(/may or may not have been filed/);
    expect(screen.queryByTestId("handoff-retry")).toBeNull();
    expect(useHandoffStore.getState().claimId).toBeNull();
  });

  it("keeps Retry for a failure the agent reported before filing", async () => {
    failWith({ errorMessage: 'The agent reported "Filing failed: POLICY_NOT_FOUND", so no claim was filed.' });
    await transfer();
    const error = await screen.findByTestId("ai-status-error", {}, { timeout: 4500 });
    expect(error).toHaveTextContent(/POLICY_NOT_FOUND/);
    expect(screen.getByTestId("handoff-retry")).toBeInTheDocument();
  });

  it("keeps an uncertain MCS request unresolved through reset and reload until someone checks the claims system", async () => {
    failWith({ outcome: "uncertain", errorMessage: "The agent's session ended without reporting a filed claim in its log. A claim may or may not have been filed. Check its run record; do not submit another handoff." });
    await transfer();
    await screen.findByTestId("ai-status-error", {}, { timeout: 4500 });
    fireEvent.click(screen.getByTestId("handoff-fallback"));
    window.dispatchEvent(new CustomEvent("ccaas:reset-demo"));

    cleanup();
    useHandoffStore.getState().reset();
    resetTransferRecorderForTests();
    render(<TooltipProvider><RightRail /></TooltipProvider>);
    const note = await screen.findByTestId("previous-transfer");
    expect(note).toHaveAttribute("data-state", "stopped");
    expect(note).toHaveTextContent(/may or may not have been filed/);
    expect(within(note).queryByTestId("previous-transfer-dismiss")).toBeNull();
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await waitFor(() => expect(screen.getByTestId("handoff-to-ai-mcs")).toBeDisabled());
    expect(screen.getByTestId("handoff-mcs-availability")).toHaveTextContent(/may already have filed a claim/);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.click(within(screen.getByTestId("previous-transfer")).getByTestId("previous-transfer-acknowledge"));
    fireEvent.click(screen.getByTestId("open-transfer-directory"));
    await waitFor(() => expect(screen.getByTestId("handoff-to-ai-mcs")).not.toBeDisabled());
  }, 12000);

  it("keeps a confirmed claim when a later poll for the Cloud PC release fails", async () => {
    let poll = 0;
    server.use(
      http.post("http://mcs.test/api/cua-run", () => HttpResponse.json({ runId: "r-kept" })),
      http.get("http://mcs.test/api/cua-run/r-kept/progress", () => {
        poll += 1;
        return HttpResponse.json(poll === 1
          ? { status: "succeeded", claimId: "CLM-2024-007004", steps: [], activity: { state: "verified", conversationId: "c1" }, release: { state: "pending" } }
          : { status: "failed", outcome: "uncertain", claimId: null, steps: [], errorMessage: "Could not verify this handoff's result: the exact handoff row is unavailable after a service restart. A claim may or may not have been filed. Check its run record; do not submit another handoff." });
      })
    );
    await transfer();
    await waitFor(() => expect(screen.getByTestId("ai-status-claim-id")).toHaveTextContent("CLM-2024-007004"), { timeout: 4500 });
    await waitFor(() => expect(poll).toBeGreaterThanOrEqual(2), { timeout: 6000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(useHandoffStore.getState().status).toBe("submitted");
    expect(useHandoffStore.getState().claimId).toBe("CLM-2024-007004");
    // ...but the later doubt is shown, not dropped.
    const log = useHandoffStore.getState().activity.map((x) => x.message).join("\n");
    expect(log).toMatch(/A later check of CLM-2024-007004 could not confirm it/);
    expect(log).toMatch(/exact handoff row is unavailable/);
  }, 12000);
});