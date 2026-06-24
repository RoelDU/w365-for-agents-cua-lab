import { describe, it, expect } from "vitest";
import { formatMmSs, formatHhMmSs, intentLabel, dispositionLabel, auxDotClass } from "@/lib/format";

describe("format helpers", () => {
  it("formatMmSs pads minutes and seconds", () => {
    expect(formatMmSs(0)).toBe("00:00");
    expect(formatMmSs(75)).toBe("01:15");
    expect(formatMmSs(3599)).toBe("59:59");
  });

  it("formatHhMmSs pads hours too", () => {
    expect(formatHhMmSs(3661)).toBe("01:01:01");
  });

  it("intentLabel humanizes snake_case", () => {
    expect(intentLabel("auto_collision")).toBe("Auto Collision");
    expect(intentLabel("fraud_investigation")).toBe("Fraud Investigation");
  });

  it("dispositionLabel matches the spec labels", () => {
    expect(dispositionLabel("escalated_ai")).toBe("Escalated to AI Agent");
    expect(dispositionLabel("callback")).toBe("Callback Scheduled");
  });

  it("auxDotClass returns sensible colors", () => {
    expect(auxDotClass("available")).toContain("ok");
    expect(auxDotClass("tech_issue")).toContain("danger");
    expect(auxDotClass("unknown")).toContain("muted");
  });
});
