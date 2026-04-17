-- Subjective Conflict Resolution (issue #229)
-- session_conflicts: mutable lifecycle table for active disputes
-- decision_log: append-only history of all resolved conflicts

CREATE TABLE IF NOT EXISTS "session_conflicts" (
  "id"                   varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"           varchar NOT NULL,
  "raised_by"            text NOT NULL,
  "raised_by_instance"   text NOT NULL,
  "question"             text NOT NULL,
  "context"              text,
  "strategy"             text NOT NULL,
  "status"               text NOT NULL DEFAULT 'open',
  "proposals"            jsonb NOT NULL DEFAULT '[]'::jsonb,
  "votes"                jsonb NOT NULL DEFAULT '[]'::jsonb,
  "quorum_threshold"     real NOT NULL DEFAULT 0.67,
  "timeout_ms"           integer NOT NULL DEFAULT 300000,
  "judgement"            jsonb,
  "experiment_results"   jsonb,
  "outcome"              jsonb,
  "created_at"           timestamp NOT NULL DEFAULT now(),
  "updated_at"           timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "session_conflicts_session_idx" ON "session_conflicts" ("session_id");
CREATE INDEX IF NOT EXISTS "session_conflicts_status_idx"  ON "session_conflicts" ("status");

CREATE TABLE IF NOT EXISTS "decision_log" (
  "id"                varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"        varchar NOT NULL,
  "conflict_id"       varchar NOT NULL,
  "question"          text NOT NULL,
  "strategy"          text NOT NULL,
  "outcome"           jsonb NOT NULL,
  "participant_count" integer NOT NULL DEFAULT 0,
  "proposal_count"    integer NOT NULL DEFAULT 0,
  "duration_ms"       integer NOT NULL DEFAULT 0,
  "recorded_at"       timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "decision_log_session_idx"     ON "decision_log" ("session_id");
CREATE INDEX IF NOT EXISTS "decision_log_conflict_idx"    ON "decision_log" ("conflict_id");
CREATE INDEX IF NOT EXISTS "decision_log_recorded_at_idx" ON "decision_log" ("recorded_at");
