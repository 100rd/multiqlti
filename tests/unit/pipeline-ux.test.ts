/**
 * Unit tests for pipeline UX improvements (T-300 / T-302).
 *
 * T-300: The pipelines[0] fallback was removed from MultiAgentPipeline.
 * Verified by inspecting the component source directly — no React DOM needed.
 *
 * T-302: Each EXECUTION_STRATEGY_PRESET now carries a costMultiplier field
 * that the component renders inline on preset buttons.
 * Verified against the shared constants and the computeCostMultiplier function.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  EXECUTION_STRATEGY_PRESETS,
  computeCostMultiplier,
} from "../../shared/constants.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

// ─── T-300: pipelines[0] fallback removed ────────────────────────────────────

describe("T-300 — MultiAgentPipeline: pipelines[0] fallback removal", () => {
  const componentSource = readFileSync(
    resolve(PROJECT_ROOT, "client/src/components/workflow/MultiAgentPipeline.tsx"),
    "utf-8",
  );

  it("does NOT contain the pipelines[0] fallback expression", () => {
    // The old code was: pipelines[0]
    // After T-300, this must be gone
    expect(componentSource).not.toMatch(/pipelines\[0\]/);
  });

  it("resolves pipeline as null when pipelineId is not provided", () => {
    // Verify the new logic: the ternary fallback is null (not pipelines[0])
    // The code is: const pipeline = pipelineId ? (...) : null;
    expect(componentSource).toMatch(/:\s*null/);
  });

  it("still finds pipeline by pipelineId when provided", () => {
    // The pipelineId branch should still use find()
    expect(componentSource).toMatch(/pipelines\.find\(/);
  });
});

// ─── T-302: cost multiplier on strategy presets ───────────────────────────────

describe("T-302 — EXECUTION_STRATEGY_PRESETS: costMultiplier field", () => {
  it("every preset has a costMultiplier field", () => {
    for (const preset of EXECUTION_STRATEGY_PRESETS) {
      expect(
        preset.costMultiplier,
        `preset "${preset.id}" is missing costMultiplier`,
      ).toBeDefined();
      expect(typeof preset.costMultiplier).toBe("number");
    }
  });

  it("'single' preset has costMultiplier of 1", () => {
    const single = EXECUTION_STRATEGY_PRESETS.find((p) => p.id === "single");
    expect(single).toBeDefined();
    expect(single!.costMultiplier).toBe(1);
  });

  it("'quality_max' preset has costMultiplier > 1 (multi-model on all stages)", () => {
    const qualityMax = EXECUTION_STRATEGY_PRESETS.find((p) => p.id === "quality_max");
    expect(qualityMax).toBeDefined();
    expect(qualityMax!.costMultiplier).toBeGreaterThan(1);
  });

  it("'cost_optimized_multi' preset has lower costMultiplier than 'quality_max'", () => {
    const qualityMax = EXECUTION_STRATEGY_PRESETS.find((p) => p.id === "quality_max");
    const costOpt = EXECUTION_STRATEGY_PRESETS.find((p) => p.id === "cost_optimized_multi");
    expect(qualityMax).toBeDefined();
    expect(costOpt).toBeDefined();
    expect(costOpt!.costMultiplier).toBeLessThan(qualityMax!.costMultiplier);
  });

  it("all costMultiplier values are positive numbers", () => {
    for (const preset of EXECUTION_STRATEGY_PRESETS) {
      expect(preset.costMultiplier).toBeGreaterThan(0);
    }
  });
});

// ─── T-302: computeCostMultiplier function ───────────────────────────────────

describe("T-302 — computeCostMultiplier function", () => {
  it("returns 1 for single strategy", () => {
    expect(computeCostMultiplier({ type: "single" })).toBe(1);
  });

  it("returns proposers + 1 for moa strategy", () => {
    const result = computeCostMultiplier({
      type: "moa",
      proposers: [{ modelSlug: "a" }, { modelSlug: "b" }, { modelSlug: "c" }],
    });
    expect(result).toBe(4); // 3 proposers + 1 aggregator
  });

  it("returns participants * rounds + 1 for debate strategy", () => {
    const result = computeCostMultiplier({
      type: "debate",
      participants: [{ modelSlug: "a" }, { modelSlug: "b" }],
      rounds: 3,
    });
    expect(result).toBe(7); // 2 * 3 + 1 judge
  });

  it("returns candidate count for voting strategy", () => {
    const result = computeCostMultiplier({
      type: "voting",
      candidates: [{ modelSlug: "a" }, { modelSlug: "b" }, { modelSlug: "c" }],
    });
    expect(result).toBe(3);
  });

  it("falls back to defaults when array is missing for moa", () => {
    // proposers missing → defaults to 2, returns 2 + 1 = 3
    const result = computeCostMultiplier({ type: "moa" });
    expect(result).toBe(3);
  });

  it("falls back to defaults when participants/rounds missing for debate", () => {
    // participants missing → 2, rounds missing → 3, returns 2*3+1 = 7
    const result = computeCostMultiplier({ type: "debate" });
    expect(result).toBe(7);
  });

  it("returns 1 for unknown strategy type", () => {
    const result = computeCostMultiplier({ type: "unknown" });
    expect(result).toBe(1);
  });
});

// ─── T-302: Component renders costMultiplier hint ────────────────────────────

describe("T-302 — MultiAgentPipeline component: costMultiplier rendered on buttons", () => {
  const componentSource = readFileSync(
    resolve(PROJECT_ROOT, "client/src/components/workflow/MultiAgentPipeline.tsx"),
    "utf-8",
  );

  it("references costMultiplier in the execution strategy preset section", () => {
    expect(componentSource).toMatch(/costMultiplier/);
  });

  it("renders the cost hint conditionally (only when multiplier > 1)", () => {
    // The component should have a check like `preset.costMultiplier > 1`
    expect(componentSource).toMatch(/costMultiplier\s*>\s*1/);
  });

  it("shows a ~Nx label for cost hint in the UI", () => {
    // Should render something like ~2x or ~5x
    expect(componentSource).toMatch(/~\{preset\.costMultiplier\}x/);
  });
});
