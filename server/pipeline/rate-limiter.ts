import type { ParallelGuardrails, RateLimitFallback, SubTask } from "@shared/types";
import { estimateCostUsd } from "@shared/constants";
import { ModelCapabilityRegistry } from "./model-capability-registry";

// ─── Semaphore for per-model concurrency ─────────────────────────────────────

export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    } else {
      this.current = Math.max(0, this.current - 1);
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.current;
  }
}

// ─── Cost Estimator ──────────────────────────────────────────────────────────

export interface CostEstimate {
  totalEstimatedCostUsd: number;
  perSubtask: Array<{ subtaskId: string; modelSlug: string; estimatedCostUsd: number }>;
  withinBudget: boolean;
}

const AVERAGE_OUTPUT_TOKENS = 2000;

/**
 * Estimate total cost for a set of subtasks before execution.
 * Uses input length to approximate input tokens (1 token ~ 4 chars).
 */
export function estimateSplitCost(
  subtasks: SubTask[],
  modelSlug: string,
  maxBudget: number,
): CostEstimate {
  const perSubtask = subtasks.map((st) => {
    const inputChars = st.description.length + st.context.join("").length;
    const estimatedInputTokens = Math.ceil(inputChars / 4);
    const slug = st.suggestedModel ?? modelSlug;
    const estimatedCostUsd = estimateCostUsd(slug, estimatedInputTokens, AVERAGE_OUTPUT_TOKENS);
    return { subtaskId: st.id, modelSlug: slug, estimatedCostUsd };
  });

  const totalEstimatedCostUsd = perSubtask.reduce((sum, e) => sum + e.estimatedCostUsd, 0);

  return {
    totalEstimatedCostUsd,
    perSubtask,
    withinBudget: totalEstimatedCostUsd <= maxBudget,
  };
}

// ─── Parallel Rate Limiter ───────────────────────────────────────────────────

export class ParallelRateLimiter {
  private semaphores: Map<string, Semaphore> = new Map();
  private capabilityRegistry: ModelCapabilityRegistry;
  private guardrails: ParallelGuardrails;

  constructor(guardrails: ParallelGuardrails, capabilityRegistry: ModelCapabilityRegistry) {
    this.guardrails = guardrails;
    this.capabilityRegistry = capabilityRegistry;
  }

  /**
   * Get or create a semaphore for a model, respecting guardrails and model capabilities.
   */
  private getSemaphore(modelSlug: string): Semaphore {
    let sem = this.semaphores.get(modelSlug);
    if (!sem) {
      const modelCap = this.capabilityRegistry.getCapabilities(modelSlug);
      const limit = Math.min(
        this.guardrails.maxConcurrentPerModel,
        modelCap.maxConcurrentAgents,
      );
      sem = new Semaphore(Math.max(1, limit));
      this.semaphores.set(modelSlug, sem);
    }
    return sem;
  }

  /** Acquire a slot for the given model. Respects cooldown between requests. */
  async acquire(modelSlug: string): Promise<void> {
    const sem = this.getSemaphore(modelSlug);
    await sem.acquire();

    if (this.guardrails.cooldownBetweenRequests > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.guardrails.cooldownBetweenRequests),
      );
    }
  }

  /** Release a slot for the given model. */
  release(modelSlug: string): void {
    const sem = this.semaphores.get(modelSlug);
    sem?.release();
  }

  /** Check estimated cost and decide fallback action if over budget. */
  checkBudget(
    subtasks: SubTask[],
    defaultModelSlug: string,
  ): { allowed: boolean; fallback: RateLimitFallback; estimate: CostEstimate } {
    const estimate = estimateSplitCost(
      subtasks,
      defaultModelSlug,
      this.guardrails.maxTotalCostPerSplit,
    );

    return {
      allowed: estimate.withinBudget,
      fallback: this.guardrails.onLimitHit,
      estimate,
    };
  }

  /** Run a function with rate limiting for the specified model. */
  async withRateLimit<T>(modelSlug: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(modelSlug);
    try {
      return await fn();
    } finally {
      this.release(modelSlug);
    }
  }
}
