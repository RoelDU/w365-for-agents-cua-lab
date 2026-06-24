import { describe, it, expect, beforeEach } from "vitest";
import { useHandoffStore } from "@/stores/useHandoffStore";
import type { CallContext } from "@/types/contracts";

const ctx: CallContext = {
  request_id: "REQ-2024-0099",
  caller_phone: "(555) 222-0198",
  policy_number: "POL-2024-002210",
  intent: "home_water",
  summary: "Burst pipe under sink, water on floor.",
  requested_by: { agent_id: "csr-acarter", display_name: "A. Carter" },
  timestamp: "2024-04-15T18:32:11Z"
};

describe("useHandoffStore", () => {
  beforeEach(() => {
    useHandoffStore.getState().reset();
    useHandoffStore.setState({ activity: [] });
  });

  it("starts idle with no payloads", () => {
    const s = useHandoffStore.getState();
    expect(s.status).toBe("idle");
    expect(s.callContext).toBeNull();
    expect(s.active).toBe(false);
    expect(s.activity).toHaveLength(0);
  });

  it("beginHandoff stores context, handoff id and sets queued status", () => {
    useHandoffStore.getState().beginHandoff(ctx, { handoffId: "handoff-1" });
    const s = useHandoffStore.getState();
    expect(s.status).toBe("queued");
    expect(s.callContext?.request_id).toBe("REQ-2024-0099");
    expect(s.handoffId).toBe("handoff-1");
    expect(s.active).toBe(true);
  });

  it("applyStatus walks queued → prefilled → ready → submitted", () => {
    useHandoffStore.getState().beginHandoff(ctx);
    useHandoffStore.getState().applyStatus({ request_id: ctx.request_id, status: "prefilled" });
    expect(useHandoffStore.getState().status).toBe("prefilled");
    useHandoffStore.getState().applyStatus({
      request_id: ctx.request_id,
      status: "ready",
      window_title: "Claims v1.0",
      matched_policy_number: "POL-2024-002210"
    });
    expect(useHandoffStore.getState().windowTitle).toBe("Claims v1.0");
    useHandoffStore.getState().applyStatus({
      request_id: ctx.request_id,
      status: "submitted",
      claim_id: "CLM-2024-000123",
      agent_id: "C1001",
      reserve_amount: 4200
    });
    const s = useHandoffStore.getState();
    expect(s.status).toBe("submitted");
    expect(s.claimId).toBe("CLM-2024-000123");
    expect(s.reserveAmount).toBe(4200);
  });

  it("setError records the error code and message", () => {
    useHandoffStore.getState().beginHandoff(ctx);
    useHandoffStore.getState().setError("POLICY_NOT_FOUND", "No matching policy.");
    const s = useHandoffStore.getState();
    expect(s.status).toBe("error");
    expect(s.errorCode).toBe("POLICY_NOT_FOUND");
    expect(s.errorMessage).toBe("No matching policy.");
  });

  it("pushActivity caps the log at 50 entries", () => {
    for (let i = 0; i < 60; i += 1) {
      useHandoffStore.getState().pushActivity({ level: "info", message: `entry-${i}` });
    }
    expect(useHandoffStore.getState().activity.length).toBe(50);
  });
});
