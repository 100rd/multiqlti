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
  // M-1: novelty patience is structural control — re-clamp HARD at runtime so a
  // bypassed/oversized config can never push the dry-streak past the round cap.
  debateNoveltyPatience: 5,
  // M-3: min-rounds floor is structural anti-premature control. HARD ceiling is
  // the round cap; the runtime clamp also enforces minRounds <= hardCap.
  deliberationMinRounds: 5,
  // /consensus HARD ceilings (match schema .max()).
  consensusMaxRounds: 5,
  consensusVoterCountMax: 7,
  consensusVoterCountMin: 5,
  consensusMaxTotalTokens: 2_000_000,
  consensusOverallTimeoutMs: 3_600_000,
  consensusVoterTimeoutMs: 600_000,
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
  /** Stop the debate after K consecutive no-new-argument rounds (HARD-clamped 1..5). */
  debateNoveltyPatience: number;
  /** Min rounds before a stability stop can fire (HARD-clamped to [2, maxDebateRounds]). */
  deliberationMinRounds: number;
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
  const maxDebateRounds = tighten(o.maxDebateRounds, overrides.maxDebateRounds, HARD.maxDebateRounds);
  return {
    maxSteps: tighten(o.maxSteps, overrides.maxSteps, HARD.maxSteps),
    maxDebateRounds,
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
    // M-1: HARD re-clamp to [1, 5] regardless of config (never trust config alone).
    debateNoveltyPatience: clamp(o.debateNoveltyPatience, 1, HARD.debateNoveltyPatience),
    // M-3: floor clamped to [2, hardCap]. min can NEVER exceed the round cap, so a
    // maxDebateRounds=1 + minRounds=2 misconfig resolves to floor=1 (== cap), not 2.
    deliberationMinRounds: resolveMinRounds(config, maxDebateRounds),
  };
}

/**
 * Resolve the deliberation min-rounds floor (M-3). Clamp the configured value to
 * [2, HARD.deliberationMinRounds], then HARD-cap it to the resolved debate round
 * cap so `minRounds <= hardCap` ALWAYS holds at runtime (a stability stop can
 * never be made unreachable, and the floor can never exceed the cap).
 */
function resolveMinRounds(config: AppConfig, hardCap: number): number {
  const configured = config.pipeline.deliberation?.minRounds ?? 2;
  const floor = clamp(configured, 2, HARD.deliberationMinRounds);
  return Math.min(floor, hardCap);
}

/** Effective caps for a /consensus run (HARD re-clamped at runtime). */
export interface ConsensusCaps {
  maxRounds: number;
  voterCount: number;
  maxTotalTokens: number;
  overallTimeoutMs: number;
  voterTimeoutMs: number;
  /** Shared min-rounds floor (anti-premature). Clamped to [2, maxRounds]. */
  minRounds: number;
}

/** Optional per-run consensus overrides (already zod-bounded at the route). */
export interface ConsensusCapOverrides {
  maxRounds?: number;
  voterCount?: number;
  maxTotalTokens?: number;
}

/**
 * Resolve effective caps for a /consensus run. Every value is HARD re-clamped
 * even if config was bypassed; overrides only TIGHTEN. voterCount is clamped to
 * [5, 7]; minRounds is clamped to [2, maxRounds] so the floor can never exceed
 * the round cap (M-3 parity with the debate path).
 */
export function resolveConsensusCaps(
  config: AppConfig,
  overrides: ConsensusCapOverrides = {},
): ConsensusCaps {
  const c = config.pipeline.consensus;
  const maxRounds = tighten(c.maxRounds, overrides.maxRounds, HARD.consensusMaxRounds);
  // voterCount: tighten toward the config value but never below the HARD min (5).
  const baseVoters = clamp(c.voterCount, HARD.consensusVoterCountMin, HARD.consensusVoterCountMax);
  const voterCount =
    overrides.voterCount === undefined
      ? baseVoters
      : Math.max(
          HARD.consensusVoterCountMin,
          Math.min(baseVoters, clamp(overrides.voterCount, HARD.consensusVoterCountMin, HARD.consensusVoterCountMax)),
        );
  const configuredMin = config.pipeline.deliberation?.minRounds ?? 2;
  const minRounds = Math.min(clamp(configuredMin, 2, HARD.deliberationMinRounds), maxRounds);
  return {
    maxRounds,
    voterCount,
    maxTotalTokens: tighten(c.maxTotalTokens, overrides.maxTotalTokens, HARD.consensusMaxTotalTokens),
    overallTimeoutMs: clamp(c.overallTimeoutMs, 10_000, HARD.consensusOverallTimeoutMs),
    voterTimeoutMs: clamp(c.voterTimeoutMs, 1_000, HARD.consensusVoterTimeoutMs),
    minRounds,
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
