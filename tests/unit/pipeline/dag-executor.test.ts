import { describe, it, expect } from "vitest";
import type { DAGStage, DAGEdge, PipelineDAG } from "../../../shared/types.js";
import { computeReadyStages, assembleStageInput } from "../../../server/pipeline/dag-executor.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStage(id: string): DAGStage {
  return {
    id,
    teamId: "planning",
    modelSlug: "mock",
    enabled: true,
    position: { x: 0, y: 0 },
  };
}

function makeEdge(from: string, to: string, conditionField?: string): DAGEdge {
  const edge: DAGEdge = { id: `${from}->${to}`, from, to };
  if (conditionField) {
    edge.condition = { field: conditionField, operator: "exists" };
  }
  return edge;
}

function makeState(opts: {
  completed?: string[];
  skipped?: string[];
  active?: string[];
  outputs?: Record<string, Record<string, unknown>>;
}) {
  return {
    completedStageIds: new Set(opts.completed ?? []),
    skippedStageIds: new Set(opts.skipped ?? []),
    activeStageIds: new Set(opts.active ?? []),
    stageOutputs: new Map(Object.entries(opts.outputs ?? {})),
    stageIndexCounter: 0,
  };
}

// ─── computeReadyStages ───────────────────────────────────────────────────────

describe("computeReadyStages — root stages", () => {
  it("returns all root stages at start", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s2")],
      edges: [],
    };
    const state = makeState({});
    const ready = computeReadyStages(dag, state);
    expect(ready.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("skips disabled root stages", () => {
    const stage = makeStage("s1");
    stage.enabled = false;
    const dag: PipelineDAG = {
      stages: [stage, makeStage("s2")],
      edges: [],
    };
    const ready = computeReadyStages(dag, makeState({}));
    expect(ready.map((s) => s.id)).toEqual(["s2"]);
  });
});

describe("computeReadyStages — blocked stages", () => {
  it("blocks a stage when parent is not yet complete", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s2")],
      edges: [makeEdge("s1", "s2")],
    };
    const state = makeState({}); // s1 not complete
    const ready = computeReadyStages(dag, state);
    expect(ready.map((s) => s.id)).toEqual(["s1"]);
  });

  it("unblocks stage when parent completes", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s2")],
      edges: [makeEdge("s1", "s2")],
    };
    const state = makeState({ completed: ["s1"] });
    const ready = computeReadyStages(dag, state);
    expect(ready.map((s) => s.id)).toEqual(["s2"]);
  });
});

describe("computeReadyStages — condition-based skipping", () => {
  it("skips stage when edge condition is not met", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s2")],
      edges: [makeEdge("s1", "s2", "score")],
    };
    // parent completed but output has no "score" field
    const state = makeState({
      completed: ["s1"],
      outputs: { s1: { status: "done" } },
    });
    const ready = computeReadyStages(dag, state);
    // s2 should not be in ready because condition fails
    expect(ready.map((s) => s.id)).not.toContain("s2");
    // s2 should be added to skipped
    expect(state.skippedStageIds.has("s2")).toBe(true);
  });

  it("keeps stage when edge has no condition", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s2")],
      edges: [makeEdge("s1", "s2")],
    };
    const state = makeState({ completed: ["s1"] });
    const ready = computeReadyStages(dag, state);
    expect(ready.map((s) => s.id)).toContain("s2");
  });

  it("keeps stage when edge condition is met", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s2")],
      edges: [makeEdge("s1", "s2", "score")],
    };
    const state = makeState({
      completed: ["s1"],
      outputs: { s1: { score: 95 } },
    });
    const ready = computeReadyStages(dag, state);
    expect(ready.map((s) => s.id)).toContain("s2");
  });
});

describe("computeReadyStages — already active stages excluded", () => {
  it("does not return stages that are already active", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1")],
      edges: [],
    };
    const state = makeState({ active: ["s1"] });
    expect(computeReadyStages(dag, state)).toHaveLength(0);
  });
});

// ─── assembleStageInput ───────────────────────────────────────────────────────

describe("assembleStageInput — root stage", () => {
  it("root stage gets taskDescription from run input", () => {
    const stage = makeStage("s1");
    const dag: PipelineDAG = { stages: [stage], edges: [] };
    const state = makeState({});
    const input = assembleStageInput(stage, dag, state, "do some task");
    expect(input).toEqual({ taskDescription: "do some task" });
  });
});

describe("assembleStageInput — single parent", () => {
  it("single-parent stage gets parent output directly", () => {
    const s1 = makeStage("s1");
    const s2 = makeStage("s2");
    const dag: PipelineDAG = {
      stages: [s1, s2],
      edges: [makeEdge("s1", "s2")],
    };
    const state = makeState({
      completed: ["s1"],
      outputs: { s1: { summary: "work done" } },
    });
    const input = assembleStageInput(s2, dag, state, "original");
    expect(input).toEqual({ summary: "work done" });
  });
});

describe("assembleStageInput — multi-parent merge", () => {
  it("multi-parent stage merges parent outputs keyed by stage ID", () => {
    const s1 = makeStage("s1");
    const s2 = makeStage("s2");
    const s3 = makeStage("s3");
    const dag: PipelineDAG = {
      stages: [s1, s2, s3],
      edges: [makeEdge("s1", "s3"), makeEdge("s2", "s3")],
    };
    const state = makeState({
      completed: ["s1", "s2"],
      outputs: {
        s1: { result: "from s1" },
        s2: { result: "from s2" },
      },
    });
    const input = assembleStageInput(s3, dag, state, "original");
    expect(input).toEqual({
      s1: { result: "from s1" },
      s2: { result: "from s2" },
    });
  });

  it("multi-parent merge excludes skipped parents", () => {
    const s1 = makeStage("s1");
    const s2 = makeStage("s2");
    const s3 = makeStage("s3");
    const dag: PipelineDAG = {
      stages: [s1, s2, s3],
      edges: [makeEdge("s1", "s3"), makeEdge("s2", "s3")],
    };
    const state = makeState({
      completed: ["s1"],
      skipped: ["s2"],
      outputs: { s1: { result: "from s1" } },
    });
    const input = assembleStageInput(s3, dag, state, "original");
    expect(input).toEqual({ s1: { result: "from s1" } });
    expect(input).not.toHaveProperty("s2");
  });
});
