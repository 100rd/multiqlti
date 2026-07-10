-- migration: 0058_secrets_vault
-- Phase 1 secrets manager — project-scoped secrets vault table.
--
-- Purpose:
--   Introduces `secrets`, a named/versioned credential store owned directly by
--   a project (distinct from the workspaceConnections-backed credentials that
--   DbCryptoCredentialProvider also serves). `value_encrypted` holds AES-256-GCM
--   ciphertext (crypto.ts `v2:` format) and is written/read ONLY inside
--   server/credentials/db-crypto-provider.ts. project_id NOT NULL → projects(id)
--   enforces hard project isolation; the application layer additionally asserts
--   projectId === getProjectId() on every broker method.
--
-- Deploy sequence (push-based):
--   1. psql "$DATABASE_URL" -f migrations/0058_secrets_vault.sql
--   2. npm run db:push   (schema.ts already declares the table; push is a no-op
--      for the DDL once the DB has it; safe to run regardless)
--
-- Idempotent: all DDL uses IF NOT EXISTS.
-- Transactional: wrapped in BEGIN/COMMIT.
-- Additive only — no existing table/column touched.

BEGIN;

CREATE TABLE IF NOT EXISTS secrets (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  project_id       TEXT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  description      TEXT,
  scope            TEXT,
  provider         TEXT,
  value_encrypted  TEXT,
  version          INTEGER     NOT NULL DEFAULT 1,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at       TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS secrets_project_name_idx
  ON secrets (project_id, name);

COMMIT;

-- ─── Rollback (for reference — not auto-applied) ───────────────────────────────
--
--   BEGIN;
--   DROP TABLE IF EXISTS secrets;
--   COMMIT;
