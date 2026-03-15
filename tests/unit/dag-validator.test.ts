/**
 * Unit tests — DAG Structure Validator
 */
import { describe, it, expect } from "vitest";
import { validateDAGStructure } from "../../server/pipeline/dag-validator.js";
import type { PipelineDAG, DAGStage } from "../../shared/types.js";

function makeStage(id: string): DAGStage {
  return {
    id,
    teamId: "planning",
    modelSlug: "mock",
    enabled: true,
    position: { x: 0, y: 0 },
  };
}

function makeDAG(stages: DAGStage[], edges: PipelineDAG["edges"] = []): PipelineDAG {
  return { stages, edges };
}

describe("validateDAGStructure", () => {
  // ── Empty DAG ──────────────────────────────────────────────────────────────
  it("rejects empty stages array", () => {
    const result = validateDAGStructure(makeDAG([]));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/at least one stage/i);
  });

  // ── Valid DAGs ─────────────────────────────────────────────────────────────
  it("accepts a single-stage DAG with no edges", () => {
    const result = validateDAGStructure(makeDAG([makeStage("s1")]));
    expect(result.ok).toBe(true);
  });

  it("accepts a two-stage linear chain", () => {
    const dag = makeDAG(
      [makeStage("s1"), makeStage("s2")],
      [{ id: "e1", from: "s1", to: "s2" }],
    );
    expect(validateDAGStructure(dag).ok).toBe(true);
  });

  it("accepts a diamond shape (fork and join)", () => {
    const dag = makeDAG(
      [makeStage("start"), makeStage("left"), makeStage("right"), makeStage("end")],
      [
        { id: "e1", from: "start", to: "left" },
        { id: "e2", from: "start", to: "right" },
        { id: "e3", from: "left", to: "end" },
        { id: "e4", from: "right", to: "end" },
      ],
    );
    expect(validateDAGStructure(dag).ok).toBe(true);
  });

  // ── Duplicate Stage IDs ────────────────────────────────────────────────────
  it("rejects duplicate stage IDs", () => {
    const result = validateDAGStructure(makeDAG([makeStage("s1"), makeStage("s1")]));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/duplicate stage id/i);
  });

  // ── Invalid Edge References ────────────────────────────────────────────────
  it("rejects edge referencing unknown from-stage", () => {
    const dag = makeDAG(
      [makeStage("s1")],
      [{ id: "e1", from: "unknown", to: "s1" }],
    );
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown stage/i);
  });

  it("rejects edge referencing unknown to-stage", () => {
    const dag = makeDAG(
      [makeStage("s1")],
      [{ id: "e1", from: "s1", to: "ghost" }],
    );
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown stage/i);
  });

  it("rejects self-loop edges", () => {
    const dag = makeDAG(
      [makeStage("s1")],
      [{ id: "e1", from: "s1", to: "s1" }],
    );
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/self-loop/i);
  });

  // ── Cycle Detection ────────────────────────────────────────────────────────
  it("rejects a two-node cycle (A→B→A)", () => {
    const dag = makeDAG(
      [makeStage("A"), makeStage("B")],
      [
        { id: "e1", from: "A", to: "B" },
        { id: "e2", from: "B", to: "A" },
      ],
    );
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cycle/i);
  });

  it("rejects a three-node cycle (A→B→C→A)", () => {
    const dag = makeDAG(
      [makeStage("A"), makeStage("B"), makeStage("C")],
      [
        { id: "e1", from: "A", to: "B" },
        { id: "e2", from: "B", to: "C" },
        { id: "e3", from: "C", to: "A" },
      ],
    );
    const result = validateDAGStructure(dag);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cycle/i);
  });

  it("does not flag disconnected subgraphs as cycles", () => {
    // Two separate chains in one DAG — valid
    const dag = makeDAG(
      [makeStage("a1"), makeStage("a2"), makeStage("b1"), makeStage("b2")],
      [
        { id: "e1", from: "a1", to: "a2" },
        { id: "e2", from: "b1", to: "b2" },
      ],
    );
    expect(validateDAGStructure(dag).ok).toBe(true);
  });

  // ── Edges with Conditions ──────────────────────────────────────────────────
  it("accepts edges that carry conditions", () => {
    const dag = makeDAG(
      [makeStage("s1"), makeStage("s2")],
      [
        {
          id: "e1",
          from: "s1",
          to: "s2",
          condition: { field: "score", operator: "gt", value: 0.5 },
        },
      ],
    );
    expect(validateDAGStructure(dag).ok).toBe(true);
  });
});
