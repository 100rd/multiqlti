import { describe, it, expect } from "vitest";
import { readConvergence } from "../../../server/services/orchestrator/convergence.js";
import type { ConvergenceVerdict } from "@shared/types";

const p0 = { title: "fix race", priority: "P0", rationale: "data loss" };
const p1 = { title: "add docs", priority: "P1" };

interface Case {
  name: string;
  input: unknown;
  expected: ConvergenceVerdict;
}

const cases: Case[] = [
  {
    name: "trusted convergence object — converged true (0 P0)",
    input: { output: { convergence: { converged: true, open_p0: 0, open_action_points: [] } } },
    expected: { converged: true, openP0: 0, openActionPoints: [] },
  },
  {
    name: "trusted convergence object — P0s present, converged false",
    input: { output: { convergence: { converged: false, open_p0: 1, open_action_points: [p0] } } },
    expected: { converged: false, openP0: 1, openActionPoints: [p0] },
  },
  {
    name: "trusted object accepted when passed as bare output (no wrapper)",
    input: { convergence: { converged: true, open_p0: 0, open_action_points: [] } },
    expected: { converged: true, openP0: 0, openActionPoints: [] },
  },
  {
    name: "trusted object: open_p0 inferred from list when omitted",
    input: { output: { convergence: { converged: false, open_action_points: [p0] } } },
    expected: { converged: false, openP0: 1, openActionPoints: [p0] },
  },
  {
    name: "fallback: no convergence object, derive from action_points — clean (0 P0)",
    input: { output: { action_points: [p1] } },
    expected: { converged: true, openP0: 0, openActionPoints: [] },
  },
  {
    name: "fallback: derive from action_points — open P0s",
    input: { output: { action_points: [p0, p1, { title: "another", priority: "P0" }] } },
    expected: {
      converged: false,
      openP0: 2,
      openActionPoints: [p0, { title: "another", priority: "P0" }],
    },
  },
  {
    name: "fallback works on an unwrapped judge body (no .output)",
    input: { action_points: [p0] },
    expected: { converged: false, openP0: 1, openActionPoints: [p0] },
  },
  {
    name: "empty action_points → conservatively converged (positively zero P0)",
    input: { output: { action_points: [] } },
    expected: { converged: true, openP0: 0, openActionPoints: [] },
  },
  {
    name: "no verdict at all → conservatively NOT converged",
    input: { output: { verdict: "looks good", pros: ["x"] } },
    expected: { converged: false, openP0: 0, openActionPoints: [] },
  },
  {
    name: "malformed convergence falls through to action_points",
    input: { output: { convergence: { converged: "yes" }, action_points: [p0] } },
    expected: { converged: false, openP0: 1, openActionPoints: [p0] },
  },
  {
    name: "malformed everything → conservatively NOT converged",
    input: { output: { convergence: 42, action_points: "nope" } },
    expected: { converged: false, openP0: 0, openActionPoints: [] },
  },
  {
    name: "null input → conservatively NOT converged",
    input: null,
    expected: { converged: false, openP0: 0, openActionPoints: [] },
  },
  {
    name: "string input → conservatively NOT converged",
    input: "not an object",
    expected: { converged: false, openP0: 0, openActionPoints: [] },
  },
  {
    name: "array input → conservatively NOT converged",
    input: [p0],
    expected: { converged: false, openP0: 0, openActionPoints: [] },
  },
];

describe("readConvergence — trust-then-derive convergence verdict", () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(readConvergence(c.input)).toEqual(c.expected);
    });
  }

  it("never throws on hostile/cyclic-ish input", () => {
    expect(() => readConvergence(undefined)).not.toThrow();
    expect(() => readConvergence({ output: { convergence: null } })).not.toThrow();
  });

  // ─── Output bounds (Security L-2) ─────────────────────────────────────────

  it("caps openActionPoints to 50 on the derived path", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      title: `p${i}`,
      priority: "P0",
    }));
    const r = readConvergence({ output: { action_points: many } });
    expect(r.openActionPoints).toHaveLength(50);
    expect(r.openP0).toBe(50); // openP0 derives from the bounded list here
    expect(r.converged).toBe(false);
  });

  it("caps openActionPoints to 50 on the trusted path (openP0 keeps judge count)", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      title: `p${i}`,
      priority: "P0",
    }));
    const r = readConvergence({
      output: { convergence: { converged: false, open_p0: 200, open_action_points: many } },
    });
    expect(r.openActionPoints).toHaveLength(50);
    expect(r.openP0).toBe(200); // the judge's own count signal is preserved
  });

  it("truncates per-field string lengths (title 500, others 1000) on both paths", () => {
    const bloated = {
      title: "t".repeat(2000),
      priority: "P0",
      effort: "e".repeat(2000),
      rationale: "r".repeat(2000),
      tradeoff: "x".repeat(2000),
    };
    const derived = readConvergence({ output: { action_points: [bloated] } });
    const ap = derived.openActionPoints[0];
    expect(ap.title).toHaveLength(500);
    expect(ap.priority).toBe("P0");
    expect(ap.effort).toHaveLength(1000);
    expect(ap.rationale).toHaveLength(1000);
    expect(ap.tradeoff).toHaveLength(1000);

    const trusted = readConvergence({
      output: { convergence: { converged: false, open_action_points: [bloated] } },
    });
    const tap = trusted.openActionPoints[0];
    expect(tap.title).toHaveLength(500);
    expect(tap.rationale).toHaveLength(1000);
  });
});

// ─── Stage B (design §5): per-criterion verification method ─────────────────

import { extractActionPoints, normalizeActionPointMethods, archetypeDefaultMethod } from "../../../server/services/orchestrator/convergence.js";

describe("Stage B — verificationMethod carry + enum-clamp", () => {
  it("carries a VALID judge-proposed method through readConvergence + extractActionPoints", () => {
    const judge = {
      output: {
        action_points: [
          { title: "rotate secret", priority: "P0", verificationMethod: "manual-ops" },
          { title: "improve readme", priority: "P0", verificationMethod: "judge" },
          { title: "fix parser", priority: "P0", verificationMethod: "test-run" },
        ],
      },
    };
    const conv = readConvergence(judge);
    expect(conv.openActionPoints.map((a) => a.verificationMethod)).toEqual(["manual-ops", "judge", "test-run"]);
    const all = extractActionPoints(judge);
    expect(all.map((a) => a.verificationMethod)).toEqual(["manual-ops", "judge", "test-run"]);
  });

  it("DROPS an invalid/injected method to absent (enum-clamp) WITHOUT dropping the action point", () => {
    const judge = {
      output: {
        action_points: [
          { title: "sneaky", priority: "P0", verificationMethod: "web-evidence" }, // not judge-proposable
          { title: "evil", priority: "P0", verificationMethod: "rm -rf /" }, // garbage
        ],
      },
    };
    const all = extractActionPoints(judge);
    // Both action points survive; the invalid methods are dropped to absent.
    expect(all).toHaveLength(2);
    expect(all[0].verificationMethod).toBeUndefined();
    expect(all[1].verificationMethod).toBeUndefined();
  });
});

describe("Stage B — normalizeActionPointMethods (planner assignment)", () => {
  it("fills ABSENT methods from the archetype default, never overriding a proposal", () => {
    const aps = [
      { title: "a", priority: "P0" }, // absent → default
      { title: "b", priority: "P0", verificationMethod: "manual-ops" as const }, // kept
    ];
    const repo = normalizeActionPointMethods(aps, "repo-assessment");
    expect(repo.map((a) => a.verificationMethod)).toEqual(["test-run", "manual-ops"]);
    const research = normalizeActionPointMethods(aps, "research");
    expect(research.map((a) => a.verificationMethod)).toEqual(["web-evidence", "manual-ops"]);
    const nul = normalizeActionPointMethods(aps, null);
    expect(nul.map((a) => a.verificationMethod)).toEqual(["test-run", "manual-ops"]);
  });

  it("archetypeDefaultMethod: research→web-evidence, else test-run", () => {
    expect(archetypeDefaultMethod("research")).toBe("web-evidence");
    expect(archetypeDefaultMethod("repo-assessment")).toBe("test-run");
    expect(archetypeDefaultMethod("infra")).toBe("test-run");
    expect(archetypeDefaultMethod(null)).toBe("test-run");
  });
});

// ─── Stage C (design §9 "Stage 7"): acceptance-criterion QA ─────────────────

import { isWeakCriterion, applyCriteriaQa } from "../../../server/services/orchestrator/convergence.js";
import type { ActionPoint } from "@shared/types";

// A criterion that PASSES every rule for a test-run AP: has the shape, is long,
// and names a concrete observable signal.
const GOOD_TESTRUN =
  "When the parser receives a malformed header, then it returns a 400 with error code E_HEADER";

describe("Stage C — isWeakCriterion lint heuristics", () => {
  it("(a) flags an ABSENT or empty/whitespace criterion as weak", () => {
    expect(isWeakCriterion(undefined, "test-run")).toBe(true);
    expect(isWeakCriterion("", "test-run")).toBe(true);
    expect(isWeakCriterion("   ", "test-run")).toBe(true);
    expect(isWeakCriterion(undefined, "judge")).toBe(true);
  });

  it("(b) flags a criterion missing the 'When … Then …' shape", () => {
    // no when/then at all
    expect(isWeakCriterion("The endpoint returns the right value for all inputs", "judge")).toBe(true);
    // "then" before "when" is not the required order
    expect(isWeakCriterion("Return 400 then log, when malformed", "judge")).toBe(true);
    // only one of the two markers
    expect(isWeakCriterion("When the input is malformed the parser rejects it", "judge")).toBe(true);
  });

  it("(c) test-run: flags a shaped-but-too-short criterion (<= 40 chars)", () => {
    // shape present but far too thin to name a runnable observable
    expect(isWeakCriterion("When x then y", "test-run")).toBe(true);
  });

  it("(c) test-run: flags a shaped, long criterion made of PURELY abstract filler", () => {
    // EVERY content token is abstract glue (works/correct/passes/valid/…) — names no
    // concrete observable. Structural words (when/then/it/is/and/the) don't count.
    const abstract = "When done then it works correctly and passes and is valid and complete and fine";
    expect(abstract.length).toBeGreaterThan(40);
    expect(isWeakCriterion(abstract, "test-run")).toBe(true);
  });

  it("(c) test-run: a single concrete token is enough to survive (false-negative bias)", () => {
    // adding one non-abstract token ("parser") makes it pass — conservative on purpose.
    const oneConcrete = "When done then the parser works correctly and passes and is valid and complete";
    expect(oneConcrete.length).toBeGreaterThan(40);
    expect(isWeakCriterion(oneConcrete, "test-run")).toBe(false);
  });

  it("(c) is NOT applied to judge/manual-ops (only test-run gets the concrete-signal bar)", () => {
    // a short but shaped criterion is fine for judge / manual-ops (adjudicated by model/human)
    expect(isWeakCriterion("When x then y", "judge")).toBe(false);
    expect(isWeakCriterion("When x then y", "manual-ops")).toBe(false);
  });

  it("passes a well-formed, concrete test-run criterion (false-negative bias — good ones survive)", () => {
    expect(isWeakCriterion(GOOD_TESTRUN, "test-run")).toBe(false);
    // absent method is treated leniently (no test-run concrete-signal bar)
    expect(isWeakCriterion("When the flag is set then the banner renders", undefined)).toBe(false);
  });
});

describe("Stage C — applyCriteriaQa demotion", () => {
  it("demotes a weak/absent-criterion test-run AP to judge and flags weakCriterion", () => {
    const aps: ActionPoint[] = [
      { title: "no dod", priority: "P0", verificationMethod: "test-run" }, // absent criterion
      { title: "vacuous", priority: "P0", acceptanceCriterion: "When x then y", verificationMethod: "test-run" }, // too short
    ];
    const out = applyCriteriaQa(aps);
    expect(out.map((a) => a.verificationMethod)).toEqual(["judge", "judge"]);
    expect(out.map((a) => a.weakCriterion)).toEqual([true, true]);
  });

  it("leaves a GOOD test-run criterion untouched (no weakCriterion field, method unchanged)", () => {
    const aps: ActionPoint[] = [
      { title: "solid", priority: "P0", acceptanceCriterion: GOOD_TESTRUN, verificationMethod: "test-run" },
    ];
    const out = applyCriteriaQa(aps);
    expect(out[0].verificationMethod).toBe("test-run");
    expect(out[0].weakCriterion).toBeUndefined();
    // returned unchanged (referential passthrough for a passing AP)
    expect(out[0]).toBe(aps[0]);
  });

  it("PRESERVES manual-ops even when its criterion is weak (still flagged, never a test)", () => {
    const aps: ActionPoint[] = [
      { title: "rotate secret", priority: "P0", verificationMethod: "manual-ops" }, // absent criterion
    ];
    const out = applyCriteriaQa(aps);
    expect(out[0].verificationMethod).toBe("manual-ops");
    expect(out[0].weakCriterion).toBe(true);
  });

  it("does not mutate the input array/objects (pure)", () => {
    const aps: ActionPoint[] = [{ title: "x", priority: "P0", verificationMethod: "test-run" }];
    const out = applyCriteriaQa(aps);
    expect(aps[0].weakCriterion).toBeUndefined();
    expect(aps[0].verificationMethod).toBe("test-run");
    expect(out).not.toBe(aps);
  });
});
