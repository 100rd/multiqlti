/**
 * Routing tests for Retriever ↔ OmniscienceProvider (memory-architecture ADR,
 * Track A).
 *
 * Proves the feature-flag routing behavior:
 *   - with no Omniscience provider → uses local pgvector (default),
 *   - with an Omniscience provider → routes to it,
 *   - on Omniscience error → falls back to local pgvector (graceful, no throw).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Retriever } from "../../../server/memory/retriever";
import { OmniscienceProvider } from "../../../server/memory/omniscience-provider";
import type { EmbeddingProvider } from "../../../server/memory/embeddings";
import type { VectorStore, VectorSearchResult } from "../../../server/memory/vector-store";
import { makeMockOmniscienceCaller } from "../../helpers/mock-omniscience";

function makeVec(len = 768): number[] {
  return Array.from({ length: len }, (_, i) => i / len);
}

function localResult(id: string, text: string): VectorSearchResult {
  return {
    id,
    workspaceId: "ws-1",
    sourceType: "document",
    sourceId: `local-${id}`,
    chunkText: text,
    score: 0.7,
    metadata: { backend: "local" },
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

function makeVectorStore(results: VectorSearchResult[]): VectorStore {
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

describe("Retriever routing (feature flag)", () => {
  let embedding: EmbeddingProvider;
  let store: VectorStore;

  beforeEach(() => {
    embedding = makeEmbeddingProvider();
    store = makeVectorStore([localResult("1", "local pgvector chunk")]);
  });

  it("uses local pgvector when no Omniscience provider is wired (default)", async () => {
    const retriever = new Retriever(embedding, store);

    const result = await retriever.retrieveContext({ query: "q", workspaceId: "ws-1" });

    expect(store.search).toHaveBeenCalledTimes(1);
    expect(result.chunks[0].metadata.backend).toBe("local");
  });

  it("routes to Omniscience when a provider is wired", async () => {
    const omniscience = new OmniscienceProvider(makeMockOmniscienceCaller());
    const retriever = new Retriever(embedding, store, omniscience);

    const result = await retriever.retrieveContext({ query: "q", workspaceId: "ws-1" });

    // Local store was never consulted; results came from Omniscience.
    expect(store.search).not.toHaveBeenCalled();
    expect(result.chunks[0].metadata.backend).toBe("omniscience");
  });

  it("falls back to local pgvector when Omniscience errors (graceful)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = new OmniscienceProvider(
      makeMockOmniscienceCaller({ failWith: new Error("omniscience down") }),
    );
    const retriever = new Retriever(embedding, store, failing);

    const result = await retriever.retrieveContext({ query: "q", workspaceId: "ws-1" });

    // Did not throw; local backend served the request.
    expect(store.search).toHaveBeenCalledTimes(1);
    expect(result.chunks[0].metadata.backend).toBe("local");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to local pgvector"),
    );
    warn.mockRestore();
  });

  it("falls back to local when Omniscience returns a malformed payload", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const malformed = new OmniscienceProvider(
      makeMockOmniscienceCaller({ returnMalformed: true }),
    );
    const retriever = new Retriever(embedding, store, malformed);

    const result = await retriever.retrieveContext({ query: "q", workspaceId: "ws-1" });

    expect(result.chunks[0].metadata.backend).toBe("local");
    vi.restoreAllMocks();
  });

  it("passes as_of and strategy through the Retriever to Omniscience", async () => {
    const caller = makeMockOmniscienceCaller();
    const retriever = new Retriever(embedding, store, new OmniscienceProvider(caller));

    await retriever.retrieveContext({
      query: "q",
      workspaceId: "ws-1",
      asOf: "2026-02-01T12:00:00.000Z",
      retrievalStrategy: "keyword",
    });

    expect(caller.lastCall?.params.as_of).toBe("2026-02-01T12:00:00.000Z");
    expect(caller.lastCall?.params.retrieval_strategy).toBe("keyword");
  });
});
