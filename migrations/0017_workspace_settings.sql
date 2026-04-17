-- migration: 0017_workspace_settings
-- Adds a key-value settings store for per-workspace configuration.
-- Used initially to persist custom tool/skill source lists (issue #280).
-- The `value` column is a JSONB blob; callers own the schema per key.

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id VARCHAR NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value        JSONB NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, key)
);

-- Index for bulk reads per workspace
CREATE INDEX IF NOT EXISTS workspace_settings_workspace_idx ON workspace_settings(workspace_id);

-- Rollback: DROP TABLE workspace_settings;
