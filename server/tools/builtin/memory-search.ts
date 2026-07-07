import type { ToolHandler } from "../registry";
import { EmbeddingProviderFactory, DEFAULT_EMBEDDING_CONFIG } from "../../memory/embeddings";
import type { EmbeddingProviderName } from "../../memory/embeddings";
import { VectorStore } from "../../memory/vector-store";
import type { ChunkSourceType } from "../../memory/chunker";

/** Top-K results for vector search. */
const DEFAULT_TOP_K = 5;

function formatVectorResult(chunk: { chunkText: string; sourceType: string; sourceId: string; score: number }): string {
  return `[vector:${chunk.sourceType}/${chunk.sourceId}] ${chunk.chunkText.slice(0, 200)} (score: ${chunk.score.toFixed(2)})`;
}

export const memorySearchHandler: ToolHandler = {
  definition: {
    name: "memory_search",
    description:
      "Semantic search over a workspace's embedded knowledge chunks. " +
      "Requires a workspace_id to search against.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to find relevant memories" },
        workspace_id: { type: "string", description: "Optional workspace ID to include vector search results" },
        top_k: { type: "number", description: "Max vector search results to return (default 5)" },
      },
      required: ["query"],
    },
    source: "builtin",
    tags: ["memory", "search", "context", "rag"],
  },
  async execute(args) {
    const query = String(args.query ?? "").trim();
    if (!query) return "Query cannot be empty.";

    const workspaceId = args.workspace_id ? String(args.workspace_id) : undefined;
    const topK = typeof args.top_k === "number" ? Math.max(1, Math.min(args.top_k, 20)) : DEFAULT_TOP_K;

    const vectorResults = workspaceId ? await performVectorSearch(workspaceId, query, topK) : [];

    if (vectorResults.length === 0) {
      return `No memories found matching "${query}".`;
    }

    const parts = ["--- Semantic Memory ---", ...vectorResults.map(formatVectorResult)];
    return parts.join("\n");
  },
};

// ─── Vector search helper ─────────────────────────────────────────────────────

async function performVectorSearch(
  workspaceId: string,
  query: string,
  topK: number,
): Promise<Array<{ chunkText: string; sourceType: ChunkSourceType; sourceId: string; score: number }>> {
  try {
    const store = new VectorStore();
    const configRow = await store.getEmbeddingConfig(workspaceId);

    const embeddingConfig = configRow
      ? {
          provider: configRow.provider as EmbeddingProviderName,
          model: configRow.model,
          dimensions: configRow.dimensions,
          options: configRow.config as Record<string, string> | undefined,
        }
      : DEFAULT_EMBEDDING_CONFIG;

    const provider = EmbeddingProviderFactory.create(embeddingConfig);
    const queryEmbedding = await provider.embed(query);
    return await store.search(workspaceId, queryEmbedding, { topK, minScore: 0.3 });
  } catch {
    // Vector search is best-effort — fail silently if Ollama is not running
    // or no embeddings exist yet.
    return [];
  }
}
