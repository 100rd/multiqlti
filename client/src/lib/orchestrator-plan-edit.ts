/**
 * Pure, immutable plan-edit operations for the approval gate's light editing
 * (reorder / remove). Kept separate + unit-tested; the PlanGate component holds
 * the edited plan in state and calls these. Never mutates the input array.
 *
 * Editing is intentionally limited to reorder + remove (the "light editing"
 * the brief calls for): the per-step args are shown read-only, since arbitrary
 * arg edits are re-validated server-side anyway (H3) and a rich arg editor would
 * be heavy. Removing every step is disallowed by the gate (empty plans cannot be
 * approved); these helpers stay pure and let the component enforce that.
 */
import type { OrchestratorStepArgs } from "@shared/types";

export type { OrchestratorStepArgs };

/** Move the step at `index` one position earlier. No-op at the top. */
export function moveStepUp(
  steps: OrchestratorStepArgs[],
  index: number,
): OrchestratorStepArgs[] {
  if (index <= 0 || index >= steps.length) return steps;
  const next = steps.slice();
  [next[index - 1], next[index]] = [next[index], next[index - 1]];
  return next;
}

/** Move the step at `index` one position later. No-op at the bottom. */
export function moveStepDown(
  steps: OrchestratorStepArgs[],
  index: number,
): OrchestratorStepArgs[] {
  if (index < 0 || index >= steps.length - 1) return steps;
  const next = steps.slice();
  [next[index], next[index + 1]] = [next[index + 1], next[index]];
  return next;
}

/** Remove the step at `index`. No-op for an out-of-range index. */
export function removeStep(
  steps: OrchestratorStepArgs[],
  index: number,
): OrchestratorStepArgs[] {
  if (index < 0 || index >= steps.length) return steps;
  return steps.filter((_, i) => i !== index);
}

/**
 * Whether the edited plan differs from the original (by order or membership).
 * A shallow per-position identity compare is enough since edits only reorder /
 * remove existing step objects (never construct new ones).
 */
export function planChanged(
  original: OrchestratorStepArgs[],
  edited: OrchestratorStepArgs[],
): boolean {
  if (original.length !== edited.length) return true;
  for (let i = 0; i < original.length; i++) {
    if (original[i] !== edited[i]) return true;
  }
  return false;
}
