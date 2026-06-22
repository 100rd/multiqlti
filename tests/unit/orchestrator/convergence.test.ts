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
