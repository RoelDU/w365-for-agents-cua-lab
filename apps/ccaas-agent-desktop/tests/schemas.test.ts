import { describe, it, expect } from "vitest";
import { validators } from "@/lib/schemas";

describe("schema validation (Ajv)", () => {
  it("accepts a valid CallContext example", () => {
    const ok = validators.callContext({
      request_id: "REQ-2024-0042",
      caller_phone: "(555) 123-4567",
      policy_number: "POL-2024-008341",
      intent: "auto_collision",
      summary: "Rear-ended at intersection.",
      requested_by: { agent_id: "csr-acarter", display_name: "A. Carter" },
      timestamp: "2024-04-15T18:32:11Z"
    });
    expect(ok.ok).toBe(true);
  });

  it("rejects a CallContext with a malformed phone number", () => {
    const res = validators.callContext({
      request_id: "REQ-2024-0042",
      caller_phone: "555-123-4567",
      intent: "auto_collision",
      summary: "x",
      requested_by: { agent_id: "csr-x", display_name: "X" },
      timestamp: "2024-04-15T18:32:11Z"
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/caller_phone/);
  });

  it("rejects a CallContext with an unknown intent", () => {
    const res = validators.callContext({
      request_id: "REQ-2024-0042",
      caller_phone: "(555) 123-4567",
      intent: "auto_meteor",
      summary: "x",
      requested_by: { agent_id: "csr-x", display_name: "X" },
      timestamp: "2024-04-15T18:32:11Z"
    });
    expect(res.ok).toBe(false);
  });

  it("accepts a valid Prefill projection", () => {
    const res = validators.prefill({
      request_id: "REQ-2024-0042",
      caller_phone: "(555) 123-4567",
      policy_number: "POL-2024-008341",
      intent: "auto_collision",
      summary: "Rear-ended.",
      requested_by: "ccaas-desktop:csr-acarter"
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a Prefill that uses a structured requested_by object", () => {
    const res = validators.prefill({
      request_id: "REQ-2024-0042",
      caller_phone: "(555) 123-4567",
      intent: "auto_collision",
      summary: "Rear-ended.",
      requested_by: { agent_id: "csr-acarter", display_name: "A. Carter" }
    });
    expect(res.ok).toBe(false);
  });

  it("accepts a valid Ready message", () => {
    const res = validators.ready({
      request_id: "REQ-2024-0042",
      status: "ready",
      window_title: "Zava Mutual — Claims Workstation v1.0",
      matched_policy_number: "POL-2024-008341",
      matched_customer_name: "Jordan Smith",
      timestamp: "2024-04-15T18:32:34Z"
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a Ready message with the wrong status const", () => {
    const res = validators.ready({
      request_id: "REQ-2024-0042",
      status: "submitted",
      window_title: "x",
      timestamp: "2024-04-15T18:32:34Z"
    });
    expect(res.ok).toBe(false);
  });

  it("accepts a valid Result message", () => {
    const res = validators.result({
      request_id: "REQ-2024-0042",
      status: "submitted",
      claim_id: "CLM-2024-000123",
      policy_number: "POL-2024-008341",
      agent_id: "C1001",
      reserve_amount: 4200,
      timestamp: "2024-04-15T18:36:02Z"
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a Result message with a malformed claim_id", () => {
    const res = validators.result({
      request_id: "REQ-2024-0042",
      status: "submitted",
      claim_id: "claim-123",
      agent_id: "C1001",
      timestamp: "2024-04-15T18:36:02Z"
    });
    expect(res.ok).toBe(false);
  });

  it("accepts a valid Error message", () => {
    const res = validators.error({
      request_id: "REQ-2024-0042",
      status: "error",
      error_code: "POLICY_NOT_FOUND",
      message: "No matching policy.",
      timestamp: "2024-04-15T18:32:35Z"
    });
    expect(res.ok).toBe(true);
  });

  it("rejects an Error message with an unknown error_code", () => {
    const res = validators.error({
      request_id: "REQ-2024-0042",
      status: "error",
      error_code: "GREMLINS",
      message: "Bad.",
      timestamp: "2024-04-15T18:32:35Z"
    });
    expect(res.ok).toBe(false);
  });
});
