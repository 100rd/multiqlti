/**
 * Unit tests for the PURE stop policy (decideStop + confidenceBySpeed) — the
 * single termination truth shared by debate + /consensus. Table-driven, no
 * timers, no I/O (QA Section 1).
 *
 * Covers the full precedence ladder:
 *   abort > budget > timeout > min-rounds floor > adaptive-stability > hard-cap.
 * The min-rounds floor is the ANTI-PREMATURE guarantee: a stop signal at round 1
 * can NEVER stop. confidenceBySpeed is only reachable AFTER the floor.
 */
import { describe, it, expect } from "vitest";
import {
  decideStop,
  confidenceBySpeed,
  type DeliberationState,
  type StabilitySignal,
} from "../../../../server/orchestrator/deliberation/stop-policy.js";
import type { StopReason, Confidence } from "../../../../shared/types.js";

const DEFAULTS: DeliberationState = {
  round: 1,
  minRounds: 2,
  hardCap: 3,
  stabilitySignal: { kind: "still-diverging" },
  budgetExhausted: false,
  elapsedMs: 0,
  overallTimeoutMs: 1_800_000,
  aborted: false,
};

function makeState(overrides: Partial<DeliberationState>): DeliberationState {
  return { ...DEFAULTS, ...overrides };
}

const STABLE: StabilitySignal = { kind: "explored-and-stable" };
const MET: StabilitySignal = { kind: "consensus-met" };

describe("decideStop — precedence table", () => {
  interface Row {
    name: string;
    state: Partial<DeliberationState>;
    stop: boolean;
    reason?: StopReason;
    confidence?: Confidence;
  }

  const rows: Row[] = [
    // T-STOP-1: min-rounds floor blocks a stable signal at round 1 (anti-premature).
    {
      name: "T-STOP-1 floor blocks explored-and-stable at round 1",
      state: { round: 1, minRounds: 2, stabilitySignal: STABLE },
      stop: false,
    },
    {
      name: "T-STOP-1b floor blocks consensus-met at round 1",
      state: { round: 1, minRounds: 2, stabilitySignal: MET },
      stop: false,
    },
    // T-STOP-2: stable at round 2 → stop, high.
    {
      name: "T-STOP-2 stable at round 2 → stable/high",
      state: { round: 2, minRounds: 2, hardCap: 5, stabilitySignal: STABLE },
      stop: true,
      reason: "stable",
      confidence: "high",
    },
    // T-STOP-3: stable at round 3 → medium.
    {
      name: "T-STOP-3 stable at round 3 → stable/medium",
      state: { round: 3, minRounds: 2, hardCap: 5, stabilitySignal: STABLE },
      stop: true,
      reason: "stable",
      confidence: "medium",
    },
    // T-STOP-4: stable at round 4/5 → low.
    {
      name: "T-STOP-4 stable at round 4 → stable/low",
      state: { round: 4, minRounds: 2, hardCap: 5, stabilitySignal: STABLE },
      stop: true,
      reason: "stable",
      confidence: "low",
    },
    {
      name: "T-STOP-4b stable at round 5 → stable/low",
      state: { round: 5, minRounds: 2, hardCap: 5, stabilitySignal: STABLE },
      stop: true,
      reason: "stable",
      confidence: "low",
    },
    // T-STOP-5: hard-cap stop (never converged) → low.
    {
      name: "T-STOP-5 hard-cap at round 3 with still-diverging → hard-cap/low",
      state: { round: 3, minRounds: 2, hardCap: 3, stabilitySignal: { kind: "still-diverging" } },
      stop: true,
      reason: "hard-cap",
      confidence: "low",
    },
    // T-STOP-6: backstops precede a stop signal.
    {
      name: "T-STOP-6a abort beats a stable signal → aborted/low",
      state: { round: 2, aborted: true, stabilitySignal: STABLE },
      stop: true,
      reason: "aborted",
      confidence: "low",
    },
    {
      name: "T-STOP-6b budget beats a stable signal → budget/low",
      state: { round: 2, budgetExhausted: true, stabilitySignal: STABLE },
      stop: true,
      reason: "budget",
      confidence: "low",
    },
    {
      name: "T-STOP-6c timeout beats a stable signal → timeout/low",
      state: {
        round: 2,
        elapsedMs: 2_000_000,
        overallTimeoutMs: 1_800_000,
        stabilitySignal: STABLE,
      },
      stop: true,
      reason: "timeout",
      confidence: "low",
    },
    // T-STOP-7: consensus-met gated by the floor identically.
    {
      name: "T-STOP-7 consensus-met at round 2 → stable/high",
      state: { round: 2, minRounds: 2, hardCap: 5, stabilitySignal: MET },
      stop: true,
      reason: "stable",
      confidence: "high",
    },
    // T-STOP-8: abort precedence over budget + timeout.
    {
      name: "T-STOP-8 abort > budget > timeout",
      state: { round: 3, aborted: true, budgetExhausted: true, elapsedMs: 9_999_999 },
      stop: true,
      reason: "aborted",
      confidence: "low",
    },
    {
      name: "T-STOP-9 budget > timeout",
      state: { round: 3, budgetExhausted: true, elapsedMs: 9_999_999 },
      stop: true,
      reason: "budget",
      confidence: "low",
    },
    // T-STOP-10: still-diverging below cap → continue.
    {
      name: "T-STOP-10 still-diverging at round 2 (< hardCap 5) → continue",
      state: { round: 2, minRounds: 2, hardCap: 5, stabilitySignal: { kind: "still-diverging" } },
      stop: false,
    },
    // T-STOP-11: indeterminate (parse miss / fail-open) → continue.
    {
      name: "T-STOP-11 indeterminate at round 2 (< hardCap) → continue (fail-open)",
      state: { round: 2, minRounds: 2, hardCap: 5, stabilitySignal: { kind: "indeterminate" } },
      stop: false,
    },
    // T-STOP-12: consensus-not-met below cap → continue.
    {
      name: "T-STOP-12 consensus-not-met at round 2 (< hardCap) → continue",
      state: { round: 2, minRounds: 2, hardCap: 5, stabilitySignal: { kind: "consensus-not-met" } },
      stop: false,
    },
    // indeterminate at hard-cap still hard-caps.
    {
      name: "indeterminate at hard-cap → hard-cap/low",
      state: { round: 3, minRounds: 2, hardCap: 3, stabilitySignal: { kind: "indeterminate" } },
      stop: true,
      reason: "hard-cap",
      confidence: "low",
    },
    // min-rounds floor higher than 2: a stable signal at round 2 still blocked.
    {
      name: "floor=3 blocks stable at round 2",
      state: { round: 2, minRounds: 3, hardCap: 5, stabilitySignal: STABLE },
      stop: false,
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const decision = decideStop(makeState(row.state));
      expect(decision.stop).toBe(row.stop);
      if (row.stop) {
        expect(decision.reason).toBe(row.reason);
        expect(decision.confidence).toBe(row.confidence);
      } else {
        expect(decision.reason).toBeUndefined();
        expect(decision.confidence).toBeUndefined();
      }
    });
  }
});

describe("confidenceBySpeed", () => {
  it("round <= 2 → high", () => {
    expect(confidenceBySpeed(1)).toBe("high");
    expect(confidenceBySpeed(2)).toBe("high");
  });
  it("round === 3 → medium", () => {
    expect(confidenceBySpeed(3)).toBe("medium");
  });
  it("round 4/5 → low", () => {
    expect(confidenceBySpeed(4)).toBe("low");
    expect(confidenceBySpeed(5)).toBe("low");
  });
});
