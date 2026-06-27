-- migration: 0027_phase0c_projectid_secret_tables
-- ADR-001 Phase 0c — per-project scoping for the remaining secret/config tables.
--
-- Tables modified:
--   provider_keys     — add project_id; swap unique(provider) → unique(project_id, provider)
--   argocd_config     — add project_id; convert id from fixed-DEFAULT-1 to serial; one row/project
--   triggers          — add project_id (denormalized from pipelines.project_id via JOIN backfill)
--   mcp_tool_calls    — add project_id (resolves PR-0a column-not-found gap; backfill from pipeline_runs)
--
-- Migration sequence per ADR-001 §5 (backfill-safe pattern):
--   1. Create sentinel "default" project (operator must reassign later — see note below)
--   2. Add columns as NULLABLE (safe while legacy rows have no project_id)
--   3. Backfill all existing rows
--   4. Set NOT NULL
--   5. provider_keys: drop old unique(provider) constraint; add unique(project_id, provider)
--   6. argocd_config: convert id column from fixed DEFAULT 1 to an auto-incrementing sequence
--
-- OPERATOR NOTE (sentinel project):
--   Existing provider_keys and argocd_config rows are assigned to the synthetic
--   "default" project (id = '__default__'). This keeps the DB constraint valid but
--   does NOT imply they are correctly scoped to a real user project.
--
--   Before enabling hard project isolation (PR-0a fail-closed + PR-0b requireProject),
--   an operator MUST:
--     1. Run: SELECT provider FROM provider_keys WHERE project_id = '__default__';
--     2. Reassign each row to the correct project via UPDATE provider_keys SET project_id = ...
--     3. Repeat for argocd_config.
--     4. Acknowledge the inventory by deleting or renaming the sentinel project row.
--
--   Failing to reassign will silently expose the default-project credentials to whichever
--   project context first calls the route (depending on requireProject enforcement).
--
-- Idempotent: every step uses IF NOT EXISTS / IF EXISTS / DO NOTHING guards.

-- ─── Step 1: Create sentinel "default" project ─────────────────────────────
-- Requires at least one user to exist (ownerId FK). We pick the first user by
-- created_at. If no users exist (fresh DB), the backfill is a no-op anyway.

DO $$
DECLARE
  v_owner_id TEXT;
BEGIN
  SELECT id INTO v_owner_id FROM users ORDER BY created_at ASC LIMIT 1;
  IF v_owner_id IS NOT NULL THEN
    INSERT INTO projects (id, name, description, owner_id, created_at, updated_at)
    VALUES (
      '__default__',
      'Default Project (legacy credentials — operator must reassign)',
      'Synthetic sentinel project created by migration 0027. Holds global credentials '
        'that existed before per-project scoping. Operator must reassign rows to real '
        'projects and remove this entry.',
      v_owner_id,
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

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

-- 5a. Drop old single-column unique constraint and add composite one
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
--     This replaces the singleton pattern with a proper surrogate key.
DO $$
BEGIN
  -- Only run if the sequence doesn't exist yet (idempotent)
  IF NOT EXISTS (
    SELECT 1 FROM pg_sequences
    WHERE schemaname = current_schema()
      AND sequencename = 'argocd_config_id_seq'
  ) THEN
    CREATE SEQUENCE argocd_config_id_seq;
    -- Start the sequence AFTER the current max id (existing row id=1 stays untouched)
    PERFORM setval('argocd_config_id_seq',
      COALESCE((SELECT MAX(id) FROM argocd_config), 0) + 1, false);
    -- Drop the static DEFAULT 1 and attach the sequence
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

-- Any triggers whose pipeline has no project_id yet fall back to sentinel
UPDATE triggers
SET project_id = '__default__'
WHERE project_id IS NULL;

-- 4c. Set NOT NULL
ALTER TABLE triggers
  ALTER COLUMN project_id SET NOT NULL;

-- Index for project-scoped trigger queries (withProject filter)
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

-- Rows without a pipeline_run_id (or whose run has no project_id) use sentinel
UPDATE mcp_tool_calls
SET project_id = '__default__'
WHERE project_id IS NULL;

-- 4d. Set NOT NULL
ALTER TABLE mcp_tool_calls
  ALTER COLUMN project_id SET NOT NULL;

-- Index for project-scoped tool-call queries (withProject filter)
CREATE INDEX IF NOT EXISTS mcp_tool_calls_project_id_idx ON mcp_tool_calls(project_id);

-- ─── Rollback (for reference — not auto-applied) ───────────────────────────
--
--   ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS project_id;
--   ALTER TABLE triggers DROP COLUMN IF EXISTS project_id;
--
--   ALTER TABLE argocd_config DROP CONSTRAINT IF EXISTS argocd_config_project_unique;
--   ALTER TABLE argocd_config DROP COLUMN IF EXISTS project_id;
--   ALTER TABLE argocd_config ALTER COLUMN id SET DEFAULT 1;
--   DROP SEQUENCE IF EXISTS argocd_config_id_seq;
--
--   ALTER TABLE provider_keys DROP CONSTRAINT IF EXISTS provider_keys_project_provider_unique;
--   ALTER TABLE provider_keys DROP COLUMN IF EXISTS project_id;
--   ALTER TABLE provider_keys ADD CONSTRAINT provider_keys_provider_unique UNIQUE (provider);
--
--   DELETE FROM projects WHERE id = '__default__';
