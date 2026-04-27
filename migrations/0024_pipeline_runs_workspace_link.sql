-- migration: 0024_pipeline_runs_workspace_link
-- Adds an optional workspace_id link to pipeline_runs so a run can be bound
-- to the workspace it operates against. Pipelines remain workspace-agnostic
-- templates; the binding is per-run.
--
-- Nullable; legacy / unbound runs stay NULL. ON DELETE SET NULL preserves run
-- history when a workspace is removed.
--
-- Issue: #343

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS workspace_id VARCHAR
    REFERENCES workspaces(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pipeline_runs_workspace_idx
  ON pipeline_runs(workspace_id)
  WHERE workspace_id IS NOT NULL;

-- Rollback:
--   DROP INDEX IF EXISTS pipeline_runs_workspace_idx;
--   ALTER TABLE pipeline_runs DROP COLUMN workspace_id;
