import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LoginScreen } from "@/components/workflow/LoginScreen";

// The Microsoft sign-in helper navigates the window to Entra via a redirect, so
// it is mocked here. We only assert the screen wires the button to it.
const signInWithMicrosoft = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/msalLogin", () => ({
  signInWithMicrosoft: () => signInWithMicrosoft()
}));

describe("<LoginScreen> (Entra-only)", () => {
  beforeEach(() => {
    signInWithMicrosoft.mockClear();
  });

  it("renders the Microsoft Entra sign-in button, enabled", () => {
    render(
      <MemoryRouter>
        <LoginScreen />
      </MemoryRouter>
    );
    const btn = screen.getByTestId("entra-signin");
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
    expect(btn.textContent).toMatch(/Sign in with Microsoft/i);
  });

  it("does not render any agent picker", () => {
    render(
      <MemoryRouter>
        <LoginScreen />
      </MemoryRouter>
    );
    expect(screen.queryByTestId("agent-picker")).not.toBeInTheDocument();
  });

  it("clicking the button invokes signInWithMicrosoft", async () => {
    render(
      <MemoryRouter>
        <LoginScreen />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByTestId("entra-signin"));
    await waitFor(() => expect(signInWithMicrosoft).toHaveBeenCalledTimes(1));
  });
});
