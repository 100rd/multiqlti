-- migration: 0046_experience_items
-- Experience plane — the "Dream" distillation, WRITE side (DREAM-1).
-- Spec: docs/design/experience-plane-dream.md §3 (item schema) / §5 (boundaries) / §9.
--
-- A NEW, standalone table. A background distiller reads a TERMINAL consilium loop's
-- already-persisted trail (rounds, execution traces, verdicts, git refs) and emits
-- compact, verification-GROUNDED Experience items here. WRITE-ONLY in DREAM-1: items
-- accumulate for inspection; the read path (planner) is DREAM-2, consolidation DREAM-3.
--
-- GROUNDING (§1/§3/§6): `confidence` is set by HOW the underlying claim was verified by
-- our INDEPENDENT verification (a real test-run pass / single-verifier `closed` / a
-- merged-converged loop), never by an agent's self-report. A coder-believed-but-refuted
-- pattern lands as 'refuted' (a negative lesson), equally stored.
--
-- BOUNDARIES (§5): this table is the ONLY sink. The distiller does NOT write the
-- Omniscience state graph, does NOT patch SKILL.md (DREAM-4), does NOT store bare
-- repo-facts. `related_components` LINKS to Omniscience components but never mutates them.
--
-- SCOPING: project_id mirrors consilium_loops (nullable) so items inherit the source
-- loop's project isolation. source_loop_id is the single loop the item was distilled
-- from; its index makes the idempotency dedup ("has this loop already produced items?")
-- an O(1) lookup so a re-observe writes no duplicate.
--
-- Additive + idempotent (CREATE TABLE / INDEX IF NOT EXISTS): no existing table is
-- touched, so this is byte-identical for every current row. Off by default at runtime
-- (pipeline.consiliumLoop.experiencePlane.enabled=false ⇒ no distiller ⇒ no rows).

CREATE TABLE IF NOT EXISTS experience_items (
  id                 VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope              JSONB NOT NULL,
  claim              TEXT NOT NULL,
  evidence           JSONB NOT NULL,
  verification       JSONB NOT NULL,
  confidence         TEXT NOT NULL,
  success_delta      REAL,
  provenance         JSONB NOT NULL,
  freshness          JSONB NOT NULL,
  related_components JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_loop_id     VARCHAR NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS experience_items_source_loop_id_idx
  ON experience_items (source_loop_id);

CREATE INDEX IF NOT EXISTS experience_items_project_id_idx
  ON experience_items (project_id);

-- Rollback:
--   DROP TABLE IF EXISTS experience_items;
