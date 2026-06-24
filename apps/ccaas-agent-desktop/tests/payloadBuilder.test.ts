import { describe, it, expect, beforeEach } from "vitest";
import {
  buildCallContext,
  generateRequestId,
  resetRequestIdCounter
} from "@/lib/payloadBuilder";
import { validators } from "@/lib/schemas";
import { HERO_SCENARIOS } from "@/mocks/heroScenarios";
import { SAMPLE_AGENT } from "./fixtures/agent";

describe("payloadBuilder", () => {
  beforeEach(() => {
    resetRequestIdCounter();
  });

  it("generates IDs matching the schema pattern", () => {
    const id = generateRequestId(new Date("2024-04-15T00:00:00Z"));
    expect(id).toMatch(/^REQ-\d{4}-\d{4,}$/);
    expect(id.startsWith("REQ-2024-")).toBe(true);
  });

  it("buildCallContext produces a CallContext that validates against the schema", () => {
    const scenario = HERO_SCENARIOS[0];
    const agent = SAMPLE_AGENT;
    const ctx = buildCallContext({
      scenario,
      agent,
      summary: scenario.summary_seed,
      transcriptExcerpt: "Caller: short excerpt"
    });
    const result = validators.callContext(ctx);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(ctx.caller_phone).toBe("(555) 123-4567");
    expect(ctx.intent).toBe("auto_collision");
    expect(ctx.requested_by.agent_id).toBe(agent.agent_id);
  });

  it("buildCallContext omits transcript_excerpt when none is provided (schema allows)", () => {
    const scenario = HERO_SCENARIOS[0];
    const agent = SAMPLE_AGENT;
    const ctx = buildCallContext({ scenario, agent, summary: scenario.summary_seed });
    expect(ctx.transcript_excerpt).toBeUndefined();
    expect(validators.callContext(ctx).ok).toBe(true);
  });

  it("buildCallContext truncates summary to 1000 characters", () => {
    const scenario = HERO_SCENARIOS[0];
    const agent = SAMPLE_AGENT;
    const longSummary = "x".repeat(1500);
    const ctx = buildCallContext({ scenario, agent, summary: longSummary });
    expect(ctx.summary.length).toBe(1000);
  });

  it("buildCallContext stamps the selected backend and still validates", () => {
    const scenario = HERO_SCENARIOS[0];
    const agent = SAMPLE_AGENT;
    const ctx = buildCallContext({ scenario, agent, summary: scenario.summary_seed, backend: "foundry" });
    expect(ctx.target_backend).toBe("foundry");
    expect(validators.callContext(ctx).ok).toBe(true);
  });

  it("buildCallContext omits target_backend when no backend is provided", () => {
    const scenario = HERO_SCENARIOS[0];
    const agent = SAMPLE_AGENT;
    const ctx = buildCallContext({ scenario, agent, summary: scenario.summary_seed });
    expect(ctx.target_backend).toBeUndefined();
    expect(validators.callContext(ctx).ok).toBe(true);
  });
});
