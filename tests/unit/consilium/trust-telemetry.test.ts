/**
 * trust-telemetry.test.ts — Stage D pure aggregator (design §7+§9 "Stage 8").
 *
 * `computeTrustTelemetry(loops)` is PURE: given loop rows + their rounds' execution
 * traces / action points, it produces the grounding ratio, planner track record,
 * and criteria-quality rates. These tests pin every ratio, the empty-input (div/0)
 * behavior, and the ISO-week trend bucketing.
 */
import { describe, it, expect } from "vitest";
import {
  computeTrustTelemetry,
  type TelemetryLoopInput,
} from "../../../server/services/consilium/trust-telemetry";
import type {
  ExecutionTrace,
  ExecutionCriterion,
  ExecutionSkill,
} from "@shared/types";

// ─── Fixture builders ──────────────────────────────────────────────────────────

function crit(over: Partial<ExecutionCriterion> & Pick<ExecutionCriterion, "method">): ExecutionCriterion {
  return { criterion: "When X Then Y", ran: true, passed: true, ...over };
}

function skill(name: string, green: boolean): ExecutionSkill {
  return { skillName: name, capability: "worktree-write", permissionsUsed: ["Edit"], green };
}

function trace(opts: {
  criteria?: ExecutionCriterion[];
  skills?: ExecutionSkill[];
}): ExecutionTrace {
  return {
    schemaVersion: 1,
    archetype: "repo-assessment",
    controller: {
      kind: "sdlc-executor",
      label: "sdlc",
      green: true,
      workers: [
        {
          index: 1,
          priority: "P0",
          title: "w",
          status: "completed",
          skills: opts.skills ?? [],
          criteria: opts.criteria ?? [],
        },
      ],
    },
  };
}

describe("computeTrustTelemetry — grounding ratio", () => {
  it("mechanical (test-run/web-evidence) vs judge vs none/manual-ops", () => {
    const loops: TelemetryLoopInput[] = [
      {
        archetype: "repo-assessment",
        archetypeSource: "proposed",
        createdAt: "2026-06-01T00:00:00.000Z",
        rounds: [
          {
            createdAt: "2026-06-01T00:00:00.000Z",
            openActionPoints: [],
            executionTrace: trace({
              criteria: [
                crit({ method: "test-run" }),
                crit({ method: "web-evidence" }),
                crit({ method: "judge" }),
                crit({ method: "manual-ops", ran: false, passed: false }),
                crit({ method: "none", ran: false, passed: false }),
              ],
            }),
          },
        ],
      },
    ];
    const t = computeTrustTelemetry(loops);
    expect(t.grounding.totalCriteria).toBe(5);
    expect(t.grounding.mechanical).toBe(2);
    expect(t.grounding.judged).toBe(1);
    expect(t.grounding.unverified).toBe(2); // manual-ops + none
    expect(t.grounding.groundingRatio).toBe(0.4); // 2/5
    expect(t.grounding.judgedRatio).toBe(0.2);
    expect(t.grounding.byMethod["test-run"]).toBe(1);
    expect(t.grounding.byMethod["manual-ops"]).toBe(1);
    expect(t.honesty).toContain("40%");
  });

  it("counts live-deploy-smoke as mechanical (forward-compatible)", () => {
    const loops: TelemetryLoopInput[] = [
      {
        archetype: "infra",
        archetypeSource: "proposed",
        createdAt: "2026-06-01T00:00:00.000Z",
        rounds: [
          {
            createdAt: "2026-06-01T00:00:00.000Z",
            openActionPoints: [],
            // cast: live-deploy-smoke isn't in the persisted union yet, but §5 calls it mechanical.
            executionTrace: trace({
              criteria: [crit({ method: "live-deploy-smoke" as ExecutionCriterion["method"] })],
            }),
          },
        ],
      },
    ];
    const t = computeTrustTelemetry(loops);
    expect(t.grounding.mechanical).toBe(1);
    expect(t.grounding.groundingRatio).toBe(1);
  });

  it("buckets the trend by ISO week, oldest→newest", () => {
    const mk = (createdAt: string, method: ExecutionCriterion["method"]): TelemetryLoopInput => ({
      archetype: "repo-assessment",
      archetypeSource: "proposed",
      createdAt,
      rounds: [{ createdAt, openActionPoints: [], executionTrace: trace({ criteria: [crit({ method })] }) }],
    });
    const t = computeTrustTelemetry([
      mk("2026-06-15T00:00:00.000Z", "judge"), // later week
      mk("2026-06-01T00:00:00.000Z", "test-run"), // earlier week
    ]);
    expect(t.grounding.trend).toHaveLength(2);
    expect(t.grounding.trend[0].period < t.grounding.trend[1].period).toBe(true);
    expect(t.grounding.trend[0].groundingRatio).toBe(1); // earlier week: test-run
    expect(t.grounding.trend[1].groundingRatio).toBe(0); // later week: judge
  });
});

describe("computeTrustTelemetry — planner track record", () => {
  it("override rate, distribution, and per-skill green-rate", () => {
    const loops: TelemetryLoopInput[] = [
      {
        archetype: "repo-assessment",
        archetypeSource: "override",
        createdAt: "2026-06-01T00:00:00.000Z",
        rounds: [
          {
            createdAt: "2026-06-01T00:00:00.000Z",
            openActionPoints: [],
            executionTrace: trace({ skills: [skill("coder", true), skill("test-author", false)] }),
          },
        ],
      },
      {
        archetype: "repo-assessment",
        archetypeSource: "proposed",
        createdAt: "2026-06-02T00:00:00.000Z",
        rounds: [
          {
            createdAt: "2026-06-02T00:00:00.000Z",
            openActionPoints: [],
            executionTrace: trace({ skills: [skill("coder", true)] }),
          },
        ],
      },
      {
        archetype: "research",
        archetypeSource: null, // null counts as "planner's pick stood"
        createdAt: "2026-06-03T00:00:00.000Z",
        rounds: [],
      },
    ];
    const t = computeTrustTelemetry(loops);
    expect(t.planner.archetypeDecided).toBe(3);
    expect(t.planner.overridden).toBe(1);
    expect(t.planner.proposed).toBe(2);
    expect(t.planner.overrideRate).toBe(round4(1 / 3));
    expect(t.planner.archetypeDistribution).toEqual({ "repo-assessment": 2, research: 1 });
    const coder = t.planner.skillGreenRate.find((s) => s.skill === "coder");
    expect(coder).toEqual({ skill: "coder", total: 2, green: 2, greenRate: 1 });
    const ta = t.planner.skillGreenRate.find((s) => s.skill === "test-author");
    expect(ta).toEqual({ skill: "test-author", total: 1, green: 0, greenRate: 0 });
    // most-run first
    expect(t.planner.skillGreenRate[0].skill).toBe("coder");
  });

  it("loops with no archetype do not inflate the decided/override counts", () => {
    const t = computeTrustTelemetry([
      { archetype: null, archetypeSource: null, createdAt: "2026-06-01T00:00:00.000Z", rounds: [] },
    ]);
    expect(t.planner.archetypeDecided).toBe(0);
    expect(t.planner.overrideRate).toBe(0); // div/0 safe
  });
});

describe("computeTrustTelemetry — criteria quality", () => {
  it("weak rate, manual-ops, timeout rate, and final regression rate", () => {
    const loops: TelemetryLoopInput[] = [
      {
        archetype: "repo-assessment",
        archetypeSource: "proposed",
        createdAt: "2026-06-01T00:00:00.000Z",
        rounds: [
          {
            createdAt: "2026-06-01T00:00:00.000Z",
            openActionPoints: [
              { weakCriterion: true, acceptanceCriterion: "vague" },
              { weakCriterion: false, acceptanceCriterion: "When A Then B" },
              { acceptanceCriterion: "no flag" }, // undefined → not weak
            ],
            executionTrace: trace({
              criteria: [
                // a regression: passed at implement, failed at final re-verify
                crit({ method: "test-run", passed: true, passedAtFinal: false, ran: true }),
                // clean final pass
                crit({ method: "test-run", passed: true, passedAtFinal: true, ran: true }),
                // timed out / NOT-ADJUDICATED
                crit({ method: "test-run", ran: true, passed: false, timedOut: true }),
                // surfaced manual-ops
                crit({ method: "manual-ops", ran: false, passed: false }),
              ],
            }),
          },
        ],
      },
    ];
    const t = computeTrustTelemetry(loops);
    expect(t.criteria.totalActionPoints).toBe(3);
    expect(t.criteria.weakCriteria).toBe(1);
    expect(t.criteria.weakRate).toBe(round4(1 / 3));
    expect(t.criteria.manualOpsSurfaced).toBe(1);
    expect(t.criteria.timedOut).toBe(1);
    // ran criteria = 3 (two test-run passed + one timed-out ran); manual-ops ran:false
    expect(t.criteria.timeoutRate).toBe(round4(1 / 3));
    expect(t.criteria.finalVerified).toBe(2); // two carry passedAtFinal
    expect(t.criteria.regressions).toBe(1);
    expect(t.criteria.regressionRate).toBe(0.5); // 1/2
  });
});

describe("computeTrustTelemetry — robustness", () => {
  it("empty input → all zeros, honest message, no throw", () => {
    const t = computeTrustTelemetry([]);
    expect(t.window).toEqual({ loops: 0, rounds: 0, roundsWithTrace: 0 });
    expect(t.grounding.groundingRatio).toBe(0);
    expect(t.grounding.trend).toEqual([]);
    expect(t.planner.overrideRate).toBe(0);
    expect(t.criteria.regressionRate).toBe(0);
    expect(t.honesty).toMatch(/nothing to ground/i);
  });

  it("tolerates malformed traces / missing arrays without throwing", () => {
    const t = computeTrustTelemetry([
      {
        archetype: "repo-assessment",
        archetypeSource: "proposed",
        createdAt: "not-a-date",
        // @ts-expect-error — deliberately malformed persisted data
        rounds: [{ createdAt: "not-a-date", openActionPoints: null, executionTrace: {} }],
      },
    ]);
    expect(t.window.rounds).toBe(1);
    expect(t.grounding.totalCriteria).toBe(0);
    // bad date lands in the "unknown" trend bucket only if there were criteria; none here
    expect(t.grounding.trend).toEqual([]);
  });
});

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
