/**
 * Tests for shared/pricing.ts
 * Covers: exact lookup, prefix-match fallback, unknown models, cost computation.
 */

import { describe, it, expect } from "vitest";
import {
  lookupPricing,
  computeCostUsd,
  knownProviders,
  MODEL_PRICING_TABLE,
} from "../../../shared/pricing.js";

describe("lookupPricing", () => {
  it("1. exact match — claude-sonnet-4-6", () => {
    const entry = lookupPricing("claude-sonnet-4-6");
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe("anthropic");
    expect(entry!.inputPer1M).toBeCloseTo(3.0);
    expect(entry!.outputPer1M).toBeCloseTo(15.0);
  });

  it("2. exact match — gemini-2.0-flash", () => {
    const entry = lookupPricing("gemini-2.0-flash");
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe("google");
    expect(entry!.inputPer1M).toBeCloseTo(0.075);
  });

  it("3. exact match — grok-3-mini", () => {
    const entry = lookupPricing("grok-3-mini");
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe("xai");
    expect(entry!.inputPer1M).toBeCloseTo(0.30);
  });

  it("4. prefix match — versioned slug claude-sonnet-4-6-20251022", () => {
    const entry = lookupPricing("claude-sonnet-4-6-20251022");
    expect(entry).toBeDefined();
    expect(entry!.model).toBe("claude-sonnet-4-6");
  });

  it("5. prefix match — versioned slug grok-3-2025", () => {
    const entry = lookupPricing("grok-3-2025");
    expect(entry).toBeDefined();
    expect(entry!.model).toBe("grok-3");
  });

  it("6. returns undefined for unknown model", () => {
    expect(lookupPricing("totally-unknown-model")).toBeUndefined();
  });

  it("7. returns undefined for empty string", () => {
    expect(lookupPricing("")).toBeUndefined();
  });

  it("8. self-hosted prefix vllm not in table → undefined", () => {
    expect(lookupPricing("vllm/llama3-70b")).toBeUndefined();
  });

  it("9. ollama model → undefined (no cloud cost)", () => {
    expect(lookupPricing("ollama/mistral")).toBeUndefined();
  });

  it("10. longer prefix wins over shorter prefix (claude-sonnet-4-6 over claude-sonnet-4)", () => {
    // claude-sonnet-4-6-custom should match claude-sonnet-4-6 not claude-sonnet-4
    const entry = lookupPricing("claude-sonnet-4-6-custom");
    expect(entry!.model).toBe("claude-sonnet-4-6");
  });
});

describe("computeCostUsd", () => {
  it("11. zero tokens → zero cost", () => {
    expect(computeCostUsd("claude-sonnet-4-6", 0, 0)).toBe(0);
  });

  it("12. 1M prompt tokens at $3/1M = $3.00", () => {
    const cost = computeCostUsd("claude-sonnet-4-6", 1_000_000, 0);
    expect(cost).toBeCloseTo(3.0);
  });

  it("13. 1M completion tokens at $15/1M = $15.00", () => {
    const cost = computeCostUsd("claude-sonnet-4-6", 0, 1_000_000);
    expect(cost).toBeCloseTo(15.0);
  });

  it("14. mixed tokens for claude-haiku-4-5", () => {
    // 500K prompt * 0.80/1M + 500K output * 4.00/1M
    const cost = computeCostUsd("claude-haiku-4-5", 500_000, 500_000);
    expect(cost).toBeCloseTo(0.4 + 2.0); // 2.40
  });

  it("15. unknown model returns 0 (no cloud cost)", () => {
    expect(computeCostUsd("llama3-70b", 1_000_000, 1_000_000)).toBe(0);
  });

  it("16. gemini-2.0-flash cost correct", () => {
    // 1M prompt * 0.075/1M + 1M output * 0.30/1M = 0.375
    const cost = computeCostUsd("gemini-2.0-flash", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.375);
  });

  it("17. grok-3 cost correct", () => {
    const cost = computeCostUsd("grok-3", 1_000_000, 0);
    expect(cost).toBeCloseTo(3.0);
  });

  it("18. prefix-matched model computes correct cost", () => {
    // claude-sonnet-4-6-2025 should use claude-sonnet-4-6 pricing
    const direct = computeCostUsd("claude-sonnet-4-6", 100_000, 50_000);
    const prefixed = computeCostUsd("claude-sonnet-4-6-2025", 100_000, 50_000);
    expect(prefixed).toBeCloseTo(direct);
  });

  it("19. large token count — no overflow / floating point issues", () => {
    const cost = computeCostUsd("claude-opus-4", 10_000_000, 5_000_000);
    // 10M * 15 + 5M * 75 = 150 + 375 = 525
    expect(cost).toBeCloseTo(525.0);
  });
});

describe("knownProviders", () => {
  it("20. returns anthropic, google, xai", () => {
    const providers = knownProviders();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("google");
    expect(providers).toContain("xai");
  });

  it("21. does not include self-hosted providers", () => {
    const providers = knownProviders();
    expect(providers).not.toContain("ollama");
    expect(providers).not.toContain("vllm");
    expect(providers).not.toContain("mock");
  });
});

describe("MODEL_PRICING_TABLE invariants", () => {
  it("22. all entries have positive prices", () => {
    for (const entry of MODEL_PRICING_TABLE) {
      expect(entry.inputPer1M).toBeGreaterThan(0);
      expect(entry.outputPer1M).toBeGreaterThan(0);
    }
  });

  it("23. all entries have non-empty provider and model", () => {
    for (const entry of MODEL_PRICING_TABLE) {
      expect(entry.provider).toBeTruthy();
      expect(entry.model).toBeTruthy();
    }
  });

  it("24. no duplicate model keys", () => {
    const seen = new Set<string>();
    for (const entry of MODEL_PRICING_TABLE) {
      expect(seen.has(entry.model)).toBe(false);
      seen.add(entry.model);
    }
  });
});
