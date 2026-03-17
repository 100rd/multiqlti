-- Phase 6.6: Hierarchical Orchestration (Manager Agent)
-- Adds manager_config column to pipelines and creates manager_iterations table

-- Add manager_config column to pipelines table (nullable JSONB, opt-in)
ALTER TABLE pipelines ADD COLUMN manager_config JSONB;
COMMENT ON COLUMN pipelines.manager_config IS 'Manager mode config. If non-null, pipeline uses manager orchestration instead of linear/DAG.';

-- Create manager_iterations table to store iteration history
CREATE TABLE manager_iterations (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id VARCHAR NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  iteration_number INTEGER NOT NULL,
  decision JSONB NOT NULL,
  team_result TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  decision_duration_ms INTEGER NOT NULL DEFAULT 0,
  team_duration_ms INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT manager_iterations_run_iteration_unique
    UNIQUE (run_id, iteration_number)
);

-- Index for fast run lookups
CREATE INDEX manager_iterations_run_id_idx ON manager_iterations(run_id);

COMMENT ON TABLE manager_iterations IS 'Stores iteration history for manager-mode pipeline runs (Phase 6.6)';
