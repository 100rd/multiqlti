-- migration: 0043_consilium_loops_review_redrive
-- Adds a nullable `review_redrive` jsonb column to consilium_loops for bug #7
-- (stranded-review recovery).
--
-- A review round runs in the in-process consilium workers. If they die (a crash or,
-- most commonly, a server restart) the round's task_executions stay `running`
-- forever, deriveReviewEvent never settles, and the loop sits in `reviewing` with
-- zero LLM activity and NO recovery (unlike the develop phase's redriveStranded).
-- Live evidence: loop 76ce2ecd sat reviewing 45+ min with 2 executions "running"
-- and 0 LLM requests after a restart.
--
-- The controller now RE-LAUNCHES a stalled review round automatically (bounded by
-- `pipeline.consiliumLoop.reviewMaxRedrives`), falling back to `failed` only once
-- the budget is exhausted. This column records the per-round auto re-launch count
-- as `{ round, count }` so the bound SURVIVES a restart (a process-local counter
-- would reset on boot → an unbounded redrive storm across crash-loops) and the
-- launch passport can surface "re-launched attempt k/N after a stall".
--
-- `round`-scoped: a stored value whose `round` differs from the loop's current
-- round counts as 0, so the counter auto-resets each round with no explicit clear.
-- INERT display/audit data — never a prompt/shell/branch/PR sink.
--
-- We add a DEDICATED column (rather than riding archetype_params) because that
-- jsonb is UI-rendered as archetype key/value chips AND is forwarded to the SDLC
-- executor — a redrive write there would corrupt display and coder behavior.
-- Nullable; no backfill — null means "never re-launched", exactly the pre-feature
-- behavior, so every pre-existing loop keeps working unchanged (full back-compat).
--
-- Idempotent (IF NOT EXISTS) so re-applying against a push-managed dev DB is safe.

ALTER TABLE consilium_loops
  ADD COLUMN IF NOT EXISTS review_redrive JSONB;

-- Rollback:
--   ALTER TABLE consilium_loops DROP COLUMN review_redrive;
