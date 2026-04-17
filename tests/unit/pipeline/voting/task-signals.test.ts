import { describe, it, expect } from "vitest";
import {
  collectSignals,
  hasSignal,
  getSignal,
  mergeSignalBags,
  KNOWN_SIGNALS,
} from "../../../../server/pipeline/voting/task-signals.js";
import type { TaskSignal, TaskSignalBag } from "@shared/types";

// ─── collectSignals ───────────────────────────────────────────────────────────

describe("collectSignals", () => {
  it("returns empty bag when nothing is provided", () => {
    const bag = collectSignals({});
    expect(bag.signals).toHaveLength(0);
  });

  it("converts tags to plain signals with source=tag", () => {
    const bag = collectSignals({ tags: ["alpha", "beta"] });
    expect(bag.signals).toHaveLength(2);
    expect(bag.signals[0]).toMatchObject({ key: "alpha", source: "tag" });
    expect(bag.signals[1]).toMatchObject({ key: "beta", source: "tag" });
  });

  it("maps risk_level=high to signal:high_risk", () => {
    const bag = collectSignals({ riskLevel: "high" });
    const sig = bag.signals.find((s) => s.key === KNOWN_SIGNALS.HIGH_RISK);
    expect(sig).toBeDefined();
    expect(sig?.source).toBe("risk_level");
    expect(sig?.value).toBe("high");
  });

  it("maps risk_level=critical to signal:high_risk", () => {
    const bag = collectSignals({ riskLevel: "critical" });
    const sig = bag.signals.find((s) => s.key === KNOWN_SIGNALS.HIGH_RISK);
    expect(sig).toBeDefined();
    expect(sig?.value).toBe("critical");
  });

  it("maps risk_level=low to signal:low_stakes", () => {
    const bag = collectSignals({ riskLevel: "low" });
    const sig = bag.signals.find((s) => s.key === KNOWN_SIGNALS.LOW_STAKES);
    expect(sig).toBeDefined();
    expect(sig?.source).toBe("risk_level");
  });

  it("does not emit a signal for risk_level=medium", () => {
    const bag = collectSignals({ riskLevel: "medium" });
    expect(bag.signals).toHaveLength(0);
  });

  it("includes upstream signals with their original source", () => {
    const upstream: TaskSignal[] = [
      { key: "signal:high_risk", source: "upstream_stage" },
    ];
    const bag = collectSignals({ upstreamSignals: upstream });
    expect(bag.signals).toHaveLength(1);
    expect(bag.signals[0]).toMatchObject({ key: "signal:high_risk", source: "upstream_stage" });
  });

  it("deduplicates signals by key — first occurrence wins", () => {
    const bag = collectSignals({
      tags: ["signal:high_risk"],
      upstreamSignals: [{ key: "signal:high_risk", source: "upstream_stage" }],
    });
    // Only one signal:high_risk, from the tag (first seen)
    const all = bag.signals.filter((s) => s.key === "signal:high_risk");
    expect(all).toHaveLength(1);
    expect(all[0].source).toBe("tag");
  });

  it("combines tags + riskLevel + upstream without duplication", () => {
    const bag = collectSignals({
      tags: ["important"],
      riskLevel: "high",
      upstreamSignals: [{ key: "signal:low_stakes", source: "upstream_stage" }],
    });
    // important (tag) + signal:high_risk (riskLevel) + signal:low_stakes (upstream)
    expect(bag.signals).toHaveLength(3);
  });
});

// ─── hasSignal ────────────────────────────────────────────────────────────────

describe("hasSignal", () => {
  const bag: TaskSignalBag = {
    signals: [
      { key: "signal:high_risk", source: "tag" },
      { key: "custom-tag", source: "tag" },
    ],
  };

  it("returns true when the signal key is present", () => {
    expect(hasSignal(bag, "signal:high_risk")).toBe(true);
  });

  it("returns false when the signal key is not present", () => {
    expect(hasSignal(bag, "signal:low_stakes")).toBe(false);
  });

  it("returns false for empty bag", () => {
    expect(hasSignal({ signals: [] }, "any")).toBe(false);
  });
});

// ─── getSignal ────────────────────────────────────────────────────────────────

describe("getSignal", () => {
  const bag: TaskSignalBag = {
    signals: [
      { key: "signal:high_risk", source: "risk_level", value: "critical" },
    ],
  };

  it("returns the matching signal", () => {
    const sig = getSignal(bag, "signal:high_risk");
    expect(sig).toBeDefined();
    expect(sig?.value).toBe("critical");
  });

  it("returns undefined when not found", () => {
    expect(getSignal(bag, "signal:missing")).toBeUndefined();
  });
});

// ─── mergeSignalBags ──────────────────────────────────────────────────────────

describe("mergeSignalBags", () => {
  it("merges two disjoint bags", () => {
    const left: TaskSignalBag = { signals: [{ key: "a", source: "tag" }] };
    const right: TaskSignalBag = { signals: [{ key: "b", source: "tag" }] };
    const merged = mergeSignalBags(left, right);
    expect(merged.signals).toHaveLength(2);
  });

  it("left wins on duplicate keys", () => {
    const left: TaskSignalBag = { signals: [{ key: "x", source: "risk_level", value: "left" }] };
    const right: TaskSignalBag = { signals: [{ key: "x", source: "tag", value: "right" }] };
    const merged = mergeSignalBags(left, right);
    expect(merged.signals).toHaveLength(1);
    expect(merged.signals[0].value).toBe("left");
  });

  it("returns copy of left when right is empty", () => {
    const left: TaskSignalBag = { signals: [{ key: "a", source: "tag" }] };
    const merged = mergeSignalBags(left, { signals: [] });
    expect(merged.signals).toHaveLength(1);
    expect(merged.signals[0].key).toBe("a");
  });

  it("returns copy of right when left is empty", () => {
    const right: TaskSignalBag = { signals: [{ key: "b", source: "tag" }] };
    const merged = mergeSignalBags({ signals: [] }, right);
    expect(merged.signals).toHaveLength(1);
    expect(merged.signals[0].key).toBe("b");
  });
});
