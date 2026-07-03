-- migration: 0041_consilium_loops_applied_skills
-- Adds a nullable `applied_skills` jsonb column to consilium_loops for the Stage 2
-- feature "skills extend the loop's engineer instruction".
--
-- When the "New consilium review" route is given `skillIds`, the factory resolves
-- each (PROJECT-SCOPED) skills-table row and APPENDS its directives to the human
-- engineer instruction (fenced-as-data, byte-clamped so nothing truncates mid-skill).
-- This column records WHICH skills shaped the launch, as an ordered array of
-- `{ id, name, dropped? }`:
--   - an entry WITHOUT `dropped` was applied in full;
--   - an entry WITH `dropped: true` was resolved but DROPPED WHOLE (lowest-priority
--     -last) to keep the combined instruction under the byte budget.
-- It is INERT display/audit data (the launch passport lists it); never a shell/
-- branch/PR sink.
--
-- We add a DEDICATED column (rather than riding archetype_params) because that
-- jsonb is owned by the intent→archetype planner's plain partial updates and a
-- skill write must never race/clobber it. Nullable; no backfill — null means "no
-- skills applied", which is exactly the pre-feature behavior, so every pre-existing
-- loop keeps working unchanged (full back-compat).
--
-- Idempotent (IF NOT EXISTS) so re-applying against a push-managed dev DB is safe.

ALTER TABLE consilium_loops
  ADD COLUMN IF NOT EXISTS applied_skills JSONB;

-- Rollback:
--   ALTER TABLE consilium_loops DROP COLUMN applied_skills;
