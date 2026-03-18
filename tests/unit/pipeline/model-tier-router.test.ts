/**
 * Unit tests for server/pipeline/model-tier-router.ts
 *
 * Covers:
 *  - pickCheapestModelSlug: correct provider detection and cheapest selection
 *  - checkSplitCost: warn / block / proceed logic with thresholds
 */
import { describe, it, expect } from "vitest";
import {
  pickCheapestModelSlug,
  checkSplitCost,
} from "../../../server/pipeline/model-tier-router.js";

// ─── pickCheapestModelSlug ────────────────────────────────────────────────────

describe("pickCheapestModelSlug", () => {
  it("returns claude-haiku for an Anthropic primary model (haiku is cheapest)", () => {
    const cheapest = pickCheapestModelSlug("claude-sonnet-4-6");
    // haiku: $0.80 + $4.00 = $4.80 / 1M < sonnet: $3.00 + $15.00 = $18.00 / 1M
    expect(cheapest).toBe("claude-haiku-4-5");
  });

  it("returns grok-3-mini for an xai primary model", () => {
    const cheapest = pickCheapestModelSlug("grok-3");
    expect(cheapest).toBe("grok-3-mini");
  });

  it("returns the same model when there is only one in the family (gemini)", () => {
    // Only gemini-2.0-flash is in MODEL_PRICING — should return it
    const cheapest = pickCheapestModelSlug("gemini-2.0-flash");
    expect(cheapest).toBe("gemini-2.0-flash");
  });

  it("falls back to the provided fallback for unknown models (local/mock)", () => {
    expect(pickCheapestModelSlug("ollama/llama3", "ollama/llama3")).toBe("ollama/llama3");
    expect(pickCheapestModelSlug("mock", "mock")).toBe("mock");
    expect(pickCheapestModelSlug("vllm", "fallback-slug")).toBe("fallback-slug");
  });

  it("uses primarySlug as default fallback when fallback is omitted", () => {
    expect(pickCheapestModelSlug("unknown-model")).toBe("unknown-model");
  });
});

// ─── checkSplitCost ───────────────────────────────────────────────────────────

describe("checkSplitCost", () => {
  it("returns proceed when no threshold is configured", () => {
    const result = checkSplitCost(1000, 3, "claude-sonnet-4-6", undefined);
    expect(result.action).toBe("proceed");
    expect(result.estimate.totalCostUsd).toBeGreaterThan(0);
    expect(result.estimate.chunkModelSlug).toBe("claude-haiku-4-5");
    expect(result.estimate.mergeModelSlug).toBe("claude-sonnet-4-6");
  });

  it("returns warn when total cost is between warnUsd and blockUsd", () => {
    // Use tiny thresholds so even small token counts trigger warn
    const result = checkSplitCost(1_000_000, 5, "claude-sonnet-4-6", {
      warnUsd: 0.01,
      blockUsd: 100,
    });
    expect(result.action).toBe("warn");
    expect("message" in result).toBe(true);
  });

  it("returns block when total cost exceeds blockUsd", () => {
    const result = checkSplitCost(1_000_000, 5, "claude-sonnet-4-6", {
      warnUsd: 0.001,
      blockUsd: 0.001,
    });
    expect(result.action).toBe("block");
    expect("message" in result).toBe(true);
  });

  it("block takes priority over warn when cost exceeds both", () => {
    const result = checkSplitCost(10_000_000, 10, "claude-sonnet-4-6", {
      warnUsd: 0.01,
      blockUsd: 0.01,
    });
    expect(result.action).toBe("block");
  });

  it("proceed when cost is below warnUsd", () => {
    const result = checkSplitCost(100, 2, "claude-haiku-4-5", {
      warnUsd: 100,
      blockUsd: 1000,
    });
    expect(result.action).toBe("proceed");
  });

  it("estimate has non-negative chunk and merge costs", () => {
    const result = checkSplitCost(500, 3, "claude-sonnet-4-6");
    expect(result.estimate.chunksCostUsd).toBeGreaterThanOrEqual(0);
    expect(result.estimate.mergeCostUsd).toBeGreaterThanOrEqual(0);
    expect(result.estimate.totalCostUsd).toBeCloseTo(
      result.estimate.chunksCostUsd + result.estimate.mergeCostUsd,
      10,
    );
  });

  it("uses mock/local model pricing (returns 0 cost) for non-cloud models", () => {
    const result = checkSplitCost(100_000, 5, "mock");
    expect(result.estimate.totalCostUsd).toBe(0);
    expect(result.action).toBe("proceed");
  });
});
