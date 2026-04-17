/**
 * Unit tests for the Retriever.
 *
 * Mocks EmbeddingProvider and VectorStore to test retrieval logic in isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Retriever } from "../../../server/memory/retriever.js";
import type { EmbeddingProvider } from "../../../server/memory/embeddings.js";
import type { VectorStore, VectorSearchResult } from "../../../server/memory/vector-store.js";
import type { ChunkSourceType } from "../../../server/memory/chunker.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeVec(len = 768): number[] {
  return Array.from({ length: len }, (_, i) => i / len);
}

function makeResult(id: string, score: number, chunkText: string, sourceType: ChunkSourceType = "document"): VectorSearchResult {
  return {
    id,
    workspaceId: "ws-1",
    sourceType,
    sourceId: `src-${id}`,
    chunkText,
    score,
    metadata: {},
    ts: new Date(),
  };
}

function makeEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "ollama",
    model: "nomic-embed-text",
    dimensions: 768,
    embed: vi.fn().mockResolvedValue(makeVec()),
    embedBatch: vi.fn().mockResolvedValue([makeVec()]),
  };
}

function makeVectorStore(results: VectorSearchResult[] = []): VectorStore {
  return {
    search: vi.fn().mockResolvedValue(results),
    insertChunk: vi.fn(),
    insertChunks: vi.fn(),
    deleteBySource: vi.fn(),
    deleteByWorkspace: vi.fn(),
    countChunks: vi.fn().mockResolvedValue(0),
    listSources: vi.fn().mockResolvedValue([]),
    getEmbeddingConfig: vi.fn().mockResolvedValue(null),
    upsertEmbeddingConfig: vi.fn(),
  } as unknown as VectorStore;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Retriever", () => {
  let provider: EmbeddingProvider;
  let store: VectorStore;

  beforeEach(() => {
    provider = makeEmbeddingProvider();
    store = makeVectorStore();
  });

  // ─── Basic retrieval ───────────────────────────────────────────────────────

  describe("retrieveContext", () => {
    it("embeds the query using the embedding provider", async () => {
      const retriever = new Retriever(provider, makeVectorStore());
      await retriever.retrieveContext({ query: "how to handle errors", workspaceId: "ws-1" });
      expect(provider.embed).toHaveBeenCalledWith("how to handle errors");
    });

    it("passes the query embedding to the vector store", async () => {
      const queryVec = makeVec();
      (provider.embed as ReturnType<typeof vi.fn>).mockResolvedValue(queryVec);
      const retriever = new Retriever(provider, store);

      await retriever.retrieveContext({ query: "test", workspaceId: "ws-1" });
      expect(store.search).toHaveBeenCalledWith("ws-1", queryVec, expect.any(Object));
    });

    it("returns empty context when no results found", async () => {
      const retriever = new Retriever(provider, makeVectorStore([]));
      const result = await retriever.retrieveContext({ query: "test", workspaceId: "ws-1" });

      expect(result.chunks).toHaveLength(0);
      expect(result.context).toBe("");
      expect(result.tokensUsed).toBe(0);
    });

    it("returns all chunks when under token budget", async () => {
      const results = [
        makeResult("1", 0.9, "Short text A"),
        makeResult("2", 0.8, "Short text B"),
      ];
      const retriever = new Retriever(provider, makeVectorStore(results));
      const result = await retriever.retrieveContext({
        query: "test",
        workspaceId: "ws-1",
        maxTokens: 1000,
      });

      expect(result.chunks).toHaveLength(2);
      expect(result.chunks[0].id).toBe("1");
      expect(result.chunks[1].id).toBe("2");
    });

    it("respects topK option", async () => {
      const retriever = new Retriever(provider, store);
      await retriever.retrieveContext({ query: "test", workspaceId: "ws-1", topK: 3 });

      expect(store.search).toHaveBeenCalledWith("ws-1", expect.any(Array), expect.objectContaining({ topK: 3 }));
    });

    it("passes filter (source types) to vector store", async () => {
      const retriever = new Retriever(provider, store);
      await retriever.retrieveContext({
        query: "test",
        workspaceId: "ws-1",
        filter: ["code", "document"],
      });

      expect(store.search).toHaveBeenCalledWith("ws-1", expect.any(Array), expect.objectContaining({
        sourceTypes: ["code", "document"],
      }));
    });
  });

  // ─── Token budget enforcement ──────────────────────────────────────────────

  describe("token budget enforcement", () => {
    it("stops including chunks when token budget is exceeded", async () => {
      // 10 maxTokens × 4 chars/token = 40 chars budget
      // Each chunk has 30 chars, so max 1 full chunk
      const results = [
        makeResult("1", 0.9, "A".repeat(30), "document"),
        makeResult("2", 0.8, "B".repeat(30), "document"),
        makeResult("3", 0.7, "C".repeat(30), "document"),
      ];
      const retriever = new Retriever(provider, makeVectorStore(results));
      const result = await retriever.retrieveContext({
        query: "test",
        workspaceId: "ws-1",
        maxTokens: 10, // 40 chars
      });

      // Only 1 full chunk fits (30 chars), maybe partial second
      expect(result.chunks.length).toBeLessThanOrEqual(2);
      expect(result.tokensUsed).toBeLessThanOrEqual(10 + 1); // slight rounding
    });

    it("truncates last chunk when it exceeds remaining budget", async () => {
      // Budget: 20 tokens = 80 chars
      // First chunk: 60 chars (fits)
      // Second chunk: 60 chars (only 20 chars remain → truncated)
      const results = [
        makeResult("1", 0.9, "A".repeat(60), "document"),
        makeResult("2", 0.8, "B".repeat(60), "document"),
      ];
      const retriever = new Retriever(provider, makeVectorStore(results));
      const result = await retriever.retrieveContext({
        query: "test",
        workspaceId: "ws-1",
        maxTokens: 20, // 80 chars
      });

      if (result.chunks.length === 2) {
        // Second chunk should be truncated with ellipsis
        expect(result.chunks[1].chunkText).toContain("…");
      }
      expect(result.tokensUsed).toBeLessThanOrEqual(21); // allow rounding
    });

    it("reports tokensUsed correctly", async () => {
      const text = "Hello world here."; // 17 chars = ceil(17/4) = 5 tokens
      const retriever = new Retriever(provider, makeVectorStore([makeResult("1", 0.9, text)]));
      const result = await retriever.retrieveContext({ query: "test", workspaceId: "ws-1" });

      expect(result.tokensUsed).toBe(Math.ceil(text.length / 4));
    });
  });

  // ─── Context formatting ────────────────────────────────────────────────────

  describe("context formatting", () => {
    it("includes source metadata in context header", async () => {
      const results = [makeResult("1", 0.87, "Some important code", "code")];
      const retriever = new Retriever(provider, makeVectorStore(results));
      const { context } = await retriever.retrieveContext({ query: "test", workspaceId: "ws-1" });

      expect(context).toContain("## Relevant Context");
      expect(context).toContain("code:");
      expect(context).toContain("0.87");
      expect(context).toContain("Some important code");
    });

    it("includes all chunks in context output", async () => {
      const results = [
        makeResult("1", 0.9, "First chunk"),
        makeResult("2", 0.8, "Second chunk"),
      ];
      const retriever = new Retriever(provider, makeVectorStore(results));
      const { context } = await retriever.retrieveContext({ query: "test", workspaceId: "ws-1" });

      expect(context).toContain("First chunk");
      expect(context).toContain("Second chunk");
    });

    it("returns empty string when no chunks", async () => {
      const retriever = new Retriever(provider, makeVectorStore([]));
      const { context } = await retriever.retrieveContext({ query: "test", workspaceId: "ws-1" });
      expect(context).toBe("");
    });
  });

  // ─── MinScore filtering ────────────────────────────────────────────────────

  describe("minScore option", () => {
    it("passes minScore to vector store search", async () => {
      const retriever = new Retriever(provider, store);
      await retriever.retrieveContext({ query: "test", workspaceId: "ws-1", minScore: 0.7 });

      expect(store.search).toHaveBeenCalledWith("ws-1", expect.any(Array), expect.objectContaining({ minScore: 0.7 }));
    });

    it("uses default minScore of 0.3 when not specified", async () => {
      const retriever = new Retriever(provider, store);
      await retriever.retrieveContext({ query: "test", workspaceId: "ws-1" });

      expect(store.search).toHaveBeenCalledWith("ws-1", expect.any(Array), expect.objectContaining({ minScore: 0.3 }));
    });
  });
});
