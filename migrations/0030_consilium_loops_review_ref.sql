-- migration: 0030_consilium_loops_review_ref
-- Adds a nullable `review_ref` text column to consilium_loops for BRANCH-targeted
-- consilium reviews.
--
-- When set, the review targets THAT git ref (branch name / revision): the
-- recorded head sha is the ref's tip, a diff-pr-review diffs baseline..<ref>, and
-- a full-viability review reads specs/*.md AT THAT REF (git show / git ls-tree),
-- NOT the working tree — so the checkout is never disturbed.
--
-- Nullable; no backfill — null means "working-tree HEAD", which is exactly the
-- existing behavior, so every pre-existing loop keeps reviewing the working-tree
-- HEAD (full back-compat).
--
-- Idempotent (IF NOT EXISTS) so re-applying against a push-managed dev DB is safe.

ALTER TABLE consilium_loops
  ADD COLUMN IF NOT EXISTS review_ref TEXT;

-- Rollback:
--   ALTER TABLE consilium_loops DROP COLUMN review_ref;
