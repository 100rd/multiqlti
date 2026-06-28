-- migration: 0027_phase0c_projectid_secret_tables
-- ADR-001 Phase 0c — per-project scoping for the remaining secret/config tables.
--
-- Tables modified:
--   provider_keys     — add project_id; swap unique(provider) → unique(project_id, provider)
--   argocd_config     — add project_id; convert id from fixed-DEFAULT-1 to serial; one row/project
--   triggers          — add project_id (denormalized from pipelines.project_id via JOIN backfill)
--   mcp_tool_calls    — add project_id (resolves PR-0a column-not-found gap; backfill from pipeline_runs)
--
-- HOW TO APPLY (push-based deploy) — MANDATORY ORDERING:
--   1. Run this file FIRST (handles add-nullable → backfill → SET NOT NULL):
--        psql "$DATABASE_URL" -f migrations/0027_phase0c_projectid_secret_tables.sql
--   2. Then run: psql "$DATABASE_URL" -f migrations/0028_phase0d_clean_argocd_env.sql
--   3. THEN run `npm run db:push` (drizzle-kit push) to sync schema.ts.
--      schema.ts declares .notNull() on the four projectId columns; since the DB
--      already has NOT NULL after step 1, push is a no-op for those constraints.
--   Running db:push BEFORE step 1 fails on populated tables (no backfill yet).
--
-- Migration sequence per ADR-001 §5 (backfill-safe pattern):
--   1. Create __system__ user (permanent owner) + __default__ sentinel project
--   2. Add columns as NULLABLE (safe while legacy rows have no project_id)
--   3. Backfill all existing rows
--   4. Set NOT NULL
--   5. provider_keys: drop old unique(provider); add unique(project_id, provider)
--   6. argocd_config: convert id from fixed DEFAULT 1 to an auto-incrementing sequence
--
-- R3-HIGH SENTINEL CASCADE FIX:
--   The __default__ project is owned by the __system__ user — a permanent internal
--   user row that is NEVER deleted.  The original design tied ownership to the first
--   real user (ORDER BY created_at); a GDPR/user-purge of that user would cascade-
--   delete the sentinel project and all legacy provider_keys / argocd_config rows.
--   With __system__ as owner, user deletions cannot reach the sentinel project.
--   The __system__ user has is_active=FALSE so it CANNOT authenticate.
--   Operators MUST NOT delete the __system__ user row.
--
-- OPERATOR NOTE (sentinel project reassignment):
--   Existing provider_keys and argocd_config rows are assigned to '__default__'.
--   Before enabling hard project isolation (PR-0a fail-closed + PR-0b requireProject)
--   an operator MUST:
--     1. SELECT provider FROM provider_keys WHERE project_id = '__default__';
--     2. Reassign each row: UPDATE provider_keys SET project_id = '<real-id>' WHERE ...
--     3. Repeat for argocd_config.
--     4. Acknowledge by deleting or renaming the __default__ project row.
--
-- Idempotent: every step uses IF NOT EXISTS / IF EXISTS / DO NOTHING guards.
-- Transactional: entire file runs in BEGIN/COMMIT — partial failure rolls back all.

BEGIN;

-- ─── Step 1: Create __system__ user + sentinel __default__ project ──────────
--
-- __system__ is permanent. GDPR/user-purge operations MUST NOT delete it.
-- is_active=FALSE prevents login. Epoch timestamp makes it clearly synthetic.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = '__system__') THEN
    INSERT INTO users (id, email, name, is_active, role, created_at, updated_at)
    VALUES (
      '__system__',
      'system@internal.multiqlti',
      'System',
      FALSE,
      'user',
      TIMESTAMPTZ '1970-01-01 00:00:00+00',
      TIMESTAMPTZ '1970-01-01 00:00:00+00'
    );
  END IF;
END $$;

INSERT INTO projects (id, name, description, owner_id, created_at, updated_at)
VALUES (
  '__default__',
  'Default Project (legacy credentials — operator must reassign)',
  'Synthetic sentinel project created by migration 0027. Holds global credentials '
    'that existed before per-project scoping. Operator must reassign rows to real '
    'projects and remove this entry. Owner is __system__ (permanent; never delete).',
  '__system__',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- ─── provider_keys ─────────────────────────────────────────────────────────

-- 2a. Add project_id as nullable
ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;

-- 3a. Backfill existing rows with sentinel project
UPDATE provider_keys
SET project_id = '__default__'
WHERE project_id IS NULL;

-- 4a. Set NOT NULL
ALTER TABLE provider_keys
  ALTER COLUMN project_id SET NOT NULL;

-- 5a. Drop old single-column unique constraint; add composite constraint.
--     The old constraint name is provider_keys_provider_unique (Drizzle default).
ALTER TABLE provider_keys
  DROP CONSTRAINT IF EXISTS provider_keys_provider_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'provider_keys_project_provider_unique'
      AND conrelid = 'provider_keys'::regclass
  ) THEN
    ALTER TABLE provider_keys
      ADD CONSTRAINT provider_keys_project_provider_unique
      UNIQUE (project_id, provider);
  END IF;
END $$;

-- ─── argocd_config ─────────────────────────────────────────────────────────

-- 2b. Add project_id as nullable
ALTER TABLE argocd_config
  ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;

-- 3b. Backfill existing rows (typically only the singleton id=1 row)
UPDATE argocd_config
SET project_id = '__default__'
WHERE project_id IS NULL;

-- 4b. Set NOT NULL
ALTER TABLE argocd_config
  ALTER COLUMN project_id SET NOT NULL;

-- 5b. Add unique(project_id) — one ArgoCD config per project
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'argocd_config_project_unique'
      AND conrelid = 'argocd_config'::regclass
  ) THEN
    ALTER TABLE argocd_config
      ADD CONSTRAINT argocd_config_project_unique
      UNIQUE (project_id);
  END IF;
END $$;

-- 6b. Convert id from fixed DEFAULT 1 to an auto-incrementing sequence.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_sequences
    WHERE schemaname = current_schema()
      AND sequencename = 'argocd_config_id_seq'
  ) THEN
    CREATE SEQUENCE argocd_config_id_seq;
    PERFORM setval('argocd_config_id_seq',
      COALESCE((SELECT MAX(id) FROM argocd_config), 0) + 1, false);
    ALTER TABLE argocd_config ALTER COLUMN id DROP DEFAULT;
    ALTER TABLE argocd_config ALTER COLUMN id SET DEFAULT nextval('argocd_config_id_seq');
    ALTER SEQUENCE argocd_config_id_seq OWNED BY argocd_config.id;
  END IF;
END $$;

-- ─── triggers ──────────────────────────────────────────────────────────────

-- 2c. Add project_id as nullable
ALTER TABLE triggers
  ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;

-- 3c. Backfill from pipelines.project_id (denormalized — ADR-001 §3.1(e))
UPDATE triggers t
SET project_id = p.project_id
FROM pipelines p
WHERE t.pipeline_id = p.id
  AND t.project_id IS NULL
  AND p.project_id IS NOT NULL;

-- Triggers whose pipeline has no project_id fall back to sentinel
UPDATE triggers
SET project_id = '__default__'
WHERE project_id IS NULL;

-- 4c. Set NOT NULL
ALTER TABLE triggers
  ALTER COLUMN project_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS triggers_project_id_idx ON triggers(project_id);

-- ─── mcp_tool_calls ────────────────────────────────────────────────────────

-- 2d. Add project_id as nullable
ALTER TABLE mcp_tool_calls
  ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;

-- 3d. Backfill from pipeline_runs.project_id (via pipeline_run_id FK)
UPDATE mcp_tool_calls mc
SET project_id = pr.project_id
FROM pipeline_runs pr
WHERE mc.pipeline_run_id = pr.id
  AND mc.project_id IS NULL
  AND pr.project_id IS NOT NULL;

-- Rows without a pipeline_run_id or with no project_id on the run use sentinel
UPDATE mcp_tool_calls
SET project_id = '__default__'
WHERE project_id IS NULL;

-- 4d. Set NOT NULL
ALTER TABLE mcp_tool_calls
  ALTER COLUMN project_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS mcp_tool_calls_project_id_idx ON mcp_tool_calls(project_id);

COMMIT;

-- ─── Rollback (for reference — not auto-applied) ───────────────────────────
--
--   BEGIN;
--   ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS project_id;
--   ALTER TABLE triggers DROP COLUMN IF EXISTS project_id;
--   ALTER TABLE argocd_config DROP CONSTRAINT IF EXISTS argocd_config_project_unique;
--   ALTER TABLE argocd_config DROP COLUMN IF EXISTS project_id;
--   ALTER TABLE argocd_config ALTER COLUMN id SET DEFAULT 1;
--   DROP SEQUENCE IF EXISTS argocd_config_id_seq;
--   ALTER TABLE provider_keys DROP CONSTRAINT IF EXISTS provider_keys_project_provider_unique;
--   ALTER TABLE provider_keys DROP COLUMN IF EXISTS project_id;
--   ALTER TABLE provider_keys ADD CONSTRAINT provider_keys_provider_unique UNIQUE (provider);
--   DELETE FROM projects WHERE id = '__default__';
--   DELETE FROM users WHERE id = '__system__';
--   COMMIT;
