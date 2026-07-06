-- migration: 0049_experience_items_consolidation
-- Experience plane — the "Dream" distillation, CONSOLIDATE side (DREAM-3).
-- Spec: docs/design/experience-plane-dream.md §4 (scheduled/consolidating) / §6
-- (freshness/decay/self-correction) / §9 (DREAM-3).
--
-- A SINGLE additive, nullable column on the existing experience_items table. A
-- background, scheduled consolidator re-reads recent items, MERGES duplicates,
-- DECAYS stale ones (verified → observed), flags verified↔refuted CONTRADICTIONS
-- (keeping both), and recomputes success_delta from any reuse signal. This column is
-- the consolidator's durable AUDIT TRAIL for what it did to a surviving item
-- (merge count, contradiction cross-link, decay origin, last pass id).
--
-- BOUNDARIES (§5): the consolidator writes ONLY to experience_items — never the
-- Omniscience state graph, never SKILL.md (DREAM-4). This column keeps the audit
-- trail inside the same plane.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS): no existing column is touched and
-- the new column defaults to NULL, so every current row is byte-identical. Off by
-- default at runtime (pipeline.consiliumLoop.experiencePlane.consolidate.enabled=false
-- ⇒ no consolidator ⇒ the column is never populated ⇒ the store just accumulates,
-- exactly the DREAM-1/DREAM-2 behaviour).

ALTER TABLE experience_items
  ADD COLUMN IF NOT EXISTS consolidation JSONB;

-- Rollback:
--   ALTER TABLE experience_items DROP COLUMN IF EXISTS consolidation;
