import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { subscribeToStatus } from "@/lib/statusPolling";
import type { HandoffStatusPayload } from "@/types/contracts";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body
  } as unknown as Response;
}

describe("subscribeToStatus (polling-only)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("polls the handoff_id status path", async () => {
    const payload: HandoffStatusPayload = { request_id: "REQ-2024-0001", status: "queued" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal("fetch", fetchMock);

    const onUpdate = vi.fn();
    const sub = subscribeToStatus({
      baseUrl: "/api",
      handoffId: "handoff-abc",
      pollIntervalMs: 100,
      onUpdate
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toBe("/api/handoff/handoff-abc/status");
    expect(onUpdate).toHaveBeenCalledWith(payload);

    sub.stop();
  });

  it("keeps polling on non-terminal statuses until a terminal status, then stops", async () => {
    const responses: HandoffStatusPayload[] = [
      { request_id: "REQ-2024-0002", status: "queued" },
      { request_id: "REQ-2024-0002", status: "ready" },
      { request_id: "REQ-2024-0002", status: "submitted", claim_id: "CLM-2024-000123" }
    ];
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(responses[call++]));
    vi.stubGlobal("fetch", fetchMock);

    const onUpdate = vi.fn();
    subscribeToStatus({
      baseUrl: "/api",
      handoffId: "handoff-2",
      pollIntervalMs: 100,
      onUpdate
    });

    // First poll (queued), then two interval-driven polls (ready, submitted).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(onUpdate).toHaveBeenCalledTimes(3);
    expect(onUpdate).toHaveBeenLastCalledWith(responses[2]);

    // No further polling after the terminal status.
    const callsAfterTerminal = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock.mock.calls.length).toBe(callsAfterTerminal);
  });

  it("reports poll errors via onError without stopping the subscription", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const onError = vi.fn();
    const sub = subscribeToStatus({
      baseUrl: "/api",
      handoffId: "handoff-3",
      pollIntervalMs: 100,
      onUpdate: vi.fn(),
      onError
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    // Still scheduled to retry.
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledTimes(2);

    sub.stop();
  });
});
