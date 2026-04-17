import type { ToolHandler } from "../registry";
import { storage } from "../../storage";
import { getFederationManager } from "../../federation/manager-state";
import { MemoryFederationService } from "../../federation/memory-federation";
import type { FederatedMemoryResult } from "../../federation/memory-federation";
import { EmbeddingProviderFactory, DEFAULT_EMBEDDING_CONFIG } from "../../memory/embeddings";
import type { EmbeddingProviderName } from "../../memory/embeddings";
import { VectorStore } from "../../memory/vector-store";
import type { ChunkSourceType } from "../../memory/chunker";

/** Timeout for federated search fan-out (ms). */
const FEDERATION_TIMEOUT_MS = 3000;

/** Top-K results for vector search. */
const DEFAULT_TOP_K = 5;

/**
 * Build a MemoryFederationService on first use and cache it.
 * Returns null when federation is not enabled.
 */
let cachedService: MemoryFederationService | null = null;
function getMemoryFederation(): MemoryFederationService | null {
  if (cachedService) return cachedService;
  const fm = getFederationManager();
  if (!fm || !fm.isEnabled()) return null;
  cachedService = new MemoryFederationService(fm, storage, "local", "local");
  return cachedService;
}

function formatLocalResult(m: { type: string; key: string; content: string; confidence: number }): string {
  return `[${m.type}] ${m.key}: ${m.content} (confidence: ${m.confidence.toFixed(2)})`;
}

function formatFederatedResult(r: FederatedMemoryResult): string {
  const relevance = r.relevance !== undefined ? ` (relevance: ${r.relevance.toFixed(2)})` : "";
  return `[${r.sourceInstanceName}] ${r.content}${relevance}`;
}

function formatVectorResult(chunk: { chunkText: string; sourceType: string; sourceId: string; score: number }): string {
  return `[vector:${chunk.sourceType}/${chunk.sourceId}] ${chunk.chunkText.slice(0, 200)} (score: ${chunk.score.toFixed(2)})`;
}

export const memorySearchHandler: ToolHandler = {
  definition: {
    name: "memory_search",
    description:
      "Search project memories — decisions, patterns, known issues, preferences, and facts stored by previous pipeline runs. " +
      "When a workspace_id is provided, also performs semantic vector search over embedded knowledge chunks. " +
      "When federation is enabled, also searches peer instances.",
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

    try {
      const [localMemories, vectorResults] = await Promise.all([
        storage.searchMemories(query),
        workspaceId ? performVectorSearch(workspaceId, query, topK) : Promise.resolve([]),
      ]);

      const federation = getMemoryFederation();

      // Build output parts.
      const parts: string[] = [];

      if (vectorResults.length > 0) {
        parts.push("--- Semantic Memory ---");
        parts.push(...vectorResults.map(formatVectorResult));
      }

      if (localMemories.length > 0) {
        parts.push("--- Structured Memory ---");
        parts.push(...localMemories.map(formatLocalResult));
      }

      if (!federation) {
        if (parts.length === 0) {
          return `No memories found matching "${query}".`;
        }
        return parts.join("\n");
      }

      // Federated search.
      const publishedLocal: FederatedMemoryResult[] = localMemories
        .filter((m) => m.published)
        .map((m) => ({
          id: String(m.id),
          content: m.content,
          tags: (m.tags ?? []) as string[],
          sourceInstance: "local",
          sourceInstanceName: "local",
          relevance: m.confidence,
        }));

      const { results: federatedResults, sources } = await federation.federatedSearch(
        query,
        publishedLocal,
        FEDERATION_TIMEOUT_MS,
      );

      const remoteResults = federatedResults.filter((r) => r.sourceInstance !== "local");
      if (remoteResults.length > 0) {
        parts.push("--- Federated ---");
        parts.push(...remoteResults.map(formatFederatedResult));

        const sourceInfo = Object.entries(sources)
          .map(([src, count]) => `${src}: ${count}`)
          .join(", ");
        parts.push(`\n(Sources: ${sourceInfo})`);
      }

      if (parts.length === 0) {
        return `No memories found matching "${query}".`;
      }

      return parts.join("\n");
    } catch (err) {
      console.warn("[memory-search] Memory search failed:", err);
      return `Memory search unavailable: ${(err as Error).message}`;
    }
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
    return store.search(workspaceId, queryEmbedding, { topK, minScore: 0.3 });
  } catch {
    // Vector search is best-effort — fail silently if Ollama is not running
    // or no embeddings exist yet.
    return [];
  }
}
