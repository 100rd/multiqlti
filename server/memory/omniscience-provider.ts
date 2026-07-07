/**
 * OmniscienceProvider — world-knowledge retrieval via Omniscience's MCP `search`
 * tool (memory-architecture ADR, Track A).
 *
 * Contract-first: validated against the REAL Omniscience v0.2 `search` response
 * (the server's Pydantic `SearchResponse`/`SearchHit` models), proven live over
 * MCP. The response is `hits: SearchHit[]` — an earlier build parsed a top-level
 * `chunks[]` that only ever matched a mock and threw `chunks: Required` against a
 * real server. The provider:
 *   - calls the `search` MCP tool with { query, retrieval_strategy, as_of, ... },
 *   - validates the returned hits+citation payload at the boundary (zod),
 *   - maps results into the existing RetrievalResult shape so the Retriever can
 *     route to it transparently.
 *
 * Auth: the token is read from the configured env var at call time and passed to
 * the transport (stdio env / streamable-http Authorization header) by the
 * connection layer. It is NEVER hardcoded or persisted in config.
 */
import { z } from "zod";
import type { RetrievalOptions, RetrievedChunk, RetrievalResult } from "./retriever.js";
import type { ChunkSourceType } from "./chunker.js";

// ─── Contract: search tool params (Omniscience ADR 0004) ───────────────────────

/**
 * Retrieval strategy accepted by Omniscience `search`. v0.1 implements only
 * "hybrid"; structural/keyword/auto are accepted-and-downgraded server-side.
 * We preserve the full contract so callers can pass any of them.
 */
export type OmniscienceRetrievalStrategy =
  | "hybrid"
  | "structural"
  | "keyword"
  | "auto";

export const OMNISCIENCE_SEARCH_TOOL = "search" as const;

/** Arguments sent to the Omniscience `search` MCP tool. */
export interface OmniscienceSearchParams {
  query: string;
  /** Defaults to "hybrid". Unknown strategies downgrade server-side. */
  retrieval_strategy: OmniscienceRetrievalStrategy;
  /** Bitemporal anchor (ISO-8601 datetime). Optional. */
  as_of?: string;
  /** Max number of chunks to return. */
  limit?: number;
  /** Source-type filters mapped from RetrievalOptions.filter. */
  filters?: { source_types?: string[] };
}

// ─── Boundary validation: search tool result (Omniscience v0.2 SearchResponse) ──
//
// Ground truth = the running server's Pydantic models. The top-level response is
// `SearchHit[]` under `hits` (NOT a top-level `chunks[]` — that was the shape of
// an early mock and never matched a real Omniscience). Sibling fields
// (query_stats, effective_as_of, degraded_subsystems, meta, min_applied_version,
// staleness_seconds, pinned_watermark, snapshot_id, next_cursor) are tolerated
// and ignored via `.passthrough()`; an empty `hits: []` is a valid response.

/**
 * SourceInfo — the source a hit came from. Nested object (id/name/type), NOT the
 * flat source_id/source_type the old mock used.
 */
const sourceInfoSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    type: z.string(),
  })
  .passthrough();

/**
 * A SINGLE citation object per hit (not an array). Tolerant: `title` may be null,
 * and indexed_at/doc_version may be absent on some hits.
 */
const hitCitationSchema = z
  .object({
    uri: z.string(),
    title: z.string().nullish(),
    indexed_at: z.string().optional(),
    doc_version: z.number().optional(),
  })
  .passthrough();

/**
 * SearchHit — one retrieved chunk. Required: chunk_id/score/text. `source` and
 * `citation` are present in practice but modeled tolerantly (a hit may omit the
 * citation). Scoring/lineage extras are accepted and ignored; unknown score_type
 * strings are allowed. Extra fields pass through so future server additions never
 * break validation.
 */
const searchHitSchema = z
  .object({
    chunk_id: z.string(),
    document_id: z.string().optional(),
    score: z.number(),
    text: z.string(),
    source: sourceInfoSchema.optional(),
    citation: hitCitationSchema.nullish(),
    metadata: z.record(z.unknown()).optional(),
    // Accepted-and-ignored (or threaded into metadata) scoring/provenance extras.
    confidence: z.number().nullish(),
    score_type: z.string().nullish(),
    impact: z.number().nullish(),
    source_instance: z.string().nullish(),
    lineage: z.unknown().optional(),
  })
  .passthrough();

const searchResultSchema = z
  .object({
    hits: z.array(searchHitSchema),
  })
  .passthrough();

export type OmniscienceSearchResult = z.infer<typeof searchResultSchema>;
type OmniscienceHit = z.infer<typeof searchHitSchema>;

// ─── Tool caller seam ──────────────────────────────────────────────────────────

/**
 * Minimal seam over the MCP client: invoke the named tool with arguments and
 * return the raw text payload. The real implementation wraps
 * McpClientManager.callTool; tests inject a mock. Keeping this narrow keeps the
 * provider decoupled from transport/connection lifecycle.
 */
export type OmniscienceToolCaller = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>;

// ─── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_TOKENS = 2000;
const CHARS_PER_TOKEN = 4;

/**
 * Map an Omniscience `source.type` string onto our ChunkSourceType union.
 * Covers the real Omniscience v0.2 source_type enum
 * (git/fs/confluence/notion/slack/jira/grafana/k8s/terraform/otel/k8s_operator/
 * s3/aws/alerts) plus legacy/contract aliases. Anything unknown → "document".
 */
const SOURCE_TYPE_MAP: Record<string, ChunkSourceType> = {
  // Legacy / contract aliases.
  code: "code",
  document: "document",
  doc: "document",
  docs: "document",
  incident: "document",
  infra: "document",
  memory_entry: "memory_entry",
  // Real Omniscience v0.2 source_type enum.
  git: "code",
  terraform: "code",
  k8s: "document",
  k8s_operator: "document",
  fs: "document",
  s3: "document",
  aws: "document",
  confluence: "document",
  notion: "document",
  slack: "document",
  jira: "document",
  grafana: "document",
  otel: "document",
  alerts: "document",
};

function mapSourceType(raw: string | undefined): ChunkSourceType {
  if (!raw) return "document";
  return SOURCE_TYPE_MAP[raw] ?? "document";
}

// ─── Provider ────────────────────────────────────────────────────────────────────

export interface OmniscienceProviderOptions {
  /** Default retrieval strategy when the caller does not specify one. */
  retrievalStrategy?: OmniscienceRetrievalStrategy;
}

export class OmniscienceProvider {
  private readonly defaultStrategy: OmniscienceRetrievalStrategy;

  constructor(
    private readonly callTool: OmniscienceToolCaller,
    options: OmniscienceProviderOptions = {},
  ) {
    this.defaultStrategy = options.retrievalStrategy ?? "hybrid";
  }

  /**
   * Retrieve world-knowledge context from Omniscience. Mirrors
   * Retriever.retrieveContext so the Retriever can route to it transparently.
   * Throws on transport / validation failure — the Retriever catches and falls
   * back to local pgvector.
   */
  async retrieveContext(options: RetrievalOptions): Promise<RetrievalResult> {
    const params = buildSearchParams(options, this.defaultStrategy);
    const raw = await this.callTool(
      OMNISCIENCE_SEARCH_TOOL,
      params as unknown as Record<string, unknown>,
    );
    const result = parseSearchResult(raw);
    return toRetrievalResult(result, options);
  }
}

// ─── Param building ──────────────────────────────────────────────────────────────

/** Build the `search` tool arguments from RetrievalOptions, preserving the contract. */
export function buildSearchParams(
  options: RetrievalOptions,
  defaultStrategy: OmniscienceRetrievalStrategy,
): OmniscienceSearchParams {
  const params: OmniscienceSearchParams = {
    query: options.query,
    retrieval_strategy: options.retrievalStrategy ?? defaultStrategy,
    limit: options.topK ?? DEFAULT_TOP_K,
  };
  if (options.asOf) params.as_of = options.asOf;
  if (options.filter && options.filter.length > 0) {
    params.filters = { source_types: options.filter };
  }
  return params;
}

// ─── Boundary parsing ────────────────────────────────────────────────────────────

/**
 * Parse + validate the raw tool text into a typed search result.
 * The MCP client returns tool output as a text payload; Omniscience emits JSON.
 */
export function parseSearchResult(raw: string): OmniscienceSearchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Omniscience search returned non-JSON payload");
  }
  const validated = searchResultSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Omniscience search response failed validation: ${validated.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return validated.data;
}

// ─── Mapping to RetrievalResult ──────────────────────────────────────────────────

function toRetrievedChunk(hit: OmniscienceHit): RetrievedChunk {
  const metadata: Record<string, unknown> = { ...(hit.metadata ?? {}) };
  const sourceId = hit.source?.id ?? hit.chunk_id;
  const sourceType = hit.source?.type;

  // The real hit carries ONE `citation` object; normalize it into the existing
  // `metadata.citations` array shape the formatter/consumers already expect.
  if (hit.citation) {
    metadata.citations = [
      {
        source_id: sourceId,
        source_type: sourceType,
        uri: hit.citation.uri,
        title: hit.citation.title ?? undefined,
      },
    ];
  }

  // Thread useful provenance/scoring extras into metadata (best-effort).
  if (hit.confidence != null) metadata.confidence = hit.confidence;
  if (hit.document_id) metadata.documentId = hit.document_id;
  if (hit.lineage != null) metadata.lineage = hit.lineage;

  metadata.backend = "omniscience";
  return {
    id: hit.chunk_id,
    sourceType: mapSourceType(sourceType),
    sourceId,
    chunkText: hit.text,
    score: hit.score,
    metadata,
  };
}

/** Apply the token budget and format the context, mirroring the local Retriever. */
function toRetrievalResult(
  result: OmniscienceSearchResult,
  options: RetrievalOptions,
): RetrievalResult {
  const maxChars = (options.maxTokens ?? DEFAULT_MAX_TOKENS) * CHARS_PER_TOKEN;
  const selected: RetrievedChunk[] = [];
  let usedChars = 0;

  for (const hit of result.hits) {
    const mapped = toRetrievedChunk(hit);
    if (usedChars + mapped.chunkText.length > maxChars && selected.length > 0) break;
    selected.push(mapped);
    usedChars += mapped.chunkText.length;
  }

  return {
    chunks: selected,
    context: formatOmniscienceContext(selected),
    tokensUsed: Math.ceil(usedChars / CHARS_PER_TOKEN),
  };
}

/** Format chunks into an LLM-ready context block, surfacing citations. */
export function formatOmniscienceContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const lines: string[] = ["## Relevant Context\n"];
  for (const chunk of chunks) {
    lines.push(`[${chunk.sourceType}:${chunk.sourceId}] (score: ${chunk.score.toFixed(2)})`);
    lines.push(chunk.chunkText.trim());
    const cites = chunk.metadata.citations;
    if (Array.isArray(cites) && cites.length > 0) {
      const formatted = formatCitations(cites);
      if (formatted) lines.push(formatted);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function formatCitations(citations: unknown[]): string {
  const refs = citations
    .map((c) => (isCitation(c) ? c.uri ?? c.title ?? c.source_id : undefined))
    .filter((s): s is string => typeof s === "string");
  return refs.length > 0 ? `Sources: ${refs.join(", ")}` : "";
}

function isCitation(
  value: unknown,
): value is { source_id: string; uri?: string; title?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "source_id" in value &&
    typeof (value as { source_id: unknown }).source_id === "string"
  );
}
