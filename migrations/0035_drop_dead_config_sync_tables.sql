-- migration: 0035_drop_dead_config_sync_tables
-- Drops two dead tables left behind by the removed export/apply config-sync subsystem.
--
-- Context:
--   The `server/config-sync/` export/apply orchestrators and the `mqlti config` CLI
--   (script/mqlti-config.ts) were removed as dead code — nothing in the live server
--   entrypoint chain imported them. This migration drops the two tables that were
--   used *only* by that removed code path and have ZERO remaining code usage:
--
--     config_applies          — apply-attempt audit log (was written by the deleted
--                                server/config-sync/audit-log.ts; read by `mqlti config
--                                history`). No FK in or out.
--     config_events_received  — federation idempotency log. Never persisted to: the
--                                federation runtime uses in-memory idempotency, and no
--                                code imports the table or its inferred types. No FK.
--
-- Deliberately NOT dropped (still live — see PR body):
--     config_events_outbox        — FK target of the retained `peer_pending_events`
--                                   table; its ConfigEventOperation type is imported by
--                                   live server/federation/config-sync.ts.
--     config_conflicts,
--     config_conflict_strategies,
--     config_conflict_audit       — their $inferSelect/$inferInsert types are consumed
--                                   by live server/federation/config-conflict.ts, which
--                                   is wired into server/routes/federation.ts.
--     peer_pending_events         — live federation offline queue (out of scope).
--
-- Deploy sequence (push-based):
--   1. psql "$DATABASE_URL" -f migrations/0035_drop_dead_config_sync_tables.sql
--   2. npm run db:push   (schema.ts no longer declares these tables)
--
-- Drop-only. Idempotent (IF EXISTS). Do NOT apply automatically — run against a DB
-- only after a reviewed backup.

DROP TABLE IF EXISTS config_applies CASCADE;
DROP TABLE IF EXISTS config_events_received CASCADE;

-- Rollback:
--   Re-create the tables from the schema.ts definitions as they existed prior to this
--   change (see git history of shared/schema.ts). Both tables were empty of live data.
