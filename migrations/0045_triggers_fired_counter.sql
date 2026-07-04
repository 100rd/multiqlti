-- migration: 0045_triggers_fired_counter
-- WRITE-on-fire rail for the trigger subsystem (docs/design/loop-triggers.md §6).
--
-- BUG: a trigger that SUCCESSFULLY launched consilium loops showed `lastFired: None`
-- and no fire tally — only `suppressed_count` advanced (on the dedup-suppress branch
-- of `launchReviewWithDedup`). The successful-launch branch recorded the fire in the
-- loop's `trigger_provenance` but NEVER wrote back to the trigger row. Symmetric to
-- 0042's `suppressed_count`, we add TWO additive columns:
--
--   triggers.last_fired_at → new TIMESTAMP (nullable). The instant the trigger last
--     ACTUALLY created a loop. Distinct from `last_triggered_at`, which is recorded
--     on EVERY fire (including suppressed / no-op). NULL ⇒ never launched a loop.
--   triggers.fired_count   → new INT NOT NULL DEFAULT 0. Count of loops this trigger
--     launched — incremented ONLY on the successful-launch branch, never on dedup.
--     Backfills to 0 for existing rows.
--
-- Additive + idempotent (IF NOT EXISTS) — no data dropped or rewritten; safe to
-- re-apply against a push-managed dev DB (same discipline as 0042).

ALTER TABLE triggers
  ADD COLUMN IF NOT EXISTS last_fired_at TIMESTAMP;

ALTER TABLE triggers
  ADD COLUMN IF NOT EXISTS fired_count INTEGER NOT NULL DEFAULT 0;

-- Rollback:
--   ALTER TABLE triggers DROP COLUMN fired_count;
--   ALTER TABLE triggers DROP COLUMN last_fired_at;
