/**
 * converged-remainder.test.ts — finding #5 unit coverage for the READ-SIDE
 * "converged with remainder" helpers (`shared/consilium-remainder.ts`).
 *
 * Convergence is keyed on P0 by design; a loop can converge (no open P0) while
 * still carrying actionable non-P0 items. These pure helpers compute a
 * count-by-priority summary of the LAST round's still-open action points (no
 * schema change, no double-count across rounds) and the non-P0 view the UI
 * callout renders. Covers:
 *   - priorities counted from the LAST round's openActionPoints only
 *   - empty / absent last round → undefined (empty → no field on the wire)
 *   - priority normalization (trim/upper; missing → "P?")
 *   - highest-round row chosen regardless of array order
 *   - summarizeNonP0Remainder excludes P0, sorts tier-first, and returns null
 *     when there is nothing non-P0 to surface (clean convergence renders nothing)
 */
import { describe, it, expect } from "vitest";
import {
  computeOpenRemainder,
  summarizeNonP0Remainder,
  type RemainderRoundInput,
} from "../../../shared/consilium-remainder.js";
import type { ActionPoint } from "@shared/types";

const ap = (priority?: string, title = "x"): ActionPoint => ({ title, priority });

function round(r: number, aps?: ActionPoint[] | null): RemainderRoundInput {
  return { round: r, openActionPoints: aps ?? null };
}

describe("computeOpenRemainder", () => {
  it("counts priorities from the LAST round's action points only (no cross-round double-count)", () => {
    const rounds = [
      round(1, [ap("P0"), ap("P0")]), // earlier, still-open-at-round-1 set — MUST be ignored
      round(2, [ap("P1"), ap("P2")]), // the converged round's remainder
    ];
    expect(computeOpenRemainder(rounds)).toEqual({ total: 2, byPriority: { P1: 1, P2: 1 } });
  });

  it("buckets multiple items of the same tier", () => {
    const rounds = [round(1, [ap("P1"), ap("P1"), ap("P2")])];
    expect(computeOpenRemainder(rounds)).toEqual({ total: 3, byPriority: { P1: 2, P2: 1 } });
  });

  it("normalizes priority labels (trim + uppercase) and buckets a missing priority under P?", () => {
    const rounds = [round(1, [ap(" p1 "), ap(undefined), ap("")])];
    expect(computeOpenRemainder(rounds)).toEqual({ total: 3, byPriority: { P1: 1, "P?": 2 } });
  });

  it("picks the highest-round row regardless of array order", () => {
    const rounds = [round(3, [ap("P2")]), round(1, [ap("P0")]), round(2, [ap("P1")])];
    expect(computeOpenRemainder(rounds)).toEqual({ total: 1, byPriority: { P2: 1 } });
  });

  it("returns undefined when there are no rounds (empty → no field)", () => {
    expect(computeOpenRemainder([])).toBeUndefined();
  });

  it("returns undefined when the last round has an empty / absent action-point set", () => {
    expect(computeOpenRemainder([round(1, [])])).toBeUndefined();
    expect(computeOpenRemainder([round(1, null)])).toBeUndefined();
    expect(computeOpenRemainder([{ round: 1 }])).toBeUndefined();
  });
});

describe("summarizeNonP0Remainder", () => {
  it("excludes P0 and formats a tier-ordered breakdown", () => {
    const out = summarizeNonP0Remainder({ total: 4, byPriority: { P2: 1, P1: 2, "P?": 1 } });
    expect(out).toEqual({ total: 4, breakdown: "2 P1, 1 P2, 1 P?" });
  });

  it("drops a P0 tier from the non-P0 view (stopped_cap can still carry P0)", () => {
    const out = summarizeNonP0Remainder({ total: 3, byPriority: { P0: 1, P1: 2 } });
    expect(out).toEqual({ total: 2, breakdown: "2 P1" });
  });

  it("returns null for a clean convergence (undefined / P0-only / empty)", () => {
    expect(summarizeNonP0Remainder(undefined)).toBeNull();
    expect(summarizeNonP0Remainder(null)).toBeNull();
    expect(summarizeNonP0Remainder({ total: 1, byPriority: { P0: 1 } })).toBeNull();
    expect(summarizeNonP0Remainder({ total: 0, byPriority: {} })).toBeNull();
  });
});
