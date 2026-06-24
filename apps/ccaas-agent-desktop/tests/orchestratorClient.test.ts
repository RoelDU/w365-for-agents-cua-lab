import { describe, it, expect, vi } from "vitest";
import {
  postHandoff,
  getHandoffStatus,
  OrchestratorError,
  pingOrchestrator
} from "@/lib/orchestratorClient";

describe("orchestratorClient", () => {
  it("postHandoff returns the parsed payload on success", async () => {
    const payload = { request_id: "REQ-2024-0001", status: "queued" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status: 200 })
    );
    const res = await postHandoff("http://orchestrator.test", {
      request_id: "REQ-2024-0001",
      caller_phone: "(555) 123-4567",
      intent: "auto_collision",
      summary: "x",
      requested_by: { agent_id: "csr-x", display_name: "X" },
      timestamp: "2024-04-15T18:32:11Z"
    });
    expect(res.request_id).toBe("REQ-2024-0001");
    expect(res.status).toBe("queued");
  });

  it("postHandoff throws OrchestratorError on non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(
      postHandoff("http://orchestrator.test", {
        request_id: "REQ-2024-0001",
        caller_phone: "(555) 123-4567",
        intent: "auto_collision",
        summary: "x",
        requested_by: { agent_id: "csr-x", display_name: "X" },
        timestamp: "2024-04-15T18:32:11Z"
      })
    ).rejects.toBeInstanceOf(OrchestratorError);
  });

  it("postHandoff throws OrchestratorError on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(
      postHandoff("http://broken.test", {
        request_id: "REQ-2024-0001",
        caller_phone: "(555) 123-4567",
        intent: "auto_collision",
        summary: "x",
        requested_by: { agent_id: "csr-x", display_name: "X" },
        timestamp: "2024-04-15T18:32:11Z"
      })
    ).rejects.toBeInstanceOf(OrchestratorError);
  });

  it("postHandoff surfaces handoff_id from the 202 body", async () => {
    const payload = {
      request_id: "REQ-2024-0007",
      status: "queued",
      handoff_id: "handoff-abc123"
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status: 202 })
    );
    const res = await postHandoff("/api", {
      request_id: "REQ-2024-0007",
      caller_phone: "(555) 123-4567",
      intent: "auto_collision",
      summary: "x",
      requested_by: { agent_id: "csr-x", display_name: "X" },
      timestamp: "2024-04-15T18:32:11Z"
    });
    expect(res.handoff_id).toBe("handoff-abc123");
  });

  it("postHandoff surfaces the response body details on a 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Could not start the Foundry agent run" }), {
        status: 502
      })
    );
    await expect(
      postHandoff("/api", {
        request_id: "REQ-2024-0001",
        caller_phone: "(555) 123-4567",
        intent: "auto_collision",
        summary: "x",
        requested_by: { agent_id: "csr-x", display_name: "X" },
        timestamp: "2024-04-15T18:32:11Z"
      })
    ).rejects.toThrow(/Could not start the Foundry agent run/);
  });

  it("getHandoffStatus polls the handoff_id status path", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ request_id: "REQ-2024-0008", status: "ready" }), {
        status: 200
      })
    );
    await getHandoffStatus("/api", "handoff-abc123");
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toBe("/api/handoff/handoff-abc123/status");
  });

  it("getHandoffStatus url-encodes the handoff id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ request_id: "REQ-2024-0009", status: "queued" }), {
        status: 200
      })
    );
    await getHandoffStatus("/api", "handoff a/b");
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toBe("/api/handoff/handoff%20a%2Fb/status");
  });

  it("pingOrchestrator returns false on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("nope"));
    expect(await pingOrchestrator("http://broken.test", 50)).toBe(false);
  });
});
