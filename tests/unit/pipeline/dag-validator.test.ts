import { describe, it, expect } from "vitest";
import type { DAGStage, DAGEdge, PipelineDAG } from "../../../shared/types.js";
import { validateDAGStructure } from "../../../server/pipeline/dag-validator.js";

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

function makeEdge(id: string, from: string, to: string): DAGEdge {
  return { id, from, to };
}

// ─── validateDAGStructure ─────────────────────────────────────────────────────

describe("validateDAGStructure — valid DAGs", () => {
  it("accepts a single-stage DAG", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1")],
      edges: [],
    };
    expect(validateDAGStructure(dag)).toEqual({ ok: true });
  });

  it("accepts a linear 3-stage DAG", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s2"), makeStage("s3")],
      edges: [makeEdge("e1", "s1", "s2"), makeEdge("e2", "s2", "s3")],
    };
    expect(validateDAGStructure(dag)).toEqual({ ok: true });
  });

  it("accepts a diamond DAG (no cycle)", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s2"), makeStage("s3"), makeStage("s4")],
      edges: [
        makeEdge("e1", "s1", "s2"),
        makeEdge("e2", "s1", "s3"),
        makeEdge("e3", "s2", "s4"),
        makeEdge("e4", "s3", "s4"),
      ],
    };
    expect(validateDAGStructure(dag)).toEqual({ ok: true });
  });
});

describe("validateDAGStructure — rejects empty DAG", () => {
  it("rejects DAG with no stages", () => {
    const result = validateDAGStructure({ stages: [], edges: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/at least one stage/i);
  });
});

describe("validateDAGStructure — duplicate stage IDs", () => {
  it("rejects duplicate stage IDs", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s1")],
      edges: [],
    };
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/duplicate/i);
  });
});

describe("validateDAGStructure — invalid edge references", () => {
  it("rejects edge with unknown from stage", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1")],
      edges: [makeEdge("e1", "unknown", "s1")],
    };
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown/i);
  });

  it("rejects edge with unknown to stage", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1")],
      edges: [makeEdge("e1", "s1", "unknown")],
    };
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown/i);
  });

  it("rejects self-loop edge", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1")],
      edges: [makeEdge("e1", "s1", "s1")],
    };
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/self-loop/i);
  });
});

describe("validateDAGStructure — cycle detection", () => {
  it("rejects simple 2-node cycle", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s2")],
      edges: [makeEdge("e1", "s1", "s2"), makeEdge("e2", "s2", "s1")],
    };
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cycle/i);
  });

  it("rejects 3-node cycle", () => {
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s2"), makeStage("s3")],
      edges: [
        makeEdge("e1", "s1", "s2"),
        makeEdge("e2", "s2", "s3"),
        makeEdge("e3", "s3", "s1"),
      ],
    };
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cycle/i);
  });

  it("rejects cycle in subgraph with isolated root", () => {
    // s1 → s2, s3 → s4 → s3
    const dag: PipelineDAG = {
      stages: [makeStage("s1"), makeStage("s2"), makeStage("s3"), makeStage("s4")],
      edges: [
        makeEdge("e1", "s1", "s2"),
        makeEdge("e2", "s3", "s4"),
        makeEdge("e3", "s4", "s3"),
      ],
    };
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cycle/i);
  });
});
