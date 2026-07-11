-- "throttled v2" Part A (additive, non-breaking): bounded AUTO-RESUME bookkeeping for
-- a consilium loop resting in `throttled` (agent-limit throttling MVP, migration 0060).
-- `throttled_until` is the deadline stamped at the throttling transition (now + parsed
-- Retry-After, else the configured cooldown); cleared (NULL) on ANY resume (auto or
-- operator). `resume_attempts` counts bounded auto-resume attempts for the CURRENT
-- pause; reset to 0 on every resume (auto or operator). Null/0 for every loop that has
-- never been throttled. Ship-only: applied by the lead, not by this change.
ALTER TABLE consilium_loops ADD COLUMN IF NOT EXISTS throttled_until timestamp;
ALTER TABLE consilium_loops ADD COLUMN IF NOT EXISTS resume_attempts integer NOT NULL DEFAULT 0;
