-- migration: 0053_retire_pipelines_memories
-- Retires the legacy pipelines DAG/stage-execution engine and the legacy
-- relational memories subsystem, per the multi-team cleanup on
-- chore/retire-legacy-pipelines-memories.
--
-- Context:
--   The product has moved orchestration to Consilium Loops / Task Groups v2,
--   and memory to the vector/RAG subsystem (memory_chunks, Subsystem B — NOT
--   touched here). The pipelines engine (PipelineController, TeamRegistry,
--   the DAG executor, the manager-agent iteration loop) and the relational
--   `memories` table are dead product surface: server-side code that read or
--   wrote any of the tables below was deleted earlier in this same effort
--   (server/controller/pipeline-controller.ts, server/teams/*,
--   server/pipeline/*, server/memory/provider.ts + extractor.ts, the
--   /api/pipelines, /api/runs, /api/guardrails, /api/strategies, /api/dag
--   routes, and the delegation-service).
--
-- Drop set (6 tables, child→parent FK order):
--   manager_iterations → stage_executions → pipeline_runs → pipelines
--   → memories → delegation_requests
--   (memories and delegation_requests are standalone — no FK to/from the
--   pipeline chain — but are dropped in this same pass per the same
--   dead-subsystem rationale.)
--
-- FK-constraint-only drops (columns and their tables STAY — these are live,
-- unrelated features that happened to carry a pipeline_run_id/run_id column):
--   mcp_tool_calls.pipeline_run_id  — live tool-call audit trail
--     (server/tools/mcp-client.ts, server/tools/audit.ts). The column is kept
--     as a plain (no-FK) varchar; historical rows keep their value, new
--     rows may carry an id that no longer resolves to anything (acceptable —
--     it was already an optional, best-effort audit field).
--   cost_ledger.pipeline_run_id     — live cost/billing aggregation
--     (server/services/cost-service.ts groups spend by this field). Same
--     column-stays / FK-only-detach treatment as mcp_tool_calls above.
--   traces.run_id                   — the traces table stays (write-less;
--     server/tracing/tracer.ts's only caller was the deleted
--     PipelineController, so createTrace() has zero real callers going
--     forward). getTraces()/getTraceByRunId() (server/storage-pg.ts) no
--     longer query through pipeline_runs at all — they now return []/null
--     unconditionally, so no code depends on this FK either. See task #29
--     (WorkspaceTraces repoint to task_traces) for the eventual full
--     retirement of this table's read path.
--
-- DROP COLUMN (removed, not just FK-detached):
--   triggers.pipeline_id — genuinely vestigial: the T1 retarget
--     (loop-triggers.md) already repointed every trigger to fire a
--     CONSILIUM LOOP, not a pipeline run; the column had been nullable and
--     unused by any live code path (assertTriggerAccess no longer resolves
--     it, config-sync's applyTriggerEvent no longer gates on it). Its index
--     (triggers_pipeline_id_idx) and FK are dropped implicitly along with
--     the column.
--
-- Deliberately NOT dropped (still live — verified by grep against the
-- server tree before this migration was authored):
--   traces, task_traces, experience_items, skill_proposals, memory_chunks,
--   embedding_provider_config, practice_cards, shared_sessions, lessons,
--   consilium_loops / consilium_loop_rounds, credential_leases (security-
--   owned, untouched), tasks.pipeline_id / tasks.pipeline_run_id (live
--   task-grouping field, task-group-editor.ts / task-orchestrator.ts;
--   flagged as a separate follow-up architectural decision, not part of
--   this drop set).
--
-- Deploy sequence (push-based):
--   1. psql "$DATABASE_URL" -f migrations/0053_retire_pipelines_memories.sql
--   2. npm run db:push -- --force   (schema.ts no longer declares these
--      tables/columns/constraints; push reconciles anything this hand-
--      written SQL didn't already cover)
--
-- Drop-only. Idempotent (IF EXISTS). FK constraints and the vestigial
-- triggers column are detached/dropped BEFORE the table DROPs below so the
-- table drops are never CASCADE-implicit for the mcp_tool_calls/cost_ledger
-- FKs (CASCADE is still set as a backstop for anything this migration
-- missed). Do NOT apply automatically — run against a DB only after a
-- reviewed backup. The actual `db:push --force` apply is HUMAN-GATED
-- (dev-DB snapshot + explicit go-ahead), never run by an agent.

-- ── Step 1: detach FK constraints on tables/columns that STAY ──────────────
ALTER TABLE mcp_tool_calls DROP CONSTRAINT IF EXISTS mcp_tool_calls_pipeline_run_fk;
ALTER TABLE cost_ledger    DROP CONSTRAINT IF EXISTS cost_ledger_pipeline_run_fk;
ALTER TABLE traces         DROP CONSTRAINT IF EXISTS traces_run_id_pipeline_runs_id_fk;

-- ── Step 2: drop the vestigial triggers.pipeline_id column (+ its index/FK) ─
ALTER TABLE triggers DROP COLUMN IF EXISTS pipeline_id;

-- ── Step 3: drop the 6 tables, child→parent ─────────────────────────────────
DROP TABLE IF EXISTS manager_iterations CASCADE;
DROP TABLE IF EXISTS stage_executions CASCADE;
DROP TABLE IF EXISTS pipeline_runs CASCADE;
DROP TABLE IF EXISTS pipelines CASCADE;
DROP TABLE IF EXISTS memories CASCADE;
DROP TABLE IF EXISTS delegation_requests CASCADE;

-- Rollback:
--   Re-create the 6 tables from the shared/schema.ts definitions as they
--   existed prior to this change (see git history of shared/schema.ts).
--   Re-add triggers.pipeline_id as a nullable varchar (no data to restore —
--   the T1 retarget already made every live row's value moot).
--   Re-add the mcp_tool_calls_pipeline_run_fk / cost_ledger_pipeline_run_fk /
--   traces_run_id_pipeline_runs_id_fk constraints only if pipeline_runs is
--   also restored first (they reference it).
