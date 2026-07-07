/**
 * Unit tests for the memory_search tool (vector/RAG only — Subsystem B).
 *
 * The structured-memory (Subsystem A) and federation branches were retired
 * along with the pipeline engine; this tool is now a thin wrapper over
 * VectorStore semantic search. Tests focus on the tool's contract: input
 * validation, output formatting, and graceful degradation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mockSearch = vi.hoisted(() => vi.fn());
const mockGetEmbeddingConfig = vi.hoisted(() => vi.fn());

vi.mock("../../../server/memory/vector-store", () => ({
  VectorStore: class MockVectorStore {
    async search(...args: unknown[]) {
      return mockSearch(...args);
    }
    async getEmbeddingConfig(...args: unknown[]) {
      return mockGetEmbeddingConfig(...args);
    }
  },
}));

vi.mock("../../../server/memory/embeddings", () => ({
  EmbeddingProviderFactory: {
    create: vi.fn().mockReturnValue({
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    }),
  },
  DEFAULT_EMBEDDING_CONFIG: {
    provider: "ollama",
    model: "nomic-embed-text",
    dimensions: 768,
  },
}));

import { memorySearchHandler } from "../../../server/tools/builtin/memory-search";

// ─── Sample data ──────────────────────────────────────────────────────────────

function makeChunk(overrides: Partial<{ chunkText: string; sourceType: string; sourceId: string; score: number }> = {}) {
  return {
    chunkText: "Some embedded knowledge chunk content",
    sourceType: "document",
    sourceId: "doc-1",
    score: 0.85,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("memorySearchHandler", () => {
  beforeEach(() => {
    mockSearch.mockReset().mockResolvedValue([]);
    mockGetEmbeddingConfig.mockReset().mockResolvedValue(null);
  });

  // ─── Input validation ────────────────────────────────────────────────────────

  it("returns error message for empty query", async () => {
    const result = await memorySearchHandler.execute({ query: "" });
    expect(result).toBe("Query cannot be empty.");
  });

  it("returns error message for whitespace-only query", async () => {
    const result = await memorySearchHandler.execute({ query: "   " });
    expect(result).toBe("Query cannot be empty.");
  });

  // ─── No results ───────────────────────────────────────────────────────────────

  it('returns "no memories found" when nothing found', async () => {
    const result = await memorySearchHandler.execute({ query: "unknown topic", workspace_id: "ws-1" });
    expect(result).toContain(`No memories found matching "unknown topic"`);
  });

  it("does not call vector search when workspace_id is absent", async () => {
    const result = await memorySearchHandler.execute({ query: "test" });
    expect(mockSearch).not.toHaveBeenCalled();
    expect(result).toContain("No memories found");
  });

  // ─── Vector search results ────────────────────────────────────────────────────

  it("returns formatted semantic memory results with source and score", async () => {
    mockSearch.mockResolvedValue([makeChunk({ sourceId: "doc-42", score: 0.91 })]);

    const result = await memorySearchHandler.execute({ query: "architecture", workspace_id: "ws-1" });
    expect(result).toContain("Semantic Memory");
    expect(result).toContain("doc-42");
    expect(result).toContain("0.91");
  });

  it("formats multiple vector results correctly", async () => {
    mockSearch.mockResolvedValue([
      makeChunk({ sourceId: "doc-1" }),
      makeChunk({ sourceId: "doc-2" }),
    ]);

    const result = await memorySearchHandler.execute({ query: "test", workspace_id: "ws-1" });
    expect(result).toContain("doc-1");
    expect(result).toContain("doc-2");
  });

  // ─── workspace_id / top_k handling ────────────────────────────────────────────

  it("accepts workspace_id parameter without throwing", async () => {
    const result = await memorySearchHandler.execute({ query: "test", workspace_id: "ws-1" });
    expect(typeof result).toBe("string");
  });

  it("passes top_k through to vector search", async () => {
    mockSearch.mockResolvedValue([makeChunk()]);
    await memorySearchHandler.execute({ query: "test", workspace_id: "ws-1", top_k: 3 });
    expect(mockSearch).toHaveBeenCalledWith("ws-1", expect.any(Array), expect.objectContaining({ topK: 3 }));
  });

  it("clamps large top_k value to 20", async () => {
    mockSearch.mockResolvedValue([makeChunk()]);
    await memorySearchHandler.execute({ query: "test", workspace_id: "ws-1", top_k: 9999 });
    expect(mockSearch).toHaveBeenCalledWith("ws-1", expect.any(Array), expect.objectContaining({ topK: 20 }));
  });

  // ─── Error handling ────────────────────────────────────────────────────────

  it("degrades gracefully (empty results) when vector search throws", async () => {
    mockSearch.mockRejectedValueOnce(new Error("pgvector connection failed"));
    const result = await memorySearchHandler.execute({ query: "test", workspace_id: "ws-1" });
    expect(typeof result).toBe("string");
    expect(result).toContain("No memories found");
  });

  // ─── Tool definition ───────────────────────────────────────────────────────

  it("tool definition has correct name", () => {
    expect(memorySearchHandler.definition.name).toBe("memory_search");
  });

  it("tool definition has 'builtin' source", () => {
    expect(memorySearchHandler.definition.source).toBe("builtin");
  });

  it("tool definition includes 'memory' and 'rag' tags", () => {
    expect(memorySearchHandler.definition.tags).toContain("memory");
    expect(memorySearchHandler.definition.tags).toContain("rag");
  });

  it("tool definition requires 'query' field", () => {
    expect(memorySearchHandler.definition.inputSchema.required).toContain("query");
  });

  it("tool definition describes workspace_id as optional", () => {
    const props = memorySearchHandler.definition.inputSchema.properties as Record<string, unknown>;
    expect(props["workspace_id"]).toBeDefined();
    expect(memorySearchHandler.definition.inputSchema.required).not.toContain("workspace_id");
  });
});
