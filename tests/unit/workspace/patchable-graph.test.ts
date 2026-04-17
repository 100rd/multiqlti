/**
 * Unit tests for PatchableGraph (Issue #284)
 *
 * Tests addNode, removeNode, addEdge, removeEdge, adjacency counts,
 * patch flush, snapshot, restore, and WAL replay (applyOp).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PatchableGraph, type GraphNode, type GraphEdge } from "../../../server/workspace/patchable-graph.js";

function makeNode(id: string): GraphNode {
  return { id, label: id.split("/").pop() ?? id, importCount: 0, importedByCount: 0 };
}

function makeEdge(source: string, target: string): GraphEdge {
  return { id: `${source}→${target}`, source, target };
}

describe("PatchableGraph", () => {
  let graph: PatchableGraph;

  beforeEach(() => {
    graph = new PatchableGraph();
  });

  // ── addNode ──────────────────────────────────────────────────────────────────

  it("1. addNode stores the node and it can be queried", () => {
    graph.addNode(makeNode("src/a.ts"));
    expect(graph.hasNode("src/a.ts")).toBe(true);
    expect(graph.getNode("src/a.ts")?.id).toBe("src/a.ts");
  });

  it("2. addNode emits an addNode patch op", () => {
    graph.addNode(makeNode("src/a.ts"));
    const patch = graph.flushPatch();
    expect(patch.some((op) => op.kind === "addNode" && op.id === "src/a.ts")).toBe(true);
  });

  it("3. addNode replacing existing node emits removeNode + addNode pair", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.flushPatch(); // clear first patch
    graph.addNode({ ...makeNode("src/a.ts"), importCount: 5 });
    const patch = graph.flushPatch();
    expect(patch.some((op) => op.kind === "removeNode" && op.id === "src/a.ts")).toBe(true);
    expect(patch.some((op) => op.kind === "addNode" && op.id === "src/a.ts")).toBe(true);
  });

  it("4. nodeCount reflects actual count", () => {
    expect(graph.nodeCount()).toBe(0);
    graph.addNode(makeNode("src/a.ts"));
    graph.addNode(makeNode("src/b.ts"));
    expect(graph.nodeCount()).toBe(2);
  });

  // ── removeNode ───────────────────────────────────────────────────────────────

  it("5. removeNode removes the node", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.flushPatch();
    graph.removeNode("src/a.ts");
    expect(graph.hasNode("src/a.ts")).toBe(false);
  });

  it("6. removeNode on absent id is a no-op", () => {
    expect(() => graph.removeNode("does-not-exist.ts")).not.toThrow();
    const patch = graph.flushPatch();
    expect(patch).toHaveLength(0);
  });

  it("7. removeNode cascades to all connected edges", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.addNode(makeNode("src/b.ts"));
    graph.addEdge(makeEdge("src/a.ts", "src/b.ts"));
    graph.flushPatch();

    graph.removeNode("src/a.ts");
    expect(graph.hasEdge("src/a.ts→src/b.ts")).toBe(false);
  });

  it("8. removeNode emits removeNode patch op", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.flushPatch();
    graph.removeNode("src/a.ts");
    const patch = graph.flushPatch();
    expect(patch.some((op) => op.kind === "removeNode" && op.id === "src/a.ts")).toBe(true);
  });

  // ── addEdge ──────────────────────────────────────────────────────────────────

  it("9. addEdge stores the edge", () => {
    const edge = makeEdge("src/a.ts", "src/b.ts");
    graph.addEdge(edge);
    expect(graph.hasEdge(edge.id)).toBe(true);
  });

  it("10. addEdge emits addEdge patch op", () => {
    graph.addEdge(makeEdge("src/a.ts", "src/b.ts"));
    const patch = graph.flushPatch();
    expect(patch.some((op) => op.kind === "addEdge")).toBe(true);
  });

  it("11. addEdge updates importCount on source node", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.addNode(makeNode("src/b.ts"));
    graph.addEdge(makeEdge("src/a.ts", "src/b.ts"));
    expect(graph.getNode("src/a.ts")?.importCount).toBe(1);
  });

  it("12. addEdge updates importedByCount on target node", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.addNode(makeNode("src/b.ts"));
    graph.addEdge(makeEdge("src/a.ts", "src/b.ts"));
    expect(graph.getNode("src/b.ts")?.importedByCount).toBe(1);
  });

  it("13. adding the same edge twice is idempotent in final state", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.addNode(makeNode("src/b.ts"));
    graph.addEdge(makeEdge("src/a.ts", "src/b.ts"));
    graph.addEdge(makeEdge("src/a.ts", "src/b.ts")); // second add
    expect(graph.edgeCount()).toBe(1);
    // importCount should still be 1 — re-add removes old then adds new
    expect(graph.getNode("src/a.ts")?.importCount).toBe(1);
  });

  // ── removeEdge ───────────────────────────────────────────────────────────────

  it("14. removeEdge removes the edge", () => {
    const edge = makeEdge("src/a.ts", "src/b.ts");
    graph.addEdge(edge);
    graph.flushPatch();
    graph.removeEdge(edge.id);
    expect(graph.hasEdge(edge.id)).toBe(false);
  });

  it("15. removeEdge emits removeEdge patch op", () => {
    const edge = makeEdge("src/a.ts", "src/b.ts");
    graph.addEdge(edge);
    graph.flushPatch();
    graph.removeEdge(edge.id);
    const patch = graph.flushPatch();
    expect(patch.some((op) => op.kind === "removeEdge" && op.id === edge.id)).toBe(true);
  });

  it("16. removeEdge decrements importCount on source", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.addNode(makeNode("src/b.ts"));
    graph.addEdge(makeEdge("src/a.ts", "src/b.ts"));
    graph.flushPatch();
    graph.removeEdge("src/a.ts→src/b.ts");
    expect(graph.getNode("src/a.ts")?.importCount).toBe(0);
  });

  it("17. removeEdge on absent id is a no-op", () => {
    expect(() => graph.removeEdge("phantom→edge")).not.toThrow();
    const patch = graph.flushPatch();
    expect(patch).toHaveLength(0);
  });

  // ── Patch flush ──────────────────────────────────────────────────────────────

  it("18. flushPatch clears the pending buffer", () => {
    graph.addNode(makeNode("src/a.ts"));
    const p1 = graph.flushPatch();
    expect(p1.length).toBeGreaterThan(0);
    const p2 = graph.flushPatch();
    expect(p2).toHaveLength(0);
  });

  it("19. flushPatch increments currentVersion", () => {
    const v0 = graph.currentVersion;
    graph.addNode(makeNode("src/a.ts"));
    graph.flushPatch();
    expect(graph.currentVersion).toBe(v0 + 1);
  });

  // ── Snapshot & restore ───────────────────────────────────────────────────────

  it("20. snapshot captures all nodes and edges", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.addNode(makeNode("src/b.ts"));
    graph.addEdge(makeEdge("src/a.ts", "src/b.ts"));

    const snap = graph.snapshot();
    expect(snap.nodes).toHaveLength(2);
    expect(snap.edges).toHaveLength(1);
    expect(snap.nodes.map((n) => n.id)).toContain("src/a.ts");
    expect(snap.edges[0].source).toBe("src/a.ts");
  });

  it("21. restore recreates nodes and edges from snapshot", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.addNode(makeNode("src/b.ts"));
    graph.addEdge(makeEdge("src/a.ts", "src/b.ts"));

    const snap = graph.snapshot();

    const g2 = new PatchableGraph();
    g2.restore(snap);

    expect(g2.hasNode("src/a.ts")).toBe(true);
    expect(g2.hasNode("src/b.ts")).toBe(true);
    expect(g2.hasEdge("src/a.ts→src/b.ts")).toBe(true);
  });

  it("22. restore preserves version number", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.flushPatch(); // version becomes 1

    const snap = graph.snapshot();
    const g2 = new PatchableGraph();
    g2.restore(snap);
    expect(g2.currentVersion).toBe(1);
  });

  // ── WAL replay (applyOp) ─────────────────────────────────────────────────────

  it("23. applyOp addNode replays a node addition", () => {
    const node = makeNode("src/a.ts");
    graph.applyOp({ kind: "addNode", id: "src/a.ts", node });
    expect(graph.hasNode("src/a.ts")).toBe(true);
  });

  it("24. applyOp removeNode replays a node removal", () => {
    graph.addNode(makeNode("src/a.ts"));
    graph.flushPatch();
    graph.applyOp({ kind: "removeNode", id: "src/a.ts" });
    expect(graph.hasNode("src/a.ts")).toBe(false);
  });

  it("25. applyOp addEdge replays an edge addition", () => {
    const edge = makeEdge("src/a.ts", "src/b.ts");
    graph.applyOp({ kind: "addEdge", id: edge.id, edge });
    expect(graph.hasEdge(edge.id)).toBe(true);
  });

  it("26. applyOp removeEdge replays an edge removal", () => {
    const edge = makeEdge("src/a.ts", "src/b.ts");
    graph.addEdge(edge);
    graph.flushPatch();
    graph.applyOp({ kind: "removeEdge", id: edge.id });
    expect(graph.hasEdge(edge.id)).toBe(false);
  });

  it("27. applyOp does NOT add to pendingPatch (WAL replay is clean)", () => {
    const node = makeNode("src/a.ts");
    graph.applyOp({ kind: "addNode", id: "src/a.ts", node });
    const patch = graph.flushPatch();
    expect(patch).toHaveLength(0);
  });

  // ── allNodes / allEdges ──────────────────────────────────────────────────────

  it("28. allNodes returns copies (mutation does not affect internal state)", () => {
    graph.addNode(makeNode("src/a.ts"));
    const nodes = graph.allNodes();
    nodes[0].importCount = 999;
    expect(graph.getNode("src/a.ts")?.importCount).toBe(0);
  });

  it("29. allEdges returns copies (mutation does not affect internal state)", () => {
    graph.addEdge(makeEdge("src/a.ts", "src/b.ts"));
    const edges = graph.allEdges();
    edges[0].source = "mutated";
    expect(graph.getEdge("src/a.ts→src/b.ts")?.source).toBe("src/a.ts");
  });

  it("30. multi-edge scenario: A→B, A→C, B→C counts are correct", () => {
    graph.addNode(makeNode("a.ts"));
    graph.addNode(makeNode("b.ts"));
    graph.addNode(makeNode("c.ts"));
    graph.addEdge(makeEdge("a.ts", "b.ts"));
    graph.addEdge(makeEdge("a.ts", "c.ts"));
    graph.addEdge(makeEdge("b.ts", "c.ts"));

    expect(graph.getNode("a.ts")?.importCount).toBe(2);
    expect(graph.getNode("b.ts")?.importCount).toBe(1);
    expect(graph.getNode("c.ts")?.importedByCount).toBe(2);
    expect(graph.getNode("b.ts")?.importedByCount).toBe(1);
  });
});
