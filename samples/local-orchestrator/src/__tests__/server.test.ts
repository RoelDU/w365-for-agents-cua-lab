import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import request from "supertest";
import { makeHarness, writeOut, waitFor, sampleCallContext, type Harness } from "./harness";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe("GET /health", () => {
  it("reports ok and the handoff dir", async () => {
    harness = await makeHarness();
    const res = await request(harness.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.handoff_dir).toBe(harness.config.handoffDir);
    expect(res.body.listening_since).toBeDefined();
  });
});

describe("POST /handoff", () => {
  it("rejects an invalid CallContext with 400", async () => {
    harness = await makeHarness();
    const res = await request(harness.app)
      .post("/handoff")
      .send({ request_id: "nope", caller_phone: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid CallContext/);
  });

  it("accepts a valid CallContext, writes prefill.json, and returns prefilled", async () => {
    harness = await makeHarness();
    const res = await request(harness.app).post("/handoff").send(sampleCallContext);
    expect(res.status).toBe(202);
    expect(res.body.request_id).toBe(sampleCallContext.request_id);
    expect(res.body.handoff_id).toBe(sampleCallContext.request_id);
    expect(res.body.status).toBe("prefilled");
    expect(res.body.status_url).toContain(sampleCallContext.request_id);

    const written = JSON.parse(await fs.readFile(harness.config.prefillPath, "utf8"));
    expect(written.requested_by).toBe("ccaas-desktop:csr-acarter");
    expect(written).not.toHaveProperty("transcript_excerpt");

    const status = await request(harness.app).get(
      `/handoff/${sampleCallContext.request_id}/status`
    );
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("prefilled");
  });

  it("returns 409 when a different handoff is already in flight", async () => {
    harness = await makeHarness();
    await request(harness.app).post("/handoff").send(sampleCallContext);
    const second = { ...sampleCallContext, request_id: "REQ-2024-0099" };
    const res = await request(harness.app).post("/handoff").send(second);
    expect(res.status).toBe(409);
    expect(res.body.active_request_id).toBe(sampleCallContext.request_id);
  });

  it("allows re-posting the same request id (idempotent)", async () => {
    harness = await makeHarness();
    await request(harness.app).post("/handoff").send(sampleCallContext);
    const res = await request(harness.app).post("/handoff").send(sampleCallContext);
    expect(res.status).toBe(202);
  });
});

describe("GET /handoff/:id/status", () => {
  it("returns 404 for an unknown request id", async () => {
    harness = await makeHarness();
    const res = await request(harness.app).get("/handoff/REQ-2024-7777/status");
    expect(res.status).toBe(404);
  });
});

describe("end-to-end watcher relay", () => {
  it("flips status to ready then submitted as the legacy app writes out files", async () => {
    harness = await makeHarness();
    const { app, config, store } = harness;

    await request(app).post("/handoff").send(sampleCallContext);

    await writeOut(config, "ready", {
      request_id: sampleCallContext.request_id,
      status: "ready",
      window_title: "Zava Mutual - Claims Workstation v1.0",
      matched_policy_number: "POL-2024-008341",
      matched_customer_name: "Jordan Smith",
      timestamp: new Date().toISOString()
    });
    await waitFor(() => store.get(sampleCallContext.request_id)?.status === "ready");

    await writeOut(config, "result", {
      request_id: sampleCallContext.request_id,
      status: "submitted",
      claim_id: "CLM-2024-000123",
      policy_number: "POL-2024-008341",
      agent_id: "C1001",
      reserve_amount: 4200,
      timestamp: new Date().toISOString()
    });
    await waitFor(() => store.get(sampleCallContext.request_id)?.status === "submitted");

    const status = await request(app).get(`/handoff/${sampleCallContext.request_id}/status`);
    expect(status.body.status).toBe("submitted");
    expect(status.body.claim_id).toBe("CLM-2024-000123");
    expect(status.body.reserve_amount).toBe(4200);
  });

  it("relays an error file as an error status", async () => {
    harness = await makeHarness();
    const { app, config, store } = harness;
    await request(app).post("/handoff").send(sampleCallContext);

    await writeOut(config, "error", {
      request_id: sampleCallContext.request_id,
      status: "error",
      error_code: "POLICY_NOT_FOUND",
      message: "No matching policy found.",
      timestamp: new Date().toISOString()
    });
    await waitFor(() => store.get(sampleCallContext.request_id)?.status === "error");

    const status = await request(app).get(`/handoff/${sampleCallContext.request_id}/status`);
    expect(status.body.status).toBe("error");
    expect(status.body.error_code).toBe("POLICY_NOT_FOUND");
  });

  it("does not regress to ready if result arrives first", async () => {
    harness = await makeHarness();
    const { app, config, store } = harness;
    await request(app).post("/handoff").send(sampleCallContext);

    await writeOut(config, "result", {
      request_id: sampleCallContext.request_id,
      status: "submitted",
      claim_id: "CLM-2024-000123",
      agent_id: "C1001",
      timestamp: new Date().toISOString()
    });
    await waitFor(() => store.get(sampleCallContext.request_id)?.status === "submitted");

    await writeOut(config, "ready", {
      request_id: sampleCallContext.request_id,
      status: "ready",
      window_title: "Zava",
      timestamp: new Date().toISOString()
    });
    // Give the watcher a moment; status must remain submitted.
    await new Promise((r) => setTimeout(r, 300));
    expect(store.get(sampleCallContext.request_id)?.status).toBe("submitted");
  });
});
