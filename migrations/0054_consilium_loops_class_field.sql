-- migration: 0054_consilium_loops_class_field
-- ADR-0003 I1 (re-scoped, GH #445 P1): additive autonomy CLASS metadata on
-- consilium_loops. Pure data addition — no behavior change, no escalation,
-- no gating. Nothing reads these columns yet (that lands in P2/P3).
--
-- consilium_loops.class → new TEXT NOT NULL DEFAULT 'R0'.
--   One of R0 | A | B | C | E (app-level union, not DB-enforced here — same
--   convention as `state`/`review_mode` elsewhere on this table):
--     - R0 — review/judge-only loop (no worktree write). DEFAULT for every
--       pre-existing and newly-created review-only loop.
--     - A  — coder-enabled loop (worktree write / Draft-PR capable, i.e.
--       `pipeline.consiliumLoop.implement.enabled` at launch).
--     - B/C/E — reserved for future deploy/prod targets; never assigned today.
--   Every pre-existing loop backfills to 'R0' (the safe, review-only default),
--   which is byte-identical to today's behavior since nothing reads this column.
--
-- consilium_loops.autonomy_tier → new TEXT (nullable).
--   Reserved for a future finer-grained autonomy tier. Left unset by this PR.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS): metadata-only, no rewrite,
-- no data loss. Re-applying against a push-managed dev DB is safe.
--
-- ⚠️ NOT applied by this PR. Ships for review only — the human gate applies it
-- (no `drizzle push` / `drizzle migrate` run against any database here).

ALTER TABLE consilium_loops
  ADD COLUMN IF NOT EXISTS class TEXT NOT NULL DEFAULT 'R0',
  ADD COLUMN IF NOT EXISTS autonomy_tier TEXT;

-- Rollback:
--   ALTER TABLE consilium_loops DROP COLUMN class, DROP COLUMN autonomy_tier;
