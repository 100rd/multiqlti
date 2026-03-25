CREATE TABLE IF NOT EXISTS "shared_sessions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" varchar NOT NULL,
  "share_token" varchar NOT NULL,
  "owner_instance_id" text NOT NULL,
  "created_by" text NOT NULL,
  "expires_at" timestamp,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "shared_sessions_share_token_unique" UNIQUE("share_token")
);

CREATE INDEX IF NOT EXISTS "idx_shared_sessions_run_id" ON "shared_sessions" ("run_id");
CREATE INDEX IF NOT EXISTS "idx_shared_sessions_token" ON "shared_sessions" ("share_token");
CREATE INDEX IF NOT EXISTS "idx_shared_sessions_active" ON "shared_sessions" ("is_active") WHERE "is_active" = true;
