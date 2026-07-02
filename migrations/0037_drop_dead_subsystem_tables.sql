-- migration: 0037_drop_dead_subsystem_tables
-- Drops the tables left behind by five removed dead subsystems (Phase 3a).
--
-- Context:
--   The Orchestrator (debate-research run mode), Consensus (/consensus decision
--   verdict run mode), Morning Brief / News board, and Library subsystems were
--   removed as dead code — their tables held ZERO rows across every real run and
--   nothing in the live server chain reaches them any more. This migration drops
--   the tables that were used *only* by those removed code paths.
--
--   Orchestrator (workspace debate-research run mode):
--     orchestrator_runs, orchestrator_steps, orchestrator_debates,
--     orchestrator_research  — written only by the deleted PipelineController
--     orchestrator methods + server/orchestrator/. All key on
--     pipeline_runs.id ON DELETE CASCADE.
--
--   Consensus (/consensus decision verdict run mode):
--     consensus_runs, consensus_rounds, consensus_critical_issues  — written only
--     by the deleted server/consensus/. All key on pipeline_runs.id ON DELETE
--     CASCADE.
--
--   Morning Brief / News board:
--     news_item      → morning_brief (FK) → workspaces
--     news_profile   → workspaces
--     Written only by the deleted server/news/ + omniscience board provider.
--
--   Library (RSS/manual content collections):
--     library_items → library_channels (FK)  — written only by the deleted
--     server/routes/library.ts + server/services/rss-fetcher.ts.
--
-- Deliberately NOT dropped (still live — see PR body):
--     chat_messages  — the chat_messages table is still referenced by the LIVE
--                      pipeline flow (PipelineController.createChatMessage), the
--                      federation session-sharing handoff, and the pipeline
--                      AgentChat UI. Only the STANDALONE Chat page/routes were
--                      removed; the table and its shared plumbing were kept to
--                      avoid cascading into live pipeline/federation/storage core.
--
-- Deploy sequence (push-based):
--   1. psql "$DATABASE_URL" -f migrations/0037_drop_dead_subsystem_tables.sql
--   2. npm run db:push   (schema.ts no longer declares these tables)
--
-- Drop-only. Idempotent (IF EXISTS). Children dropped before parents (CASCADE is
-- also set as a backstop). Do NOT apply automatically — run against a DB only
-- after a reviewed backup.

-- Orchestrator run mode
DROP TABLE IF EXISTS orchestrator_research CASCADE;
DROP TABLE IF EXISTS orchestrator_debates CASCADE;
DROP TABLE IF EXISTS orchestrator_steps CASCADE;
DROP TABLE IF EXISTS orchestrator_runs CASCADE;

-- Consensus run mode
DROP TABLE IF EXISTS consensus_critical_issues CASCADE;
DROP TABLE IF EXISTS consensus_rounds CASCADE;
DROP TABLE IF EXISTS consensus_runs CASCADE;

-- Morning Brief / News board
DROP TABLE IF EXISTS news_item CASCADE;
DROP TABLE IF EXISTS morning_brief CASCADE;
DROP TABLE IF EXISTS news_profile CASCADE;

-- Library
DROP TABLE IF EXISTS library_items CASCADE;
DROP TABLE IF EXISTS library_channels CASCADE;

-- Rollback:
--   Re-create the tables from the shared/schema.ts definitions as they existed
--   prior to this change (see git history of shared/schema.ts). All tables were
--   empty of live data across every real run.
