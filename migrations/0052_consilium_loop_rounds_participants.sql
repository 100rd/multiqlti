-- migration: 0052_consilium_loop_rounds_participants
-- The review participants for a consilium round (Phase 2 — direct review-runner).
--
-- consilium_loop_rounds.participants → new JSONB (nullable).
--   The round's review contributions, shape:
--     [{ name: string, model: string, role: 'primary' | 'rebuttal', text: string }]
--   The primary reviewers and their rebuttals, each with the seat name, the model
--   that filled it, the role, and the human-readable review prose. Bounded before
--   write (count + per-text clamp, Security L-2, same as verdict) and rendered as
--   INERT text on the client (RoundParticipant). NEVER the raw diff / prompt input
--   (H-4). NULL for every pre-existing round (no backfill) and for any round run via
--   the legacy task-group path — every consumer guards on NULL before reading it.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS): metadata-only, no rewrite, no
-- data loss. Re-applying against a push-managed dev DB is safe.

ALTER TABLE consilium_loop_rounds
  ADD COLUMN IF NOT EXISTS participants jsonb;

-- Rollback:
--   ALTER TABLE consilium_loop_rounds DROP COLUMN participants;
