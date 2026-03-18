/**
 * Unit tests for server/pipeline/token-budget.ts
 *
 * Covers:
 *  - truncateToTokenBudget: normal truncation, no-op, edge cases
 *  - CumulativeCostTracker: accumulation, threshold trigger, idempotency
 */
import { describe, it, expect } from "vitest";
import {
  truncateToTokenBudget,
  CumulativeCostTracker,
} from "../../../server/pipeline/token-budget.js";

// ─── truncateToTokenBudget ────────────────────────────────────────────────────

describe("truncateToTokenBudget", () => {
  it("returns input unchanged when it fits within budget", () => {
    const input = "hello"; // 2 tokens
    expect(truncateToTokenBudget(input, 100)).toBe(input);
  });

  it("truncates input that exceeds budget and appends notice", () => {
    // 400 chars → 100 tokens; budget = 50 → must truncate
    const input = "a".repeat(400);
    const result = truncateToTokenBudget(input, 50);
    expect(result.length).toBeLessThan(input.length);
    expect(result).toContain("truncated");
  });

  it("truncated result has token count <= maxTokens (approximate)", () => {
    const input = "x".repeat(1000); // 250 tokens
    const maxTokens = 50;
    const result = truncateToTokenBudget(input, maxTokens);
    // Rough check: result length should be ≤ maxTokens * 4 + notice length
    expect(result.length).toBeLessThanOrEqual(maxTokens * 4 + 500);
  });

  it("handles maxTokens === 0 — returns only the truncation notice", () => {
    const result = truncateToTokenBudget("some content", 0);
    expect(result.trim().length).toBeGreaterThan(0);
    expect(result).toContain("truncated");
  });

  it("handles empty input", () => {
    const result = truncateToTokenBudget("", 100);
    expect(result).toBe("");
  });

  it("does not truncate input whose char count is exactly on the boundary", () => {
    // 200 chars = 50 tokens exactly; budget = 50 → no truncation
    const input = "b".repeat(200);
    const result = truncateToTokenBudget(input, 50);
    expect(result).toBe(input);
  });
});

// ─── CumulativeCostTracker ────────────────────────────────────────────────────

describe("CumulativeCostTracker", () => {
  describe("when blockLimitUsd is undefined", () => {
    it("never triggers abort regardless of cost accumulated", () => {
      const tracker = new CumulativeCostTracker(undefined);
      expect(tracker.record(100)).toBe(false);
      expect(tracker.record(100)).toBe(false);
      expect(tracker.isAborted).toBe(false);
      expect(tracker.totalUsd).toBe(200);
      expect(tracker.completed).toBe(2);
    });
  });

  describe("when blockLimitUsd is set", () => {
    it("does not abort while below the limit", () => {
      const tracker = new CumulativeCostTracker(1.0);
      expect(tracker.record(0.3)).toBe(false);
      expect(tracker.record(0.3)).toBe(false);
      expect(tracker.isAborted).toBe(false);
    });

    it("triggers abort exactly when limit is reached", () => {
      const tracker = new CumulativeCostTracker(1.0);
      tracker.record(0.5);
      const exceeded = tracker.record(0.5); // total = 1.0 >= limit
      expect(exceeded).toBe(true);
      expect(tracker.isAborted).toBe(true);
    });

    it("triggers abort when limit is exceeded mid-way", () => {
      const tracker = new CumulativeCostTracker(0.5);
      tracker.record(0.3);
      const exceeded = tracker.record(0.3); // total = 0.6 >= 0.5
      expect(exceeded).toBe(true);
    });

    it("does NOT trigger again once already aborted (idempotent)", () => {
      const tracker = new CumulativeCostTracker(0.1);
      const first = tracker.record(0.2);  // triggers
      const second = tracker.record(0.2); // already aborted
      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it("accumulates totalUsd correctly across multiple records", () => {
      const tracker = new CumulativeCostTracker(100);
      tracker.record(1.5);
      tracker.record(2.5);
      tracker.record(0.1);
      expect(tracker.totalUsd).toBeCloseTo(4.1, 10);
      expect(tracker.completed).toBe(3);
    });
  });
});
