/**
 * Unit tests — DAG Executor (pure functions)
 *
 * Tests computeReadyStages and assembleStageInput without spinning up
 * the full executor or making real storage/ws calls.
 */
import { describe, it, expect } from "vitest";
import { computeReadyStages, assembleStageInput } from "../../server/pipeline/dag-executor.js";
import type { PipelineDAG, DAGStage } from "../../shared/types.js";

function makeStage(id: string, enabled = true): DAGStage {
  return {
    id,
    teamId: "planning",
    modelSlug: "mock",
    enabled,
    position: { x: 0, y: 0 },
  };
}

function makeState(
  completed: string[] = [],
  skipped: string[] = [],
  active: string[] = [],
  outputs: [string, Record<string, unknown>][] = [],
) {
  return {
    completedStageIds: new Set(completed),
    skippedStageIds: new Set(skipped),
    stageOutputs: new Map(outputs),
    activeStageIds: new Set(active),
    stageIndexCounter: 0,
  };
}

// ─── computeReadyStages ───────────────────────────────────────────────────────

describe("computeReadyStages", () => {
  it("returns all root stages (no incoming edges) when none are done", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A"), makeStage("B"), makeStage("C")],
      edges: [{ id: "e1", from: "A", to: "C" }],
    };
    const ready = computeReadyStages(dag, makeState());
    // A has no incoming edges; B has no edges; C depends on A
    const ids = ready.map((s) => s.id).sort();
    expect(ids).toEqual(["A", "B"]);
  });

  it("excludes disabled stages", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A", false), makeStage("B")],
      edges: [],
    };
    const ready = computeReadyStages(dag, makeState());
    expect(ready.map((s) => s.id)).toEqual(["B"]);
  });

  it("excludes already-completed stages", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A"), makeStage("B")],
      edges: [],
    };
    const ready = computeReadyStages(dag, makeState(["A"]));
    expect(ready.map((s) => s.id)).toEqual(["B"]);
  });

  it("excludes active stages", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A"), makeStage("B")],
      edges: [],
    };
    const ready = computeReadyStages(dag, makeState([], [], ["A"]));
    expect(ready.map((s) => s.id)).toEqual(["B"]);
  });

  it("unblocks downstream stage once parent completes", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A"), makeStage("B")],
      edges: [{ id: "e1", from: "A", to: "B" }],
    };
    const ready = computeReadyStages(dag, makeState(["A"]));
    expect(ready.map((s) => s.id)).toEqual(["B"]);
  });

  it("keeps downstream stage blocked if parent is still active", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A"), makeStage("B")],
      edges: [{ id: "e1", from: "A", to: "B" }],
    };
    const ready = computeReadyStages(dag, makeState([], [], ["A"]));
    expect(ready).toHaveLength(0);
  });

  it("marks stage as skipped when no edge conditions pass", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A"), makeStage("B")],
      edges: [
        {
          id: "e1",
          from: "A",
          to: "B",
          condition: { field: "score", operator: "gt", value: 0.9 },
        },
      ],
    };
    // Parent A completed with score=0.5 — condition fails
    const state = makeState(["A"], [], [], [["A", { score: 0.5 }]]);
    const ready = computeReadyStages(dag, state);
    expect(ready).toHaveLength(0);
    expect(state.skippedStageIds.has("B")).toBe(true);
  });

  it("marks stage as ready when at least one edge condition passes (OR semantics)", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A"), makeStage("B"), makeStage("C")],
      edges: [
        // Two edges into C — one from A (no condition), one from B (condition fails)
        { id: "e1", from: "A", to: "C" },
        {
          id: "e2",
          from: "B",
          to: "C",
          condition: { field: "score", operator: "gt", value: 0.9 },
        },
      ],
    };
    const state = makeState(["A", "B"], [], [], [
      ["A", {}],
      ["B", { score: 0.1 }],
    ]);
    const ready = computeReadyStages(dag, state);
    // e1 has no condition so it always passes — C should be ready
    expect(ready.map((s) => s.id)).toContain("C");
    expect(state.skippedStageIds.has("C")).toBe(false);
  });

  it("handles diamond convergence — waits for both parents", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("start"), makeStage("left"), makeStage("right"), makeStage("end")],
      edges: [
        { id: "e1", from: "start", to: "left" },
        { id: "e2", from: "start", to: "right" },
        { id: "e3", from: "left", to: "end" },
        { id: "e4", from: "right", to: "end" },
      ],
    };
    // Only left completed; right is still active
    const state = makeState(["start", "left"], [], ["right"]);
    const ready = computeReadyStages(dag, state);
    // end should NOT be ready — right is still active (not completed/skipped)
    expect(ready.map((s) => s.id)).not.toContain("end");
  });
});

// ─── assembleStageInput ───────────────────────────────────────────────────────

describe("assembleStageInput", () => {
  it("returns taskDescription for root stages (no incoming edges)", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A")],
      edges: [],
    };
    const input = assembleStageInput(
      makeStage("A"),
      dag,
      makeState(),
      "do something",
    );
    expect(input).toEqual({ taskDescription: "do something" });
  });

  it("returns parent output for single-parent stages", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A"), makeStage("B")],
      edges: [{ id: "e1", from: "A", to: "B" }],
    };
    const parentOutput = { result: "done" };
    const state = makeState(["A"], [], [], [["A", parentOutput]]);
    const input = assembleStageInput(makeStage("B"), dag, state, "task");
    expect(input).toEqual(parentOutput);
  });

  it("merges multiple parent outputs keyed by stage ID", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A"), makeStage("B"), makeStage("C")],
      edges: [
        { id: "e1", from: "A", to: "C" },
        { id: "e2", from: "B", to: "C" },
      ],
    };
    const state = makeState(["A", "B"], [], [], [
      ["A", { fromA: 1 }],
      ["B", { fromB: 2 }],
    ]);
    const input = assembleStageInput(makeStage("C"), dag, state, "task");
    expect(input).toEqual({ A: { fromA: 1 }, B: { fromB: 2 } });
  });

  it("omits skipped parents from merged input", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("A"), makeStage("B"), makeStage("C")],
      edges: [
        { id: "e1", from: "A", to: "C" },
        { id: "e2", from: "B", to: "C" },
      ],
    };
    // Only A completed; B was skipped
    const state = makeState(["A"], ["B"], [], [["A", { fromA: 1 }]]);
    const input = assembleStageInput(makeStage("C"), dag, state, "task");
    // B was skipped (not in completedStageIds) — only A's output appears
    expect((input as Record<string, unknown>)["A"]).toEqual({ fromA: 1 });
    expect((input as Record<string, unknown>)["B"]).toBeUndefined();
  });
});
