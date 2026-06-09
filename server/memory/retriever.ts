/**
 * RAG retrieval helper.
 *
 * retrieveContext() embeds the query, searches the vector store, applies a
 * token budget, and returns formatted context chunks ready for LLM injection.
 *
 * Routing (memory-architecture ADR, Track A): when an Omniscience provider is
 * wired in (feature flag `memory.retrieval.backend = "omniscience"`), the
 * Retriever delegates world-knowledge retrieval to it and falls back to the
 * local pgvector path on any error. By default (no provider) it uses pgvector.
 */
import type { EmbeddingProvider } from "./embeddings.js";
import type { VectorStore, VectorSearchResult } from "./vector-store.js";
import type { ChunkSourceType } from "./chunker.js";
import type { OmniscienceProvider, OmniscienceRetrievalStrategy } from "./omniscience-provider.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RetrievalOptions {
  query: string;
  workspaceId: string;
  topK?: number;
  /** Only return chunks from these source types. */
  filter?: ChunkSourceType[];
  /** Max tokens to include in the returned context. Enforced by truncating. */
  maxTokens?: number;
  /** Minimum similarity score (0–1). */
  minScore?: number;
  /**
   * Bitemporal anchor (ISO-8601 datetime) passed through to Omniscience
   * `search`. Ignored by the local pgvector path.
   */
  asOf?: string;
  /**
   * Retrieval strategy passed through to Omniscience `search`. Ignored by the
   * local pgvector path. Unknown strategies downgrade server-side to "hybrid".
   */
  retrievalStrategy?: OmniscienceRetrievalStrategy;
}

export interface RetrievedChunk {
  id: string;
  sourceType: ChunkSourceType;
  sourceId: string;
  chunkText: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** Formatted context string ready to prepend as system context. */
  context: string;
  /** Total approximate tokens in the returned context. */
  tokensUsed: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;
const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_MIN_SCORE = 0.3;
const MIN_TRUNCATION_CHARS = 40;

// ─── Retriever ────────────────────────────────────────────────────────────────

export class Retriever {
  /**
   * @param embeddingProvider — embeds queries for the local pgvector path.
   * @param vectorStore       — local pgvector store (default + fallback backend).
   * @param omniscience       — optional Omniscience provider; when present the
   *   Retriever routes to it and falls back to local pgvector on error.
   */
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly vectorStore: VectorStore,
    private readonly omniscience?: OmniscienceProvider,
  ) {}

  async retrieveContext(options: RetrievalOptions): Promise<RetrievalResult> {
    if (this.omniscience) {
      try {
        return await this.omniscience.retrieveContext(options);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Graceful fallback: log and use local pgvector. Never throw to the
        // caller just because the optional world-knowledge backend is down.
        console.warn(
          `[retriever] Omniscience retrieval failed, falling back to local pgvector: ${msg}`,
        );
      }
    }
    return this.retrieveLocal(options);
  }

  /** Local pgvector retrieval path (default backend + Omniscience fallback). */
  private async retrieveLocal(options: RetrievalOptions): Promise<RetrievalResult> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const maxChars = maxTokens * CHARS_PER_TOKEN;

    // Embed the query.
    const queryEmbedding = await this.embeddingProvider.embed(options.query);

    // Search the vector store.
    const searchResults = await this.vectorStore.search(options.workspaceId, queryEmbedding, {
      topK,
      sourceTypes: options.filter,
      minScore,
    });

    const selectedChunks = selectWithinBudget(searchResults, maxChars);
    const usedChars = selectedChunks.reduce((sum, c) => sum + c.chunkText.length, 0);

    return {
      chunks: selectedChunks,
      context: formatContext(selectedChunks),
      tokensUsed: Math.ceil(usedChars / CHARS_PER_TOKEN),
    };
  }
}

// ─── Token budget ───────────────────────────────────────────────────────────────

/**
 * Select chunks in relevance order until the character budget is exhausted,
 * truncating the final chunk to fit when there is meaningful room left.
 */
function selectWithinBudget(
  results: VectorSearchResult[],
  maxChars: number,
): RetrievedChunk[] {
  const selected: RetrievedChunk[] = [];
  let usedChars = 0;

  for (const result of results) {
    const chunkChars = result.chunkText.length;
    if (usedChars + chunkChars > maxChars && selected.length > 0) {
      const remaining = maxChars - usedChars;
      if (remaining > MIN_TRUNCATION_CHARS) {
        selected.push(toChunk(result, result.chunkText.slice(0, remaining) + "…"));
      }
      break;
    }
    selected.push(toChunk(result, result.chunkText));
    usedChars += chunkChars;
  }

  return selected;
}

function toChunk(result: VectorSearchResult, chunkText: string): RetrievedChunk {
  return {
    id: result.id,
    sourceType: result.sourceType,
    sourceId: result.sourceId,
    chunkText,
    score: result.score,
    metadata: result.metadata,
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";

  const lines: string[] = ["## Relevant Context\n"];

  for (const chunk of chunks) {
    const header = `[${chunk.sourceType}:${chunk.sourceId}] (score: ${chunk.score.toFixed(2)})`;
    lines.push(header);
    lines.push(chunk.chunkText.trim());
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
