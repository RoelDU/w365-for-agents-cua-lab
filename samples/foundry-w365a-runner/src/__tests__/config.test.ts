import { describe, it, expect } from "vitest";
import { loadConfig, validateForLive } from "../config";

describe("config", () => {
  it("defaults to simulation mode", () => {
    const c = loadConfig({});
    expect(c.mode).toBe("simulation");
  });

  it("selects live mode case-insensitively", () => {
    expect(loadConfig({ RUNNER_MODE: "LIVE" }).mode).toBe("live");
    expect(loadConfig({ RUNNER_MODE: "Simulation" }).mode).toBe("simulation");
  });

  it("derives in/out paths under the handoff dir", () => {
    const c = loadConfig({ HANDOFF_DIR: process.platform === "win32" ? "C:\\tmp\\h" : "/tmp/h" });
    expect(c.prefillPath.endsWith("prefill.json")).toBe(true);
    expect(c.readyPath.endsWith("ready.json")).toBe(true);
    expect(c.resultPath.endsWith("result.json")).toBe(true);
    expect(c.errorPath.endsWith("error.json")).toBe(true);
  });

  it("trims trailing slashes off endpoints", () => {
    const c = loadConfig({ FOUNDRY_ENDPOINT: "https://x.openai.azure.com/", W365A_BASE_URL: "https://pool/" });
    expect(c.foundry.endpoint).toBe("https://x.openai.azure.com");
    expect(c.w365a.baseUrl).toBe("https://pool");
  });

  it("reports missing live configuration", () => {
    const problems = validateForLive(loadConfig({ RUNNER_MODE: "live" }));
    expect(problems.length).toBeGreaterThan(0);
    const ok = validateForLive(
      loadConfig({
        RUNNER_MODE: "live",
        FOUNDRY_ENDPOINT: "https://x.openai.azure.com",
        FOUNDRY_MODEL: "computer-use-preview",
        W365A_BASE_URL: "https://pool",
        W365A_POOL_ID: "pool-1"
      })
    );
    expect(ok).toEqual([]);
  });
});
