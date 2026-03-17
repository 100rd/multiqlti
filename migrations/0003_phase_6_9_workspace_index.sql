-- Phase 6.9: Semantic Workspace Indexing
-- Adds workspace_symbols table and index_status/owner_id columns to workspaces

-- ─── Add owner_id to workspaces (nullable, no cascade — legacy rows stay accessible) ───
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS index_status TEXT NOT NULL DEFAULT 'idle';

COMMENT ON COLUMN workspaces.owner_id IS 'User who connected this workspace. Enforced on Phase 6.9+ endpoints.';
COMMENT ON COLUMN workspaces.index_status IS 'idle | indexing | ready | error';

-- ─── workspace_symbols table ──────────────────────────────────────────────────
CREATE TABLE workspace_symbols (
  id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  VARCHAR NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,    -- 'function' | 'class' | 'interface' | 'type' | 'variable' | 'export' | 'import'
  line          INTEGER NOT NULL,
  col           INTEGER NOT NULL DEFAULT 0,
  signature     TEXT,
  file_hash     TEXT NOT NULL,    -- SHA-256 hex of file at index time
  exported_from TEXT,             -- module specifier if this is a re-export
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT workspace_symbols_unique
    UNIQUE (workspace_id, file_path, name, kind)
);

-- Index: symbol lookup by workspace + name (symbol search)
CREATE INDEX workspace_symbols_name_idx
  ON workspace_symbols (workspace_id, name);

-- Index: file-level lookup (incremental hash check, stale cleanup)
CREATE INDEX workspace_symbols_file_idx
  ON workspace_symbols (workspace_id, file_path);

-- Index: kind filter (e.g. "show only functions")
CREATE INDEX workspace_symbols_kind_idx
  ON workspace_symbols (workspace_id, kind);

COMMENT ON TABLE workspace_symbols IS 'AST-extracted symbols per workspace file. Supports incremental re-indexing via file_hash. Phase 6.9.';
