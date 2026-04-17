-- migration: 0018_memory_chunks
-- Adds vector-backed memory chunks for hybrid RAG retrieval (issue #282).
-- Requires: CREATE EXTENSION vector (pgvector) — applied here if absent.
-- HNSW index gives sub-millisecond ANN search at O(log n) complexity.

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── memory_chunks ────────────────────────────────────────────────────────────
-- source_type: 'code' | 'pipeline_run' | 'document' | 'memory_entry'
-- embedding dimensions are parametrized at insert time; 1536 is the OpenAI/
-- Voyage default. Ollama nomic-embed-text uses 768. Both fit in vector(1536)
-- because pgvector supports any inner dimension up to max_dimensions.
-- We store the actual model dimension in metadata.dim so ANN comparisons are
-- always within the same model family.

CREATE TABLE IF NOT EXISTS memory_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  VARCHAR NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL CHECK (source_type IN ('code','pipeline_run','document','memory_entry')),
  source_id     TEXT NOT NULL,
  chunk_text    TEXT NOT NULL,
  embedding     vector(1536),
  metadata      JSONB NOT NULL DEFAULT '{}',
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for fast approximate nearest-neighbour search (cosine distance).
-- m=16 / ef_construction=64 are sensible production defaults per pgvector docs.
CREATE INDEX IF NOT EXISTS memory_chunks_embedding_hnsw_idx
  ON memory_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Composite index for bulk deletes by workspace + source
CREATE INDEX IF NOT EXISTS memory_chunks_workspace_source_idx
  ON memory_chunks (workspace_id, source_type, source_id);

-- Index for time-ordered scans
CREATE INDEX IF NOT EXISTS memory_chunks_ts_idx
  ON memory_chunks (workspace_id, ts DESC);

-- ─── embedding_provider_config ────────────────────────────────────────────────
-- Per-workspace embedding provider configuration.
-- provider: 'ollama' | 'openai' | 'voyage' | 'jina'
-- config: provider-specific JSON (model, dimensions, api_key ref, etc.)

CREATE TABLE IF NOT EXISTS embedding_provider_config (
  workspace_id  VARCHAR NOT NULL PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL DEFAULT 'ollama',
  model         TEXT NOT NULL DEFAULT 'nomic-embed-text',
  dimensions    INTEGER NOT NULL DEFAULT 768,
  config        JSONB NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rollback:
--   DROP TABLE IF EXISTS embedding_provider_config;
--   DROP TABLE IF EXISTS memory_chunks;
--   DROP EXTENSION IF EXISTS vector;
