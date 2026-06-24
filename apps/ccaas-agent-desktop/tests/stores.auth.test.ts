import { describe, it, expect, beforeEach } from "vitest";
import { useAuthStore } from "@/stores/useAuthStore";
import { SAMPLE_AGENT, SAMPLE_AGENT_2 } from "./fixtures/agent";

describe("useAuthStore", () => {
  beforeEach(() => {
    useAuthStore.setState({ agent: null });
  });

  it("starts unauthenticated (no agent)", () => {
    const s = useAuthStore.getState();
    expect(s.agent).toBeNull();
  });

  it("setAgent makes the user 'signed in'", () => {
    useAuthStore.getState().setAgent(SAMPLE_AGENT);
    expect(useAuthStore.getState().agent?.agent_id).toBe(SAMPLE_AGENT.agent_id);
  });

  it("signOut clears the agent", () => {
    useAuthStore.getState().setAgent(SAMPLE_AGENT_2);
    useAuthStore.getState().signOut();
    expect(useAuthStore.getState().agent).toBeNull();
  });
});
