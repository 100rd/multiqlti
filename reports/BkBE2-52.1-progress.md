# BkBE2-52.1 progress (successor insurance)

Phase 0 (recon verification): confirmed all binding recon against live worktree source —
schema.ts skills table cols (sourceType/gitSourceId/externalSource/externalId/externalVersion/
installedAt/autoUpdate) exact match, MemStorage.createSkill/updateSkill exact match,
routes/skills.ts isBuiltin guard at 5 sites (versions POST L203, rollback L234, sharing PATCH
L289, PATCH L343, DELETE L388), repo-allowlist.ts exports match, routes.ts:145 requireAuth+
requireProject on /api/skills confirmed. Found bonus reference: genai-enablement/skills/
skills-lock.json is a REAL example of the lock format (source/sourceType/skillPath/
computedHash) — verified computedHash = sha256 of raw SKILL.md file bytes via `shasum -a 256`.
Found PRIOR removed impl (297d62d, server/services/git-skill-sync.ts) — different design
(remote clone+PAT), read for context only, not reused (new design is local-registry-root based).
- Phase 3 done: full suite 304/304 files, 5169 passed/5 skipped, 0 failed (tsc clean)
- Phase 4/5 done: committed d35939d, pushed feat/git-backed-skills-sync, PR #535 opened (https://github.com/100rd/multiqlti/pull/535), reports/BkBE2-52.1.md written
- Post-review fix: getSkillIdByName is global/unscoped -> added name-collision guard (sourceType!=='git' or teamId mismatch => status:error, no write); regression test added; tsc clean; new suite 3 files/21 tests; full suite 303/304 files 1 pre-existing flake (connections-api EADDRINUSE, passes 56/56 isolated, unrelated to this change)
