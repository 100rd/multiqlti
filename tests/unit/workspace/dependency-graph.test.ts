/**
 * Unit tests for DependencyGraph (Phase 6.9)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock DB ──────────────────────────────────────────────────────────────────

type MockSymbolRow = {
  id: string;
  workspaceId: string;
  filePath: string;
  name: string;
  kind: string;
  line: number;
  col: number;
  signature: string | null;
  fileHash: string;
  exportedFrom: string | null;
  createdAt: Date;
  updatedAt: Date;
};

let mockSymbolRows: MockSymbolRow[] = [];

vi.mock("../../../server/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (_cond: unknown) => {
          void _cond;
          return Promise.resolve([...mockSymbolRows]);
        },
      }),
    }),
  },
}));

import { DependencyGraph } from "../../../server/workspace/dependency-graph.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeImportSymbol(
  workspaceId: string,
  filePath: string,
  specifier: string,
  line = 1,
): MockSymbolRow {
  return {
    id: `sym-${Math.random()}`,
    workspaceId,
    filePath,
    name: specifier,
    kind: "import",
    line,
    col: 0,
    signature: null,
    fileHash: "hash",
    exportedFrom: specifier,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeFunctionSymbol(
  workspaceId: string,
  filePath: string,
  name: string,
  line = 5,
): MockSymbolRow {
  return {
    id: `sym-${Math.random()}`,
    workspaceId,
    filePath,
    name,
    kind: "function",
    line,
    col: 0,
    signature: `function ${name}()`,
    fileHash: "hash",
    exportedFrom: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DependencyGraph", () => {
  beforeEach(() => {
    mockSymbolRows = [];
  });

  it("1. two files with one import → one edge, two nodes", async () => {
    mockSymbolRows = [
      makeImportSymbol("ws-001", "src/a.ts", "./b"),
    ];

    const dg = new DependencyGraph();
    const graph = await dg.buildGraph("ws-001");

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].source).toBe("src/a.ts");
    expect(graph.edges[0].target).toContain("src/b");
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("2. circular import (A→B, B→A) → two edges, handles without infinite loop", async () => {
    mockSymbolRows = [
      makeImportSymbol("ws-001", "src/a.ts", "./b"),
      makeImportSymbol("ws-001", "src/b.ts", "./a"),
    ];

    const dg = new DependencyGraph();
    // Should not throw or loop
    const graph = await dg.buildGraph("ws-001");

    expect(graph.edges).toHaveLength(2);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("3. bare module specifier ('react') excluded from graph", async () => {
    mockSymbolRows = [
      makeImportSymbol("ws-001", "src/a.ts", "react"),
      makeImportSymbol("ws-001", "src/a.ts", "./b"),
    ];

    const dg = new DependencyGraph();
    const graph = await dg.buildGraph("ws-001");

    // Only the relative import should produce an edge
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].source).toBe("src/a.ts");
  });

  it("4. cached result returned on second call", async () => {
    mockSymbolRows = [
      makeImportSymbol("ws-001", "src/a.ts", "./b"),
    ];

    const dg = new DependencyGraph();
    const graph1 = await dg.buildGraph("ws-001");

    // Change mockSymbolRows — result should still be cached
    mockSymbolRows = [];
    const graph2 = await dg.buildGraph("ws-001");

    expect(graph2.edges).toHaveLength(graph1.edges.length);
    expect(graph2).toBe(graph1); // Same reference from cache
  });

  it("5. invalidateCache causes rebuild from DB on next call", async () => {
    mockSymbolRows = [
      makeImportSymbol("ws-001", "src/a.ts", "./b"),
    ];

    const dg = new DependencyGraph();
    await dg.buildGraph("ws-001");

    // Invalidate and change DB
    dg.invalidateCache("ws-001");
    mockSymbolRows = [];

    const graph2 = await dg.buildGraph("ws-001");
    expect(graph2.edges).toHaveLength(0);
  });

  it("6. findReferences returns files that import the named symbol's defining file", async () => {
    // a.ts defines myFunc, b.ts imports from ./a
    mockSymbolRows = [
      makeFunctionSymbol("ws-001", "src/a.ts", "myFunc"),
      makeImportSymbol("ws-001", "src/b.ts", "./a"),
    ];

    const dg = new DependencyGraph();
    const refs = await dg.findReferences("ws-001", "myFunc");

    expect(refs).toHaveLength(1);
    expect(refs[0].file).toBe("src/b.ts");
  });

  it("7. findReferences returns empty array for unknown symbol", async () => {
    mockSymbolRows = [];

    const dg = new DependencyGraph();
    const refs = await dg.findReferences("ws-001", "unknownSymbol");

    expect(refs).toHaveLength(0);
  });

  it("8. findDefinition returns correct file/line/col/signature", async () => {
    mockSymbolRows = [
      makeFunctionSymbol("ws-001", "src/utils.ts", "calculateTotal", 42),
    ];

    const dg = new DependencyGraph();
    const def = await dg.findDefinition("ws-001", "calculateTotal");

    expect(def).not.toBeNull();
    expect(def!.file).toBe("src/utils.ts");
    expect(def!.line).toBe(42);
    expect(def!.signature).toBe("function calculateTotal()");
  });

  it("9. findDefinition returns null for symbol not in index", async () => {
    mockSymbolRows = [];

    const dg = new DependencyGraph();
    const def = await dg.findDefinition("ws-001", "ghostSymbol");

    expect(def).toBeNull();
  });
});
