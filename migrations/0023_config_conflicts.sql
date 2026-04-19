-- Config sync conflict tracking (issue #323)
-- Per-entity conflict detection, resolution strategies, and audit trail.
--
-- Behaviour:
--   • When an incoming config event targets an entity that was locally modified
--     after the last synced version, a conflict row is recorded here.
--   • Each entity kind has a configured resolution strategy.
--   • Conflicts awaiting human action have status = 'pending_human'.
--   • All resolutions (automatic and human) are recorded in config_conflict_audit.

CREATE TYPE config_conflict_status AS ENUM (
  'detected',
  'pending_human',
  'auto_resolved',
  'human_resolved',
  'dismissed'
);

CREATE TABLE IF NOT EXISTS "config_conflicts" (
  "id"              varchar   PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Entity that has conflicting state
  "entity_kind"     text      NOT NULL,
  "entity_id"       text      NOT NULL,
  -- The peer whose incoming event triggered the conflict
  "peer_id"         text      NOT NULL,
  -- The incoming event's version (ISO timestamp or UUID from the remote event)
  "remote_version"  text      NOT NULL,
  -- The local entity's version at conflict-detection time
  "local_version"   text      NOT NULL,
  -- Full payloads captured at detection time (for human review)
  "remote_payload"  jsonb     NOT NULL DEFAULT '{}'::jsonb,
  "local_payload"   jsonb     NOT NULL DEFAULT '{}'::jsonb,
  -- Resolution strategy that was applied
  "strategy"        text      NOT NULL,
  -- Current lifecycle status
  "status"          config_conflict_status NOT NULL DEFAULT 'detected',
  -- When the conflict was detected
  "detected_at"     timestamp NOT NULL DEFAULT now(),
  -- When it was resolved (null while open)
  "resolved_at"     timestamp,
  -- Who or what resolved it ('lww_auto' | 'skill_state_merge' | 'human:<userId>' | etc.)
  "resolved_by"     text,
  -- Human-readable notes about the resolution (optional)
  "resolution_note" text,
  -- Whether a "contested" UI flag is active (LWW strategies)
  "is_contested"    boolean   NOT NULL DEFAULT false,
  -- JSON snapshot of merged result (for skill-state auto-merge)
  "merged_payload"  jsonb
);

-- Query unresolved conflicts quickly
CREATE INDEX IF NOT EXISTS "config_conflicts_open_idx"
  ON "config_conflicts" ("entity_kind", "entity_id")
  WHERE "status" IN ('detected', 'pending_human');

-- Query conflicts by peer
CREATE INDEX IF NOT EXISTS "config_conflicts_peer_idx"
  ON "config_conflicts" ("peer_id", "detected_at");

-- Staleness alert query: find old unresolved conflicts
CREATE INDEX IF NOT EXISTS "config_conflicts_stale_idx"
  ON "config_conflicts" ("detected_at")
  WHERE "status" IN ('detected', 'pending_human');

-- ─── Per-entity strategy configuration table ───────────────────────────────────

CREATE TABLE IF NOT EXISTS "config_conflict_strategies" (
  "entity_kind"     text      PRIMARY KEY,
  -- 'lww' | 'human' | 'auto_merge' | 'approval_voting'
  "strategy"        text      NOT NULL DEFAULT 'lww',
  -- For 'lww': whether to set the is_contested flag on the winning side
  "mark_contested"  boolean   NOT NULL DEFAULT true,
  -- For staleness notifications: hours before alerting (0 = disabled)
  "alert_after_h"   integer   NOT NULL DEFAULT 24,
  "updated_at"      timestamp NOT NULL DEFAULT now()
);

-- Seed default strategies per entity kind
INSERT INTO "config_conflict_strategies" ("entity_kind", "strategy", "mark_contested", "alert_after_h")
VALUES
  ('pipeline',     'lww',         true,  24),
  ('trigger',      'lww',         true,  24),
  ('prompt',       'lww',         true,  24),
  ('connection',   'human',       false,  1),
  ('provider-key', 'human',       false,  1),
  ('preferences',  'lww',         false, 48),
  ('skill-state',  'auto_merge',  false, 48)
ON CONFLICT ("entity_kind") DO NOTHING;

-- ─── Audit log (append-only) ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "config_conflict_audit" (
  "id"              varchar   PRIMARY KEY DEFAULT gen_random_uuid(),
  "conflict_id"     varchar   NOT NULL REFERENCES "config_conflicts" ("id") ON DELETE CASCADE,
  "entity_kind"     text      NOT NULL,
  "entity_id"       text      NOT NULL,
  "peer_id"         text      NOT NULL,
  "strategy"        text      NOT NULL,
  "action"          text      NOT NULL,  -- 'detected' | 'auto_resolved' | 'human_resolved' | 'dismissed'
  "resolved_by"     text,
  "resolution_note" text,
  "payload_before"  jsonb,
  "payload_after"   jsonb,
  "recorded_at"     timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "config_conflict_audit_conflict_idx"
  ON "config_conflict_audit" ("conflict_id");

CREATE INDEX IF NOT EXISTS "config_conflict_audit_entity_idx"
  ON "config_conflict_audit" ("entity_kind", "entity_id");

CREATE INDEX IF NOT EXISTS "config_conflict_audit_recorded_at_idx"
  ON "config_conflict_audit" ("recorded_at");
