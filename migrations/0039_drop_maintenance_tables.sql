-- migration: 0039_drop_maintenance_tables
-- Drops the tables left behind by the removed Maintenance Autopilot subsystem.
--
-- Context:
--   The Maintenance Autopilot (Phase 4.5 + Auto-Trigger Phase 6.11) was removed as
--   a shipped-but-unused feature — maintenance_policies and maintenance_scans held
--   ZERO rows across every real run, the MaintenanceScheduler was never bootstrapped
--   anywhere in server/index.ts, and nothing in the live loop/orchestrator chain
--   reads these tables. The subsystem was wired end-to-end (Maintenance.tsx page →
--   /api/maintenance routes → scout/analytics on demand) but never adopted.
--
--   Removed code paths (this PR):
--     server/maintenance/{scheduler,scout,analytics}.ts, server/routes/maintenance.ts,
--     client/src/pages/Maintenance.tsx, client/src/components/settings/MaintenanceSettings.tsx.
--
--   Tables dropped (written only by the removed code):
--     auto_trigger_audit   → scan_id (FK) → maintenance_scans (ON DELETE restrict),
--                            triggered_by (FK) → users. Audited maintenance-scan
--                            findings that auto-triggered a pipeline run (Phase 6.11).
--     maintenance_scans    → policy_id (FK) → maintenance_policies, workspace_id → workspaces.
--     maintenance_policies → workspace_id → workspaces.
--
-- Deliberately NOT dropped / NOT touched (still live — see PR body):
--     server/maintenance/ephemeral-janitor.ts — an UNRELATED feature (issue #272,
--       ephemeral k8s namespace TTL janitor for the e2e_kubernetes pipeline stage)
--       that merely shares the server/maintenance/ directory. Left in place.
--     task_templates (Task Library) — the Task Library is LIVE: TemplatePicker is
--       rendered in CreateTaskGroup.tsx/TaskGroup.tsx and the orchestrator COPY-IN
--       path (task-orchestrator / task-group-editor → composeTemplateFields →
--       storage.getTaskTemplate) reads it. Not part of this migration.
--     workspaces, pipeline_runs, users — shared tables that maintenance only read.
--
-- Deploy sequence (push-based):
--   1. psql "$DATABASE_URL" -f migrations/0039_drop_maintenance_tables.sql
--   2. npm run db:push   (schema.ts no longer declares these tables)
--
-- Drop-only. Idempotent (IF EXISTS). Children dropped before parents (CASCADE is
-- also set as a backstop). Do NOT apply automatically — run against a DB only
-- after a reviewed backup.

-- Auto-Trigger Audit (child: FK auto_trigger_audit.scan_id → maintenance_scans)
DROP TABLE IF EXISTS auto_trigger_audit CASCADE;

-- Maintenance scans (child: FK maintenance_scans.policy_id → maintenance_policies)
DROP TABLE IF EXISTS maintenance_scans CASCADE;

-- Maintenance policies (parent)
DROP TABLE IF EXISTS maintenance_policies CASCADE;

-- Rollback:
--   Re-create the tables from the shared/schema.ts definitions as they existed
--   prior to this change (see git history of shared/schema.ts). All tables were
--   empty of live data across every real run.
