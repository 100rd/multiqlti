/**
 * Unit tests for IndexSnapshot (Issue #284)
 *
 * Tests snapshot + WAL write/read, checkpoint compaction,
 * WAL replay correctness, version mismatch, and workspace mismatch handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";

// ─── Mock fs/promises ─────────────────────────────────────────────────────────

type FileStore = Map<string, string>;
const fileStore: FileStore = new Map();

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (p: string) => {
      const content = fileStore.get(p);
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return content;
    }),
    writeFile: vi.fn(async (p: string, content: string) => {
      fileStore.set(p, content);
    }),
    appendFile: vi.fn(async (p: string, content: string) => {
      const existing = fileStore.get(p) ?? "";
      fileStore.set(p, existing + content);
    }),
    rename: vi.fn(async (src: string, dest: string) => {
      const content = fileStore.get(src);
      if (content === undefined) throw new Error("ENOENT");
      fileStore.set(dest, content);
      fileStore.delete(src);
    }),
    unlink: vi.fn(async (p: string) => {
      fileStore.delete(p);
    }),
    access: vi.fn(async (p: string) => {
      if (!fileStore.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
  },
}));

import {
  IndexSnapshot,
  SNAPSHOT_FILENAME,
  WAL_FILENAME,
  SERIALIZATION_VERSION,
} from "../../../server/workspace/index-snapshot.js";
import { PatchableGraph } from "../../../server/workspace/patchable-graph.js";

const DATA_DIR = "/workspace/test/.multiqlti-index";
const WS_ID = "ws-test-001";

function snapshotPath(): string {
  return path.join(DATA_DIR, SNAPSHOT_FILENAME);
}

function walPath(): string {
  return path.join(DATA_DIR, WAL_FILENAME);
}

function makeGraph(nodeIds: string[]): PatchableGraph {
  const g = new PatchableGraph();
  for (const id of nodeIds) {
    g.addNode({ id, label: id, importCount: 0, importedByCount: 0 });
  }
  return g;
}

describe("IndexSnapshot", () => {
  let snap: IndexSnapshot;

  beforeEach(() => {
    fileStore.clear();
    snap = new IndexSnapshot(DATA_DIR, WS_ID);
  });

  it("1. load() returns fresh graph when no snapshot exists", async () => {
    const result = await snap.load();
    expect(result.fromCache).toBe(false);
    expect(result.walEntriesReplayed).toBe(0);
    expect(result.graph.nodeCount()).toBe(0);
  });

  it("2. checkpoint() writes a snapshot file", async () => {
    const g = makeGraph(["src/a.ts", "src/b.ts"]);
    await snap.checkpoint(g);
    expect(fileStore.has(snapshotPath())).toBe(true);

    const raw = fileStore.get(snapshotPath())!;
    const parsed = JSON.parse(raw);
    expect(parsed.serializationVersion).toBe(SERIALIZATION_VERSION);
    expect(parsed.workspaceId).toBe(WS_ID);
    expect(parsed.graph.nodes).toHaveLength(2);
  });

  it("3. load() after checkpoint() restores graph from cache", async () => {
    const g = makeGraph(["src/a.ts", "src/b.ts"]);
    await snap.checkpoint(g);

    const result = await snap.load();
    expect(result.fromCache).toBe(true);
    expect(result.graph.nodeCount()).toBe(2);
    expect(result.graph.hasNode("src/a.ts")).toBe(true);
  });

  it("4. appendWal() writes a WAL entry", async () => {
    await snap.appendWal([{ kind: "addNode", id: "src/a.ts", node: { id: "src/a.ts", label: "a.ts", importCount: 0, importedByCount: 0 } }]);
    expect(fileStore.has(walPath())).toBe(true);
    const walContent = fileStore.get(walPath())!;
    expect(walContent).toContain("addNode");
  });

  it("5. load() replays WAL entries after snapshot", async () => {
    // Checkpoint with one node
    const g = makeGraph(["src/a.ts"]);
    await snap.checkpoint(g);

    // Append a WAL entry adding another node
    await snap.appendWal([{ kind: "addNode", id: "src/b.ts", node: { id: "src/b.ts", label: "b.ts", importCount: 0, importedByCount: 0 } }]);

    const result = await snap.load();
    expect(result.fromCache).toBe(true);
    expect(result.walEntriesReplayed).toBe(1);
    expect(result.graph.hasNode("src/b.ts")).toBe(true);
    expect(result.graph.nodeCount()).toBe(2);
  });

  it("6. WAL replays removeNode correctly", async () => {
    const g = makeGraph(["src/a.ts", "src/b.ts"]);
    await snap.checkpoint(g);
    await snap.appendWal([{ kind: "removeNode", id: "src/b.ts" }]);

    const result = await snap.load();
    expect(result.graph.hasNode("src/b.ts")).toBe(false);
    expect(result.graph.nodeCount()).toBe(1);
  });

  it("7. WAL replays addEdge correctly", async () => {
    const g = makeGraph(["src/a.ts", "src/b.ts"]);
    await snap.checkpoint(g);

    const edge = { id: "src/a.ts→src/b.ts", source: "src/a.ts", target: "src/b.ts" };
    await snap.appendWal([{ kind: "addEdge", id: edge.id, edge }]);

    const result = await snap.load();
    expect(result.graph.hasEdge("src/a.ts→src/b.ts")).toBe(true);
  });

  it("8. WAL replays removeEdge correctly", async () => {
    const g = makeGraph(["src/a.ts", "src/b.ts"]);
    g.addEdge({ id: "src/a.ts→src/b.ts", source: "src/a.ts", target: "src/b.ts" });
    await snap.checkpoint(g);

    await snap.appendWal([{ kind: "removeEdge", id: "src/a.ts→src/b.ts" }]);

    const result = await snap.load();
    expect(result.graph.hasEdge("src/a.ts→src/b.ts")).toBe(false);
  });

  it("9. checkpoint() truncates WAL after writing snapshot", async () => {
    const g = makeGraph(["src/a.ts"]);
    await snap.appendWal([{ kind: "addNode", id: "src/b.ts", node: { id: "src/b.ts", label: "b.ts", importCount: 0, importedByCount: 0 } }]);
    await snap.checkpoint(g);
    // WAL should be empty after checkpoint
    expect(fileStore.get(walPath())).toBe("");
  });

  it("10. version mismatch in snapshot causes fresh graph return", async () => {
    // Write a snapshot with wrong version
    const fakeSnap = {
      serializationVersion: SERIALIZATION_VERSION + 1,
      workspaceId: WS_ID,
      graph: {
        nodes: [{ id: "src/a.ts", label: "a.ts", importCount: 0, importedByCount: 0 }],
        edges: [],
        version: 1,
        snapshotAt: new Date().toISOString(),
      },
    };
    fileStore.set(snapshotPath(), JSON.stringify(fakeSnap));

    const result = await snap.load();
    expect(result.fromCache).toBe(false);
    expect(result.graph.nodeCount()).toBe(0);
  });

  it("11. workspace ID mismatch in snapshot causes fresh graph return", async () => {
    const g = makeGraph(["src/a.ts"]);
    // Checkpoint with a different workspace ID
    const snap2 = new IndexSnapshot(DATA_DIR, "other-workspace");
    await snap2.checkpoint(g);

    // Load with original workspace ID — should not restore
    const result = await snap.load();
    expect(result.fromCache).toBe(false);
  });

  it("12. malformed WAL line is skipped without crashing", async () => {
    const g = makeGraph(["src/a.ts"]);
    await snap.checkpoint(g);

    // Append a malformed WAL entry
    const walContent = fileStore.get(walPath()) ?? "";
    fileStore.set(walPath(), walContent + "THIS IS NOT JSON\n");

    // Should not throw
    const result = await snap.load();
    expect(result.graph.nodeCount()).toBe(1);
  });

  it("13. clear() removes snapshot and WAL files", async () => {
    const g = makeGraph(["src/a.ts"]);
    await snap.checkpoint(g);
    await snap.appendWal([{ kind: "addNode", id: "src/b.ts", node: { id: "src/b.ts", label: "b.ts", importCount: 0, importedByCount: 0 } }]);

    await snap.clear();

    expect(fileStore.has(snapshotPath())).toBe(false);
    expect(fileStore.has(walPath())).toBe(false);
  });

  it("14. hasSnapshot() returns true when snapshot file exists", async () => {
    const g = makeGraph(["src/a.ts"]);
    await snap.checkpoint(g);
    expect(await snap.hasSnapshot()).toBe(true);
  });

  it("15. hasSnapshot() returns false when no snapshot", async () => {
    expect(await snap.hasSnapshot()).toBe(false);
  });

  it("16. snapshot + WAL produces same graph as full build", async () => {
    // Build a graph manually
    const g = new PatchableGraph();
    g.addNode({ id: "src/a.ts", label: "a.ts", importCount: 0, importedByCount: 0 });
    g.addNode({ id: "src/b.ts", label: "b.ts", importCount: 0, importedByCount: 0 });
    g.addEdge({ id: "src/a.ts→src/b.ts", source: "src/a.ts", target: "src/b.ts" });

    // Checkpoint snapshot (nodes a, b; edge a→b)
    const snapG = new PatchableGraph();
    snapG.addNode({ id: "src/a.ts", label: "a.ts", importCount: 0, importedByCount: 0 });
    await snap.checkpoint(snapG);

    // WAL: add b, add edge
    await snap.appendWal([
      { kind: "addNode", id: "src/b.ts", node: { id: "src/b.ts", label: "b.ts", importCount: 0, importedByCount: 0 } },
      { kind: "addEdge", id: "src/a.ts→src/b.ts", edge: { id: "src/a.ts→src/b.ts", source: "src/a.ts", target: "src/b.ts" } },
    ]);

    const result = await snap.load();
    expect(result.graph.nodeCount()).toBe(2);
    expect(result.graph.edgeCount()).toBe(1);
    expect(result.graph.hasNode("src/b.ts")).toBe(true);
    expect(result.graph.hasEdge("src/a.ts→src/b.ts")).toBe(true);
  });
});
