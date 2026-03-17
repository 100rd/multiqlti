-- Migration: Phase 6.7 — add swarm result columns to stage_executions
ALTER TABLE stage_executions
  ADD COLUMN swarm_clone_results JSONB,
  ADD COLUMN swarm_meta JSONB;

-- Both columns are nullable (NULL when the stage was not a swarm stage).
-- No indexes needed: these columns are read by runId+stageIndex, which is
-- already covered by the existing (run_id, stage_index) access pattern.
