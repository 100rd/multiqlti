/**
 * Provider × model pricing table.
 *
 * Prices are in USD per 1,000,000 tokens (prompt / completion).
 *
 * Source URLs (as of 2025-04):
 *  - Anthropic: https://www.anthropic.com/api
 *  - Google:    https://ai.google.dev/gemini-api/docs/models
 *  - xAI:       https://x.ai/api
 *
 * To add a new model entry:
 *   1. Add it to MODEL_PRICING_TABLE below, grouped by provider.
 *   2. Add a source URL comment referencing the pricing page.
 *   3. Run `npx tsc --noEmit` to verify no type errors.
 *
 * IMPORTANT: This file is version-controlled. When prices change, update the
 * entry and record the effective date in a comment on the same line.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModelPricingEntry {
  /** Provider key (e.g. "anthropic", "google", "xai", "ollama", "vllm") */
  provider: string;
  /** Model identifier as used in the gateway (matches model slug or modelId) */
  model: string;
  /** Cost per 1,000,000 prompt/input tokens in USD */
  inputPer1M: number;
  /** Cost per 1,000,000 completion/output tokens in USD */
  outputPer1M: number;
}

// ─── Pricing Table ───────────────────────────────────────────────────────────

/**
 * Ordered list of model pricing entries.
 * Lookup uses exact match first, then prefix match for versioned slugs.
 *
 * Self-hosted providers (vllm, ollama, lmstudio, mock) are intentionally
 * absent — they have no API cost.
 */
export const MODEL_PRICING_TABLE: readonly ModelPricingEntry[] = [
  // ── Anthropic ─────────────────────────────────────────────────────────────
  // Source: https://www.anthropic.com/api (retrieved 2025-04)
  { provider: "anthropic", model: "claude-opus-4",        inputPer1M: 15.00, outputPer1M: 75.00 },
  { provider: "anthropic", model: "claude-sonnet-4-6",    inputPer1M:  3.00, outputPer1M: 15.00 },
  { provider: "anthropic", model: "claude-sonnet-4-5",    inputPer1M:  3.00, outputPer1M: 15.00 },
  { provider: "anthropic", model: "claude-sonnet-4",      inputPer1M:  3.00, outputPer1M: 15.00 },
  { provider: "anthropic", model: "claude-haiku-4-5",     inputPer1M:  0.80, outputPer1M:  4.00 },
  { provider: "anthropic", model: "claude-haiku-4",       inputPer1M:  0.80, outputPer1M:  4.00 },
  { provider: "anthropic", model: "claude-3-5-sonnet",    inputPer1M:  3.00, outputPer1M: 15.00 },
  { provider: "anthropic", model: "claude-3-5-haiku",     inputPer1M:  0.80, outputPer1M:  4.00 },
  { provider: "anthropic", model: "claude-3-opus",        inputPer1M: 15.00, outputPer1M: 75.00 },
  { provider: "anthropic", model: "claude-3-sonnet",      inputPer1M:  3.00, outputPer1M: 15.00 },
  { provider: "anthropic", model: "claude-3-haiku",       inputPer1M:  0.25, outputPer1M:  1.25 },

  // ── Google ────────────────────────────────────────────────────────────────
  // Source: https://ai.google.dev/gemini-api/docs/models (retrieved 2025-04)
  { provider: "google", model: "gemini-2.5-pro",          inputPer1M:  7.00, outputPer1M: 21.00 },
  { provider: "google", model: "gemini-2.0-flash",        inputPer1M:  0.075, outputPer1M: 0.30 },
  { provider: "google", model: "gemini-2.0-flash-lite",   inputPer1M:  0.075, outputPer1M: 0.30 },
  { provider: "google", model: "gemini-1.5-pro",          inputPer1M:  3.50, outputPer1M: 10.50 },
  { provider: "google", model: "gemini-1.5-flash",        inputPer1M:  0.075, outputPer1M: 0.30 },
  { provider: "google", model: "gemini-1.5-flash-8b",     inputPer1M:  0.0375, outputPer1M: 0.15 },

  // ── xAI ───────────────────────────────────────────────────────────────────
  // Source: https://x.ai/api (retrieved 2025-04)
  { provider: "xai", model: "grok-3",                     inputPer1M:  3.00, outputPer1M: 15.00 },
  { provider: "xai", model: "grok-3-fast",                inputPer1M:  5.00, outputPer1M: 25.00 },
  { provider: "xai", model: "grok-3-mini",                inputPer1M:  0.30, outputPer1M:  0.50 },
  { provider: "xai", model: "grok-3-mini-fast",           inputPer1M:  0.60, outputPer1M:  4.00 },
  { provider: "xai", model: "grok-beta",                  inputPer1M:  5.00, outputPer1M: 15.00 },
  { provider: "xai", model: "grok-vision-beta",           inputPer1M:  5.00, outputPer1M: 15.00 },
] as const;

// ─── Lookup helpers ──────────────────────────────────────────────────────────

/** Build a fast exact-match index from model slug → pricing entry. */
const _exactIndex = new Map<string, ModelPricingEntry>(
  MODEL_PRICING_TABLE.map((e) => [e.model, e]),
);

/**
 * Look up pricing for a model slug.
 *
 * Matching strategy:
 * 1. Exact match on `model` field.
 * 2. Prefix match: iterate table entries and pick the first whose `model`
 *    string is a prefix of the given slug (e.g. "claude-sonnet-4" matches
 *    "claude-sonnet-4-20251022").
 * 3. Returns `undefined` when no match — callers should treat as $0 cost.
 */
export function lookupPricing(modelSlug: string): ModelPricingEntry | undefined {
  const exact = _exactIndex.get(modelSlug);
  if (exact) return exact;

  // Prefix fallback (longer prefixes take precedence via table ordering)
  let best: ModelPricingEntry | undefined;
  let bestLen = 0;
  for (const entry of MODEL_PRICING_TABLE) {
    if (modelSlug.startsWith(entry.model) && entry.model.length > bestLen) {
      best = entry;
      bestLen = entry.model.length;
    }
  }
  return best;
}

/**
 * Compute USD cost for a given model slug and token counts.
 * Returns 0 for self-hosted / unknown models.
 */
export function computeCostUsd(
  modelSlug: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const entry = lookupPricing(modelSlug);
  if (!entry) return 0;
  return (
    (promptTokens   / 1_000_000) * entry.inputPer1M +
    (completionTokens / 1_000_000) * entry.outputPer1M
  );
}

/**
 * Returns all unique provider keys known to have priced models.
 */
export function knownProviders(): string[] {
  return [...new Set(MODEL_PRICING_TABLE.map((e) => e.provider))];
}
