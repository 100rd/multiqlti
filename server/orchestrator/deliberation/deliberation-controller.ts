/**
 * Deliberation controller — the thin, shared orchestration seam between the two
 * deliberation entry shapes (the orchestrator debate step and the /consensus
 * cycle) and the PURE stop policy.
 *
 * It owns NO I/O and NO clock; it is a pure delegation layer so both shapes get
 * IDENTICAL termination semantics:
 *   - `shouldStop(state)` → `decideStop(state)` (the single termination truth);
 *   - `debateStabilitySignal(turnResults)` derives the debate-shape stability
 *     signal from the round's parsed stability-judge markers. A round is
 *     `explored-and-stable` ONLY when EVERY participant turn parsed AND reported
 *     explored && stabilized; any still-diverging turn keeps it diverging; a
 *     fail-open (parse miss / empty round) is conservative toward CONTINUING
 *     (mapped to still-diverging, never to a stop signal).
 *
 * The consensus shape builds its own `consensus-met` / `consensus-not-met`
 * signal from structural state (the 4-condition AND) and passes it straight to
 * `shouldStop` — it does NOT go through `debateStabilitySignal`.
 */
import {
  decideStop,
  type DeliberationState,
  type StopDecision,
  type StabilitySignal,
} from "./stop-policy";
import { type StabilityResult } from "./stability-judge";

/** A single participant turn's parsed stability decision for a debate round. */
export interface TurnStability {
  /** The parse result for this turn's terminal marker (fail-open when !ok). */
  readonly result: StabilityResult;
}

/**
 * Derive the debate-shape stability signal for a completed round from its
 * participant turns. Pure.
 *
 *   - empty round                                  → still-diverging (continue);
 *   - any turn failed to parse (fail-open)         → still-diverging (continue);
 *   - any turn is not (explored && stabilized)     → still-diverging (continue);
 *   - EVERY turn parsed AND explored && stabilized → explored-and-stable.
 *
 * This is strictly conservative: a stop signal requires unanimous, parsed,
 * explored-and-stabilized turns. Anything less keeps the debate going (the
 * fail-open guarantee — a parser miss can only extend, never truncate).
 */
export function debateStabilitySignal(turns: readonly TurnStability[]): StabilitySignal {
  if (turns.length === 0) return { kind: "still-diverging" };
  const allStable = turns.every(
    (t) => t.result.ok && t.result.explored === true && t.result.stabilized === true,
  );
  return allStable ? { kind: "explored-and-stable" } : { kind: "still-diverging" };
}

/**
 * The shared stop decision. Identical for both shapes — delegates to the pure
 * policy. Kept as a named seam so call sites read intent ("should this
 * deliberation stop?") and so the policy can never be bypassed inline.
 */
export function shouldStop(state: DeliberationState): StopDecision {
  return decideStop(state);
}
