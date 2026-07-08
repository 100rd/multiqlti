# Task 52.1 — Git-backed skills registry sync (closes #446)

## Summary

Implemented the approved Option 3 design: a manually-triggered sync that reads
a `skills-lock.json` from a configured local registry root, verifies each
referenced `SKILL.md` against its lock-pinned sha256 (`computedHash`), skips
skills whose `compatible_tools` frontmatter omits `"multiqlti"`, and upserts
the rest as read-only `sourceType: 'git'` skill rows carrying provenance
(`externalSource`, `externalId`, `externalVersion`, `installedAt`,
`autoUpdate`). Drift (hash mismatch) never touches storage — it's only
reported in the sync result.

## What shipped

- `server/skills/skill-md-service.ts` — SKILL.md parser (YAML frontmatter +
  Markdown body). Zod-bound frontmatter schema mirrors existing skill limits
  (name ≤200, description ≤1000, tags/compatible_tools ≤20 items ≤100 chars),
  requires semver `version`, enforces a 256KB whole-file size cap, throws
  `SkillMdParseError` with a descriptive message on any violation.
- `server/skills/registry-sync.ts` — `syncSkillsRegistry()`. Path confinement
  reuses `assertAllowedRepoPath` from
  `server/services/consilium/repo-allowlist.ts` (fail-closed, empty allowlist
  throws) for both the registry root and each individual `skillPath`
  (defense in depth). Per-skill failures (missing file, drift, parse error,
  skip) are captured in results, never thrown; whole-sync failures (bad lock
  file, path confinement violation) throw.
- `server/routes/skills.ts`:
  - `POST /api/skills/registry-sync` — validates `{ registryRoot, teamId,
    autoUpdate? }`, reads `allowedRepoPaths` from the *existing*
    `config.pipeline.consiliumLoop.allowedRepoPaths` via `configLoader` (no
    new config keys, `config.yaml` untouched), returns per-skill
    synced/skipped/drift/error results.
  - Immutability guard: a shared `immutableReason(skill)` helper now blocks
    version-create, rollback, sharing-PATCH, PATCH, and DELETE with 403 on
    both `isBuiltin` ("built-in") and `sourceType === 'git'`
    ("git-sourced") rows — extending the existing isBuiltin guard pattern to
    read-only git-sourced rows.
- Tests (21 new, all passing):
  - `tests/unit/skills/skill-md-service.test.ts` (10 cases) — valid variants,
    malformed YAML/missing frontmatter, oversized name/file/tags, non-semver
    version.
  - `tests/unit/skills/registry-sync.test.ts` (7 cases) — synced, skipped
    (compatible_tools), drift (no row created/updated), idempotent re-run
    (same row updated, not duplicated), name-collision-with-manual-skill
    (see below), fail-closed allowlist, missing lock file.
  - `tests/integration/skills-registry-sync-api.test.ts` (4 cases) — 401
    unauthenticated (real `requireAuth`), 400 invalid body, 200 happy path
    (drift/skip/synced reported + synced row rejects PATCH/DELETE with 403
    "git-sourced"), 400 registryRoot outside the configured allowlist.
  - Fixtures under `tests/fixtures/skill-md/` and
    `tests/fixtures/registry-sync/` (a self-contained fixture registry root
    with `skills-lock.json` + three `SKILL.md` files) — the real
    `genai-enablement/skills*` reference tree was read-only and was not
    pointed at by any test.

## Verification

- `tsc --noEmit --pretty false`: clean (0 errors) — checked after Phase 1
  code, after Phase 2 tests/fixtures, and again after the name-collision fix.
- New test files: `vitest run tests/unit/skills/skill-md-service.test.ts
  tests/unit/skills/registry-sync.test.ts
  tests/integration/skills-registry-sync-api.test.ts` → 3 files passed, 21
  tests passed.
- Regression check on adjacent skills suites:
  `tests/integration/skills-api.test.ts`,
  `tests/integration/model-skill-bindings-api.test.ts` → 2 files passed, 35
  tests passed.
- Full unit/integration suite: `vitest run --reporter=dot` → **304 test
  files, 5169 tests passed | 5 skipped, 0 failed** (first run). A second
  full run after the collision fix showed 1 unrelated flake
  (`connections-api.test.ts` — `EADDRINUSE:5000` port race under full-suite
  parallelism); re-run in isolation: **1 file passed, 56/56 tests passed**,
  confirming it is pre-existing test-infra flakiness, not a regression from
  this change.

## Design decisions / judgment calls

- **Name-collision on upsert (security-review finding, fixed)**: the
  storage layer's `getSkillIdByName` is a *global* lookup with no
  `teamId`/`sourceType` scoping. The initial upsert blindly called
  `updateSkill()` on any name match, which meant a registry sync could
  silently overwrite a manually-created skill (or another team's
  git-sourced skill) that happened to share a name — clobbering its
  `systemPromptOverride`/`teamId`/`sharing` and converting it to
  `sourceType: 'git'`. Fixed: `syncOneSkill` now fetches the matched row
  and only proceeds to `updateSkill` when it already has `sourceType ===
  'git'` AND the same `teamId` (i.e., a row this sync previously created).
  Any other match (manual skill, built-in, or a different team's git row)
  returns `status: "error"` with a `"Name collision: ..."` reason and the
  existing row is left completely untouched. Covered by a new regression
  test (`registry-sync.test.ts`) that pre-creates a manual skill via
  `storage.createSkill`, runs sync, and asserts the row's
  `systemPromptOverride`/`sourceType` are unchanged.
- Immutability guard applied at all 5 existing `isBuiltin`-gated
  checkpoints (versions POST, rollback, sharing PATCH, PATCH, DELETE), not
  just PATCH/DELETE — a read-only git-sourced row should be fully immutable
  via the API, consistent with "reuse the isBuiltin guard pattern."
- `skillPath` entries in `skills-lock.json` are resolved relative to
  `registryRoot` directly (no special-casing of the lock file's own
  directory) — a clean, explicit convention for this feature's fixtures,
  independent of the real-world reference repo's directory layout.
- `computedHash` = sha256 hex digest of the full raw SKILL.md file bytes
  (frontmatter + body), verified empirically against a real lock file via
  `shasum -a 256` before implementing.

## PR

https://github.com/100rd/multiqlti/pull/535 (`feat/git-backed-skills-sync` → `main`, closes #446)

## Follow-ups (not in scope for this PR)

- No automatic/scheduled sync — trigger is manual (`POST
  /api/skills/registry-sync`) per the approved design.
- `autoUpdate` is stored as a tracking flag on synced rows; it does not yet
  drive any automatic re-sync behavior.
