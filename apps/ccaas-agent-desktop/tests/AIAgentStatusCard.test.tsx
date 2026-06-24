import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AIAgentStatusCard } from "@/components/workflow/AIAgentStatusCard";
import { useHandoffStore } from "@/stores/useHandoffStore";
import type { CallContext } from "@/types/contracts";

const ctx: CallContext = {
  request_id: "REQ-2024-0500",
  caller_phone: "(555) 123-4567",
  policy_number: "POL-2024-008341",
  intent: "auto_collision",
  summary: "Rear-ended at intersection.",
  requested_by: { agent_id: "csr-acarter", display_name: "A. Carter" },
  timestamp: "2024-04-15T18:32:11Z"
};

describe("<AIAgentStatusCard> (smoke)", () => {
  beforeEach(() => {
    useHandoffStore.getState().reset();
  });

  it("renders the queued copy when a handoff has just started", () => {
    useHandoffStore.getState().beginHandoff(ctx, { handoffId: "handoff-1" });
    render(
      <TooltipProvider>
        <AIAgentStatusCard onReset={() => undefined} />
      </TooltipProvider>
    );
    expect(screen.getByTestId("ai-status-badge").textContent).toMatch(/queued/i);
    expect(screen.getByTestId("ai-status-copy").textContent).toMatch(/Waiting/i);
    expect(screen.getByTestId("ai-status-request-id").textContent).toBe(
      ctx.request_id
    );
  });

  it("renders the claim ID prominently when status reaches 'submitted'", () => {
    useHandoffStore.getState().beginHandoff(ctx, { handoffId: "handoff-1" });
    useHandoffStore.getState().applyStatus({
      request_id: ctx.request_id,
      status: "submitted",
      claim_id: "CLM-2024-000123",
      policy_number: "POL-2024-008341",
      agent_id: "C1001",
      reserve_amount: 4200
    });
    render(
      <TooltipProvider>
        <AIAgentStatusCard onReset={() => undefined} />
      </TooltipProvider>
    );
    const el = screen.getByTestId("ai-status-claim-id");
    expect(el.textContent).toBe("CLM-2024-000123");
    expect(screen.getByTestId("ai-status-policy").textContent).toBe(
      "POL-2024-008341"
    );
  });

  it("renders the error state when the orchestrator returns an error", () => {
    useHandoffStore.getState().beginHandoff(ctx, { handoffId: "handoff-1" });
    useHandoffStore.getState().setError("POLICY_NOT_FOUND", "No matching policy found.");
    render(
      <TooltipProvider>
        <AIAgentStatusCard onReset={() => undefined} />
      </TooltipProvider>
    );
    expect(screen.getByText("POLICY_NOT_FOUND")).toBeInTheDocument();
    expect(screen.getByTestId("handoff-retry")).toBeInTheDocument();
    expect(screen.getByTestId("handoff-fallback")).toBeInTheDocument();
  });
});
