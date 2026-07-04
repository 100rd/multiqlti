/**
 * Contract tests for OmniscienceProvider (memory-architecture ADR, Track A).
 *
 * Validated against the REAL Omniscience v0.2 `search` response — `hits:
 * SearchHit[]`, nested `source`, a SINGLE `citation` object, plus sibling fields
 * (query_stats/degraded_subsystems/...). An earlier build parsed a top-level
 * `chunks[]` that only ever matched a mock and threw `chunks: Required` against a
 * real server; those chunk-shaped assertions have been replaced here.
 *
 * Proves the provider:
 *   - calls the `search` tool with contract-correct params,
 *   - passes as_of + retrieval_strategy through,
 *   - preserves the strategy contract (strategy reaches the server even when v0.1
 *     downgrades it),
 *   - maps real SearchHit + citation results into RetrievalResult,
 *   - accepts an empty `hits: []` as a valid (empty) result — the exact reported
 *     bug — and tolerates missing citations and unknown extra fields,
 *   - validates the response shape at the boundary and throws on malformed
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
  defaultMockHits,
} from "../../helpers/mock-omniscience";

function baseOptions(overrides: Partial<RetrievalOptions> = {}): RetrievalOptions {
  return { query: "how does retry work", workspaceId: "ws-1", ...overrides };
}

/** Build the real v0.2 SearchResponse envelope around a set of hits. */
function envelope(hits: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hits,
    query_stats: {
      total_matches_before_filters: hits.length,
      vector_matches: hits.length,
      text_matches: 0,
      duration_ms: 4,
    },
    effective_as_of: null,
    degraded_subsystems: ["qdrant", "neo4j"],
    ...extra,
  });
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

  it("maps real SearchHit results into RetrievedChunk (id⇐chunk_id, sourceId⇐source.id, sourceType⇐source.type)", async () => {
    const provider = new OmniscienceProvider(makeMockOmniscienceCaller());

    const result = await provider.retrieveContext(baseOptions());

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0].id).toBe("c1"); // ⇐ chunk_id
    expect(result.chunks[0].sourceType).toBe("code"); // ⇐ mapSourceType(source.type "git")
    expect(result.chunks[0].sourceId).toBe("src-retry"); // ⇐ source.id
    expect(result.chunks[0].score).toBeCloseTo(0.92);
    expect(result.chunks[0].chunkText).toContain("exponential backoff");
  });

  it("normalizes the single `citation` object into the citations metadata array", async () => {
    const provider = new OmniscienceProvider(makeMockOmniscienceCaller());

    const result = await provider.retrieveContext(baseOptions());

    const citations = result.chunks[0].metadata.citations as Array<Record<string, unknown>>;
    expect(Array.isArray(citations)).toBe(true);
    expect(citations).toHaveLength(1);
    expect(citations[0].source_id).toBe("src-retry");
    expect(citations[0].source_type).toBe("git");
    expect(citations[0].uri).toBe("git://repo/server/retry.ts#L10");
    expect(citations[0].title).toBe("retry.ts");
    expect(result.chunks[0].metadata.backend).toBe("omniscience");
  });

  it("threads confidence + document_id into metadata (nice-to-have)", async () => {
    const provider = new OmniscienceProvider(makeMockOmniscienceCaller());

    const result = await provider.retrieveContext(baseOptions());

    expect(result.chunks[0].metadata.confidence).toBeCloseTo(0.88);
    expect(result.chunks[0].metadata.documentId).toBe("d1");
  });

  it("surfaces citations in the formatted context", async () => {
    const provider = new OmniscienceProvider(makeMockOmniscienceCaller());

    const result = await provider.retrieveContext(baseOptions());

    expect(result.context).toContain("## Relevant Context");
    expect(result.context).toContain("Sources:");
    expect(result.context).toContain("git://repo/server/retry.ts#L10");
  });

  it("maps an unknown source.type to document", async () => {
    const caller = makeMockOmniscienceCaller({
      hits: [{ chunk_id: "x", text: "t", score: 0.5, source: { id: "s", type: "wiki" } }],
    });
    const provider = new OmniscienceProvider(caller);

    const result = await provider.retrieveContext(baseOptions());

    expect(result.chunks[0].sourceType).toBe("document");
  });

  it("maps a hit that omits the optional citation (no crash, no citations metadata)", async () => {
    const caller = makeMockOmniscienceCaller({
      hits: [
        {
          chunk_id: "nc1",
          text: "no citation here",
          score: 0.4,
          source: { id: "src-nc", type: "slack" },
        },
      ],
    });
    const provider = new OmniscienceProvider(caller);

    const result = await provider.retrieveContext(baseOptions());

    expect(result.chunks[0].id).toBe("nc1");
    expect(result.chunks[0].sourceId).toBe("src-nc");
    expect(result.chunks[0].metadata.citations).toBeUndefined();
    expect(result.chunks[0].metadata.backend).toBe("omniscience");
  });

  it("returns an empty result when search yields no hits (the reported bug — empty must NOT throw)", async () => {
    const provider = new OmniscienceProvider(makeMockOmniscienceCaller({ hits: [] }));

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

describe("parseSearchResult (real v0.2 SearchResponse)", () => {
  it("rejects non-JSON payloads", () => {
    expect(() => parseSearchResult("<<not json>>")).toThrow(/non-JSON/i);
  });

  it("accepts a contract-shaped payload with real hits", () => {
    const result = parseSearchResult(envelope(defaultMockHits()));
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].chunk_id).toBe("c1");
    expect(result.hits[0].source?.type).toBe("git");
  });

  it("accepts an EMPTY hits response without throwing (the reported bug: chunks: Required)", () => {
    // A real empty Omniscience response — carries hits:[] plus sibling stats.
    const raw = JSON.stringify({
      hits: [],
      query_stats: { total_matches_before_filters: 0, vector_matches: 0, text_matches: 0, duration_ms: 2 },
      effective_as_of: "2026-06-30T00:00:00.000Z",
      degraded_subsystems: ["qdrant", "neo4j"],
    });
    const result = parseSearchResult(raw);
    expect(result.hits).toHaveLength(0);
  });

  it("tolerates unknown extra top-level and per-hit fields (forward-compatible)", () => {
    const raw = envelope(
      [
        {
          chunk_id: "c9",
          document_id: "d9",
          score: 0.5,
          text: "future hit",
          source: { id: "s9", name: "n9", type: "terraform" },
          citation: { uri: "s3://bucket/key", title: null, indexed_at: "2026-06-01T00:00:00.000Z", doc_version: 2 },
          score_type: "some_future_score_type", // unknown score_type allowed
          impact: 0.3,
          source_instance: "inst-1",
          lineage: { parents: ["p1"] },
          some_future_field: { anything: true }, // unknown per-hit field tolerated
        },
      ],
      { some_future_top_level_field: 123 }, // unknown top-level field tolerated
    );

    const result = parseSearchResult(raw);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].chunk_id).toBe("c9");
    expect(result.hits[0].score_type).toBe("some_future_score_type");
  });

  it("tolerates a null citation and a null citation.title (no crash)", () => {
    const raw = envelope([
      { chunk_id: "n1", score: 0.6, text: "null citation", source: { id: "s1", type: "git" }, citation: null },
      {
        chunk_id: "n2",
        score: 0.6,
        text: "null title",
        source: { id: "s2", type: "confluence" },
        citation: { uri: "conf://page", title: null },
      },
    ]);
    const result = parseSearchResult(raw);
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].citation).toBeNull();
    expect(result.hits[1].citation?.title).toBeNull();
  });
});

describe("formatOmniscienceContext", () => {
  it("returns an empty string for no chunks", () => {
    expect(formatOmniscienceContext([])).toBe("");
  });
});
