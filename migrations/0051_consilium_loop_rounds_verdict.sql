-- migration: 0051_consilium_loop_rounds_verdict
-- The FULL judge verdict for a consilium round.
--
-- consilium_loop_rounds.verdict → new JSONB (nullable).
--   The judge's rich verdict for the round, shape:
--     { verdict: string, pros: string[], cons: string[], actionPoints: ActionPoint[] }
--   Distinct from the round's SUMMARY columns (converged / open_p0 /
--   open_action_points): `verdict` carries the judge's prose summary, the pros/cons,
--   and the FULL RANKED action-point list (ALL priorities, not just the still-open
--   P0 subset). Bounded before write (readJudgeVerdict, Security L-2) and rendered as
--   INERT text on the client (RoundVerdict). NEVER the raw diff / prompt input (H-4).
--   NULL for every pre-existing round (no backfill) and whenever the raw judge output
--   is unreadable at record time — every consumer guards on NULL before reading it.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS): metadata-only, no rewrite, no
-- data loss. Re-applying against a push-managed dev DB is safe.

ALTER TABLE consilium_loop_rounds
  ADD COLUMN IF NOT EXISTS verdict jsonb;

-- Rollback:
--   ALTER TABLE consilium_loop_rounds DROP COLUMN verdict;
