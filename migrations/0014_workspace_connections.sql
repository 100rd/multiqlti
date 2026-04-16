-- Migration: Encrypted external workspace connections (issue #266)
-- Adds workspace_connections table with AES-GCM encrypted secrets column.
-- Rollback: DROP TABLE workspace_connections;

CREATE TABLE IF NOT EXISTS "workspace_connections" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" varchar NOT NULL,
  "type" text NOT NULL,
  "name" text NOT NULL,
  -- Non-secret configuration (URLs, project keys, regions, etc.)
  "config_json" jsonb NOT NULL DEFAULT '{}',
  -- AES-256-GCM encrypted JSON blob of secrets; NULL when no secrets are stored.
  -- Format: hex(iv[12] || authTag[16] || ciphertext) — see server/crypto.ts
  "secrets_encrypted" text,
  "status" text NOT NULL DEFAULT 'active',
  "last_tested_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "created_by" text,
  CONSTRAINT "workspace_connections_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "workspace_connections_created_by_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "workspace_connections_type_check"
    CHECK ("type" IN ('gitlab', 'github', 'kubernetes', 'aws', 'jira', 'grafana', 'generic_mcp')),
  CONSTRAINT "workspace_connections_status_check"
    CHECK ("status" IN ('active', 'inactive', 'error'))
);

CREATE INDEX IF NOT EXISTS "workspace_connections_workspace_id_idx"
  ON "workspace_connections" ("workspace_id");

CREATE INDEX IF NOT EXISTS "workspace_connections_workspace_type_idx"
  ON "workspace_connections" ("workspace_id", "type");
