/**
 * Contract tests for OmniscienceProvider (memory-architecture ADR, Track A).
 *
 * Drives the provider against the mock Omniscience `search` tool double and
 * proves:
 *   - it calls the `search` tool with contract-correct params,
 *   - it passes as_of + retrieval_strategy through,
 *   - it preserves the strategy contract (strategy reaches the server even when
 *     v0.1 downgrades it),
 *   - it maps chunk+citation results into RetrievalResult,
 *   - it validates the response shape at the boundary and throws on malformed
 *     payloads (so the Retriever can fall back).
 */
import { describe, it, expect } from "vitest";
import {
  OmniscienceProvider,
  buildSearchParams,
  parseSearchResult,
  formatOmniscienceContext,
} from "../../../server/memory/omniscience-provider";
import type { RetrievalOptions } from "../../../server/memory/retriever";
import {
  makeMockOmniscienceCaller,
  defaultMockChunks,
} from "../../helpers/mock-omniscience";

function baseOptions(overrides: Partial<RetrievalOptions> = {}): RetrievalOptions {
  return { query: "how does retry work", workspaceId: "ws-1", ...overrides };
}

describe("OmniscienceProvider.retrieveContext", () => {
  it("calls the `search` tool with the query and default hybrid strategy", async () => {
    const caller = makeMockOmniscienceCaller();
    const provider = new OmniscienceProvider(caller);

    await provider.retrieveContext(baseOptions());

    expect(caller.lastCall?.toolName).toBe("search");
    expect(caller.lastCall?.params.query).toBe("how does retry work");
    expect(caller.lastCall?.params.retrieval_strategy).toBe("hybrid");
  });

  it("passes as_of (bitemporal anchor) through to search", async () => {
    const caller = makeMockOmniscienceCaller();
    const provider = new OmniscienceProvider(caller);
    const asOf = "2026-01-15T00:00:00.000Z";

    await provider.retrieveContext(baseOptions({ asOf }));

    expect(caller.lastCall?.params.as_of).toBe(asOf);
  });

  it("passes a non-hybrid retrieval_strategy through (server downgrades it)", async () => {
    const caller = makeMockOmniscienceCaller();
    const provider = new OmniscienceProvider(caller);

    await provider.retrieveContext(baseOptions({ retrievalStrategy: "structural" }));

    // Contract preserved: the requested strategy reaches the server …
    expect(caller.lastCall?.params.retrieval_strategy).toBe("structural");
    // … and the server downgrades it to hybrid in v0.1.
    expect(caller.lastCall?.effectiveStrategy).toBe("hybrid");
  });

  it("uses the provider default strategy when caller omits one", async () => {
    const caller = makeMockOmniscienceCaller();
    const provider = new OmniscienceProvider(caller, { retrievalStrategy: "auto" });

    await provider.retrieveContext(baseOptions());

    expect(caller.lastCall?.params.retrieval_strategy).toBe("auto");
  });

  it("passes source-type filters and limit through", async () => {
    const caller = makeMockOmniscienceCaller();
    const provider = new OmniscienceProvider(caller);

    await provider.retrieveContext(baseOptions({ filter: ["code"], topK: 1 }));

    expect(caller.lastCall?.params.filters?.source_types).toEqual(["code"]);
    expect(caller.lastCall?.params.limit).toBe(1);
  });

  it("maps chunk results into RetrievedChunk with score and source", async () => {
    const provider = new OmniscienceProvider(makeMockOmniscienceCaller());

    const result = await provider.retrieveContext(baseOptions());

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0].id).toBe("c1");
    expect(result.chunks[0].sourceType).toBe("code");
    expect(result.chunks[0].sourceId).toBe("src-retry");
    expect(result.chunks[0].score).toBeCloseTo(0.92);
    expect(result.chunks[0].chunkText).toContain("exponential backoff");
  });

  it("preserves citations in chunk metadata", async () => {
    const provider = new OmniscienceProvider(makeMockOmniscienceCaller());

    const result = await provider.retrieveContext(baseOptions());

    const citations = result.chunks[0].metadata.citations;
    expect(Array.isArray(citations)).toBe(true);
    expect((citations as unknown[]).length).toBe(1);
    expect(result.chunks[0].metadata.backend).toBe("omniscience");
  });

  it("surfaces citations in the formatted context", async () => {
    const provider = new OmniscienceProvider(makeMockOmniscienceCaller());

    const result = await provider.retrieveContext(baseOptions());

    expect(result.context).toContain("## Relevant Context");
    expect(result.context).toContain("Sources:");
    expect(result.context).toContain("git://repo/server/retry.ts#L10");
  });

  it("maps an unknown source_type to document", async () => {
    const caller = makeMockOmniscienceCaller({
      chunks: [{ id: "x", text: "t", score: 0.5, source_type: "wiki" }],
    });
    const provider = new OmniscienceProvider(caller);

    const result = await provider.retrieveContext(baseOptions());

    expect(result.chunks[0].sourceType).toBe("document");
  });

  it("returns empty result when search yields no chunks", async () => {
    const provider = new OmniscienceProvider(makeMockOmniscienceCaller({ chunks: [] }));

    const result = await provider.retrieveContext(baseOptions());

    expect(result.chunks).toHaveLength(0);
    expect(result.context).toBe("");
    expect(result.tokensUsed).toBe(0);
  });

  it("throws when the search response is malformed (boundary validation)", async () => {
    const provider = new OmniscienceProvider(
      makeMockOmniscienceCaller({ returnMalformed: true }),
    );

    await expect(provider.retrieveContext(baseOptions())).rejects.toThrow(
      /failed validation/i,
    );
  });

  it("propagates transport errors so the Retriever can fall back", async () => {
    const provider = new OmniscienceProvider(
      makeMockOmniscienceCaller({ failWith: new Error("connection refused") }),
    );

    await expect(provider.retrieveContext(baseOptions())).rejects.toThrow(
      /connection refused/,
    );
  });
});

describe("buildSearchParams", () => {
  it("defaults limit to topK and strategy to the provided default", () => {
    const params = buildSearchParams(baseOptions(), "keyword");
    expect(params.retrieval_strategy).toBe("keyword");
    expect(params.limit).toBe(5);
    expect(params.as_of).toBeUndefined();
  });

  it("omits filters when no filter is set", () => {
    const params = buildSearchParams(baseOptions(), "hybrid");
    expect(params.filters).toBeUndefined();
  });
});

describe("parseSearchResult", () => {
  it("rejects non-JSON payloads", () => {
    expect(() => parseSearchResult("<<not json>>")).toThrow(/non-JSON/i);
  });

  it("accepts a contract-shaped payload", () => {
    const raw = JSON.stringify({ chunks: defaultMockChunks() });
    const result = parseSearchResult(raw);
    expect(result.chunks).toHaveLength(2);
  });
});

describe("formatOmniscienceContext", () => {
  it("returns an empty string for no chunks", () => {
    expect(formatOmniscienceContext([])).toBe("");
  });
});
