# Project (Tenant) Isolation

Every project is an independent tenant. With project A selected, no data from
project B may appear in any list, detail view, count, dropdown, or search.
This document describes the enforcement model and the audit that produced this
PR.

## The model

Three layers, all required:

1. **`requireProject` middleware** (`server/middleware/project.ts`)
   Reads the `x-project-id` header (400 if missing), validates the caller is the
   project **owner or a member** (403 otherwise), then runs the rest of the
   request inside an AsyncLocalStorage context (`requestContext.run({ projectId,
   userId, role }, …)`). Mounted on every project-owned `/api/*` prefix in
   `server/routes.ts`.

2. **Scoping helpers** (`server/db.ts`) — build the `WHERE` fragment from the ALS
   context. **Fail-closed**: they throw if there is no context in a request.
   - `withProject(table, condition?)` — strict per-project (`project_id = ctx`).
     Used for secret tables and detail/mutate-by-id. In **system** context it
     requires an explicit `condition` (no blind cross-project enumeration).
   - `withProjectList(table, condition?)` — for non-secret LIST reads. Request
     context → per-project filter; **system** context → cross-project (audited
     via `runAsSystem`); no context → throws.
   - `withProjectOrGlobal(table, condition?)` — `project_id IS NULL OR =
     project_id` ctx. For the **global catalog** pattern (see below).
   - `withProjectInsert(table, data)` — forces `projectId = ctx.projectId` on
     write (spread last), so a request body can never inject `projectId: null`
     to escalate a row to global.

3. **Explicit system/background scope** (`server/context.ts`)
   Code that legitimately runs outside a request (startup seeds, cron, file
   watcher, pollers, config-sync, federation) wraps its DB access in
   `runAsSystem(reason, fn)` (cross-project, audited) or
   `runAsProject(projectId, fn)` (a specific project). `unscopedSystemQuery` is
   the explicit escape hatch. Without one of these, a scoped read throws rather
   than silently leaking.

**The isolation guarantee lives on the server.** Once a storage read is scoped,
project B's rows cannot reach a project-A request regardless of the client. The
client work below is about UX (no spurious 400s), not the security boundary.

## What this PR changed

### Storage scoping (`server/storage-pg.ts`)
Previously-unscoped LIST/READ methods now scope through the helpers:

| Method | Fix |
|---|---|
| `getTaskGroups`, `getSkillTeams` | `withProject` |
| `getPipelines`, `getPipelineRuns` (both branches), `getSkills` (no-filter path), `getMcpServers`, `getSpecializationProfiles`, `getModelsWithSkillBindings` | `withProjectList` |
| `getLlmRequestStats` / `…ByModel` / `…ByProvider` | `withProject` (was aggregating cost/usage across all projects) |
| `getChatMessages` | unconditional `withProjectList` base (a no-`runId` call previously dumped all projects' chat) |
| `getLoops` (consilium_loops), `getTraces` | scoped via subquery through their project-owned parents (`task_groups` / `pipeline_runs`) — these tables have **no** `project_id` column; no migration |
| `getModels`, `getActiveModels`, `getModelBySlug` | `withProjectOrGlobal` (global catalog, see below) |

Route modules that issued **raw** unscoped queries (behind `requireProject`)
were scoped too: `routes/maintenance.ts`, `routes/privacy.ts`, `routes/library.ts`,
and `remote-agents/remote-agent-manager.ts` (`listAgents` + an IDOR in
`getAgent` that loaded a remote-agent config by id with no project scope).

### Global-catalog exception (product decision)
The **LLM model catalog** and the **skill marketplace registry** stay global.
Catalog models are stored with `project_id = NULL` (the startup reconcile runs
under `runAsSystem`) and are visible in every project via `withProjectOrGlobal`;
project-specific models, plus all **configs, provider keys, installed skills,
bindings, and teams**, remain strictly per-project.

### System/background callers wrapped
`config-sync` apply/export, `federation/config-sync`, the MCP self-server pipeline
listing, and the consilium-loop poller now run their cross-project/background DB
access inside `runAsSystem`, so the newly-scoped reads resolve instead of throwing.

### Client transport (`client/src/**`)
- `lib/projectHeaders.ts` — one canonical `buildAuthHeaders()` that always sends
  `x-project-id` when a project is selected and **never** as an empty string;
  plus `isPublicPath` (auth/health/projects/teams/sandbox/federation are exempt)
  and a typed `ProjectRequiredError` guard.
- The shared helpers (`lib/queryClient.ts`, `hooks/use-pipeline.ts`,
  `hooks/use-task-groups.ts`) route through it; `Costs.tsx` and `GuardrailEditor.tsx`
  fixed directly.
- `lib/installFetchInterceptor.ts` — a one-time `window.fetch` patch (wired once in
  `main.tsx`) that injects `x-project-id` on same-origin, non-public `/api/*`
  requests **only if the caller didn't already set it** (idempotent, never
  overwrites, never empty). This backstops the ~30 inline-fetch call sites without
  editing them, so no UI action 400s with "x-project-id required".
- Project switching stays a hard `window.location.reload()` (deliberate — it
  wipes all query cache and cannot leak stale cross-project data).

## Tests
`tests/unit/scoping/list-methods-isolation.test.ts` extends the existing
`db-layer-isolation` harness (serialises the Drizzle SQL via `PgDialect`, no real
DB): it proves each newly-scoped method embeds the bound `project_id` param, that
two project contexts produce different params, that subquery-scoped methods carry
the filter without inventing a non-existent column, and that the catalog methods
use the `IS NULL OR =` predicate. `npx tsc --noEmit` is clean; the full unit suite
passes (one unrelated gateway test is a flaky timeout under parallel load — green
in isolation).

## Known follow-ups (out of scope for this PR — need migration or design)
- **`models.slug` uniqueness** — currently globally `unique`; should be
  `unique(projectId, slug)` so two projects can hold the same private slug, and
  the `upsertModelBySlug` conflict path should re-assert scope. Needs a migration.
- **MCP self-server** (`mcp-servers/multiqlti-self`) lists pipelines cross-project
  under `runAsSystem`, scoped only by workspace token. Needs an MCP-token→project
  mapping before it can be project-scoped.
- **Latent throwers** — several pre-existing `withProject(traces/consilium_loops, …)`
  detail/update methods (`getTrace`, `updateTraceSpans`, `getLoopsByOwner`,
  `getActiveLoopByGroup`, `updateLoop`, …) reference a non-existent `project_id`
  column and therefore **throw** (500) in request context today. This is a
  correctness bug, **not** a leak (fail-closed). Fix by adding the column or
  converting them to the subquery pattern used here for the list methods.
