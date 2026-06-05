-- migration: 0025_stage_executions_error
-- Adds a nullable `error` text column to stage_executions so a stage's failure
-- reason is persisted on the run record. Previously the error was only
-- broadcast over WebSocket and written to the OTEL traces table, leaving the
-- run UI with status="failed", output=null and no reason after a page reload.
--
-- Nullable; no backfill — older failed runs have nothing useful to backfill
-- from (their trace spans, if any, are left in place).
--
-- Issue: #342

ALTER TABLE stage_executions
  ADD COLUMN IF NOT EXISTS error TEXT;

-- Rollback:
--   ALTER TABLE stage_executions DROP COLUMN error;
