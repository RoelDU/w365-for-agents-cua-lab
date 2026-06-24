import { describe, it, expect } from "vitest";
import { HandoffStore, isTerminal } from "../store";

const id = "REQ-2024-0042";

describe("HandoffStore monotonic transitions", () => {
  it("advances through prefilled -> ready -> submitted", () => {
    const s = new HandoffStore();
    expect(s.apply({ request_id: id, status: "prefilled" })?.status).toBe("prefilled");
    expect(s.apply({ request_id: id, status: "ready" })?.status).toBe("ready");
    expect(s.apply({ request_id: id, status: "submitted", claim_id: "CLM-2024-000123" })?.status).toBe(
      "submitted"
    );
  });

  it("does not regress a higher state to a lower one", () => {
    const s = new HandoffStore();
    s.apply({ request_id: id, status: "ready" });
    // A late prefilled must be rejected.
    expect(s.apply({ request_id: id, status: "prefilled" })).toBeUndefined();
    expect(s.get(id)?.status).toBe("ready");
  });

  it("never overwrites a terminal state with a late ready", () => {
    const s = new HandoffStore();
    s.apply({ request_id: id, status: "submitted", claim_id: "CLM-2024-000123" });
    expect(s.apply({ request_id: id, status: "ready" })).toBeUndefined();
    expect(s.get(id)?.status).toBe("submitted");
  });

  it("merges fields when advancing", () => {
    const s = new HandoffStore();
    s.apply({ request_id: id, status: "ready", window_title: "Zava" });
    s.apply({ request_id: id, status: "submitted", claim_id: "CLM-2024-000123" });
    const final = s.get(id);
    expect(final?.window_title).toBe("Zava");
    expect(final?.claim_id).toBe("CLM-2024-000123");
  });

  it("notifies subscribers on each accepted transition", () => {
    const s = new HandoffStore();
    const seen: string[] = [];
    s.subscribe(id, (p) => seen.push(p.status));
    s.apply({ request_id: id, status: "prefilled" });
    s.apply({ request_id: id, status: "ready" });
    s.apply({ request_id: id, status: "prefilled" }); // rejected, no notify
    expect(seen).toEqual(["prefilled", "ready"]);
  });
});

describe("HandoffStore single-flight", () => {
  it("reports the single non-terminal request id", () => {
    const s = new HandoffStore();
    s.apply({ request_id: id, status: "prefilled" });
    expect(s.activeRequestId()).toBe(id);
    expect(s.isActive(id)).toBe(true);
  });

  it("clears active once terminal", () => {
    const s = new HandoffStore();
    s.apply({ request_id: id, status: "submitted", claim_id: "CLM-2024-000123" });
    expect(s.activeRequestId()).toBeUndefined();
    expect(s.isActive(id)).toBe(false);
  });
});

describe("isTerminal", () => {
  it("treats submitted and error as terminal", () => {
    expect(isTerminal("submitted")).toBe(true);
    expect(isTerminal("error")).toBe(true);
    expect(isTerminal("ready")).toBe(false);
    expect(isTerminal("prefilled")).toBe(false);
  });
});
