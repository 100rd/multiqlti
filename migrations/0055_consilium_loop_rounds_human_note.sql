-- migration: 0055_consilium_loop_rounds_human_note
-- The operator's steering note for a consilium round (#18 — runner-mode carry-forward).
--
-- consilium_loop_rounds.human_note → new TEXT (nullable).
--   Mirrors `task_group_iterations.human_note`: recorded by the operator AFTER a
--   round completes, folded into the NEXT round's review context. Legacy
--   (task-group) loops already carry the note via `task_group_iterations` +
--   `composeIterationInput`; runner-mode rounds never mint an iteration row, so
--   this column is where the note lives for those loops. NULL for every
--   pre-existing round (no backfill) and for any round the operator never
--   annotated — every consumer guards on NULL/blank before reading it.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS): metadata-only, no rewrite, no
-- data loss. Re-applying against a push-managed dev DB is safe.

ALTER TABLE consilium_loop_rounds
  ADD COLUMN IF NOT EXISTS human_note text;

-- Rollback:
--   ALTER TABLE consilium_loop_rounds DROP COLUMN human_note;
