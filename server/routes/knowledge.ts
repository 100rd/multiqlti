/**
 * Knowledge management API — RAG chunk ingestion, search, and source management.
 *
 * Routes:
 *   GET    /api/workspaces/:id/knowledge/sources     — list indexed sources
 *   GET    /api/workspaces/:id/knowledge/search      — semantic search preview
 *   POST   /api/workspaces/:id/knowledge/ingest      — ingest text as chunks
 *   DELETE /api/workspaces/:id/knowledge/sources/:type/:sourceId — remove source
 *   GET    /api/workspaces/:id/knowledge/config      — get embedding config
 *   PUT    /api/workspaces/:id/knowledge/config      — update embedding config
 *   POST   /api/workspaces/:id/knowledge/re-embed    — re-embed all chunks (async job)
 */
import { Router } from "express";
import { z } from "zod";
import { VectorStore } from "../memory/vector-store";
import { TextChunker } from "../memory/chunker";
import { EmbeddingProviderFactory, DEFAULT_EMBEDDING_CONFIG } from "../memory/embeddings";
import type { EmbeddingProviderConfig } from "../memory/embeddings";
import { CHUNK_SOURCE_TYPES, EMBEDDING_PROVIDERS } from "@shared/schema";
import type { ChunkSourceType } from "../memory/chunker";

// ─── Validation schemas ───────────────────────────────────────────────────────

const ingestBodySchema = z.object({
  sourceType: z.enum(CHUNK_SOURCE_TYPES),
  sourceId: z.string().min(1).max(255),
  text: z.string().min(1),
  metadata: z.record(z.unknown()).optional().default({}),
  /** Replace existing chunks for this source before ingesting. */
  replace: z.boolean().optional().default(false),
});

const searchQuerySchema = z.object({
  q: z.string().min(1),
  topK: z.coerce.number().int().min(1).max(50).optional().default(10),
  sourceType: z.enum(CHUNK_SOURCE_TYPES).optional(),
});

const configBodySchema = z.object({
  provider: z.enum(EMBEDDING_PROVIDERS),
  model: z.string().min(1),
  dimensions: z.number().int().min(64).max(4096),
  options: z.record(z.string()).optional(),
});

// ─── Route registration ───────────────────────────────────────────────────────

export function registerKnowledgeRoutes(app: Router): void {
  // GET /api/workspaces/:id/knowledge/sources
  app.get("/api/workspaces/:id/knowledge/sources", async (req, res) => {
    const { id: workspaceId } = req.params;
    try {
      const store = new VectorStore();
      const sources = await store.listSources(workspaceId);
      return res.json(sources);
    } catch {
      return res.status(500).json({ error: "Failed to list knowledge sources" });
    }
  });

  // GET /api/workspaces/:id/knowledge/search
  app.get("/api/workspaces/:id/knowledge/search", async (req, res) => {
    const { id: workspaceId } = req.params;
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    try {
      const store = new VectorStore();
      const configRow = await store.getEmbeddingConfig(workspaceId);
      const embeddingConfig: EmbeddingProviderConfig = configRow
        ? {
            provider: configRow.provider as EmbeddingProviderConfig["provider"],
            model: configRow.model,
            dimensions: configRow.dimensions,
            options: configRow.config as Record<string, string> | undefined,
          }
        : DEFAULT_EMBEDDING_CONFIG;

      const provider = EmbeddingProviderFactory.create(embeddingConfig);
      const queryEmbedding = await provider.embed(parsed.data.q);

      const results = await store.search(workspaceId, queryEmbedding, {
        topK: parsed.data.topK,
        sourceTypes: parsed.data.sourceType ? [parsed.data.sourceType] : undefined,
        minScore: 0.2,
      });

      return res.json(results);
    } catch (err) {
      return res.status(500).json({ error: `Search failed: ${(err as Error).message}` });
    }
  });

  // POST /api/workspaces/:id/knowledge/ingest
  app.post("/api/workspaces/:id/knowledge/ingest", async (req, res) => {
    const { id: workspaceId } = req.params;
    const parsed = ingestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { sourceType, sourceId, text, metadata, replace } = parsed.data;

    try {
      const store = new VectorStore();
      const configRow = await store.getEmbeddingConfig(workspaceId);
      const embeddingConfig: EmbeddingProviderConfig = configRow
        ? {
            provider: configRow.provider as EmbeddingProviderConfig["provider"],
            model: configRow.model,
            dimensions: configRow.dimensions,
            options: configRow.config as Record<string, string> | undefined,
          }
        : DEFAULT_EMBEDDING_CONFIG;

      const provider = EmbeddingProviderFactory.create(embeddingConfig);
      const chunker = new TextChunker({ maxChunkTokens: 512, overlapTokens: 64 });

      if (replace) {
        await store.deleteBySource(workspaceId, sourceType as ChunkSourceType, sourceId);
      }

      const chunks = chunker.chunk(text, sourceType as ChunkSourceType, metadata);
      if (chunks.length === 0) {
        return res.json({ inserted: 0, chunks: [] });
      }

      // Embed all chunks in batch.
      const embeddings = await provider.embedBatch(chunks.map((c) => c.text));

      const rows = chunks.map((chunk, i) => ({
        workspaceId,
        sourceType,
        sourceId,
        chunkText: chunk.text,
        embedding: embeddings[i],
        metadata: {
          ...chunk.metadata,
          dim: embeddingConfig.dimensions,
          model: embeddingConfig.model,
          provider: embeddingConfig.provider,
        },
      }));

      const inserted = await store.insertChunks(rows);

      return res.status(201).json({ inserted: inserted.length, chunks: inserted.map((r) => r.id) });
    } catch (err) {
      return res.status(500).json({ error: `Ingest failed: ${(err as Error).message}` });
    }
  });

  // DELETE /api/workspaces/:id/knowledge/sources/:type/:sourceId
  app.delete("/api/workspaces/:id/knowledge/sources/:type/:sourceId", async (req, res) => {
    const { id: workspaceId, type, sourceId } = req.params;

    if (!CHUNK_SOURCE_TYPES.includes(type as ChunkSourceType)) {
      return res.status(400).json({ error: `Invalid source type: ${type}` });
    }

    try {
      const store = new VectorStore();
      const deleted = await store.deleteBySource(workspaceId, type as ChunkSourceType, sourceId);
      return res.json({ deleted });
    } catch {
      return res.status(500).json({ error: "Failed to delete knowledge source" });
    }
  });

  // GET /api/workspaces/:id/knowledge/config
  app.get("/api/workspaces/:id/knowledge/config", async (req, res) => {
    const { id: workspaceId } = req.params;
    try {
      const store = new VectorStore();
      const config = await store.getEmbeddingConfig(workspaceId);
      return res.json(config ?? { provider: "ollama", model: "nomic-embed-text", dimensions: 768 });
    } catch {
      return res.status(500).json({ error: "Failed to get embedding config" });
    }
  });

  // PUT /api/workspaces/:id/knowledge/config
  app.put("/api/workspaces/:id/knowledge/config", async (req, res) => {
    const { id: workspaceId } = req.params;
    const parsed = configBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    try {
      const store = new VectorStore();
      const row = await store.upsertEmbeddingConfig(workspaceId, {
        ...parsed.data,
        options: parsed.data.options,
      });
      return res.json(row);
    } catch {
      return res.status(500).json({ error: "Failed to update embedding config" });
    }
  });

  // POST /api/workspaces/:id/knowledge/re-embed
  // Triggers a background re-embedding job when provider/model changes.
  app.post("/api/workspaces/:id/knowledge/re-embed", async (req, res) => {
    const { id: workspaceId } = req.params;
    try {
      const store = new VectorStore();
      const count = await store.countChunks(workspaceId);

      // Fire-and-forget: re-embed in background. We acknowledge immediately.
      reEmbedWorkspace(workspaceId).catch((err) => {
        console.warn(`[knowledge] re-embed failed for workspace ${workspaceId}:`, err);
      });

      return res.json({ accepted: true, totalChunks: count });
    } catch {
      return res.status(500).json({ error: "Failed to start re-embed job" });
    }
  });
}

// ─── Re-embed job ─────────────────────────────────────────────────────────────

/**
 * Re-embed all chunks in a workspace using the current provider config.
 * Processes in batches to avoid memory pressure.
 */
async function reEmbedWorkspace(workspaceId: string): Promise<void> {
  const { db } = await import("../db.js");
  const { memoryChunks } = await import("@shared/schema");
  const { eq, isNotNull, sql: drizzleSql } = await import("drizzle-orm");

  const store = new VectorStore();
  const configRow = await store.getEmbeddingConfig(workspaceId);
  const embeddingConfig: EmbeddingProviderConfig = configRow
    ? {
        provider: configRow.provider as EmbeddingProviderConfig["provider"],
        model: configRow.model,
        dimensions: configRow.dimensions,
        options: configRow.config as Record<string, string> | undefined,
      }
    : DEFAULT_EMBEDDING_CONFIG;

  const provider = EmbeddingProviderFactory.create(embeddingConfig);

  const BATCH = 50;
  let offset = 0;

  while (true) {
    const rows = await db
      .select({ id: memoryChunks.id, chunkText: memoryChunks.chunkText })
      .from(memoryChunks)
      .where(eq(memoryChunks.workspaceId, workspaceId))
      .limit(BATCH)
      .offset(offset);

    if (rows.length === 0) break;

    const embeddings = await provider.embedBatch(rows.map((r) => r.chunkText));

    for (let i = 0; i < rows.length; i++) {
      await db
        .update(memoryChunks)
        .set({
          embedding: embeddings[i],
          metadata: drizzleSql`jsonb_set(metadata, '{model}', ${JSON.stringify(embeddingConfig.model)}::jsonb)`,
        })
        .where(eq(memoryChunks.id, rows[i].id));
    }

    offset += BATCH;
  }
}
