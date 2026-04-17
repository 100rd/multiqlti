import { describe, it, expect } from "vitest";
import {
  estimateCostUsd,
  inferProviderFromModelSlug,
  maybeRedact,
  truncate,
  REDACTED_PLACEHOLDER,
} from "../../../server/tracing/openinference.js";

describe("OpenInference semantic conventions", () => {
  // ─── maybeRedact ───────────────────────────────────────────────────────────

  describe("maybeRedact", () => {
    it("1. returns REDACTED_PLACEHOLDER when redact=true", () => {
      expect(maybeRedact("secret prompt", true)).toBe(REDACTED_PLACEHOLDER);
    });

    it("2. returns original value when redact=false", () => {
      expect(maybeRedact("my prompt", false)).toBe("my prompt");
    });

    it("3. redacts empty string", () => {
      expect(maybeRedact("", true)).toBe(REDACTED_PLACEHOLDER);
    });
  });

  // ─── truncate ─────────────────────────────────────────────────────────────

  describe("truncate", () => {
    it("4. does not truncate when value length <= maxLen", () => {
      expect(truncate("hello", 10)).toBe("hello");
    });

    it("5. truncates and appends ellipsis when length > maxLen", () => {
      const result = truncate("hello world", 7);
      expect(result).toHaveLength(7);
      expect(result.endsWith("…")).toBe(true);
    });

    it("6. exact boundary — no truncation at exactly maxLen", () => {
      expect(truncate("abcde", 5)).toBe("abcde");
    });

    it("7. truncates long prompt to maxLen with trailing ellipsis", () => {
      const long = "a".repeat(100);
      const result = truncate(long, 10);
      expect(result).toHaveLength(10);
      expect(result[9]).toBe("…");
    });
  });

  // ─── estimateCostUsd ──────────────────────────────────────────────────────

  describe("estimateCostUsd", () => {
    it("8. claude-sonnet-4-6 at 1_000_000 tokens = $3.00", () => {
      const cost = estimateCostUsd("claude-sonnet-4-6", 1_000_000);
      expect(cost).toBeCloseTo(3.0, 4);
    });

    it("9. gpt-4o-mini at 1_000_000 tokens = $0.15", () => {
      const cost = estimateCostUsd("gpt-4o-mini", 1_000_000);
      expect(cost).toBeCloseTo(0.15, 4);
    });

    it("10. unknown model returns 0", () => {
      expect(estimateCostUsd("some-unknown-model", 50_000)).toBe(0);
    });

    it("11. 0 tokens returns 0 cost regardless of model", () => {
      expect(estimateCostUsd("claude-sonnet-4-6", 0)).toBe(0);
    });

    it("12. prefix match — claude-sonnet-4-6-20251101 matches claude-sonnet-4-6", () => {
      const cost = estimateCostUsd("claude-sonnet-4-6-20251101", 1_000_000);
      expect(cost).toBeCloseTo(3.0, 4);
    });

    it("13. claude-opus-4 at 100_000 tokens has non-zero cost", () => {
      const cost = estimateCostUsd("claude-opus-4", 100_000);
      expect(cost).toBeGreaterThan(0);
    });

    it("14. cost scales linearly — 2x tokens = 2x cost", () => {
      const c1 = estimateCostUsd("gpt-4o", 100_000);
      const c2 = estimateCostUsd("gpt-4o", 200_000);
      expect(c2).toBeCloseTo(c1 * 2, 6);
    });
  });

  // ─── inferProviderFromModelSlug ────────────────────────────────────────────

  describe("inferProviderFromModelSlug", () => {
    it("15. claude-* → anthropic", () => {
      expect(inferProviderFromModelSlug("claude-sonnet-4")).toBe("anthropic");
    });

    it("16. gpt-* → openai", () => {
      expect(inferProviderFromModelSlug("gpt-4o-mini")).toBe("openai");
    });

    it("17. gemini-* → google", () => {
      expect(inferProviderFromModelSlug("gemini-1.5-pro")).toBe("google");
    });

    it("18. grok-* → xai", () => {
      expect(inferProviderFromModelSlug("grok-2")).toBe("xai");
    });

    it("19. llama-* → ollama", () => {
      expect(inferProviderFromModelSlug("llama-3")).toBe("ollama");
    });

    it("20. unknown slug → 'unknown'", () => {
      expect(inferProviderFromModelSlug("my-custom-model")).toBe("unknown");
    });

    it("21. o1-* → openai (reasoning models)", () => {
      expect(inferProviderFromModelSlug("o1-preview")).toBe("openai");
    });
  });
});
