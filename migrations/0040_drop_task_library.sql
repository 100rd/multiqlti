-- migration: 0040_drop_task_library
-- Drops the Task Library (task_templates) table and its last referencing column,
-- orphaned after the loop-centric UI consolidation.
--
-- Orphan chain:
--   PR #450 (0039) deliberately KEPT task_templates: the Task Library was LIVE —
--     TemplatePicker was rendered on CreateTaskGroup.tsx/TaskGroup.tsx and the
--     orchestrator COPY-IN path (task-orchestrator / task-group-editor →
--     composeTemplateFields → storage.getTaskTemplate) read it at task-create time.
--   PR #451 retired the standalone task-group pages + template-picker.tsx, leaving
--     the Task Library page and the copy-in seam as the only remaining consumers.
--   This PR removes both: the Task Library page + hooks, the /api/task-templates
--     routes, the storage CRUD, and the templateId copy-in seam end-to-end. With
--     nothing left that reads or writes task_templates, the table is dropped here.
--
-- Objects dropped (written only by the removed code):
--   tasks.template_id    → the provenance FK column (references task_templates.id,
--                          ON DELETE set null). Only ever written by the copy-in
--                          seam and only ever read by the deleted Task Library UI;
--                          never read by the loop/dispute/run hot path. Dropping it
--                          also removes the FK constraint that references
--                          task_templates, so the table can then be dropped.
--   task_templates       → owner-scoped reusable single-task recipes + labels.
--                          FKs: created_by → users (set null), project_id → projects
--                          (cascade). Index task_templates_created_by_idx.
--
-- Deploy sequence (push-based, mirrors 0039):
--   1. psql "$DATABASE_URL" -f migrations/0040_drop_task_library.sql
--   2. npm run db:push   (schema.ts no longer declares the table or the column)
--
-- Drop-only. Idempotent (IF EXISTS). The referencing column is dropped BEFORE the
-- table so no FK dangles (CASCADE on the table drop is a backstop). Do NOT apply
-- automatically — run against a DB only after a reviewed backup.

-- Provenance column on tasks (child: FK tasks.template_id → task_templates.id).
ALTER TABLE tasks DROP COLUMN IF EXISTS template_id;

-- Task Library (parent).
DROP TABLE IF EXISTS task_templates CASCADE;

-- Rollback:
--   Re-create task_templates from the shared/schema.ts definition as it existed
--   prior to this change (see git history) and re-add tasks.template_id as
--   `varchar references task_templates(id) on delete set null`. All task_templates
--   rows and template_id provenance were product-orphaned before this migration.
