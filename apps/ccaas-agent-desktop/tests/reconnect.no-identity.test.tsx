import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "@/App";
import { useAuthStore } from "@/stores/useAuthStore";
import { useCallStore } from "@/stores/useCallStore";
import { resetTransferRecorderForTests, saveCallForReconnect } from "@/lib/handoffRecovery";

// The page load after Microsoft's redirect when no account came back (mocked MSAL, not live proof).
const outcome = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/msalLogin", () => ({
  completeRedirectSignIn: vi.fn(async () => null),
  getSignedInAccount: vi.fn(async () => null),
  takeRedirectOutcome: vi.fn(() => outcome.value),
  acquireHandoffAccessToken: vi.fn(async () => "t"),
  signInWithMicrosoft: vi.fn(async () => undefined)
}));

describe("E2: returning from Microsoft without an account", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.setState({ agent: null });
    useCallStore.getState().reset();
    resetTransferRecorderForTests();
  });

  it("shows the failed redirect on the login screen and keeps the saved call for its owner", async () => {
    useCallStore.getState().startRinging();
    useCallStore.getState().answerCall();
    saveCallForReconnect({
      account: null,
      owner: { agent_id: "entra-oid-1", username: "tu1@contoso.example" },
      stage: "start",
      request_id: "REQ-2026-111122223333"
    });
    useCallStore.getState().reset();
    outcome.value = { error: { code: "access_denied", message: "AADSTS65004: User declined to consent." } };

    render(<MemoryRouter initialEntries={["/login"]}><App /></MemoryRouter>);

    const problem = await screen.findByTestId("login-auth-diagnostic");
    expect(problem).toHaveTextContent("AADSTS65004");
    expect(problem).toHaveTextContent("sign in as tu1@contoso.example");
    expect(problem).toHaveTextContent("REQ-2026-111122223333");
    expect(screen.getByTestId("entra-signin")).not.toBeDisabled();
    expect(sessionStorage.getItem("ccaas:reconnect-call")).not.toBeNull();
    expect(useCallStore.getState().phase).toBe("idle");
    expect(useAuthStore.getState().agent).toBeNull();
  });

  it("shows a failed plain sign-in on the login screen", async () => {
    outcome.value = { error: { code: "user_cancelled", message: "User cancelled the flow." } };
    render(<MemoryRouter initialEntries={["/login"]}><App /></MemoryRouter>);
    expect(await screen.findByTestId("login-auth-diagnostic")).toHaveTextContent("User cancelled the flow.");
  });
});
