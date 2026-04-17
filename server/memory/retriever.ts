/**
 * RAG retrieval helper.
 *
 * retrieveContext() embeds the query, searches the vector store, applies a
 * token budget, and returns formatted context chunks ready for LLM injection.
 */
import type { EmbeddingProvider } from "./embeddings.js";
import type { VectorStore, VectorSearchResult } from "./vector-store.js";
import type { ChunkSourceType } from "./chunker.js";

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

// ─── Retriever ────────────────────────────────────────────────────────────────

export class Retriever {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly vectorStore: VectorStore,
  ) {}

  async retrieveContext(options: RetrievalOptions): Promise<RetrievalResult> {
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

    // Apply token budget: include chunks in order of relevance until budget exhausted.
    const selectedChunks: RetrievedChunk[] = [];
    let usedChars = 0;

    for (const result of searchResults) {
      const chunkChars = result.chunkText.length;
      if (usedChars + chunkChars > maxChars && selectedChunks.length > 0) {
        // Partial inclusion: truncate the last chunk to fit within budget.
        const remaining = maxChars - usedChars;
        if (remaining > 40) {
          selectedChunks.push({
            id: result.id,
            sourceType: result.sourceType,
            sourceId: result.sourceId,
            chunkText: result.chunkText.slice(0, remaining) + "…",
            score: result.score,
            metadata: result.metadata,
          });
          usedChars += remaining;
        }
        break;
      }
      selectedChunks.push({
        id: result.id,
        sourceType: result.sourceType,
        sourceId: result.sourceId,
        chunkText: result.chunkText,
        score: result.score,
        metadata: result.metadata,
      });
      usedChars += chunkChars;
    }

    const context = formatContext(selectedChunks);
    const tokensUsed = Math.ceil(usedChars / CHARS_PER_TOKEN);

    return { chunks: selectedChunks, context, tokensUsed };
  }
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
