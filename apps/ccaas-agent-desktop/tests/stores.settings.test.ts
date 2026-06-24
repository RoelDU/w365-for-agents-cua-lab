import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "@/stores/useSettingsStore";

describe("useSettingsStore", () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it("defaults to CUA off, a non-empty orchestrator URL, and a positive typewriter speed", () => {
    const s = useSettingsStore.getState();
    expect(s.cuaMode).toBe(false);
    expect(s.orchestratorUrl.length).toBeGreaterThan(0);
    expect(s.typewriterCps).toBeGreaterThan(0);
  });

  it("setOrchestratorUrl persists the change", () => {
    useSettingsStore.getState().setOrchestratorUrl("https://example.local:4000");
    expect(useSettingsStore.getState().orchestratorUrl).toBe(
      "https://example.local:4000"
    );
  });

  it("setCuaMode toggles the demo's CUA-friendly behavior", () => {
    useSettingsStore.getState().setCuaMode(true);
    expect(useSettingsStore.getState().cuaMode).toBe(true);
  });

  it("setBackend switches the active orchestrator URL", () => {
    useSettingsStore.getState().setBackend("foundry");
    let s = useSettingsStore.getState();
    expect(s.backend).toBe("foundry");
    expect(s.orchestratorUrl).toBe("http://localhost:4000");

    useSettingsStore.getState().setBackend("mcs");
    s = useSettingsStore.getState();
    expect(s.backend).toBe("mcs");
    expect(s.orchestratorUrl).toBe("/api");
  });

  it("hydrateRegions populates regions and resolves the active Direct Line URL", () => {
    useSettingsStore.getState().hydrateRegions({
      activeRegionId: "au",
      regions: [
        { id: "au", label: "Australia East", directLineTokenUrl: "https://au/token" },
        { id: "us", label: "US Central", directLineTokenUrl: "https://us/token" }
      ]
    });
    const s = useSettingsStore.getState();
    expect(s.regions.map((r) => r.id)).toEqual(["au", "us"]);
    expect(s.activeRegionId).toBe("au");
    expect(s.directLineTokenUrl).toBe("https://au/token");
  });

  it("setActiveRegion switches the Direct Line URL and ignores unknown ids", () => {
    useSettingsStore.getState().hydrateRegions({
      activeRegionId: "au",
      regions: [
        { id: "au", label: "Australia East", directLineTokenUrl: "https://au/token" },
        { id: "us", label: "US Central", directLineTokenUrl: "https://us/token" }
      ]
    });
    useSettingsStore.getState().setActiveRegion("us");
    expect(useSettingsStore.getState().directLineTokenUrl).toBe("https://us/token");
    expect(useSettingsStore.getState().activeRegionId).toBe("us");

    // Unknown region id is a no-op.
    useSettingsStore.getState().setActiveRegion("zz");
    expect(useSettingsStore.getState().activeRegionId).toBe("us");
  });

  it("a region with its own orchestratorUrl switches the orchestrator too", () => {
    useSettingsStore.getState().hydrateRegions({
      activeRegionId: "au",
      regions: [
        {
          id: "au",
          label: "Australia East",
          directLineTokenUrl: "https://au/token",
          orchestratorUrl: "https://au-orch/api"
        }
      ]
    });
    expect(useSettingsStore.getState().orchestratorUrl).toBe("https://au-orch/api");
  });
});
