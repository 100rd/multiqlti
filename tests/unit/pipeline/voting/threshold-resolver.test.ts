import { describe, it, expect } from "vitest";
import { resolveThreshold } from "../../../../server/pipeline/voting/threshold-resolver.js";
import type {
  StaticThresholdConfig,
  TaskSignalThresholdConfig,
  ConfidenceThresholdConfig,
  TaskSignalBag,
} from "@shared/types";

// ─── Static mode ──────────────────────────────────────────────────────────────

describe("resolveThreshold — static mode", () => {
  const cfg: StaticThresholdConfig = { mode: "static", value: 0.6 };

  it("returns the configured value when no signals or confidence provided", () => {
    expect(resolveThreshold(cfg)).toBe(0.6);
  });

  it("ignores signals — still returns configured value", () => {
    const bag: TaskSignalBag = { signals: [{ key: "signal:high_risk", source: "tag" }] };
    expect(resolveThreshold(cfg, bag)).toBe(0.6);
  });

  it("ignores aggregated confidence — still returns configured value", () => {
    expect(resolveThreshold(cfg, undefined, 0.9)).toBe(0.6);
  });

  it("clamps values above 1 to 1", () => {
    const overCfg: StaticThresholdConfig = { mode: "static", value: 1.5 };
    expect(resolveThreshold(overCfg)).toBe(1.0);
  });

  it("clamps values below 0 to 0", () => {
    const underCfg: StaticThresholdConfig = { mode: "static", value: -0.1 };
    expect(resolveThreshold(underCfg)).toBe(0.0);
  });
});

// ─── Task signal mode ─────────────────────────────────────────────────────────

describe("resolveThreshold — task_signal mode", () => {
  const cfg: TaskSignalThresholdConfig = {
    mode: "task_signal",
    rules: [
      { signal: "signal:high_risk", threshold: 0.85 },
      { signal: "signal:low_stakes", threshold: 0.45 },
    ],
    default: 0.65,
  };

  it("returns default when no signals bag provided", () => {
    expect(resolveThreshold(cfg)).toBe(0.65);
  });

  it("returns default when signal bag is empty", () => {
    const emptyBag: TaskSignalBag = { signals: [] };
    expect(resolveThreshold(cfg, emptyBag)).toBe(0.65);
  });

  it("returns high_risk threshold when signal:high_risk is present", () => {
    const bag: TaskSignalBag = {
      signals: [{ key: "signal:high_risk", source: "upstream_stage" }],
    };
    expect(resolveThreshold(cfg, bag)).toBe(0.85);
  });

  it("returns low_stakes threshold when signal:low_stakes is present", () => {
    const bag: TaskSignalBag = {
      signals: [{ key: "signal:low_stakes", source: "tag" }],
    };
    expect(resolveThreshold(cfg, bag)).toBe(0.45);
  });

  it("first matching rule wins when multiple matching signals are present", () => {
    // high_risk rule is listed first — it should win
    const bag: TaskSignalBag = {
      signals: [
        { key: "signal:high_risk", source: "upstream_stage" },
        { key: "signal:low_stakes", source: "tag" },
      ],
    };
    expect(resolveThreshold(cfg, bag)).toBe(0.85);
  });

  it("falls back to default when no rule matches the signals in the bag", () => {
    const bag: TaskSignalBag = {
      signals: [{ key: "signal:unrelated", source: "tag" }],
    };
    expect(resolveThreshold(cfg, bag)).toBe(0.65);
  });

  it("clamps rule threshold to [0,1]", () => {
    const extremeCfg: TaskSignalThresholdConfig = {
      mode: "task_signal",
      rules: [{ signal: "signal:x", threshold: 1.5 }],
      default: 0.6,
    };
    const bag: TaskSignalBag = { signals: [{ key: "signal:x", source: "tag" }] };
    expect(resolveThreshold(extremeCfg, bag)).toBe(1.0);
  });

  it("ignores aggregated confidence in task_signal mode", () => {
    const bag: TaskSignalBag = {
      signals: [{ key: "signal:high_risk", source: "tag" }],
    };
    expect(resolveThreshold(cfg, bag, 0.99)).toBe(0.85);
  });
});

// ─── Confidence mode ──────────────────────────────────────────────────────────

describe("resolveThreshold — confidence mode", () => {
  const cfg: ConfidenceThresholdConfig = {
    mode: "confidence",
    base: 0.7,
    floor: 0.5,
    ceiling: 0.9,
    sensitivity: 0.2,
  };

  it("returns base when aggregatedConfidence is 0.5 (neutral)", () => {
    expect(resolveThreshold(cfg, undefined, 0.5)).toBeCloseTo(0.7, 5);
  });

  it("eases threshold when confidence is high (conf=1.0)", () => {
    // base - (1.0 - 0.5) * 0.2 = 0.7 - 0.1 = 0.6
    expect(resolveThreshold(cfg, undefined, 1.0)).toBeCloseTo(0.6, 5);
  });

  it("tightens threshold when confidence is low (conf=0.0)", () => {
    // base - (0.0 - 0.5) * 0.2 = 0.7 + 0.1 = 0.8
    expect(resolveThreshold(cfg, undefined, 0.0)).toBeCloseTo(0.8, 5);
  });

  it("clamps to floor when confidence is very high", () => {
    // cfg with low floor to test clamping: base=0.6, floor=0.55, ceiling=0.9, sens=0.2
    // conf=1.0 → 0.6 - 0.1 = 0.5 → clamp to floor=0.55
    const clampCfg: ConfidenceThresholdConfig = {
      mode: "confidence",
      base: 0.6,
      floor: 0.55,
      ceiling: 0.9,
      sensitivity: 0.2,
    };
    expect(resolveThreshold(clampCfg, undefined, 1.0)).toBeCloseTo(0.55, 5);
  });

  it("clamps to ceiling when confidence is very low", () => {
    // base=0.85, ceiling=0.9, floor=0.5, sens=0.5
    // conf=0.0 → 0.85 + 0.25 = 1.1 → clamp to 0.9
    const clampCfg: ConfidenceThresholdConfig = {
      mode: "confidence",
      base: 0.85,
      floor: 0.5,
      ceiling: 0.9,
      sensitivity: 0.5,
    };
    expect(resolveThreshold(clampCfg, undefined, 0.0)).toBeCloseTo(0.9, 5);
  });

  it("uses base when no aggregatedConfidence provided", () => {
    expect(resolveThreshold(cfg)).toBeCloseTo(0.7, 5);
  });

  it("uses default sensitivity of 0.2 when not specified", () => {
    const cfgNoSens: ConfidenceThresholdConfig = {
      mode: "confidence",
      base: 0.7,
      floor: 0.5,
      ceiling: 0.9,
    };
    // Default sensitivity=0.2; conf=1.0 → 0.7 - 0.1 = 0.6
    expect(resolveThreshold(cfgNoSens, undefined, 1.0)).toBeCloseTo(0.6, 5);
  });

  it("ignores signals in confidence mode", () => {
    const bag: TaskSignalBag = {
      signals: [{ key: "signal:high_risk", source: "tag" }],
    };
    expect(resolveThreshold(cfg, bag, 0.5)).toBeCloseTo(0.7, 5);
  });
});
