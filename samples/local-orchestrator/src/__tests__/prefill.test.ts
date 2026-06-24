import { describe, it, expect } from "vitest";
import { derivePrefill } from "../handoff";
import { validateCallContext, validatePrefill } from "../schemas";
import { sampleCallContext } from "./harness";
import type { CallContext } from "../types";

describe("derivePrefill", () => {
  it("projects a CallContext into a schema-valid Prefill", () => {
    const ctx = sampleCallContext as unknown as CallContext;
    expect(validateCallContext(ctx)).toBe(true);

    const prefill = derivePrefill(ctx);
    expect(validatePrefill(prefill)).toBe(true);
    expect(prefill.requested_by).toBe("ccaas-desktop:csr-acarter");
    expect(prefill.request_id).toBe(ctx.request_id);
    expect(prefill.caller_phone).toBe(ctx.caller_phone);
    expect(prefill.policy_number).toBe(ctx.policy_number);
    expect(prefill.intent).toBe(ctx.intent);
    expect(prefill.summary).toBe(ctx.summary);
  });

  it("drops transcript_excerpt and the structured requested_by/timestamp", () => {
    const prefill = derivePrefill(sampleCallContext as unknown as CallContext);
    expect(prefill).not.toHaveProperty("transcript_excerpt");
    expect(prefill).not.toHaveProperty("timestamp");
    expect(typeof prefill.requested_by).toBe("string");
  });

  it("normalizes a missing policy_number to null", () => {
    const ctx = { ...sampleCallContext, policy_number: undefined } as unknown as CallContext;
    const prefill = derivePrefill(ctx);
    expect(prefill.policy_number).toBeNull();
    expect(validatePrefill(prefill)).toBe(true);
  });

  it("carries target_backend through to the prefill so the runner can self-filter", () => {
    const ctx = { ...sampleCallContext, target_backend: "foundry" } as unknown as CallContext;
    expect(validateCallContext(ctx)).toBe(true);
    const prefill = derivePrefill(ctx);
    expect(prefill.target_backend).toBe("foundry");
    expect(validatePrefill(prefill)).toBe(true);
  });

  it("omits target_backend when the CallContext does not set one (legacy)", () => {
    const prefill = derivePrefill(sampleCallContext as unknown as CallContext);
    expect(prefill).not.toHaveProperty("target_backend");
  });
});

describe("schema validation", () => {
  it("rejects a CallContext with a bad request_id", () => {
    const bad = { ...sampleCallContext, request_id: "REQ-bad" };
    expect(validateCallContext(bad)).toBe(false);
  });

  it("rejects a CallContext with a bad phone format", () => {
    const bad = { ...sampleCallContext, caller_phone: "5551234567" };
    expect(validateCallContext(bad)).toBe(false);
  });

  it("rejects an unknown intent", () => {
    const bad = { ...sampleCallContext, intent: "spaceship_crash" };
    expect(validateCallContext(bad)).toBe(false);
  });
});
