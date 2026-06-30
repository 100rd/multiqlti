-- migration: 0031_consilium_loops_engineer_instruction
-- Adds a nullable `engineer_instruction` text column to consilium_loops for the
-- Stage 1 (design §5) HUMAN free-text "engineer instruction".
--
-- When set on the "New consilium review" route it is threaded (sanitized +
-- byte-clamped, fenced-as-data) into the dispute objective (factory
-- `objectiveExtra`) AND persisted here so the intent→archetype planner can read
-- it. It is UNTRUSTED text — inert in storage, never a shell/branch/PR sink.
--
-- Nullable; no backfill — null means "no engineer instruction", which is exactly
-- the existing behavior, so every pre-existing loop keeps working unchanged (full
-- back-compat).
--
-- Idempotent (IF NOT EXISTS) so re-applying against a push-managed dev DB is safe.

ALTER TABLE consilium_loops
  ADD COLUMN IF NOT EXISTS engineer_instruction TEXT;

-- Rollback:
--   ALTER TABLE consilium_loops DROP COLUMN engineer_instruction;
