-- Migration: Token budget enforcement and cost reporting per provider/workspace (issue #279)
-- Adds cost_ledger (append-only) and budgets tables.
-- Rollback:
--   DROP TABLE IF EXISTS budgets;
--   DROP TABLE IF EXISTS cost_ledger;

-- ─── cost_ledger ─────────────────────────────────────────────────────────────
-- Append-only ledger — never UPDATE or DELETE rows.
-- Each row records the actual token usage and USD cost for one LLM call.
CREATE TABLE IF NOT EXISTS "cost_ledger" (
  "id"              varchar  PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"    varchar  NOT NULL,
  "provider"        text     NOT NULL,
  "model"           text     NOT NULL,
  "pipeline_run_id" varchar,
  "stage_id"        text,
  "prompt_tokens"   integer  NOT NULL DEFAULT 0,
  "completion_tokens" integer NOT NULL DEFAULT 0,
  "cost_usd"        real     NOT NULL DEFAULT 0,
  "ts"              timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "cost_ledger_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "cost_ledger_pipeline_run_fk"
    FOREIGN KEY ("pipeline_run_id") REFERENCES "pipeline_runs"("id") ON DELETE SET NULL
);

-- Workspace + time-range queries (most common pattern)
CREATE INDEX IF NOT EXISTS "cost_ledger_workspace_ts_idx"
  ON "cost_ledger" ("workspace_id", "ts");

-- Provider breakdown queries
CREATE INDEX IF NOT EXISTS "cost_ledger_workspace_provider_idx"
  ON "cost_ledger" ("workspace_id", "provider");

-- Pipeline run rollup
CREATE INDEX IF NOT EXISTS "cost_ledger_run_idx"
  ON "cost_ledger" ("pipeline_run_id");

-- ─── budgets ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "budgets" (
  "id"              varchar  PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"    varchar  NOT NULL,
  -- NULL means "applies to all providers for this workspace"
  "provider"        text,
  -- day | week | month
  "period"          text     NOT NULL DEFAULT 'month',
  "limit_usd"       real     NOT NULL,
  -- true = hard block when limit is reached; false = soft warn only
  "hard"            boolean  NOT NULL DEFAULT false,
  -- percentage thresholds that trigger notifications, e.g. {50, 80, 100}
  "notify_at_pct"   integer[] NOT NULL DEFAULT '{}',
  "created_at"      timestamp NOT NULL DEFAULT now(),
  "updated_at"      timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "budgets_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "budgets_period_check"
    CHECK ("period" IN ('day', 'week', 'month')),
  CONSTRAINT "budgets_limit_positive"
    CHECK ("limit_usd" > 0)
);

-- Fast lookup by workspace (budget check hot path)
CREATE INDEX IF NOT EXISTS "budgets_workspace_id_idx"
  ON "budgets" ("workspace_id");
