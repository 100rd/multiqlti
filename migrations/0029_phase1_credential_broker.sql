-- migration: 0029_phase1_credential_broker
-- ADR-001 Phase 1a — credential_leases and credential_access_log tables.
--
-- Purpose:
--   Introduces the two audit/lease tables needed by the CredentialProvider broker.
--   Both tables carry projectId NOT NULL → projects(id) to ensure hard project
--   isolation.  The application layer (DbCryptoCredentialProvider) asserts
--   projectId === getProjectId() on every public method before reaching the DB.
--
-- Deploy sequence (push-based):
--   1. psql "$DATABASE_URL" -f migrations/0029_phase1_credential_broker.sql
--   2. npm run db:push   (schema.ts already declares the new tables; push is a no-op
--      for the DDL once the DB has the tables; safe to run regardless)
--
-- Idempotent: all DDL uses IF NOT EXISTS.
-- Transactional: wrapped in BEGIN/COMMIT.
--
-- credential_leases    — issued lease records (active | revoked | expired).
-- credential_access_log — append-only audit trail (one row per broker action).
--
-- Indexes:
--   credential_leases: (project_id), (run_id), (status) — supports issueLease
--     checks, revokeRunLeases, and the expiry sweeper.
--   credential_access_log: (project_id), (credential_id) — supports per-project
--     and per-credential audit queries.

BEGIN;

-- ─── credential_leases ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS credential_leases (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  credential_id TEXT        NOT NULL,
  project_id    TEXT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id        TEXT        NOT NULL,
  stage_id      TEXT        NOT NULL,
  requested_by  TEXT        NOT NULL,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  -- status: 'active' | 'revoked' | 'expired'
  status        TEXT        NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS credential_leases_project_id_idx
  ON credential_leases(project_id);

CREATE INDEX IF NOT EXISTS credential_leases_run_id_idx
  ON credential_leases(run_id);

CREATE INDEX IF NOT EXISTS credential_leases_status_idx
  ON credential_leases(status);

-- Composite index for the expiry sweeper: status + expires_at
CREATE INDEX IF NOT EXISTS credential_leases_status_expires_idx
  ON credential_leases(status, expires_at)
  WHERE status = 'active';

-- ─── credential_access_log ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS credential_access_log (
  id             TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  lease_id       TEXT,           -- nullable: list_metadata / get_metadata have no lease
  credential_id  TEXT        NOT NULL,
  project_id     TEXT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id         TEXT,           -- nullable: plan-time actions have no run
  stage_id       TEXT,           -- nullable: plan-time actions have no stage
  -- action: list_metadata | get_metadata | lease_issued | lease_used |
  --         lease_revoked | lease_expired
  action         TEXT        NOT NULL,
  requested_by   TEXT        NOT NULL,
  justification  TEXT,
  success        BOOLEAN     NOT NULL DEFAULT TRUE,
  error_message  TEXT,
  ttl_seconds    INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS credential_access_log_project_id_idx
  ON credential_access_log(project_id);

CREATE INDEX IF NOT EXISTS credential_access_log_credential_id_idx
  ON credential_access_log(credential_id);

CREATE INDEX IF NOT EXISTS credential_access_log_lease_id_idx
  ON credential_access_log(lease_id)
  WHERE lease_id IS NOT NULL;

COMMIT;

-- ─── Rollback (for reference — not auto-applied) ───────────────────────────────
--
--   BEGIN;
--   DROP TABLE IF EXISTS credential_access_log;
--   DROP TABLE IF EXISTS credential_leases;
--   COMMIT;
