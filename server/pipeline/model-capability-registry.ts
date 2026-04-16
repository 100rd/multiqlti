import type { ModelParallelCapabilities, CostTier } from "@shared/types";

/**
 * Default capabilities for known model families.
 * Keys are model slug prefixes — the registry matches the longest prefix.
 */
const DEFAULT_CAPABILITIES: ReadonlyMap<string, ModelParallelCapabilities> = new Map([
  ["claude-3.5-sonnet", {
    maxConcurrentAgents: 5,
    supportedMergeStrategies: ["concatenate", "review", "llm_merge", "vote", "auto"],
    recommendedForSplitting: false,
    rateLimit: 50,
    costTier: "high",
    strengths: ["reasoning", "code", "review"],
    agenticCapability: true,
    contextWindow: 200_000,
  }],
  ["claude-3.5-haiku", {
    maxConcurrentAgents: 50,
    supportedMergeStrategies: ["concatenate", "review", "llm_merge", "vote", "auto"],
    recommendedForSplitting: true,
    rateLimit: 100,
    costTier: "low",
    strengths: ["speed", "simple-tasks"],
    agenticCapability: true,
    contextWindow: 200_000,
  }],
  ["claude-3-opus", {
    maxConcurrentAgents: 3,
    supportedMergeStrategies: ["concatenate", "review", "llm_merge", "vote", "auto"],
    recommendedForSplitting: false,
    rateLimit: 30,
    costTier: "high",
    strengths: ["reasoning", "code", "review", "complex-analysis"],
    agenticCapability: true,
    contextWindow: 200_000,
  }],
  ["gemini-2.0-flash", {
    maxConcurrentAgents: 30,
    supportedMergeStrategies: ["concatenate", "review", "llm_merge", "vote", "auto"],
    recommendedForSplitting: true,
    rateLimit: 60,
    costTier: "low",
    strengths: ["speed", "code", "large-context"],
    agenticCapability: true,
    contextWindow: 1_000_000,
  }],
  ["gemini-1.5-pro", {
    maxConcurrentAgents: 5,
    supportedMergeStrategies: ["concatenate", "review", "llm_merge", "vote", "auto"],
    recommendedForSplitting: false,
    rateLimit: 30,
    costTier: "high",
    strengths: ["reasoning", "code", "review"],
    agenticCapability: true,
    contextWindow: 1_000_000,
  }],
  ["grok-3", {
    maxConcurrentAgents: 10,
    supportedMergeStrategies: ["concatenate", "review", "llm_merge", "vote", "auto"],
    recommendedForSplitting: false,
    rateLimit: 30,
    costTier: "medium",
    strengths: ["reasoning", "code"],
    agenticCapability: true,
    contextWindow: 131_072,
  }],
  ["grok-3-mini", {
    maxConcurrentAgents: 30,
    supportedMergeStrategies: ["concatenate", "review", "llm_merge", "vote", "auto"],
    recommendedForSplitting: true,
    rateLimit: 60,
    costTier: "low",
    strengths: ["speed", "simple-tasks"],
    agenticCapability: false,
    contextWindow: 131_072,
  }],
  ["mock", {
    maxConcurrentAgents: 100,
    supportedMergeStrategies: ["concatenate", "review", "llm_merge", "vote", "auto"],
    recommendedForSplitting: true,
    rateLimit: 1000,
    costTier: "low",
    strengths: ["speed"],
    agenticCapability: true,
    contextWindow: 128_000,
  }],
]);

const FALLBACK_CAPABILITIES: ModelParallelCapabilities = {
  maxConcurrentAgents: 3,
  supportedMergeStrategies: ["concatenate", "review", "llm_merge", "auto"],
  recommendedForSplitting: false,
  rateLimit: 10,
  costTier: "medium",
  strengths: [],
  agenticCapability: false,
  contextWindow: 32_000,
};

/**
 * Registry for model parallel capabilities.
 * Supports default capabilities for known models and custom overrides.
 */
export class ModelCapabilityRegistry {
  private overrides: Map<string, ModelParallelCapabilities> = new Map();

  /** Get capabilities for a model slug. Checks overrides first, then defaults by prefix. */
  getCapabilities(modelSlug: string): ModelParallelCapabilities {
    const override = this.overrides.get(modelSlug);
    if (override) return override;

    return this.matchByPrefix(modelSlug) ?? { ...FALLBACK_CAPABILITIES };
  }

  /** Register custom capabilities for a model slug. */
  setCapabilities(modelSlug: string, capabilities: ModelParallelCapabilities): void {
    this.overrides.set(modelSlug, capabilities);
  }

  /** Remove custom override, reverting to default lookup. */
  removeOverride(modelSlug: string): boolean {
    return this.overrides.delete(modelSlug);
  }

  /** Check if a model is suitable for agentic subtasks. */
  isAgenticCapable(modelSlug: string): boolean {
    return this.getCapabilities(modelSlug).agenticCapability ?? false;
  }

  /** Get cost tier for a model. */
  getCostTier(modelSlug: string): CostTier {
    return this.getCapabilities(modelSlug).costTier ?? "medium";
  }

  /** Get the effective rate limit (RPM) for a model. */
  getRateLimit(modelSlug: string): number {
    return this.getCapabilities(modelSlug).rateLimit ?? 10;
  }

  /** Find the best model for a subtask based on complexity and strengths. */
  selectModelForSubtask(
    availableModels: string[],
    complexity: "low" | "medium" | "high",
    requiredStrengths: string[],
  ): string | null {
    if (availableModels.length === 0) return null;

    const scored = availableModels.map((slug) => {
      const caps = this.getCapabilities(slug);
      let score = 0;

      if (complexity === "high" && !caps.agenticCapability) score -= 100;
      if (complexity === "low" && caps.costTier === "low") score += 10;
      if (complexity === "high" && caps.costTier !== "low") score += 5;

      for (const strength of requiredStrengths) {
        if ((caps.strengths ?? []).includes(strength)) score += 10;
      }

      return { slug, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].slug;
  }

  private matchByPrefix(modelSlug: string): ModelParallelCapabilities | null {
    let bestMatch: ModelParallelCapabilities | null = null;
    let bestLength = 0;

    for (const [prefix, caps] of DEFAULT_CAPABILITIES) {
      if (modelSlug.startsWith(prefix) && prefix.length > bestLength) {
        bestMatch = caps;
        bestLength = prefix.length;
      }
    }

    return bestMatch;
  }
}

/** Singleton instance for use across the pipeline. */
export const modelCapabilityRegistry = new ModelCapabilityRegistry();
