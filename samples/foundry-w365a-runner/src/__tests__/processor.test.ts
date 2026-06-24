import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config";
import { HandoffProcessor } from "../processor";
import { SimulationAgentDriver } from "../runner";
import { validateReady, validateResult } from "../schemas";
import type { Prefill } from "../types";

const prefill: Prefill = {
  request_id: "REQ-2024-0042",
  caller_phone: "(555) 123-4567",
  policy_number: "POL-2024-008341",
  intent: "auto_collision",
  summary: "Rear-ended at 5th and Main, no injuries.",
  requested_by: "ccaas-desktop:csr-acarter"
};

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "w365a-runner-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("HandoffProcessor (simulation)", () => {
  it("captures a prefill and relays a schema-valid ready + result", async () => {
    const config = loadConfig({ HANDOFF_DIR: dir, RUNNER_MODE: "simulation" });
    await fs.mkdir(config.outDir, { recursive: true });
    const processor = new HandoffProcessor(config, new SimulationAgentDriver());

    await processor.process(prefill);

    const ready = JSON.parse(await fs.readFile(config.readyPath, "utf8"));
    expect(validateReady(ready)).toBe(true);
    expect(ready.request_id).toBe(prefill.request_id);

    const result = JSON.parse(await fs.readFile(config.resultPath, "utf8"));
    expect(validateResult(result)).toBe(true);
    expect(result.claim_id).toBe("CLM-2024-000042");
    expect(result.agent_id).toBe("csr-acarter");
    expect(result.policy_number).toBe(prefill.policy_number);
  });

  it("ignores a duplicate request_id after it has completed", async () => {
    const config = loadConfig({ HANDOFF_DIR: dir, RUNNER_MODE: "simulation" });
    await fs.mkdir(config.outDir, { recursive: true });
    const processor = new HandoffProcessor(config, new SimulationAgentDriver());

    await processor.process(prefill);
    await fs.rm(config.resultPath, { force: true });
    await processor.process(prefill); // same id -> should be skipped

    await expect(fs.access(config.resultPath)).rejects.toBeTruthy();
  });

  it("ignores a prefill addressed to another backend (no CUA, no out files)", async () => {
    // Default backendId is "foundry"; a handoff the presenter routed to MCS must be skipped.
    const config = loadConfig({ HANDOFF_DIR: dir, RUNNER_MODE: "simulation" });
    await fs.mkdir(config.outDir, { recursive: true });
    const processor = new HandoffProcessor(config, new SimulationAgentDriver());

    await processor.process({ ...prefill, target_backend: "mcs" });

    await expect(fs.access(config.readyPath)).rejects.toBeTruthy();
    await expect(fs.access(config.resultPath)).rejects.toBeTruthy();
    await expect(fs.access(config.errorPath)).rejects.toBeTruthy();
  });

  it("acts on a prefill addressed to its own backend id", async () => {
    const config = loadConfig({ HANDOFF_DIR: dir, RUNNER_MODE: "simulation", RUNNER_BACKEND_ID: "foundry" });
    await fs.mkdir(config.outDir, { recursive: true });
    const processor = new HandoffProcessor(config, new SimulationAgentDriver());

    await processor.process({ ...prefill, target_backend: "foundry" });

    const result = JSON.parse(await fs.readFile(config.resultPath, "utf8"));
    expect(validateResult(result)).toBe(true);
  });
});
