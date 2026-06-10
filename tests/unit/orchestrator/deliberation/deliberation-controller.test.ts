/**
 * Unit tests for the deliberation-controller seam: shouldStop delegates to the
 * pure stop policy, and debateStabilitySignal derives a conservative round
 * signal from parsed participant-turn markers (fail-open toward continuing).
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect } from "vitest";
import {
  shouldStop,
  debateStabilitySignal,
} from "../../../../server/orchestrator/deliberation/deliberation-controller.js";
import type { DeliberationState } from "../../../../server/orchestrator/deliberation/stop-policy.js";
import type { StabilityResult } from "../../../../server/orchestrator/deliberation/stability-judge.js";

function ok(explored: boolean, stabilized: boolean): { result: StabilityResult } {
  return { result: { ok: true, explored, stabilized } };
}
function miss(): { result: StabilityResult } {
  return { result: { ok: false, missReason: "no-sentinel" } };
}

describe("shouldStop — delegates to decideStop", () => {
  const base: DeliberationState = {
    round: 2,
    minRounds: 2,
    hardCap: 5,
    stabilitySignal: { kind: "explored-and-stable" },
    budgetExhausted: false,
    elapsedMs: 0,
    overallTimeoutMs: 1_000_000,
    aborted: false,
  };

  it("stops on a stable signal at the floor with high confidence", () => {
    expect(shouldStop(base)).toEqual({ stop: true, reason: "stable", confidence: "high" });
  });

  it("does not stop below the floor", () => {
    expect(shouldStop({ ...base, round: 1 })).toEqual({ stop: false });
  });
});

describe("debateStabilitySignal — conservative round derivation", () => {
  it("empty round → still-diverging (continue)", () => {
    expect(debateStabilitySignal([])).toEqual({ kind: "still-diverging" });
  });

  it("all turns explored && stabilized → explored-and-stable", () => {
    expect(debateStabilitySignal([ok(true, true), ok(true, true)])).toEqual({
      kind: "explored-and-stable",
    });
  });

  it("one turn not stabilized → still-diverging", () => {
    expect(debateStabilitySignal([ok(true, true), ok(true, false)])).toEqual({
      kind: "still-diverging",
    });
  });

  it("one turn not explored → still-diverging (the double-duty case)", () => {
    expect(debateStabilitySignal([ok(true, true), ok(false, true)])).toEqual({
      kind: "still-diverging",
    });
  });

  it("a parse miss makes the round still-diverging (fail-open continue)", () => {
    expect(debateStabilitySignal([ok(true, true), miss()])).toEqual({
      kind: "still-diverging",
    });
  });
});
