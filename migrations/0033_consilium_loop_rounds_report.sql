-- migration: 0033_consilium_loop_rounds_report
-- Adds the Stage 3 (design §6) RESEARCH archetype report column to
-- consilium_loop_rounds. A `research` loop's implement phase produces a structured,
-- web-evidence-verified REPORT (not code, not a Draft PR); the research-runner
-- returns it on the SAME out-of-band settle wire as `test_summary`, and the
-- controller persists it here via `updateLoopRoundReport`. It reaches the client
-- through the existing loop GET `rounds`.
--
--   report   the structured research report (jsonb; UNTRUSTED model/web text, size-
--            clamped before write). NULL for every non-research round — no backfill.
--
-- Nullable, additive; NO FSM change (research reaches awaiting_merge via the
-- UNCHANGED dev_completed event, prRef null). Every pre-existing round keeps working
-- unchanged (full back-compat).
--
-- Idempotent (IF NOT EXISTS) so re-applying against a push-managed dev DB is safe.
-- Mirrors migration 0032's shape.

ALTER TABLE consilium_loop_rounds
  ADD COLUMN IF NOT EXISTS report JSONB;

-- Rollback:
--   ALTER TABLE consilium_loop_rounds
--     DROP COLUMN report;
