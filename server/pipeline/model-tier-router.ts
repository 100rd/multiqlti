/**
 * Model-Tier Router — Phase 6.12.2
 *
 * Implements `pickCheapestModelSlug()` by querying MODEL_PRICING and MODEL_TIERS
 * from shared constants.  The router returns the cheapest known model that
 * is available (i.e. present in MODEL_PRICING) for a given provider family
 * derived from the primary model slug.
 *
 * Routing rules
 * ─────────────
 * - Parallel chunks  → cheapest agentic model (lowest cost-per-token)
 * - Final merge step → primary/configured model
 *
 * Cost estimation
 * ───────────────
 * Before splitting, the caller can call `estimateSplitCost()` to get an
 * upfront USD estimate.  If the estimate exceeds `costThreshold.warnUsd` a
 * warning is returned; if it exceeds `costThreshold.blockUsd` the split is
 * blocked.
 */

import { MODEL_PRICING, estimateCostUsd } from "@shared/constants";
import type { CostThresholdConfig } from "@shared/types";

// ─── Provider detection ───────────────────────────────────────────────────────

type ProviderFamily = "anthropic" | "google" | "xai" | "unknown";

/** Infer the provider family from a model slug. */
function detectProvider(modelSlug: string): ProviderFamily {
  if (modelSlug.startsWith("claude")) return "anthropic";
  if (modelSlug.startsWith("gemini")) return "google";
  if (modelSlug.startsWith("grok")) return "xai";
  return "unknown";
}

// ─── Cheapest model selection ─────────────────────────────────────────────────

/**
 * Returns the cheapest model slug within the same provider family as
 * `primarySlug`, ranked by (inputPer1M + outputPer1M).
 *
 * Falls back to `primarySlug` when:
 *  - The provider family is unknown
 *  - No pricing entry exists for any candidate in the same family
 *  - `primarySlug` itself is missing from MODEL_PRICING (e.g. local/mock models)
 */
export function pickCheapestModelSlug(
  primarySlug: string,
  fallback: string = primarySlug,
): string {
  const provider = detectProvider(primarySlug);

  // For local / mock models we cannot compare cloud pricing — return as-is
  if (provider === "unknown") return fallback;

  // Collect all known models in the same provider family
  const candidates = Object.entries(MODEL_PRICING)
    .filter(([slug]) => detectProvider(slug) === provider)
    .sort(([, a], [, b]) => {
      const costA = a.inputPer1M + a.outputPer1M;
      const costB = b.inputPer1M + b.outputPer1M;
      return costA - costB;
    });

  if (candidates.length === 0) return fallback;
  return candidates[0][0];
}

// ─── Cost estimation ──────────────────────────────────────────────────────────

export interface SplitCostEstimate {
  /** Estimated cost for running all parallel chunks (USD) */
  chunksCostUsd: number;
  /** Estimated cost for the merge step (USD) */
  mergeCostUsd: number;
  /** Total estimated cost (USD) */
  totalCostUsd: number;
  /** The cheap model that would be used for chunks */
  chunkModelSlug: string;
  /** The merge model that would be used */
  mergeModelSlug: string;
}

export type CostCheckResult =
  | { action: "proceed"; estimate: SplitCostEstimate }
  | { action: "warn";    estimate: SplitCostEstimate; message: string }
  | { action: "block";   estimate: SplitCostEstimate; message: string };

/**
 * Estimate the USD cost of a parallel split before it runs.
 *
 * @param inputTokens     Estimated tokens in the full stage input
 * @param shardCount      Number of shards that would be created
 * @param primaryModel    The primary model slug (used for merge)
 * @param threshold       Optional warn/block thresholds
 */
export function checkSplitCost(
  inputTokens: number,
  shardCount: number,
  primaryModel: string,
  threshold?: CostThresholdConfig,
): CostCheckResult {
  const chunkModelSlug = pickCheapestModelSlug(primaryModel, primaryModel);
  const mergeModelSlug = primaryModel;

  // Heuristic: each chunk processes ~(inputTokens / shardCount) input tokens
  // and produces roughly the same number of output tokens.
  const tokensPerChunk = Math.ceil(inputTokens / shardCount);
  const chunksCostUsd =
    estimateCostUsd(chunkModelSlug, tokensPerChunk, tokensPerChunk) * shardCount;

  // Merge reads all chunk outputs (≈ inputTokens total) + produces a summary
  const mergeCostUsd = estimateCostUsd(mergeModelSlug, inputTokens, tokensPerChunk);

  const totalCostUsd = chunksCostUsd + mergeCostUsd;

  const estimate: SplitCostEstimate = {
    chunksCostUsd,
    mergeCostUsd,
    totalCostUsd,
    chunkModelSlug,
    mergeModelSlug,
  };

  if (threshold?.blockUsd !== undefined && totalCostUsd >= threshold.blockUsd) {
    return {
      action: "block",
      estimate,
      message:
        `Estimated split cost $${totalCostUsd.toFixed(4)} USD exceeds block limit ` +
        `$${threshold.blockUsd.toFixed(4)} USD.`,
    };
  }

  if (threshold?.warnUsd !== undefined && totalCostUsd >= threshold.warnUsd) {
    return {
      action: "warn",
      estimate,
      message:
        `Estimated split cost $${totalCostUsd.toFixed(4)} USD exceeds warn threshold ` +
        `$${threshold.warnUsd.toFixed(4)} USD.`,
    };
  }

  return { action: "proceed", estimate };
}
