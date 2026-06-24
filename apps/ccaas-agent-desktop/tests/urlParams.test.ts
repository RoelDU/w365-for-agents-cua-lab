import { describe, it, expect } from "vitest";
import { readUrlOverrides } from "@/lib/urlParams";

describe("readUrlOverrides", () => {
  it("returns sensible defaults when no params are given", () => {
    const r = readUrlOverrides("");
    expect(r.cua).toBe(false);
  });

  it("parses ?cua=true and ?cua=1", () => {
    expect(readUrlOverrides("?cua=true").cua).toBe(true);
    expect(readUrlOverrides("?cua=1").cua).toBe(true);
    expect(readUrlOverrides("?cua=false").cua).toBe(false);
  });
});
