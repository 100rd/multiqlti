/**
 * Vector store operations backed by pgvector.
 *
 * All queries use parameterized inputs — never string concatenation.
 * Cosine similarity is used for ANN search (HNSW index).
 */
import { db } from "../db.js";
import { sql as drizzleSql, eq, and } from "drizzle-orm";
import { memoryChunks, embeddingProviderConfig } from "@shared/schema";
import type { MemoryChunkRow, InsertMemoryChunk, EmbeddingProviderConfigRow } from "@shared/schema";
import type { EmbeddingProviderConfig } from "./embeddings.js";
import type { ChunkSourceType } from "./chunker.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VectorSearchResult {
  id: string;
  workspaceId: string;
  sourceType: ChunkSourceType;
  sourceId: string;
  chunkText: string;
  metadata: Record<string, unknown>;
  ts: Date;
  /** Cosine similarity score (0–1, higher = more similar). */
  score: number;
}

export interface VectorSearchOptions {
  topK?: number;
  /** Filter by one or more source types. */
  sourceTypes?: ChunkSourceType[];
  /** Filter by specific source ID. */
  sourceId?: string;
  /** Minimum similarity score threshold (0–1). */
  minScore?: number;
}

// ─── Vector Store ─────────────────────────────────────────────────────────────

export class VectorStore {
  /**
   * Insert a single chunk with its embedding vector.
   */
  async insertChunk(data: InsertMemoryChunk): Promise<MemoryChunkRow> {
    const [row] = await db.insert(memoryChunks).values(data).returning();
    return row;
  }

  /**
   * Insert multiple chunks in a single statement.
   */
  async insertChunks(data: InsertMemoryChunk[]): Promise<MemoryChunkRow[]> {
    if (data.length === 0) return [];
    return db.insert(memoryChunks).values(data).returning();
  }

  /**
   * ANN similarity search using pgvector cosine distance.
   * Returns at most `topK` results ordered by similarity (descending).
   *
   * Uses raw SQL because drizzle-orm does not yet expose pgvector operator
   * bindings for ORDER BY and WHERE expressions.
   */
  async search(
    workspaceId: string,
    queryEmbedding: number[],
    options: VectorSearchOptions = {},
  ): Promise<VectorSearchResult[]> {
    const topK = options.topK ?? 10;
    const minScore = options.minScore ?? 0;

    // Encode the query vector as a pgvector literal: '[x,y,z]'
    const vecLiteral = `[${queryEmbedding.join(",")}]`;

    // Build parameterized conditions.
    const conditions = [`mc.workspace_id = $1`];
    const params: unknown[] = [workspaceId];
    let paramIdx = 2;

    if (options.sourceTypes && options.sourceTypes.length > 0) {
      const placeholders = options.sourceTypes.map(() => `$${paramIdx++}`).join(", ");
      conditions.push(`mc.source_type IN (${placeholders})`);
      params.push(...options.sourceTypes);
    }

    if (options.sourceId) {
      conditions.push(`mc.source_id = $${paramIdx++}`);
      params.push(options.sourceId);
    }

    const whereClause = conditions.join(" AND ");
    const vecParam = `$${paramIdx}`;
    const minScoreParam = `$${paramIdx + 1}`;
    const topKParam = `$${paramIdx + 2}`;
    params.push(vecLiteral, minScore, topK);

    // 1 - cosine_distance = cosine_similarity.
    const query = `
      SELECT
        mc.id,
        mc.workspace_id,
        mc.source_type,
        mc.source_id,
        mc.chunk_text,
        mc.metadata,
        mc.ts,
        1 - (mc.embedding <=> ${vecParam}::vector) AS score
      FROM memory_chunks mc
      WHERE ${whereClause}
        AND mc.embedding IS NOT NULL
        AND 1 - (mc.embedding <=> ${vecParam}::vector) >= ${minScoreParam}
      ORDER BY mc.embedding <=> ${vecParam}::vector
      LIMIT ${topKParam}
    `;

    // Access the underlying pg pool through drizzle's $client.
    const pgDb = db as unknown as {
      $client: {
        query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      };
    };
    const result = await pgDb.$client.query(query, params);

    return result.rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      sourceType: row.source_type as ChunkSourceType,
      sourceId: String(row.source_id),
      chunkText: String(row.chunk_text),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      ts: new Date(row.ts as string),
      score: Number(row.score),
    }));
  }

  /**
   * Delete all chunks for a specific source.
   */
  async deleteBySource(workspaceId: string, sourceType: ChunkSourceType, sourceId: string): Promise<number> {
    const result = await db
      .delete(memoryChunks)
      .where(
        and(
          eq(memoryChunks.workspaceId, workspaceId),
          eq(memoryChunks.sourceType, sourceType),
          eq(memoryChunks.sourceId, sourceId),
        ),
      )
      .returning({ id: memoryChunks.id });
    return result.length;
  }

  /**
   * Delete all chunks for a workspace.
   */
  async deleteByWorkspace(workspaceId: string): Promise<number> {
    const result = await db
      .delete(memoryChunks)
      .where(eq(memoryChunks.workspaceId, workspaceId))
      .returning({ id: memoryChunks.id });
    return result.length;
  }

  /**
   * Count chunks for a workspace, optionally filtered by source type.
   */
  async countChunks(workspaceId: string, sourceType?: ChunkSourceType): Promise<number> {
    const conditions = [eq(memoryChunks.workspaceId, workspaceId)];
    if (sourceType) {
      conditions.push(eq(memoryChunks.sourceType, sourceType));
    }
    const [row] = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(memoryChunks)
      .where(and(...conditions));
    return row?.count ?? 0;
  }

  /**
   * List distinct sources for a workspace.
   */
  async listSources(
    workspaceId: string,
  ): Promise<Array<{ sourceType: ChunkSourceType; sourceId: string; count: number }>> {
    const rows = await db
      .select({
        sourceType: memoryChunks.sourceType,
        sourceId: memoryChunks.sourceId,
        count: drizzleSql<number>`count(*)::int`,
      })
      .from(memoryChunks)
      .where(eq(memoryChunks.workspaceId, workspaceId))
      .groupBy(memoryChunks.sourceType, memoryChunks.sourceId)
      .orderBy(memoryChunks.sourceType);

    return rows.map((r) => ({
      sourceType: r.sourceType as ChunkSourceType,
      sourceId: r.sourceId,
      count: r.count,
    }));
  }

  // ─── Embedding provider config ──────────────────────────────────────────────

  async getEmbeddingConfig(workspaceId: string): Promise<EmbeddingProviderConfigRow | null> {
    const [row] = await db
      .select()
      .from(embeddingProviderConfig)
      .where(eq(embeddingProviderConfig.workspaceId, workspaceId));
    return row ?? null;
  }

  async upsertEmbeddingConfig(
    workspaceId: string,
    cfg: Partial<EmbeddingProviderConfig> & { provider: string; model: string; dimensions: number },
  ): Promise<EmbeddingProviderConfigRow> {
    const [row] = await db
      .insert(embeddingProviderConfig)
      .values({
        workspaceId,
        provider: cfg.provider,
        model: cfg.model,
        dimensions: cfg.dimensions,
        config: cfg.options ?? {},
      })
      .onConflictDoUpdate({
        target: embeddingProviderConfig.workspaceId,
        set: {
          provider: cfg.provider,
          model: cfg.model,
          dimensions: cfg.dimensions,
          config: cfg.options ?? {},
          updatedAt: drizzleSql`NOW()`,
        },
      })
      .returning();
    return row;
  }
}

export const vectorStore = new VectorStore();
