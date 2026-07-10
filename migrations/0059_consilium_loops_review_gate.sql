-- "Large Research" preset gate (additive, notNull default false). See
-- shared/schema.ts consiliumLoops.reviewGate for the full rationale.
ALTER TABLE consilium_loops ADD COLUMN IF NOT EXISTS review_gate boolean NOT NULL DEFAULT false;
