/**
 * Production wiring for the practice-card routes.
 *
 * Bridges the route layer's injected interfaces (EmbeddingClient / VectorClient)
 * to the real VectorStore + per-workspace EmbeddingProvider, identical to the
 * flow knowledge.ts already uses. Tests bypass this and inject mocks instead.
 */
import { VectorStore } from "../memory/vector-store";
import { EmbeddingProviderFactory, DEFAULT_EMBEDDING_CONFIG } from "../memory/embeddings";
import type { EmbeddingProviderConfig } from "../memory/embeddings";
import type {
  PracticeCardDeps,
  EmbeddingClient,
  VectorClient,
  RefreshClient,
} from "../routes/practice-cards";
import { loadGraph } from "./compliance-mapper";

function toEmbeddingConfig(
  configRow: {
    provider: string;
    model: string;
    dimensions: number;
    config: unknown;
  } | null,
): EmbeddingProviderConfig {
  if (!configRow) return DEFAULT_EMBEDDING_CONFIG;
  return {
    provider: configRow.provider as EmbeddingProviderConfig["provider"],
    model: configRow.model,
    dimensions: configRow.dimensions,
    options: configRow.config as Record<string, string> | undefined,
  };
}

/**
 * Build the real dependency bundle for the practice-card routes. The refresh
 * scheduler is passed in (it needs storage) so this stays a thin adapter.
 */
export function buildPracticeCardDeps(refresh?: RefreshClient): PracticeCardDeps {
  const store = new VectorStore();

  const getEmbeddingClient = async (workspaceId: string): Promise<EmbeddingClient> => {
    const configRow = await store.getEmbeddingConfig(workspaceId);
    const config = toEmbeddingConfig(configRow);
    const provider = EmbeddingProviderFactory.create(config);
    return {
      embed: (text: string) => provider.embed(text),
      dimensions: config.dimensions,
      model: config.model,
      provider: config.provider,
    };
  };

  const vector: VectorClient = {
    insertChunks: (rows) =>
      store.insertChunks(rows as Parameters<VectorStore["insertChunks"]>[0]),
    deleteBySource: (workspaceId, sourceType, sourceId) =>
      store.deleteBySource(workspaceId, sourceType, sourceId),
    search: async (workspaceId, queryEmbedding, options) => {
      const results = await store.search(workspaceId, queryEmbedding, {
        topK: options.topK,
        sourceTypes: ["practice_card"],
        minScore: options.minScore,
      });
      return results.map((r) => ({ sourceId: r.sourceId, score: r.score }));
    },
  };

  return { getEmbeddingClient, vector, refresh, loadComplianceGraph: () => loadGraph() };
}
