-- Migration: Phase 6.7 — Add swarm result columns to stage_executions
--
-- Both columns are nullable (NULL when the stage was not a swarm stage).
-- No indexes needed: these columns are read by runId+stageIndex, which is
-- already covered by the existing (run_id, stage_index) access pattern.

ALTER TABLE stage_executions
  ADD COLUMN IF NOT EXISTS swarm_clone_results JSONB,
  ADD COLUMN IF NOT EXISTS swarm_meta JSONB;
