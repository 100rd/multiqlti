/**
 * Unit tests for VectorStore.
 *
 * All database calls are mocked — no real Postgres required.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks (must be before all imports) ────────────────────────────────

const mockReturning = vi.hoisted(() => vi.fn());
const mockInsert = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockDbSelect = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("../../../server/db.js", () => ({
  db: {
    insert: mockInsert,
    delete: mockDelete,
    select: mockDbSelect,
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: mockReturning })),
      })),
    })),
    $client: {
      query: mockQuery,
    },
  },
}));

vi.mock("@shared/schema", () => ({
  memoryChunks: {
    workspaceId: "workspace_id",
    sourceType: "source_type",
    sourceId: "source_id",
    id: "id",
    embedding: "embedding",
    chunkText: "chunk_text",
    metadata: "metadata",
    ts: "ts",
  },
  embeddingProviderConfig: {
    workspaceId: "workspace_id",
    provider: "provider",
    model: "model",
    dimensions: "dimensions",
    config: "config",
    updatedAt: "updated_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  and: vi.fn((...args: unknown[]) => args),
  sql: vi.fn((parts: unknown) => parts),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
  isNotNull: vi.fn((col: unknown) => ({ col })),
}));

import { VectorStore } from "../../../server/memory/vector-store.js";

// ─── Sample data ──────────────────────────────────────────────────────────────

function makeVec(len = 768): number[] {
  return Array.from({ length: len }, () => Math.random());
}

function makeSearchRow(id: string, score: number) {
  return {
    id,
    workspace_id: "ws-1",
    source_type: "document",
    source_id: "doc-1",
    chunk_text: "Some text",
    metadata: {},
    ts: new Date().toISOString(),
    score,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VectorStore", () => {
  let store: VectorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new VectorStore();

    // Default mock implementations
    mockInsert.mockReturnValue({
      values: vi.fn(() => ({
        returning: mockReturning,
        onConflictDoUpdate: vi.fn(() => ({ returning: mockReturning })),
      })),
    });

    mockDelete.mockReturnValue({
      where: vi.fn(() => ({
        returning: mockReturning,
      })),
    });

    mockDbSelect.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          groupBy: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    });
  });

  // ─── insertChunk ──────────────────────────────────────────────────────────

  describe("insertChunk", () => {
    it("calls db.insert and returns the row", async () => {
      const fakeRow = {
        id: "abc",
        workspaceId: "ws-1",
        sourceType: "document" as const,
        sourceId: "doc-1",
        chunkText: "hello",
        metadata: {},
        ts: new Date(),
        embedding: makeVec(),
      };
      mockReturning.mockResolvedValueOnce([fakeRow]);

      const result = await store.insertChunk({
        workspaceId: "ws-1",
        sourceType: "document",
        sourceId: "doc-1",
        chunkText: "hello",
        embedding: makeVec(),
        metadata: {},
      });

      expect(mockInsert).toHaveBeenCalled();
      expect(result).toEqual(fakeRow);
    });
  });

  // ─── insertChunks ─────────────────────────────────────────────────────────

  describe("insertChunks", () => {
    it("returns empty array for empty input without hitting DB", async () => {
      const result = await store.insertChunks([]);
      expect(result).toEqual([]);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("inserts multiple chunks in one call", async () => {
      const rows = [
        { id: "1", workspaceId: "ws-1", sourceType: "document" as const, sourceId: "s1", chunkText: "a", metadata: {}, ts: new Date(), embedding: makeVec() },
        { id: "2", workspaceId: "ws-1", sourceType: "document" as const, sourceId: "s1", chunkText: "b", metadata: {}, ts: new Date(), embedding: makeVec() },
      ];
      mockReturning.mockResolvedValueOnce(rows);

      const result = await store.insertChunks([
        { workspaceId: "ws-1", sourceType: "document", sourceId: "s1", chunkText: "a", embedding: makeVec(), metadata: {} },
        { workspaceId: "ws-1", sourceType: "document", sourceId: "s1", chunkText: "b", embedding: makeVec(), metadata: {} },
      ]);

      expect(mockInsert).toHaveBeenCalledOnce();
      expect(result).toHaveLength(2);
    });
  });

  // ─── search ───────────────────────────────────────────────────────────────

  describe("search", () => {
    it("executes raw SQL query and returns formatted results", async () => {
      const rows = [makeSearchRow("id-1", 0.9), makeSearchRow("id-2", 0.7)];
      mockQuery.mockResolvedValueOnce({ rows });

      const queryVec = makeVec();
      const results = await store.search("ws-1", queryVec, { topK: 5 });

      expect(mockQuery).toHaveBeenCalledOnce();
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("memory_chunks");
      expect(sql).toContain("workspace_id = $1");
      expect(params[0]).toBe("ws-1");
      // Verify vector literal format
      expect(params).toContain(`[${queryVec.join(",")}]`);
    });

    it("applies topK limit via query parameter", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await store.search("ws-1", makeVec(), { topK: 3 });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toContain(3);
    });

    it("returns results with correct score values", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeSearchRow("a", 0.9), makeSearchRow("b", 0.7), makeSearchRow("c", 0.5)],
      });

      const results = await store.search("ws-1", makeVec());
      expect(results[0].score).toBe(0.9);
      expect(results[1].score).toBe(0.7);
      expect(results[2].score).toBe(0.5);
    });

    it("maps result rows to VectorSearchResult shape", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeSearchRow("uuid-1", 0.85)] });
      const results = await store.search("ws-1", makeVec());

      expect(results[0]).toMatchObject({
        id: "uuid-1",
        workspaceId: "ws-1",
        sourceType: "document",
        sourceId: "doc-1",
        chunkText: "Some text",
        score: 0.85,
      });
      expect(results[0].ts).toBeInstanceOf(Date);
    });

    it("filters by sourceTypes by adding IN clause to SQL", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await store.search("ws-1", makeVec(), { sourceTypes: ["code", "document"] });

      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("IN (");
    });

    it("filters by sourceId by adding equality to params", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await store.search("ws-1", makeVec(), { sourceId: "specific-doc" });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toContain("specific-doc");
    });

    it("returns empty array when no results", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const results = await store.search("ws-1", makeVec());
      expect(results).toEqual([]);
    });

    it("passes minScore as query parameter", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await store.search("ws-1", makeVec(), { minScore: 0.6 });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toContain(0.6);
    });
  });

  // ─── deleteBySource ───────────────────────────────────────────────────────

  describe("deleteBySource", () => {
    it("calls db.delete and returns count of deleted rows", async () => {
      mockReturning.mockResolvedValueOnce([{ id: "1" }, { id: "2" }]);

      const count = await store.deleteBySource("ws-1", "document", "doc-1");
      expect(mockDelete).toHaveBeenCalled();
      expect(count).toBe(2);
    });

    it("returns 0 when nothing matched", async () => {
      mockReturning.mockResolvedValueOnce([]);
      const count = await store.deleteBySource("ws-1", "code", "nonexistent");
      expect(count).toBe(0);
    });
  });

  // ─── deleteByWorkspace ────────────────────────────────────────────────────

  describe("deleteByWorkspace", () => {
    it("deletes all chunks for workspace and returns count", async () => {
      mockReturning.mockResolvedValueOnce([{ id: "1" }, { id: "2" }, { id: "3" }]);
      const count = await store.deleteByWorkspace("ws-1");
      expect(mockDelete).toHaveBeenCalled();
      expect(count).toBe(3);
    });
  });

  // ─── countChunks ─────────────────────────────────────────────────────────

  describe("countChunks", () => {
    it("returns 0 when no rows returned", async () => {
      mockDbSelect.mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      });

      const count = await store.countChunks("ws-1");
      expect(count).toBe(0);
    });

    it("returns count from query result", async () => {
      mockDbSelect.mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 42 }]),
        })),
      });

      const count = await store.countChunks("ws-1");
      expect(count).toBe(42);
    });
  });

  // ─── listSources ─────────────────────────────────────────────────────────

  describe("listSources", () => {
    it("returns grouped sources from query", async () => {
      const mockSources = [
        { sourceType: "document", sourceId: "doc-1", count: 10 },
        { sourceType: "code", sourceId: "src/index.ts", count: 5 },
      ];
      mockDbSelect.mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue(mockSources),
            })),
          })),
        })),
      });

      const sources = await store.listSources("ws-1");
      expect(sources).toHaveLength(2);
      expect(sources[0]).toMatchObject({ sourceType: "document", sourceId: "doc-1", count: 10 });
    });

    it("returns empty array when no sources exist", async () => {
      const sources = await store.listSources("ws-1");
      expect(sources).toEqual([]);
    });
  });
});
