-- migration: 0032_consilium_loops_archetype
-- Adds the Stage 1 (design §6) intent→archetype planner columns to
-- consilium_loops. A lightweight OUT-OF-BAND model call ("planner") proposes one
-- of a fixed enum of archetypes for a verdict-terminal loop, and a human may
-- override it. Stage 1 STORES the archetype; it does NOT yet branch implement on
-- it (that is Stage 2).
--
--   archetype           the chosen intent class ('repo-assessment'|'research'|'infra');
--                       NULL until a planner proposal / human override lands.
--   archetype_source    'proposed' (planner) | 'override' (human). An override
--                       outranks a proposal — the planner write is guarded to
--                       never clobber a row whose source is already 'override'.
--   archetype_rationale the planner's short justification (UNTRUSTED model text).
--   archetype_params    optional planner key→value params (jsonb; UNTRUSTED).
--   archetype_decided_at when the archetype was last set (proposal or override).
--
-- All columns nullable; no backfill. Written by a PLAIN partial update (NOT the
-- state CAS), so persisting an archetype on a terminal loop never transitions it.
-- Every pre-existing loop keeps working unchanged (full back-compat).
--
-- Idempotent (IF NOT EXISTS) so re-applying against a push-managed dev DB is safe.

ALTER TABLE consilium_loops
  ADD COLUMN IF NOT EXISTS archetype TEXT,
  ADD COLUMN IF NOT EXISTS archetype_source TEXT,
  ADD COLUMN IF NOT EXISTS archetype_rationale TEXT,
  ADD COLUMN IF NOT EXISTS archetype_params JSONB,
  ADD COLUMN IF NOT EXISTS archetype_decided_at TIMESTAMP;

-- Rollback:
--   ALTER TABLE consilium_loops
--     DROP COLUMN archetype,
--     DROP COLUMN archetype_source,
--     DROP COLUMN archetype_rationale,
--     DROP COLUMN archetype_params,
--     DROP COLUMN archetype_decided_at;
