import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getRegionConfig, tokenUrlForRegion, DEFAULT_REGION_ID } from "@/lib/regionConfig";

const AU = {
  id: "au",
  label: "Australia East",
  directLineTokenUrl: "https://au.example/directline/token"
};
const US = {
  id: "us",
  label: "US Central",
  directLineTokenUrl: "https://us.example/directline/token"
};

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      json: async () => body
    })) as unknown as typeof fetch
  );
}

describe("regionConfig.getRegionConfig", () => {
  beforeEach(() => {
    // jsdom provides window/location; clear any query string.
    window.history.replaceState({}, "", "/");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads regions and the declared active region from /region-config.json", async () => {
    mockFetchOnce({ activeRegion: "au", regions: [AU, US] });
    const cfg = await getRegionConfig();
    expect(cfg.regions.map((r) => r.id)).toEqual(["au", "us"]);
    expect(cfg.activeRegionId).toBe("au");
    expect(tokenUrlForRegion(cfg, "us")).toBe(US.directLineTokenUrl);
  });

  it("falls back to the first region when activeRegion is unknown", async () => {
    mockFetchOnce({ activeRegion: "zz", regions: [AU, US] });
    const cfg = await getRegionConfig();
    expect(cfg.activeRegionId).toBe("au");
  });

  it("drops malformed region entries (missing id or token url)", async () => {
    mockFetchOnce({
      activeRegion: "au",
      regions: [AU, { id: "broken" }, { directLineTokenUrl: "x" }, US]
    });
    const cfg = await getRegionConfig();
    expect(cfg.regions.map((r) => r.id)).toEqual(["au", "us"]);
  });

  it("honours a ?region= URL override when it matches a configured region", async () => {
    window.history.replaceState({}, "", "/?region=us");
    mockFetchOnce({ activeRegion: "au", regions: [AU, US] });
    const cfg = await getRegionConfig();
    expect(cfg.activeRegionId).toBe("us");
  });

  it("ignores a ?region= override that is not configured", async () => {
    window.history.replaceState({}, "", "/?region=zz");
    mockFetchOnce({ activeRegion: "au", regions: [AU, US] });
    const cfg = await getRegionConfig();
    expect(cfg.activeRegionId).toBe("au");
  });

  it("returns an empty region set when no config file and no build-time fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no file");
      }) as unknown as typeof fetch
    );
    const cfg = await getRegionConfig();
    // No VITE_DIRECTLINE_TOKEN_URL in the test env -> empty (orchestrator path).
    expect(cfg.regions).toEqual([]);
    expect(cfg.activeRegionId).toBe("");
  });
});

describe("regionConfig.tokenUrlForRegion", () => {
  it("returns the matching url or empty string", () => {
    const cfg = { regions: [AU, US], activeRegionId: "au" };
    expect(tokenUrlForRegion(cfg, "au")).toBe(AU.directLineTokenUrl);
    expect(tokenUrlForRegion(cfg, "nope")).toBe("");
  });

  it("exports a stable DEFAULT_REGION_ID for the build-time fallback", () => {
    expect(DEFAULT_REGION_ID).toBe("default");
  });
});
