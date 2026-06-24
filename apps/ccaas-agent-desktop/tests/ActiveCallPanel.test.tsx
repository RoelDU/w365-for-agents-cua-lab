import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActiveCallPanel } from "@/components/workflow/ActiveCallPanel";
import { useCallStore } from "@/stores/useCallStore";

function renderPanel() {
  return render(
    <TooltipProvider>
      <ActiveCallPanel />
    </TooltipProvider>
  );
}

describe("<ActiveCallPanel> (smoke)", () => {
  beforeEach(() => {
    useCallStore.getState().reset();
    useCallStore.setState({ scenarioKey: "jordan_smith" });
  });

  it("shows the empty state when no call is active", () => {
    renderPanel();
    expect(screen.getByTestId("simulate-inbound-call")).toBeInTheDocument();
    expect(screen.getByTestId("scenario-picker")).toBeInTheDocument();
  });

  it("clicking Simulate Inbound Call transitions to ringing and shows caller info", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("simulate-inbound-call"));
    expect(useCallStore.getState().phase).toBe("ringing");
    expect(screen.getByTestId("caller-name").textContent).toBe("Jordan Smith");
    expect(screen.getByTestId("caller-phone").textContent).toBe("(555) 123-4567");
    expect(screen.getByTestId("answer-call")).toBeInTheDocument();
  });

  it("renders Hangup button when a call is in talking phase", () => {
    useCallStore.getState().startRinging();
    useCallStore.getState().answerCall();
    renderPanel();
    expect(screen.getByTestId("hangup-call")).toBeInTheDocument();
  });

  it("transcript region is present and has the live-region role", () => {
    useCallStore.getState().startRinging();
    useCallStore.getState().answerCall();
    renderPanel();
    expect(screen.getByTestId("transcript-stream")).toHaveAttribute(
      "aria-live",
      "polite"
    );
  });
});
