import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "@/App";
import { orchestratorServer, resetMockOrchestrator } from "./mockOrchestrator";
import { useAuthStore } from "@/stores/useAuthStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useCallStore } from "@/stores/useCallStore";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { SAMPLE_AGENT } from "./fixtures/agent";

beforeAll(() => orchestratorServer.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  orchestratorServer.resetHandlers();
  resetMockOrchestrator();
});
afterAll(() => orchestratorServer.close());

function bootstrap() {
  useAuthStore.setState({ agent: SAMPLE_AGENT });
  useSettingsStore.setState({
    orchestratorUrl: "http://orchestrator.test",
    cuaMode: true,
    typewriterCps: 999
  });
  useCallStore.getState().reset();
  useHandoffStore.getState().reset();
  // Provide a fresh clipboard mock.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) }
  });
}

describe("handoff end-to-end (with mocked orchestrator)", () => {
  beforeEach(() => bootstrap());

  it("submits handoff via webhook, transitions to submitted, copies claim ID", async () => {
    vi.useFakeTimers();
    render(
      <MemoryRouter initialEntries={["/workspace?cua=true"]}>
        <App />
      </MemoryRouter>
    );

    // Simulate an inbound call.
    fireEvent.click(screen.getByTestId("simulate-inbound-call"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // Trigger the handoff via Ctrl+Shift+H to also exercise the keyboard
    // shortcut path.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "H", ctrlKey: true, shiftKey: true })
      );
    });

    // CUA mode auto-confirms the modal after 1 second.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    // Let the network promise resolve.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Now drive polling to walk the state machine.
    for (let i = 0; i < 12; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      if (useHandoffStore.getState().status === "submitted") break;
    }

    vi.useRealTimers();

    await waitFor(
      () => expect(useHandoffStore.getState().status).toBe("submitted"),
      { timeout: 2000 }
    );
    expect(useHandoffStore.getState().claimId).toBe("CLM-2024-000777");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("CLM-2024-000777");
  });
});
