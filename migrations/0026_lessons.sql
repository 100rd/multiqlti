-- migration: 0026_lessons
-- Adds the native agent-experience "lessons" table (memory-architecture ADR,
-- Track B). A lesson records the OUTCOME of a run or stage (what worked / what
-- failed) so the planning stage can recall relevant prior lessons and improve
-- the pipeline across runs. Source material lives in stage_executions
-- (status/error/output/rejection_reason — `error` added in #342) and run
-- outcomes; capture is additive and never blocks a run.
--
-- All columns except outcome/title/summary are nullable; no backfill — older
-- runs are not retro-summarized. workspace_id / run_id / stage_id are kept as
-- loose references (no FK) so lessons survive deletion of the rows they
-- summarize, preserving cross-run learning history.
--
-- Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS lessons (
  id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  VARCHAR,
  run_id        VARCHAR,
  stage_id      VARCHAR,
  team_id       TEXT,
  model_slug    TEXT,
  outcome       TEXT NOT NULL,
  category      TEXT,
  error_pattern TEXT,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,
  detail        JSONB,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lessons_workspace_idx  ON lessons(workspace_id);
CREATE INDEX IF NOT EXISTS lessons_team_idx        ON lessons(team_id);
CREATE INDEX IF NOT EXISTS lessons_outcome_idx     ON lessons(outcome);
CREATE INDEX IF NOT EXISTS lessons_created_at_idx  ON lessons(created_at);

-- Rollback:
--   DROP INDEX IF EXISTS lessons_created_at_idx;
--   DROP INDEX IF EXISTS lessons_outcome_idx;
--   DROP INDEX IF EXISTS lessons_team_idx;
--   DROP INDEX IF EXISTS lessons_workspace_idx;
--   DROP TABLE IF EXISTS lessons;
