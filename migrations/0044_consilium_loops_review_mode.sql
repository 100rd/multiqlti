-- migration: 0044_consilium_loops_review_mode
-- Single-verifier confirmation review for re-review rounds.
--
-- consilium_loops.review_mode → new TEXT (nullable).
--   HOW rounds AFTER the first (round > 1) are run:
--     - 'full-dispute'    — the DEFAULT/historical behavior: every round re-runs the
--                           full cross-review debate panel (N debaters + rebuttals +
--                           judge). NULL is treated identically to 'full-dispute'.
--     - 'single-verifier' — re-review rounds run ONE fresh, independent verifier that
--                           only CONFIRMS whether the written code closed the prior
--                           findings. Round 1 ALWAYS runs the full preset DAG.
--   NULL ⇒ resolve from the operator default (pipeline.consiliumLoop.verifyReview.enabled);
--   an explicit per-loop value always wins. Every pre-existing loop keeps working
--   unchanged (null ⇒ full-dispute), so this is byte-identical for existing rows.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS): metadata-only, no rewrite, no
-- data loss. Re-applying against a push-managed dev DB is safe.

ALTER TABLE consilium_loops
  ADD COLUMN IF NOT EXISTS review_mode TEXT;

-- Rollback:
--   ALTER TABLE consilium_loops DROP COLUMN review_mode;
