import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "@/App";
import { useAuthStore } from "@/stores/useAuthStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useCallStore } from "@/stores/useCallStore";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { SAMPLE_AGENT } from "./fixtures/agent";

// Verifies the "JSON vs rendered card" handover framing: the human agent sees a
// rendered context card, and the raw JSON wire contract is behind a developer
// disclosure. See docs/agentic-handover-mechanism.md.
describe("transfer-to-AI handover modal — context card + JSON disclosure", () => {
  beforeEach(() => {
    useAuthStore.setState({ agent: SAMPLE_AGENT });
    useSettingsStore.setState({
      orchestratorUrl: "http://broken.localhost",
      cuaMode: false,
      typewriterCps: 999
    });
    useCallStore.getState().reset();
    useHandoffStore.getState().reset();
  });

  it("renders the context card and exposes the JSON wire contract on demand", async () => {
    render(
      <MemoryRouter initialEntries={["/workspace"]}>
        <App />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTestId("simulate-inbound-call"));
    // Answer the call so the workspace reaches the "talking" phase where a
    // transfer to the AI agent is allowed.
    act(() => useCallStore.getState().answerCall());

    // Open the transfer directory from the call-toolbar Transfer control — the
    // AI agent is a routing destination here, alongside human queues.
    const transferBtn = await screen.findByTestId("transfer-call");
    await waitFor(() => expect(transferBtn).not.toBeDisabled());
    fireEvent.click(transferBtn);

    await screen.findByTestId("transfer-directory");
    const aiDestination = await screen.findByTestId("handoff-to-ai");
    expect(aiDestination).toHaveAccessibleName(/Transfer to AI Agent/i);
    expect(aiDestination).toHaveTextContent(/Claims Automation Agent/i);
    fireEvent.click(aiDestination);

    // Modal opens with the realistic transfer title and the rendered card.
    const modal = await screen.findByTestId("handoff-modal");
    expect(modal).toHaveTextContent(/Transfer to AI Agent/i);
    const card = screen.getByTestId("handoff-context-card");
    expect(card).toHaveTextContent(/Handover context/i);

    // JSON is hidden by default — never shown raw to the agent up front.
    expect(screen.queryByTestId("handoff-json")).toBeNull();

    // Developer discloses the wire payload.
    fireEvent.click(screen.getByTestId("handoff-json-toggle"));
    const json = await screen.findByTestId("handoff-json");
    const parsed = JSON.parse(json.textContent ?? "{}");
    expect(parsed.request_id).toMatch(/^REQ-\d{4}-\d{4,}$/);
    expect(parsed).toHaveProperty("caller_phone");
    expect(parsed).toHaveProperty("intent");
    expect(parsed).toHaveProperty("requested_by");

    // The request ID shown in the card matches the JSON wire payload.
    expect(card).toHaveTextContent(parsed.request_id);
  });
});
