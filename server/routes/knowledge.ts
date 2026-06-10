/**
 * Knowledge management API — RAG chunk ingestion, search, and source management.
 *
 * Routes (ALL workspace-scoped under requireAuth, registered in routes.ts):
 *   GET    /api/workspaces/:id/knowledge/sources     — list indexed sources
 *   GET    /api/workspaces/:id/knowledge/search      — semantic search preview
 *   POST   /api/workspaces/:id/knowledge/ingest      — ingest text as chunks
 *   DELETE /api/workspaces/:id/knowledge/sources/:type/:sourceId — remove source
 *   GET    /api/workspaces/:id/knowledge/config      — get embedding config
 *   PUT    /api/workspaces/:id/knowledge/config      — update embedding config
 *   POST   /api/workspaces/:id/knowledge/re-embed    — re-embed all chunks (async job)
 *
 * Security (issue #358 — authenticated IDOR fix):
 *   Every route resolves the `:id` workspace via storage.getWorkspace and gates
 *   on its ownerId BEFORE touching the vector store. Mirrors the practice-card
 *   routes (requireOwnerOrRole(() => ws.ownerId, ...)) and the orchestrator
 *   authorizeRun / workspaces.getOwnedWorkspace idiom:
 *     - Ordering: 401 (unauth, via requireAuth) → 404 (missing) → 403 (non-owner).
 *     - null-owner is DENIED for non-admins (stricter, matches orchestrator +
 *       Phase 6.9 getOwnedWorkspace IDOR prevention). Admins may still access.
 *     - Reads (search, sources, config read) and mutations alike require
 *       owner-or-admin — knowledge chunks are private workspace data.
 *   Client errors stay generic; internal detail is logged server-side only.
 */
import type { Router, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import { VectorStore } from "../memory/vector-store";
import { TextChunker } from "../memory/chunker";
import { EmbeddingProviderFactory, DEFAULT_EMBEDDING_CONFIG } from "../memory/embeddings";
import type { EmbeddingProvider, EmbeddingProviderConfig } from "../memory/embeddings";
import { CHUNK_SOURCE_TYPES, EMBEDDING_PROVIDERS } from "@shared/schema";
import type { EmbeddingProviderConfigRow } from "@shared/schema";
import type { ChunkSourceType } from "../memory/chunker";

// ─── Injectable dependencies (so tests can avoid Ollama / pgvector) ────────────

/**
 * The subset of VectorStore behaviour the routes depend on. Injecting it keeps
 * production behaviour identical (default = real VectorStore) while letting the
 * IDOR auth-gate tests run over an in-memory mock with no DB.
 */
export interface KnowledgeStore {
  listSources(
    workspaceId: string,
  ): Promise<Array<{ sourceType: ChunkSourceType; sourceId: string; count: number }>>;
  search(
    workspaceId: string,
    queryEmbedding: number[],
    options: { topK?: number; sourceTypes?: ChunkSourceType[]; minScore?: number },
  ): Promise<Array<Record<string, unknown>>>;
  insertChunks(rows: Array<Record<string, unknown>>): Promise<Array<{ id: string }>>;
  deleteBySource(
    workspaceId: string,
    sourceType: ChunkSourceType,
    sourceId: string,
  ): Promise<number>;
  countChunks(workspaceId: string): Promise<number>;
  getEmbeddingConfig(workspaceId: string): Promise<EmbeddingProviderConfigRow | null>;
  upsertEmbeddingConfig(
    workspaceId: string,
    cfg: { provider: string; model: string; dimensions: number; options?: Record<string, string> },
  ): Promise<EmbeddingProviderConfigRow>;
}

export interface KnowledgeDeps {
  /** Factory for a per-request vector store. Defaults to a real VectorStore. */
  createStore: () => KnowledgeStore;
  /** Factory for an embedding provider from a config. Defaults to the real factory. */
  createEmbeddingProvider: (config: EmbeddingProviderConfig) => EmbeddingProvider;
}

function defaultDeps(): KnowledgeDeps {
  return {
    createStore: () => new VectorStore() as unknown as KnowledgeStore,
    createEmbeddingProvider: (config) => EmbeddingProviderFactory.create(config),
  };
}

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

// ─── Authorization helper ──────────────────────────────────────────────────────

function logServerError(context: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  // Detail stays server-side only; clients get a generic message.
  console.warn(`[knowledge] ${context}: ${detail}`);
}

/**
 * Resolve the `:id` workspace and authorize the caller against its ownerId.
 *
 * Returns the resolved workspace id on success, or sends the correct status
 * (401 → 404 → 403) and returns null. Knowledge chunks are private workspace
 * data, so the gate is owner-OR-admin for BOTH reads and mutations, and
 * null-owner is DENIED for non-admins (matching orchestrator authorizeRun and
 * workspaces.getOwnedWorkspace IDOR prevention).
 */
async function authorizeWorkspace(
  req: Request,
  res: Response,
  storage: IStorage,
): Promise<string | null> {
  // 401 first — unauth takes precedence over existence.
  const user = req.user;
  if (!user?.id) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  const ws = await storage.getWorkspace(String(req.params.id));
  if (!ws) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }

  const isAdmin = user.role === "admin";
  // Deny ownerless workspaces for non-admins (stricter; no implicit access).
  const isOwner = ws.ownerId != null && ws.ownerId === user.id;
  if (!isAdmin && !isOwner) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }

  return ws.id;
}

/** Resolve the embedding config for a workspace, falling back to the default. */
async function resolveEmbeddingConfig(
  store: KnowledgeStore,
  workspaceId: string,
): Promise<EmbeddingProviderConfig> {
  const configRow = await store.getEmbeddingConfig(workspaceId);
  if (!configRow) return DEFAULT_EMBEDDING_CONFIG;
  return {
    provider: configRow.provider as EmbeddingProviderConfig["provider"],
    model: configRow.model,
    dimensions: configRow.dimensions,
    options: configRow.config as Record<string, string> | undefined,
  };
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerKnowledgeRoutes(
  app: Router,
  storage: IStorage,
  deps: KnowledgeDeps = defaultDeps(),
): void {
  // GET /api/workspaces/:id/knowledge/sources
  app.get("/api/workspaces/:id/knowledge/sources", async (req, res) => {
    const workspaceId = await authorizeWorkspace(req, res, storage);
    if (!workspaceId) return;
    try {
      const store = deps.createStore();
      const sources = await store.listSources(workspaceId);
      return res.json(sources);
    } catch (err) {
      logServerError("list sources failed", err);
      return res.status(500).json({ error: "Failed to list knowledge sources" });
    }
  });

  // GET /api/workspaces/:id/knowledge/search
  app.get("/api/workspaces/:id/knowledge/search", async (req, res) => {
    const workspaceId = await authorizeWorkspace(req, res, storage);
    if (!workspaceId) return;
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    try {
      const store = deps.createStore();
      const embeddingConfig = await resolveEmbeddingConfig(store, workspaceId);
      const provider = deps.createEmbeddingProvider(embeddingConfig);
      const queryEmbedding = await provider.embed(parsed.data.q);

      const results = await store.search(workspaceId, queryEmbedding, {
        topK: parsed.data.topK,
        sourceTypes: parsed.data.sourceType ? [parsed.data.sourceType] : undefined,
        minScore: 0.2,
      });

      return res.json(results);
    } catch (err) {
      logServerError("search failed", err);
      return res.status(500).json({ error: "Search failed" });
    }
  });

  // POST /api/workspaces/:id/knowledge/ingest
  app.post("/api/workspaces/:id/knowledge/ingest", async (req, res) => {
    const workspaceId = await authorizeWorkspace(req, res, storage);
    if (!workspaceId) return;
    const parsed = ingestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { sourceType, sourceId, text, metadata, replace } = parsed.data;

    try {
      const store = deps.createStore();
      const embeddingConfig = await resolveEmbeddingConfig(store, workspaceId);
      const provider = deps.createEmbeddingProvider(embeddingConfig);
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
      logServerError("ingest failed", err);
      return res.status(500).json({ error: "Ingest failed" });
    }
  });

  // DELETE /api/workspaces/:id/knowledge/sources/:type/:sourceId
  app.delete("/api/workspaces/:id/knowledge/sources/:type/:sourceId", async (req, res) => {
    const workspaceId = await authorizeWorkspace(req, res, storage);
    if (!workspaceId) return;
    const { type, sourceId } = req.params;

    if (!CHUNK_SOURCE_TYPES.includes(type as ChunkSourceType)) {
      return res.status(400).json({ error: `Invalid source type: ${type}` });
    }

    try {
      const store = deps.createStore();
      const deleted = await store.deleteBySource(workspaceId, type as ChunkSourceType, sourceId);
      return res.json({ deleted });
    } catch (err) {
      logServerError("delete source failed", err);
      return res.status(500).json({ error: "Failed to delete knowledge source" });
    }
  });

  // GET /api/workspaces/:id/knowledge/config
  app.get("/api/workspaces/:id/knowledge/config", async (req, res) => {
    const workspaceId = await authorizeWorkspace(req, res, storage);
    if (!workspaceId) return;
    try {
      const store = deps.createStore();
      const config = await store.getEmbeddingConfig(workspaceId);
      return res.json(config ?? { provider: "ollama", model: "nomic-embed-text", dimensions: 768 });
    } catch (err) {
      logServerError("get config failed", err);
      return res.status(500).json({ error: "Failed to get embedding config" });
    }
  });

  // PUT /api/workspaces/:id/knowledge/config
  app.put("/api/workspaces/:id/knowledge/config", async (req, res) => {
    const workspaceId = await authorizeWorkspace(req, res, storage);
    if (!workspaceId) return;
    const parsed = configBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    try {
      const store = deps.createStore();
      const row = await store.upsertEmbeddingConfig(workspaceId, {
        ...parsed.data,
        options: parsed.data.options,
      });
      return res.json(row);
    } catch (err) {
      logServerError("update config failed", err);
      return res.status(500).json({ error: "Failed to update embedding config" });
    }
  });

  // POST /api/workspaces/:id/knowledge/re-embed
  // Triggers a background re-embedding job when provider/model changes.
  app.post("/api/workspaces/:id/knowledge/re-embed", async (req, res) => {
    const workspaceId = await authorizeWorkspace(req, res, storage);
    if (!workspaceId) return;
    try {
      const store = deps.createStore();
      const count = await store.countChunks(workspaceId);

      // Fire-and-forget: re-embed in background. We acknowledge immediately.
      reEmbedWorkspace(workspaceId, deps).catch((err) => {
        logServerError(`re-embed failed for workspace ${workspaceId}`, err);
      });

      return res.json({ accepted: true, totalChunks: count });
    } catch (err) {
      logServerError("start re-embed failed", err);
      return res.status(500).json({ error: "Failed to start re-embed job" });
    }
  });
}

// ─── Re-embed job ─────────────────────────────────────────────────────────────

/**
 * Re-embed all chunks in a workspace using the current provider config.
 * Processes in batches to avoid memory pressure.
 */
async function reEmbedWorkspace(workspaceId: string, deps: KnowledgeDeps): Promise<void> {
  const { db } = await import("../db.js");
  const { memoryChunks } = await import("@shared/schema");
  const { eq, sql: drizzleSql } = await import("drizzle-orm");

  const store = deps.createStore();
  const embeddingConfig = await resolveEmbeddingConfig(store, workspaceId);
  const provider = deps.createEmbeddingProvider(embeddingConfig);

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
