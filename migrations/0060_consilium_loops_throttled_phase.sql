-- Agent-limit throttling (additive, non-breaking): which phase to resume when a
-- consilium loop pauses in `throttled` — "review" or "develop". Null for every
-- non-throttled loop. Ship-only: applied by the lead, not by this change.
ALTER TABLE consilium_loops ADD COLUMN IF NOT EXISTS throttled_phase text;
