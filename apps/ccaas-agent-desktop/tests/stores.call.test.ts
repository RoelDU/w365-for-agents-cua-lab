import { describe, it, expect, beforeEach } from "vitest";
import { useCallStore } from "@/stores/useCallStore";

describe("useCallStore", () => {
  beforeEach(() => {
    useCallStore.getState().reset();
    useCallStore.setState({ scenarioKey: "jordan_smith" });
  });

  it("starts idle with the default scenario key", () => {
    const s = useCallStore.getState();
    expect(s.phase).toBe("idle");
    expect(s.scenarioKey).toBe("jordan_smith");
  });

  it("startRinging hydrates the scenario and seeds notes", () => {
    useCallStore.getState().startRinging();
    const s = useCallStore.getState();
    expect(s.phase).toBe("ringing");
    expect(s.scenario?.caller_phone).toBe("(555) 123-4567");
    expect(s.notes.length).toBeGreaterThan(0);
  });

  it("answerCall transitions to talking and starts the timer", () => {
    useCallStore.getState().startRinging();
    useCallStore.getState().answerCall(1000);
    expect(useCallStore.getState().phase).toBe("talking");
    expect(useCallStore.getState().startedAtMs).toBe(1000);
  });

  it("appendTranscriptLine consumes the next scripted line", () => {
    useCallStore.getState().startRinging();
    useCallStore.getState().answerCall();
    const line = useCallStore.getState().appendTranscriptLine();
    expect(line).not.toBeNull();
    expect(useCallStore.getState().transcript.length).toBe(1);
  });

  it("getTranscriptExcerpt returns formatted recent lines", () => {
    useCallStore.getState().startRinging();
    useCallStore.getState().answerCall();
    useCallStore.getState().appendTranscriptLine();
    useCallStore.getState().appendTranscriptLine();
    const excerpt = useCallStore.getState().getTranscriptExcerpt();
    expect(excerpt).toMatch(/^(System|Agent|Caller): /);
    expect(excerpt.split("\n").length).toBeGreaterThanOrEqual(1);
  });

  it("toggleHold / toggleMute flip the boolean flags", () => {
    useCallStore.getState().startRinging();
    useCallStore.getState().answerCall();
    useCallStore.getState().toggleHold();
    useCallStore.getState().toggleMute();
    expect(useCallStore.getState().isOnHold).toBe(true);
    expect(useCallStore.getState().isMuted).toBe(true);
  });

  it("endCall transitions to wrap_up", () => {
    useCallStore.getState().startRinging();
    useCallStore.getState().answerCall();
    useCallStore.getState().endCall();
    expect(useCallStore.getState().phase).toBe("wrap_up");
  });
});
