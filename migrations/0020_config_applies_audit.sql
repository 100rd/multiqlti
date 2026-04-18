-- Config sync audit log (issue #319)
-- Persistent record of every config-sync apply operation.

CREATE TABLE IF NOT EXISTS "config_applies" (
  "id"             varchar        PRIMARY KEY DEFAULT gen_random_uuid(),
  "applied_at"     timestamp      NOT NULL DEFAULT now(),
  "applied_by"     text           NOT NULL,
  "git_commit_sha" text,
  "summary_json"   jsonb          NOT NULL DEFAULT '{}'::jsonb,
  "success"        boolean        NOT NULL DEFAULT false,
  "error"          text
);

CREATE INDEX IF NOT EXISTS "config_applies_applied_at_idx" ON "config_applies" ("applied_at" DESC);
CREATE INDEX IF NOT EXISTS "config_applies_success_idx"    ON "config_applies" ("success");
