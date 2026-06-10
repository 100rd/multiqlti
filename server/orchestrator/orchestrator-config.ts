/**
 * Runtime caps for an orchestrator run, resolved from AppConfig and RE-CLAMPED
 * to hard maxima (defense-in-depth: never trust config alone, mirror
 * swarm-executor's runtime re-check). Optional per-run overrides (from the
 * start request, already zod-bounded) are clamped DOWN to the config hard-max —
 * a request can only tighten, never loosen, a cap.
 */
import type { AppConfig } from "../config/schema";

/** Absolute ceilings enforced regardless of config (matches schema .max()). */
const HARD = {
  maxSteps: 20,
  maxDebateRounds: 5,
  maxResearchSources: 50,
  maxResearchConcurrency: 10,
  maxResearchSourceBytes: 1_048_576,
  maxResearchTotalBytes: 67_108_864,
  maxTotalTokens: 2_000_000,
  overallTimeoutMs: 3_600_000,
  stepOutputMaxBytes: 1_048_576,
  geminiTurnTimeoutMs: 600_000,
} as const;

export interface OrchestratorCaps {
  maxSteps: number;
  maxDebateRounds: number;
  maxResearchSources: number;
  maxResearchConcurrency: number;
  maxResearchSourceBytes: number;
  maxResearchTotalBytes: number;
  maxTotalTokens: number;
  overallTimeoutMs: number;
  stepOutputMaxBytes: number;
  geminiTurnTimeoutMs: number;
}

/** Optional per-run overrides (already zod-bounded at the route). */
export interface CapOverrides {
  maxSteps?: number;
  maxDebateRounds?: number;
  maxResearchSources?: number;
  maxTotalTokens?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(Math.floor(value), max));
}

/** Pick the tighter of config value and an optional override; clamp to hard-max. */
function tighten(configVal: number, override: number | undefined, hardMax: number): number {
  const base = clamp(configVal, 1, hardMax);
  if (override === undefined) return base;
  return Math.min(base, clamp(override, 1, hardMax));
}

/**
 * Resolve effective caps for a run. Every value is re-clamped to its hard max
 * even if config was somehow bypassed; overrides can only tighten.
 */
export function resolveCaps(config: AppConfig, overrides: CapOverrides = {}): OrchestratorCaps {
  const o = config.pipeline.orchestrator;
  return {
    maxSteps: tighten(o.maxSteps, overrides.maxSteps, HARD.maxSteps),
    maxDebateRounds: tighten(o.maxDebateRounds, overrides.maxDebateRounds, HARD.maxDebateRounds),
    maxResearchSources: tighten(
      o.maxResearchSources,
      overrides.maxResearchSources,
      HARD.maxResearchSources,
    ),
    maxResearchConcurrency: clamp(o.maxResearchConcurrency, 1, HARD.maxResearchConcurrency),
    maxResearchSourceBytes: clamp(o.maxResearchSourceBytes, 1, HARD.maxResearchSourceBytes),
    maxResearchTotalBytes: clamp(o.maxResearchTotalBytes, 1, HARD.maxResearchTotalBytes),
    maxTotalTokens: tighten(o.maxTotalTokens, overrides.maxTotalTokens, HARD.maxTotalTokens),
    overallTimeoutMs: clamp(o.overallTimeoutMs, 10_000, HARD.overallTimeoutMs),
    stepOutputMaxBytes: clamp(o.stepOutputMaxBytes, 1, HARD.stepOutputMaxBytes),
    geminiTurnTimeoutMs: clamp(o.geminiTurnTimeoutMs, 1_000, HARD.geminiTurnTimeoutMs),
  };
}

/** Raised when the token ceiling would be exceeded by the NEXT LLM call (C2). */
export class TokenCeilingError extends Error {
  constructor(used: number, max: number) {
    super(`token ceiling reached: ${used} >= ${max}`);
    this.name = "TokenCeilingError";
  }
}

/**
 * Running token accountant. `checkBefore()` is called BEFORE every LLM call
 * (including each call inside a multi-call step) and throws TokenCeilingError
 * once the accumulated total has reached the ceiling (C2 — per-call, not
 * per-step). `add()` accumulates a response's tokensUsed.
 */
export class TokenBudget {
  private used = 0;

  constructor(private readonly max: number) {}

  get total(): number {
    return this.used;
  }

  /** Throws if the ceiling has already been reached. Call before each LLM turn. */
  checkBefore(): void {
    if (this.used >= this.max) {
      throw new TokenCeilingError(this.used, this.max);
    }
  }

  add(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.used += tokens;
  }
}
