-- migration: 0056_consilium_loop_rounds_comments
-- Result comments — operator thread-like notes on a consilium round's Result.
--
-- consilium_loop_rounds.comments → new JSONB (nullable).
--   An append-only array of { id, author, body, createdAt } (shared RoundComment
--   type), written by POST /api/consilium-loops/:id/rounds/:round/comments.
--   Mirrors the out-of-band settle discipline of human_note/report/execution_trace
--   on this same table: additive, no-op when the (loop, round) row is absent.
--   NULL for every pre-existing round (no backfill) and for any round with no
--   comments yet — every consumer guards on NULL/empty before reading it.
--
-- SECURITY: `body`/`author` are operator-authored strings, bounded server-side
-- before write; rendered client-side as inert plain text only (never HTML/eval).
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS): metadata-only, no rewrite, no
-- data loss. Re-applying against a push-managed dev DB is safe.

ALTER TABLE consilium_loop_rounds
  ADD COLUMN IF NOT EXISTS comments jsonb;

-- Rollback:
--   ALTER TABLE consilium_loop_rounds DROP COLUMN comments;
