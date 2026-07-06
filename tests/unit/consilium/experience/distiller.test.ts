/**
 * distiller.test.ts — DREAM-1: the PURE grounding logic. The load-bearing rule under
 * test (experience-plane-dream.md §1/§3/§6): `confidence` is a function of HOW the claim
 * was verified by an INDEPENDENT signal, NEVER of a coder's self-report.
 *
 * Covers:
 *   - a converged loop with a test-run-PASSED criterion ⇒ a `verified` item (independent-pass)
 *     with correct evidence (loopId/round/apTitle/diffRef) + verification (method/outcome/ratio);
 *   - a coder-believed-but-verifier-REFUTED AP (test-run ran & failed) ⇒ a `refuted` item;
 *   - a late-AP REGRESSION (passed, then failed at final re-verify) ⇒ a `refuted` item;
 *   - neither (a judge criterion in a non-converged loop) ⇒ an `observed` item;
 *   - a JUDGE criterion is NEVER `verified` on its own say-so (only loop convergence lifts it);
 *   - a RUNNING (non-terminal) loop ⇒ NOT distilled (empty);
 *   - duplicate claims across rounds collapse to ONE item (strongest confidence wins);
 *   - a huge trace is BOUNDED (never OOMs) — items capped.
 */
import { describe, it, expect } from "vitest";
import { distillLoop, type DistilledRoundInput } from "../../../../server/services/consilium/experience/distiller.js";
import type { ConsiliumLoopRow } from "@shared/schema";
import type { ExecutionCriterion, ExecutionTrace } from "@shared/types";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeLoop(p: Partial<ConsiliumLoopRow> & { id: string }): ConsiliumLoopRow {
  const base = {
    projectId: "proj-1",
    groupId: "grp-1",
    state: "converged",
    round: 1,
    maxRounds: 6,
    repoPath: "/repos/widget",
    prRef: null,
    archetype: "repo-assessment",
    archetypeSource: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T01:00:00.000Z"),
    completedAt: null,
    // Fields the distiller does not read — filled loosely.
  };
  return { ...base, ...p } as unknown as ConsiliumLoopRow;
}

function crit(p: Partial<ExecutionCriterion>): ExecutionCriterion {
  return { criterion: "When run, Then pass", method: "test-run", ran: true, passed: true, ...p };
}

function traceWith(
  criteria: ExecutionCriterion[],
  opts?: { workerTitle?: string; green?: boolean },
): ExecutionTrace {
  return {
    schemaVersion: 1,
    archetype: "repo-assessment",
    controller: {
      kind: "sdlc-executor",
      label: "SDLC executor (coder)",
      green: opts?.green ?? true,
      workers: [
        {
          index: 1,
          priority: "P0",
          title: opts?.workerTitle ?? "Add coverage gate",
          status: "completed",
          skills: [],
          criteria,
        },
      ],
    },
  };
}

function round(r: number, trace: ExecutionTrace | null, headCommit: string | null = "abc123"): DistilledRoundInput {
  return { round: r, executionTrace: trace, headCommit };
}

const OPTS = { dreamRunId: "dream-1", groundingRatioAtTime: 0.75 };

// ── Tests ───────────────────────────────────────────────────────────────────

describe("distillLoop — grounding", () => {
  it("a converged loop with a test-run-PASSED criterion ⇒ one verified item, full evidence", () => {
    const loop = makeLoop({ id: "loop-1", state: "converged", prRef: "acme/widget#42" });
    const items = distillLoop(loop, [round(1, traceWith([crit({ method: "test-run", ran: true, passed: true })]))], OPTS);

    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.confidence).toBe("verified");
    expect(it0.verification).toEqual({ method: "test-run", outcome: "independent-pass", groundingRatioAtTime: 0.75 });
    expect(it0.scope).toEqual({ repo: "widget", archetype: "repo-assessment", criterionClass: "test-run" });
    expect(it0.sourceLoopId).toBe("loop-1");
    expect(it0.evidence).toEqual([{ loopId: "loop-1", round: 1, apTitle: "Add coverage gate", diffRef: "abc123" }]);
    expect(it0.provenance.sourceLoops).toEqual(["loop-1"]);
    expect(it0.provenance.dreamRunId).toBe("dream-1");
    expect(it0.successDelta).toBeNull();
    expect(it0.claim).toContain("widget");
    expect(it0.claim).toContain("VERIFIED");
  });

  it("a coder-believed-but-verifier-REFUTED AP (test-run ran & failed) ⇒ a refuted item", () => {
    const loop = makeLoop({ id: "loop-2", state: "stopped_cap" });
    const items = distillLoop(loop, [round(1, traceWith([crit({ method: "test-run", ran: true, passed: false })]))], OPTS);

    expect(items).toHaveLength(1);
    expect(items[0].confidence).toBe("refuted");
    expect(items[0].verification.outcome).toBe("independent-fail");
    expect(items[0].claim).toContain("REFUTED");
  });

  it("a late-AP REGRESSION (passed, failed at final re-verify) ⇒ a refuted item", () => {
    const loop = makeLoop({ id: "loop-3", state: "converged" });
    const items = distillLoop(
      loop,
      [round(1, traceWith([crit({ method: "test-run", ran: true, passed: true, passedAtFinal: false })]))],
      OPTS,
    );
    expect(items).toHaveLength(1);
    expect(items[0].confidence).toBe("refuted");
    expect(items[0].verification.outcome).toBe("regressed");
  });

  it("neither (a JUDGE criterion in a NON-converged loop) ⇒ an observed item", () => {
    const loop = makeLoop({ id: "loop-4", state: "escalated" });
    const items = distillLoop(loop, [round(1, traceWith([crit({ method: "judge", ran: true, passed: true })]))], OPTS);
    expect(items).toHaveLength(1);
    expect(items[0].confidence).toBe("observed");
    expect(items[0].verification.outcome).toBe("unverified");
  });

  it("a JUDGE criterion is NEVER verified on its own — only loop CONVERGENCE can lift it", () => {
    // Same judge-passed criterion, but now the loop CONVERGED (independent terminal gate).
    const loop = makeLoop({ id: "loop-5", state: "converged" });
    const items = distillLoop(loop, [round(1, traceWith([crit({ method: "judge", ran: true, passed: true })]))], OPTS);
    expect(items).toHaveLength(1);
    expect(items[0].confidence).toBe("verified");
    expect(items[0].verification.outcome).toBe("loop-converged");
  });

  it("a manual-ops criterion is NEVER ground-truth (observed), even in a converged loop", () => {
    // manual-ops is surfaced, never green (passed:false always) — so it stays observed.
    const loop = makeLoop({ id: "loop-6", state: "converged" });
    const items = distillLoop(loop, [round(1, traceWith([crit({ method: "manual-ops", ran: false, passed: false })]))], OPTS);
    expect(items).toHaveLength(1);
    expect(items[0].confidence).toBe("observed");
  });

  it("a NOT-ADJUDICATED test-run (timedOut) ⇒ observed, never refuted", () => {
    const loop = makeLoop({ id: "loop-7", state: "stopped_cap" });
    const items = distillLoop(
      loop,
      [round(1, traceWith([crit({ method: "test-run", ran: true, passed: false, timedOut: true })]))],
      OPTS,
    );
    expect(items).toHaveLength(1);
    expect(items[0].confidence).toBe("observed");
  });

  it("a RUNNING (non-terminal) loop is NEVER distilled", () => {
    const loop = makeLoop({ id: "loop-8", state: "developing" });
    const items = distillLoop(loop, [round(1, traceWith([crit({ method: "test-run", ran: true, passed: true })]))], OPTS);
    expect(items).toEqual([]);
  });

  it("groundingRatioAtTime is null when telemetry is unavailable", () => {
    const loop = makeLoop({ id: "loop-9", state: "converged" });
    const items = distillLoop(loop, [round(1, traceWith([crit({})]))], { dreamRunId: "d", groundingRatioAtTime: null });
    expect(items[0].verification.groundingRatioAtTime).toBeNull();
  });

  it("duplicate claims across rounds collapse to ONE item (strongest confidence wins, evidence accumulates)", () => {
    // Same AP title + same method across two rounds: round 1 observed (judge), round 2
    // verified (test-run pass). They share the SAME claim text? No — the claim embeds the
    // confidence, so a change in confidence is a different claim. To exercise the MERGE
    // path we use the SAME confidence twice (two test-run passes on the same AP).
    const loop = makeLoop({ id: "loop-10", state: "converged" });
    const items = distillLoop(
      loop,
      [
        round(1, traceWith([crit({ method: "test-run", ran: true, passed: true })], { workerTitle: "Add gate" }), "c1"),
        round(2, traceWith([crit({ method: "test-run", ran: true, passed: true })], { workerTitle: "Add gate" }), "c2"),
      ],
      OPTS,
    );
    expect(items).toHaveLength(1);
    expect(items[0].confidence).toBe("verified");
    expect(items[0].evidence).toHaveLength(2);
    expect(items[0].evidence.map((e) => e.diffRef)).toEqual(["c1", "c2"]);
  });

  it("bounds a HUGE trace — items are capped (never OOM)", () => {
    const loop = makeLoop({ id: "loop-11", state: "converged" });
    // 500 distinct workers, each a unique AP title ⇒ 500 distinct candidate keys, but the
    // distiller caps DISTINCT items per loop at 50.
    const workers = Array.from({ length: 500 }, (_, i) => ({
      index: i,
      priority: "P0",
      title: `AP number ${i}`,
      status: "completed" as const,
      skills: [],
      criteria: [crit({ method: "test-run", ran: true, passed: true })],
    }));
    const trace: ExecutionTrace = {
      schemaVersion: 1,
      archetype: "repo-assessment",
      controller: { kind: "sdlc-executor", label: "x", green: true, workers },
    };
    const items = distillLoop(loop, [round(1, trace)], OPTS);
    expect(items.length).toBeLessThanOrEqual(50);
  });

  it("a terminal loop with NO execution trace ⇒ no items (nothing gradeable)", () => {
    const loop = makeLoop({ id: "loop-12", state: "cancelled" });
    const items = distillLoop(loop, [round(1, null)], OPTS);
    expect(items).toEqual([]);
  });
});
