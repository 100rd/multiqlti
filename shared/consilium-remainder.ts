/**
 * consilium-remainder.ts — finding #5: the READ-SIDE "converged with remainder"
 * computation + formatter. Pure and client-safe (no drizzle, no React), so the
 * server route, the client page, and unit tests all share ONE implementation of
 * the same rule.
 *
 * Convergence is keyed on `P0` BY DESIGN: a loop reaches `converged` the moment
 * no P0 action point remains. The judge may still leave actionable non-P0 items
 * (P1/P2/…) standing — those used to silently drop out of the lifecycle. This
 * module turns the LAST round's persisted `openActionPoints` into a
 * count-by-priority summary so the remainder is visible + executable via
 * develop-from-terminal. NOTHING is persisted: computed at read time from data
 * already in the round rows (no schema/FSM change).
 */
import { P0_PRIORITY, type ActionPoint, type OpenRemainder } from "./types.js";

/**
 * The minimal round shape `computeOpenRemainder` reads. A persisted
 * `ConsiliumLoopRoundRow` is structurally assignable to it, so the route passes
 * its rows straight through with no adapter.
 */
export interface RemainderRoundInput {
  round: number;
  openActionPoints?: readonly ActionPoint[] | null;
}

/**
 * Count (by priority) the STILL-OPEN action points on the LAST recorded round.
 *
 * ONLY the last round is read: each round persists the set of items still open AT
 * THAT round's decide, so summing across rounds would DOUBLE-COUNT items that a
 * later round closed. Returns `undefined` when there is no round, or the last
 * round carries no open action points (empty → no field on the wire). Priority
 * labels are UNTRUSTED model text — normalized (trim + uppercase) and bucketed
 * under `"P?"` when absent; treated as data, never a sink.
 */
export function computeOpenRemainder(
  rounds: readonly RemainderRoundInput[],
): OpenRemainder | undefined {
  if (rounds.length === 0) return undefined;
  // Defensive: pick the highest-round row rather than trusting array order.
  const last = rounds.reduce((a, b) => (b.round >= a.round ? b : a));
  const aps = Array.isArray(last.openActionPoints) ? last.openActionPoints : [];
  if (aps.length === 0) return undefined;
  const byPriority: Record<string, number> = {};
  for (const ap of aps) {
    const key = (ap.priority ?? "").trim().toUpperCase() || "P?";
    byPriority[key] = (byPriority[key] ?? 0) + 1;
  }
  return { total: aps.length, byPriority };
}

/**
 * The NON-P0 view of a remainder for the "converged with remainder" callout: the
 * non-P0 total plus a stable, highest-tier-first breakdown string (e.g.
 * `"1 P1, 1 P2"`). Returns `null` when there is nothing non-P0 to surface — so a
 * clean convergence (or a `P0`-only remainder) renders nothing.
 */
export function summarizeNonP0Remainder(
  remainder: OpenRemainder | null | undefined,
): { total: number; breakdown: string } | null {
  if (!remainder) return null;
  // Order by numeric tier ascending (P1 < P2 < …); an un-numbered "P?" sorts LAST.
  // Ties break on the raw label so the string is deterministic.
  const tier = (label: string): number => {
    const n = Number.parseInt(label.replace(/^P/i, ""), 10);
    return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
  };
  const entries = Object.entries(remainder.byPriority)
    .filter(([priority]) => priority !== P0_PRIORITY)
    .sort((a, b) => tier(a[0]) - tier(b[0]) || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total <= 0) return null;
  return { total, breakdown: entries.map(([priority, count]) => `${count} ${priority}`).join(", ") };
}
