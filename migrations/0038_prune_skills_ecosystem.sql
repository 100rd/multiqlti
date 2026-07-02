-- migration: 0038_prune_skills_ecosystem
-- Drops the dead skills-ecosystem tables and deletes the inert built-in seed rows,
-- keeping the ONE live hook: the `skills` table that the SDLC executor's catalog
-- narrowing reads (server/services/consilium/skills/catalog.ts → bindSkillStep).
--
-- Context (Phase 3b — loop-centric simplification):
--   The skill marketplace machinery (server/skill-market/*, marketplace-service,
--   the SkillMarket/SkillMarketplace pages + /api/skill-market* routes), the custom
--   skill-team grouping, and the git-skill-import feature were removed as dead code.
--   None had any live consumer in the pipeline / SDLC executor / gateway. The four
--   tables below were used ONLY by that removed code and have ZERO remaining usage:
--
--     skill_install_log       — marketplace install/update audit log. No FK in/out.
--     skill_registry_sources  — marketplace registry-adapter config. No FK in/out.
--     skill_teams             — skills-UI "custom team" grouping (NOT the live SDLC
--                               TeamRegistry in server/teams/, which is unrelated and
--                               retained). No FK in/out.
--     git_skill_sources       — "import skills from a git repo" feature + its sync
--                               service. The `skills.git_source_id` FK column pointed
--                               here; DROP ... CASCADE removes that FK CONSTRAINT while
--                               KEEPING the `skills.git_source_id` column (now a plain
--                               inert varchar — see shared/schema.ts).
--
--   The 7 BUILTIN_SKILLS ("Code Review", "Security Analysis", ...) were seeded at
--   bootstrap with ids `builtin-*`. None matched the catalog narrowing names
--   (test-author / coder / research / synthesize), so the hook never fired on them.
--   Seeding is removed; this deletes the inert rows. The empty-table fallback (baked-in
--   catalog defaults) is the tested path — narrowing simply stays dormant.
--
-- Deliberately NOT dropped (still live — see PR body):
--     model_skill_bindings    — read every pipeline stage by the task-orchestrator
--                               (pipeline-controller.applySkill → resolveSkillsForModel).
--     specialization_profiles — wired into the live MultiAgentPipeline UI + use-pipeline.
--     skill_versions          — auto-snapshotted by the retained /api/skills CRUD.
--     skills                  — the live narrowing hook. KEPT (incl. all columns).
--
-- Deploy sequence (push-based):
--   1. psql "$DATABASE_URL" -f migrations/0038_prune_skills_ecosystem.sql
--   2. npm run db:push   (schema.ts no longer declares the dropped tables)
--
-- Drop-only. Idempotent (IF EXISTS). Do NOT apply automatically — run against a DB
-- only after a reviewed backup.

DROP TABLE IF EXISTS skill_install_log CASCADE;
DROP TABLE IF EXISTS skill_registry_sources CASCADE;
DROP TABLE IF EXISTS skill_teams CASCADE;
-- CASCADE drops the skills_git_source_id FK constraint; the skills.git_source_id
-- column and its data are preserved.
DROP TABLE IF EXISTS git_skill_sources CASCADE;

-- Remove the inert built-in seed rows (never referenced by the narrowing hook).
DELETE FROM skills WHERE id LIKE 'builtin-%';

-- Rollback:
--   Re-create the four tables from the shared/schema.ts definitions as they existed
--   prior to this change (git history), re-add the skills.git_source_id FK, and re-seed
--   BUILTIN_SKILLS from server/skills/builtin.ts (git history). All dropped tables were
--   empty of live data; the deleted skills rows were static seed definitions.
