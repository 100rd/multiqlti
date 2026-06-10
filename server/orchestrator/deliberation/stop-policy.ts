/**
 * Stop policy — the SINGLE source of termination truth for BOTH deliberation
 * entry shapes (the orchestrator debate step and the /consensus cycle).
 *
 * `decideStop(state)` is a PURE function of an immutable DeliberationState (no
 * I/O, no clock, no randomness) so it is exhaustively table-testable.
 *
 * Precedence (deterministic):
 *   1. aborted        → {stop, "aborted", low}      (C1 — absolute)
 *   2. budgetExhausted→ {stop, "budget",  low}      (C2 — absolute)
 *   3. timeout        → {stop, "timeout", low}      (wall-clock — absolute)
 *   4. min-rounds floor: round < minRounds → {stop:false} REGARDLESS of the
 *      stability signal. This is the ANTI-PREMATURE guarantee — a stable /
 *      consensus-met signal at round 1 can NEVER stop the deliberation.
 *   5. adaptive-stability stop (explored-and-stable / consensus-met) →
 *      {stop, "stable", confidenceBySpeed(round)}.
 *   6. hard-cap: round >= hardCap → {stop, "hard-cap", low} (we never converged).
 *   7. else → {stop:false}.
 *
 * `confidenceBySpeed` is ONLY ever reached from step 5, which is ONLY reachable
 * once `round >= minRounds (>= 2)`. So "fast = high" can NEVER be awarded for a
 * premature round-1 stop. hard-cap / budget / timeout / abort stops are always
 * `low` by construction.
 */
import type { StopReason, Confidence } from "@shared/types";

/**
 * The shape-specific stability signal fed into the policy.
 *   - debate    : the stability judge's "explored AND stabilized?" double-duty
 *                 marker maps to explored-and-stable / still-diverging /
 *                 indeterminate (parse miss → fail-open → continue);
 *   - consensus : the 4-condition AND maps to consensus-met / consensus-not-met.
 */
export type StabilitySignal =
  | { readonly kind: "explored-and-stable" }
  | { readonly kind: "still-diverging" }
  | { readonly kind: "consensus-met" }
  | { readonly kind: "consensus-not-met" }
  | { readonly kind: "indeterminate" };

export interface DeliberationState {
  /** 1-based index of the round that just completed. */
  readonly round: number;
  /** Floor (>= 2 after resolveCaps HARD-clamp). No stop signal fires below it. */
  readonly minRounds: number;
  /** Absolute round cap (<= 5, default 3). */
  readonly hardCap: number;
  /** Shape-specific stability signal for the round that just completed. */
  readonly stabilitySignal: StabilitySignal;
  /** True when TokenBudget.checkBefore() would throw for the next call (C2). */
  readonly budgetExhausted: boolean;
  /** Elapsed wall-clock for the whole deliberation, in ms. */
  readonly elapsedMs: number;
  /** Overall wall-clock cap for the whole deliberation, in ms. */
  readonly overallTimeoutMs: number;
  /** True when the run's abort signal has fired (C1). */
  readonly aborted: boolean;
}

export interface StopDecision {
  readonly stop: boolean;
  /** Only present when stop === true. */
  readonly reason?: StopReason;
  /** Only present when stop === true. */
  readonly confidence?: Confidence;
}

/** A signal kind that, ABOVE the floor, ends the deliberation. */
function isStopSignal(kind: StabilitySignal["kind"]): boolean {
  return kind === "explored-and-stable" || kind === "consensus-met";
}

/**
 * Confidence purely by convergence speed. ONLY reachable after the min-rounds
 * floor, so "fast = high" can never reward a premature round-1 stop.
 */
export function confidenceBySpeed(round: number): Confidence {
  if (round <= 2) return "high";
  if (round === 3) return "medium";
  return "low";
}

/** Decide whether the deliberation should stop after the completed round. Pure. */
export function decideStop(state: DeliberationState): StopDecision {
  // 1-3: absolute backstops, always low confidence, highest precedence.
  if (state.aborted) return { stop: true, reason: "aborted", confidence: "low" };
  if (state.budgetExhausted) return { stop: true, reason: "budget", confidence: "low" };
  if (state.elapsedMs > state.overallTimeoutMs) {
    return { stop: true, reason: "timeout", confidence: "low" };
  }

  // 4: min-rounds floor — anti-premature. A stop signal below the floor is ignored.
  if (state.round < state.minRounds) {
    return { stop: false };
  }

  // 5: adaptive-stability stop (only reachable at/above the floor).
  if (isStopSignal(state.stabilitySignal.kind)) {
    return { stop: true, reason: "stable", confidence: confidenceBySpeed(state.round) };
  }

  // 6: hard-cap backstop — never converged, low by definition.
  if (state.round >= state.hardCap) {
    return { stop: true, reason: "hard-cap", confidence: "low" };
  }

  // 7: keep deliberating.
  return { stop: false };
}
