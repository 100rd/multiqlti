-- migration: 0034_consilium_loop_rounds_execution_trace
-- Adds the Stage 4 (design §8) OBSERVABILITY TREE column to consilium_loop_rounds.
-- The implement phase already computes a per-AP / per-skill / per-criterion outcome
-- each round but discarded it after settle (surviving only as Draft-PR prose + the
-- test_summary digest). Stage 4 rescues it as a structured execution_trace (phase →
-- controller → worker → skill → criterion) that BOTH archetypes emit — the executor
-- builds it from its ApOutcome[]; the research-runner from its steps + P0 evidence.
-- The controller persists it here via `updateLoopRoundExecutionTrace` on the SAME
-- out-of-band settle wire as `test_summary`/`report`; it reaches the client through
-- the existing loop GET `rounds`.
--
--   execution_trace   the per-round trace (jsonb; UNTRUSTED model/skill text + tool
--                     NAMES only, size-clamped + scrubbed before write). NULL for
--                     every pre-Stage-4 round and every round with no skilled run.
--
-- Nullable, additive; NO FSM change (rides out-of-band, the dev_completed event is
-- unchanged). Full back-compat. Idempotent (IF NOT EXISTS). Mirrors 0033's shape.

ALTER TABLE consilium_loop_rounds
  ADD COLUMN IF NOT EXISTS execution_trace JSONB;

-- Rollback:
--   ALTER TABLE consilium_loop_rounds
--     DROP COLUMN execution_trace;
