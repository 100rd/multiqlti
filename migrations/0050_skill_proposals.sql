-- migration: 0050_skill_proposals
-- Experience plane — the "Dream", SKILL.md FEEDBACK side (DREAM-4).
-- Spec: docs/design/experience-plane-dream.md §5 (Experience ≠ Skill) / §9 (DREAM-4).
--
-- A NEW, standalone table and the STRICT §5 boundary in table form: Experience ≠ Skill.
-- A background proposer reads REPEATEDLY-`verified` experience_items and writes ONLY here —
-- a PROPOSED SKILL.md patch entered into the ADR-0002 trust envelope as `unverified`. It
-- NEVER mutates a SKILL.md, the `skills` table, experience_items, or the state graph. EVERY
-- forward status move (unverified→verified/rejected/deprecated) is a HUMAN/CODEOWNERS
-- decision via the review endpoint (requireRole maintainer/admin) — the Dream proposes, a
-- human decides. Auto-apply / auto-graduate is impossible: the proposer only ever inserts
-- `status = 'unverified'`.
--
-- dedup_key = '<project>::<skillName>::<patternHash>' — a UNIQUE guard so a proven pattern
-- yields ONE proposal, never a spam of duplicates (the proposer pre-filters; this unique
-- index is the race backstop). patch_text is INERT, clamped, fence-delimited model-derived
-- text — the distilled claim is fenced-as-data, never a shell/branch/PR sink. skill_id links
-- the skills-table row when a READ of the registry knows the name, else null.
--
-- SCOPING: project_id mirrors experience_items (nullable) so a proposal inherits the source
-- pattern's project isolation.
--
-- Additive + idempotent (CREATE TABLE / INDEX IF NOT EXISTS): no existing table is touched,
-- so this is byte-identical for every current row. Off by default at runtime
-- (pipeline.consiliumLoop.experiencePlane.skillFeedback.enabled=false ⇒ no proposer ⇒ no rows).

CREATE TABLE IF NOT EXISTS skill_proposals (
  id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
  skill_name   TEXT NOT NULL,
  skill_id     VARCHAR,
  dedup_key    TEXT NOT NULL,
  pattern_key  TEXT NOT NULL,
  scope        JSONB NOT NULL,
  patch_text   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'unverified',
  evidence     JSONB NOT NULL,
  provenance   JSONB NOT NULL,
  review_note  TEXT,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now()
);

-- ONE proposal per (project, skill, pattern) — the dedup backstop against a race.
CREATE UNIQUE INDEX IF NOT EXISTS skill_proposals_dedup_key_idx
  ON skill_proposals (dedup_key);

CREATE INDEX IF NOT EXISTS skill_proposals_project_id_idx
  ON skill_proposals (project_id);

CREATE INDEX IF NOT EXISTS skill_proposals_status_idx
  ON skill_proposals (status);

-- Rollback:
--   DROP TABLE IF EXISTS skill_proposals;
