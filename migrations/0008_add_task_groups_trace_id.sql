-- Add missing trace_id column to task_groups table
-- Referenced by Drizzle schema (shared/schema.ts) but absent from DB
ALTER TABLE task_groups ADD COLUMN IF NOT EXISTS trace_id text;
