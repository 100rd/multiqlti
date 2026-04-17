/**
 * Unit tests for the memory_search MCP tool.
 *
 * Tests focus on the tool's contract: input validation, output formatting,
 * structured memory integration, and graceful degradation.
 * Vector search mocking is handled separately in retriever/vector-store tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mockSearchMemories = vi.hoisted(() =>
  vi.fn<[], Promise<unknown[]>>().mockResolvedValue([]),
);

vi.mock("../../../server/storage", () => ({
  storage: {
    searchMemories: mockSearchMemories,
  },
}));

vi.mock("../../../server/federation/manager-state", () => ({
  getFederationManager: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../server/federation/memory-federation", () => ({
  MemoryFederationService: vi.fn(),
}));

// Mock VectorStore and EmbeddingProviderFactory so performVectorSearch works in tests.
// Use simple return values without complex mock chaining.
vi.mock("../../../server/memory/vector-store", () => ({
  VectorStore: class MockVectorStore {
    async search() { return []; }
    async getEmbeddingConfig() { return null; }
    async insertChunk() { return {}; }
    async insertChunks() { return []; }
    async deleteBySource() { return 0; }
    async deleteByWorkspace() { return 0; }
    async countChunks() { return 0; }
    async listSources() { return []; }
    async upsertEmbeddingConfig() { return {}; }
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

function makeMemory(key: string, type = "fact") {
  return {
    id: Math.random(),
    type,
    key,
    content: `Content for ${key}`,
    confidence: 0.9,
    published: true,
    tags: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("memorySearchHandler", () => {
  beforeEach(() => {
    mockSearchMemories.mockClear().mockResolvedValue([]);
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
    const result = await memorySearchHandler.execute({ query: "unknown topic" });
    expect(result).toContain(`No memories found matching "unknown topic"`);
  });

  it("handles query with no results gracefully", async () => {
    mockSearchMemories.mockResolvedValue([]);
    const result = await memorySearchHandler.execute({ query: "obscure topic" });
    expect(typeof result).toBe("string");
    expect(result).toContain("No memories found");
  });

  // ─── Local structured memory ───────────────────────────────────────────────

  it("returns formatted local memories with type and confidence", async () => {
    mockSearchMemories.mockResolvedValue([
      makeMemory("arch-decision"),
      makeMemory("perf-issue", "issue"),
    ]);

    const result = await memorySearchHandler.execute({ query: "architecture" });
    expect(result).toContain("[fact] arch-decision:");
    expect(result).toContain("[issue] perf-issue:");
    expect(result).toContain("confidence: 0.90");
  });

  it("formats multiple memory types correctly", async () => {
    mockSearchMemories.mockResolvedValue([
      makeMemory("decision-1", "decision"),
      makeMemory("pattern-1", "pattern"),
      makeMemory("dep-1", "dependency"),
    ]);

    const result = await memorySearchHandler.execute({ query: "test" });
    expect(result).toContain("[decision] decision-1:");
    expect(result).toContain("[pattern] pattern-1:");
    expect(result).toContain("[dependency] dep-1:");
  });

  it("shows Structured Memory section when local results exist", async () => {
    mockSearchMemories.mockResolvedValue([makeMemory("local-key")]);

    const result = await memorySearchHandler.execute({ query: "test" });
    expect(result).toContain("Structured Memory");
  });

  // ─── workspace_id handling ────────────────────────────────────────────────

  it("accepts workspace_id parameter without throwing", async () => {
    const result = await memorySearchHandler.execute({
      query: "test",
      workspace_id: "ws-1",
    });
    expect(typeof result).toBe("string");
  });

  it("accepts top_k parameter without throwing", async () => {
    const result = await memorySearchHandler.execute({
      query: "test",
      workspace_id: "ws-1",
      top_k: 3,
    });
    expect(typeof result).toBe("string");
  });

  it("accepts large top_k value without throwing (clamped to 20)", async () => {
    const result = await memorySearchHandler.execute({
      query: "test",
      workspace_id: "ws-1",
      top_k: 9999,
    });
    expect(typeof result).toBe("string");
  });

  it("does not call vector search when workspace_id is absent", async () => {
    mockSearchMemories.mockResolvedValue([makeMemory("key1")]);
    const result = await memorySearchHandler.execute({ query: "test" });
    // Should not include "Semantic Memory" section since no workspace_id
    expect(result).not.toContain("Semantic Memory");
  });

  // ─── Error handling ────────────────────────────────────────────────────────

  it("returns error message when storage throws", async () => {
    mockSearchMemories.mockRejectedValueOnce(new Error("DB connection failed"));
    const result = await memorySearchHandler.execute({ query: "test" });
    expect(typeof result).toBe("string");
    expect(result).toContain("unavailable");
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
