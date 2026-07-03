-- migration: 0042_triggers_target_loops
-- T1 retarget of the trigger subsystem off the (deleted) pipeline entity and onto
-- consilium loops (see docs/design/loop-triggers.md, PR "triggers create consilium
-- loops"). Three additive, idempotent changes — no data is dropped or rewritten.
--
-- 1) triggers.pipeline_id → NULLABLE.
--    A trigger now fires a CONSILIUM LOOP (loop template in `config`), not a
--    pipeline run. The pipeline entity left the product surface, so there are ZERO
--    pipelines and a NOT NULL FK made every new trigger un-createable (the "Add
--    Trigger" button was permanently disabled). Dropping NOT NULL lets triggers be
--    created project-scoped with no pipeline. The FK itself is KEPT (nullable) so
--    pre-existing pipeline-era rows still reference their pipeline.
--
-- 2) triggers.suppressed_count → new INT NOT NULL DEFAULT 0.
--    Policy rail (§4): a fire suppressed by dedup (or a future budget/debounce rail)
--    increments this instead of blindly creating a second active loop. Surfaced on
--    the triggers page so silence is diagnosable. Backfills to 0 for existing rows.
--
-- 3) consilium_loops.trigger_provenance → new JSONB (nullable).
--    Provenance (§6): every trigger-fired loop records `{ triggerId, triggerType,
--    eventDigest, firedAt }` so the launch passport can show which trigger + event
--    started it. Null ⇒ a human/API-initiated loop (no trigger) — exactly the
--    pre-feature behavior, so every pre-existing loop keeps working unchanged.
--    A DEDICATED column (not archetype_params, which the intent→archetype planner's
--    plain partial updates own) so a provenance write can never race/clobber it —
--    same reasoning as the applied_skills column (migration 0041).
--
-- Idempotent (IF EXISTS / IF NOT EXISTS) so re-applying against a push-managed dev
-- DB is safe.

ALTER TABLE triggers
  ALTER COLUMN pipeline_id DROP NOT NULL;

ALTER TABLE triggers
  ADD COLUMN IF NOT EXISTS suppressed_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE consilium_loops
  ADD COLUMN IF NOT EXISTS trigger_provenance JSONB;

-- Rollback:
--   ALTER TABLE consilium_loops DROP COLUMN trigger_provenance;
--   ALTER TABLE triggers DROP COLUMN suppressed_count;
--   -- pipeline_id NOT NULL cannot be safely restored once null rows exist; first
--   -- delete/repair any pipeline-less triggers, then:
--   -- ALTER TABLE triggers ALTER COLUMN pipeline_id SET NOT NULL;
