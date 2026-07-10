-- Per-loop commit-message/MR-title prefix (additive, nullable). See
-- shared/schema.ts consiliumLoops.commitPrefix for the full rationale.
ALTER TABLE consilium_loops ADD COLUMN IF NOT EXISTS commit_prefix text;
