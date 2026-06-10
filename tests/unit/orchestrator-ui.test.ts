/**
 * Unit tests for the debate-research orchestrator UI logic (frontend).
 *
 * Like news-ui.test.ts, these exercise the PURE helpers that back the
 * components — the approval-gate state machine, run lifecycle predicates, cost /
 * token-budget projection, debate-transcript grouping, the https-only URL guard,
 * untrusted-output coercion, the 503/disabled-error signal, and the immutable
 * plan-edit operations — without a DOM renderer (the repo has no jsdom).
 */
import { describe, it, expect } from "vitest";
import {
  isAwaitingApproval,
  isRunActive,
  isRunTerminal,
  projectedCostUsd,
  formatUsd,
  formatTokens,
  tokenBudgetFraction,
  toPercent,
  groupDebateRounds,
  safeHttpsHref,
  outputToText,
  errorMessage,
  isOrchestratorDisabledError,
  stepSummary,
  STEP_LABELS,
  USD_PER_1K_TOKENS,
  type OrchestratorRun,
  type DebateRound,
  type OrchestratorStepArgs,
} from "@/lib/orchestrator";
import {
  moveStepUp,
  moveStepDown,
  removeStep,
  planChanged,
} from "@/lib/orchestrator-plan-edit";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRun(status: OrchestratorRun["status"]): OrchestratorRun {
  return {
    id: "orch-1",
    runId: "run-1",
    task: "task",
    needs: null,
    workspaceId: null,
    status,
    planApprovedAt: null,
    planApprovedBy: null,
    totalTokensUsed: 0,
    stepCount: 0,
    output: null,
    error: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    completedAt: null,
  };
}

// ─── Approval-gate state machine (brief: gate state) ────────────────────────────

describe("isAwaitingApproval", () => {
  it("is TRUE only at awaiting_plan_approval", () => {
    expect(isAwaitingApproval(makeRun("awaiting_plan_approval"))).toBe(true);
  });

  it("is FALSE for every other status and for null/undefined", () => {
    for (const s of ["planning", "executing", "completed", "failed", "cancelled"] as const) {
      expect(isAwaitingApproval(makeRun(s))).toBe(false);
    }
    expect(isAwaitingApproval(null)).toBe(false);
    expect(isAwaitingApproval(undefined)).toBe(false);
  });
});

describe("isRunActive", () => {
  it("is TRUE while planning, awaiting approval, or executing", () => {
    expect(isRunActive(makeRun("planning"))).toBe(true);
    expect(isRunActive(makeRun("awaiting_plan_approval"))).toBe(true);
    expect(isRunActive(makeRun("executing"))).toBe(true);
  });

  it("is FALSE once terminal or when there is no run", () => {
    expect(isRunActive(makeRun("completed"))).toBe(false);
    expect(isRunActive(makeRun("failed"))).toBe(false);
    expect(isRunActive(makeRun("cancelled"))).toBe(false);
    expect(isRunActive(null)).toBe(false);
  });
});

describe("isRunTerminal", () => {
  it("is TRUE only for completed/failed/cancelled", () => {
    expect(isRunTerminal(makeRun("completed"))).toBe(true);
    expect(isRunTerminal(makeRun("failed"))).toBe(true);
    expect(isRunTerminal(makeRun("cancelled"))).toBe(true);
    expect(isRunTerminal(makeRun("executing"))).toBe(false);
    expect(isRunTerminal(null)).toBe(false);
  });
});

// ─── 503 / disabled-state detection (brief: disabled/503 state) ─────────────────

describe("isOrchestratorDisabledError", () => {
  it("detects the shared apiRequest 503 error shape", () => {
    expect(isOrchestratorDisabledError(new Error("503: Orchestrator mode is disabled"))).toBe(true);
  });

  it("detects the route's plain message regardless of status text", () => {
    expect(isOrchestratorDisabledError(new Error("Orchestrator mode is disabled"))).toBe(true);
  });

  it("does NOT flip on unrelated errors", () => {
    expect(isOrchestratorDisabledError(new Error("500: Failed to start orchestrator run"))).toBe(false);
    expect(isOrchestratorDisabledError(new Error("Network error"))).toBe(false);
    expect(isOrchestratorDisabledError(null)).toBe(false);
    expect(isOrchestratorDisabledError(undefined)).toBe(false);
  });
});

describe("errorMessage", () => {
  it("unwraps Error / string / unknown", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage({ weird: true })).toBe("Unexpected error");
  });
});

// ─── Cost / token-budget projection ─────────────────────────────────────────────

describe("projectedCostUsd / formatUsd", () => {
  it("projects from the token budget at the blended rate", () => {
    expect(projectedCostUsd(400_000)).toBeCloseTo(400 * USD_PER_1K_TOKENS, 6);
    expect(formatUsd(projectedCostUsd(400_000))).toBe("$6.00");
  });

  it("returns 0 for non-positive / non-finite budgets", () => {
    expect(projectedCostUsd(0)).toBe(0);
    expect(projectedCostUsd(-5)).toBe(0);
    expect(projectedCostUsd(Number.NaN)).toBe(0);
  });

  it("formats negatives / NaN safely", () => {
    expect(formatUsd(-1)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});

describe("formatTokens", () => {
  it("groups thousands and clamps junk to 0", () => {
    expect(formatTokens(400000)).toBe("400,000");
    expect(formatTokens(-1)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("tokenBudgetFraction", () => {
  it("returns the clamped used/budget fraction", () => {
    expect(tokenBudgetFraction(200_000, 400_000)).toBe(0.5);
    expect(tokenBudgetFraction(800_000, 400_000)).toBe(1);
  });

  it("returns 0 for a zero / negative / non-finite budget", () => {
    expect(tokenBudgetFraction(100, 0)).toBe(0);
    expect(tokenBudgetFraction(100, -1)).toBe(0);
    expect(tokenBudgetFraction(100, Number.NaN)).toBe(0);
  });
});

describe("toPercent", () => {
  it("scales + clamps a 0..1 signal to 0..100", () => {
    expect(toPercent(0.82)).toBe(82);
    expect(toPercent(1.5)).toBe(100);
    expect(toPercent(-1)).toBe(0);
    expect(toPercent(null)).toBe(0);
    expect(toPercent(undefined)).toBe(0);
  });
});

// ─── Step display ────────────────────────────────────────────────────────────

describe("stepSummary / STEP_LABELS", () => {
  it("returns the primary descriptor per step type", () => {
    expect(stepSummary({ type: "research", query: "q", candidateUrls: [] })).toBe("q");
    expect(stepSummary({ type: "analyze-code", query: "ac" })).toBe("ac");
    expect(stepSummary({ type: "debate", question: "dq" })).toBe("dq");
    expect(stepSummary({ type: "ground", query: "gq" })).toBe("gq");
    expect(stepSummary({ type: "synthesize", instruction: "si" })).toBe("si");
  });

  it("falls back to a default synthesize label when no instruction is given", () => {
    expect(stepSummary({ type: "synthesize" })).toBe("Synthesize the final deliverable");
  });

  it("labels every step type", () => {
    expect(STEP_LABELS.research).toBe("Research");
    expect(STEP_LABELS["analyze-code"]).toBe("Analyze code");
    expect(STEP_LABELS.debate).toBe("Debate");
    expect(STEP_LABELS.ground).toBe("Ground");
    expect(STEP_LABELS.synthesize).toBe("Synthesize");
  });
});

// ─── Debate transcript grouping (brief: transcript rendering) ───────────────────

describe("groupDebateRounds", () => {
  const rounds: DebateRound[] = [
    { round: 1, participant: "A", role: "proposer", content: "a1" },
    { round: 2, participant: "A", role: "proposer", content: "a2" },
    { round: 1, participant: "B", role: "critic", content: "b1" },
  ];

  it("groups by round number ascending, preserving in-round turn order", () => {
    const grouped = groupDebateRounds(rounds);
    expect(grouped.map((g) => g.round)).toEqual([1, 2]);
    // round 1 preserves the original A-before-B order
    expect(grouped[0].turns.map((t) => t.participant)).toEqual(["A", "B"]);
    expect(grouped[1].turns.map((t) => t.content)).toEqual(["a2"]);
  });

  it("returns an empty list for no rounds", () => {
    expect(groupDebateRounds([])).toEqual([]);
  });
});

// ─── Untrusted-output coercion + URL guard (Security C3 / M2) ───────────────────

describe("outputToText", () => {
  it("passes strings through and stringifies structured output", () => {
    expect(outputToText("hello")).toBe("hello");
    expect(outputToText(42)).toBe("42");
    expect(outputToText(true)).toBe("true");
    expect(outputToText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("returns empty string for null/undefined", () => {
    expect(outputToText(null)).toBe("");
    expect(outputToText(undefined)).toBe("");
  });
});

describe("safeHttpsHref", () => {
  it("returns the URL only for absolute https URLs", () => {
    expect(safeHttpsHref("https://example.com/post")).toBe("https://example.com/post");
  });

  it("rejects non-https schemes (so the caller renders inert text)", () => {
    expect(safeHttpsHref("http://example.com")).toBeNull();
    expect(safeHttpsHref("javascript:alert(1)")).toBeNull();
    expect(safeHttpsHref("data:text/html,<script>")).toBeNull();
  });

  it("rejects relative / unparseable / empty values", () => {
    expect(safeHttpsHref("/relative")).toBeNull();
    expect(safeHttpsHref("not a url")).toBeNull();
    expect(safeHttpsHref(null)).toBeNull();
    expect(safeHttpsHref("")).toBeNull();
  });
});

// ─── Immutable plan-edit operations (brief: light editing before approve) ───────

describe("plan-edit operations", () => {
  const a: OrchestratorStepArgs = { type: "research", query: "a", candidateUrls: [] };
  const b: OrchestratorStepArgs = { type: "debate", question: "b" };
  const c: OrchestratorStepArgs = { type: "synthesize" };
  const plan: OrchestratorStepArgs[] = [a, b, c];

  it("moveStepUp swaps with the previous step, immutably", () => {
    const out = moveStepUp(plan, 1);
    expect(out).toEqual([b, a, c]);
    expect(plan).toEqual([a, b, c]); // original untouched
  });

  it("moveStepUp is a no-op at the top", () => {
    expect(moveStepUp(plan, 0)).toBe(plan);
  });

  it("moveStepDown swaps with the next step, immutably", () => {
    const out = moveStepDown(plan, 0);
    expect(out).toEqual([b, a, c]);
    expect(plan).toEqual([a, b, c]);
  });

  it("moveStepDown is a no-op at the bottom", () => {
    expect(moveStepDown(plan, plan.length - 1)).toBe(plan);
  });

  it("removeStep drops the step at the index, immutably", () => {
    expect(removeStep(plan, 1)).toEqual([a, c]);
    expect(plan).toEqual([a, b, c]);
  });

  it("removeStep is a no-op out of range", () => {
    expect(removeStep(plan, 9)).toBe(plan);
  });

  it("planChanged detects reorder, removal, and equality", () => {
    expect(planChanged(plan, plan)).toBe(false);
    expect(planChanged(plan, [a, b])).toBe(true); // removal
    expect(planChanged(plan, [b, a, c])).toBe(true); // reorder
    expect(planChanged(plan, [a, b, c])).toBe(false); // same identities
  });
});
