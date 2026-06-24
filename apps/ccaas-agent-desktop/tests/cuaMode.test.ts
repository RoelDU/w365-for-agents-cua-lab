import { describe, it, expect } from "vitest";
import { readUrlOverrides } from "@/lib/urlParams";
import { useSettingsStore } from "@/stores/useSettingsStore";

describe("?cua=true (CUA-friendly mode)", () => {
  it("URL override toggles CUA mode in the settings store", () => {
    useSettingsStore.setState({ cuaMode: false });
    const overrides = readUrlOverrides("?cua=true");
    expect(overrides.cua).toBe(true);
    if (overrides.cua) useSettingsStore.getState().setCuaMode(true);
    expect(useSettingsStore.getState().cuaMode).toBe(true);
  });

  it("does not enable CUA mode without the URL parameter", () => {
    useSettingsStore.setState({ cuaMode: false });
    const overrides = readUrlOverrides("?other=1");
    expect(overrides.cua).toBe(false);
    expect(useSettingsStore.getState().cuaMode).toBe(false);
  });
});
