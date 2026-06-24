import { describe, it, expect } from "vitest";
import { mapActionToMcp, SimulationW365AProvider, SimulatedCloudPcComputer } from "../w365aSession";
import { deriveClaimId, agentIdFromPrefill, interpretFinalMessage } from "../runner";
import type { Prefill } from "../types";

const prefill: Prefill = {
  request_id: "REQ-2024-0042",
  caller_phone: "(555) 123-4567",
  policy_number: "POL-2024-008341",
  intent: "auto_collision",
  summary: "Rear-ended at 5th and Main, no injuries.",
  requested_by: "ccaas-desktop:csr-acarter"
};

describe("mapActionToMcp", () => {
  it("maps a click action to computer_click with its args", () => {
    expect(mapActionToMcp({ type: "click", button: "left", x: 10, y: 20 })).toEqual({
      tool: "computer_click",
      arguments: { button: "left", x: 10, y: 20 }
    });
  });

  it("maps a type action and drops the type field from args", () => {
    expect(mapActionToMcp({ type: "type", text: "hello" })).toEqual({
      tool: "computer_type",
      arguments: { text: "hello" }
    });
  });
});

describe("driver helpers", () => {
  it("derives a schema-valid claim id from the request id", () => {
    expect(deriveClaimId("REQ-2024-0042")).toBe("CLM-2024-000042");
    expect(deriveClaimId("REQ-2026-1234567")).toMatch(/^CLM-\d{4}-\d{6}$/);
  });

  it("strips the ccaas-desktop prefix from requested_by", () => {
    expect(agentIdFromPrefill(prefill)).toBe("csr-acarter");
  });

  it("interprets a claim id in the final message as a result", () => {
    const outcome = interpretFinalMessage("Claim CLM-2024-000123 has been filed.", prefill);
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") expect(outcome.claim_id).toBe("CLM-2024-000123");
  });

  it("interprets a known error code in the final message", () => {
    const outcome = interpretFinalMessage("I could not proceed: POLICY_NOT_FOUND", prefill);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error_code).toBe("POLICY_NOT_FOUND");
  });
});

describe("SimulationW365AProvider", () => {
  it("checks out a computer and records check-in", async () => {
    const provider = new SimulationW365AProvider({} as never);
    const { session, computer } = await provider.checkout();
    expect(session.sessionId).toMatch(/^sim-session-/);
    expect(computer).toBeInstanceOf(SimulatedCloudPcComputer);
    await provider.checkin(session);
    expect(provider.checkedIn).toContain(session.sessionId);
  });
});
