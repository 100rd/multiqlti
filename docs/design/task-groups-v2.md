# Task Groups v2 — Iterations, Per-Iteration Execution History & Task Library

**Status:** Proposed (DESIGN phase) · **Branch:** `feature/task-groups-v2`
**Author:** solution-architect · **Date:** 2026-06-16

Supersedes the one-shot run model from `docs/design/task-groups-edit-history.md` (PR #374) and builds on the real-model fix (PR #375). This doc is design + task breakdown only — no implementation code ships from it.

---

## 0. Problem & user feedback

Three intertwined requests:

1. **Iterations** — a Task Group must become **re-runnable**. Each run is an *iteration* with its own execution history. Today a group is one-shot.
2. **Per-iteration execution history** — each iteration records per-task execution (status, output/summary, model, timing, trace) so the user can browse history across iterations and drill into per-task detail within an iteration.
3. **Configurable between runs + a Task Library** — the group's task *definitions* must be editable between iterations; AND standalone reusable tasks with **labels** that compose into groups (a library / templates).

---

## 1. Current model (verified against the tree)

### 1.1 Schema (`shared/schema.ts`)

| Table | Lines | Role today | v2 change |
|---|---|---|---|
| `task_groups` | 1085–1099 | one-shot: `status`, `input`, `output`, `traceId`, `startedAt`, `completedAt`, `createdBy` (FK `users.id` `onDelete:"set null"`) | `status`/`startedAt`/`completedAt`/`output`/`traceId` become a **projection of the latest iteration**; the row keeps identity + definition-level fields |
| `tasks` | 1117–1150 | **DOUBLES** as task DEFINITION (`name`, `description`, `executionMode`, `dependsOn`, `pipelineId`, `modelSlug`, `teamId`, `input`, `sortOrder`) AND per-run EXECUTION (`status`, `output`, `summary`, `artifacts`, `decisions`, `errorMessage`, `pipelineRunId`, `startedAt`, `completedAt`). FK `group_id` cascade. Indexes `tasks_group_id_idx`, `tasks_status_idx` | **split**: `tasks` keeps DEFINITION only; execution moves to `task_executions` (one row per task **per iteration**) |
| `task_traces` | 1232–1254 | one trace per group (`group_id` cascade, `trace_id` unique, `spans`, aggregates) | becomes **per-iteration** (add `iteration_id`); `group_id` retained for back-compat reads |

### 1.2 Orchestrator (`server/services/task-orchestrator.ts`)

- `startGroup` (130): **one-shot guard** — `if (group.status !== "pending") throw …already ${status}` (133). This is exactly what blocks re-run.
- `executeDirectLlm` (300): model-less `direct_llm` resolves to `task.modelSlug ?? configLoader.get().pipeline.taskGroups.defaultModel ?? DEFAULT_TASK_MODEL` (309–310) — **NEVER `"mock"`** (PR #375). v2 **must preserve this**.
- `executePipelineRun` (389): `pipeline_run` tasks run a pipeline via `pipelineController.startRun`, write `pipelineRunId` back to the task row (393), poll to completion.
- `activeGroupTraces: Map<groupId, …>` (42) and all `broadcast(groupId, …)` calls (616) are **keyed by groupId** today; v2 keeps the WS channel keyed by groupId (subscribers don't know iteration ids) but the persisted execution + trace become per-iteration.
- Dependency engine: `onTaskCompleted` (472) / `onTaskFailed` (515) / `checkGroupCompletion` (543) read/write **`tasks.status`** directly. v2 redirects these reads/writes to `task_executions` for the active iteration (the dependency *graph* still comes from `tasks.dependsOn`).

### 1.3 Routes & security (PR #374)

- `server/routes/task-groups.ts`: every per-id route is gated by `authorizeTaskGroup` (116/140/155/168/180/204/222/239/253); list (89) own-filters via `isVisible` and strips `createdBy` for non-admins (104). Edits delegate to `TaskGroupEditor` and are **pending-only** (editor 209–213) with a persist-time re-read (TOCTOU guard). `validateTaskGraph` runs before every task mutation.
- `server/routes/authorize-task-group.ts`: owner-or-admin on `task_groups.createdBy`, ordering **401 → 404 → 403**, admin bypass, **ownerless denied to non-admins** (fail-closed). Delegates to `isVisible` in `authorize-run.ts` (37–44).
- `server/routes/task-traces.ts` (8): `GET /api/task-groups/:id/trace` IS now `authorizeTaskGroup`-gated (the security entry 213 IDOR was closed here). v2 must keep the trace owner-gated when it becomes per-iteration.
- `server/ws/manager.ts` `authorizeAndSubscribe` (93): pipeline-first, then `getTaskGroup` fallback gated by `isVisible(group.createdBy)`; **unknown id in both spaces → fail closed** (110).
- `server/routes/activity.ts`: `task_group` is the 5th Activity mode; `taskGroupUnit` (166) builds a **metadata-only** unit (label/agent=executionMode/modelSlug/status — **no task text**). History (`listTaskGroupHistory`) is owner-filtered in SQL (`storage-pg.ts` 1398–1423), keyset-paginated `completedAt desc, id desc`.

### 1.4 Storage (`server/storage.ts` IStorage)

CRUD: `getTaskGroups/getTaskGroup/createTaskGroup/updateTaskGroup/deleteTaskGroup` (439–443); `getTasksByGroup/getTask/createTask/updateTask/deleteTask/getReadyTasks/getBlockedTasks` (446–455); `listTaskGroupHistory` (453); `createTaskTrace/getTaskTrace/updateTaskTrace` (458–460). Two impls: `MemStorage` (maps) + `PgStorage` (Drizzle). **Both must stay in lockstep** (the QA parity note from entry 213).

### 1.5 Client

`TaskGroup.tsx` (detail + status-driven EditForm + `TimelinePanel` via `buildTimeline` + Trace link, 526), `CreateTaskGroup.tsx`, `TaskGroupList.tsx`, `TaskGroupTrace.tsx` (waterfall), shared `components/task-groups/{task-form-logic,task-form,timeline}.ts`, hooks `use-task-groups`/`use-task-trace`/`use-task-events`. Routes mounted in `server/routes.ts` (243 `registerTaskGroupRoutes(app, …)`, 264 `registerTaskTraceRoutes(app, …)`).

---

## 2. Key design decision: Definition / Execution split

**The single most important decision.** Today one `tasks` row is *both* the recipe and the result of cooking it once. To re-run, we must separate them.

```
task_groups            (identity + latest-iteration projection)
  └─ tasks             (DEFINITION: the recipe — name/desc/mode/model/dependsOn/sortOrder/labels)   [table name kept; semantically "task definitions"]
  └─ task_group_iterations   (one row per RUN: iterationNumber, status, triggeredBy, timing, output)
        └─ task_executions    (one row per definition × iteration: status, output, summary, error, model, timing, pipelineRunId)
        └─ task_traces        (one trace per iteration — add iteration_id)

task_templates         (LIBRARY: standalone reusable labeled definitions, owner-scoped)
  └─ (composition: COPY-IN snapshot into tasks when a group is created/seeded)
```

**Why split rather than version-in-place:** keeping execution on the definition row forces either (a) destroying the prior run's results on re-run, or (b) cloning the whole task row per run and losing the stable definition id that `dependsOn` references. A dedicated `task_executions` table lets `dependsOn` stay keyed to a **stable definition id** across every iteration, and gives per-iteration history for free.

**Table-rename decision:** we **keep the table named `tasks`** (avoid a rename migration + churn across `storage-pg.ts`, `task-orchestrator.ts`, `activity.ts`, `authorize-*`, client) but treat it semantically as *task definitions*. We **stop writing the execution columns** and migrate reads to `task_executions`; the legacy execution columns stay on the row (nullable) for the non-destructive migration window (see §6/§8). Documented clearly so the next reader isn't surprised.

---

## 3. Data model (Drizzle, `db:push`, additive)

All new tables: `varchar` PK `gen_random_uuid()`, owner via the parent's `createdBy` (no new ownership domain), `createInsertSchema().omit({id,createdAt})`, enums as `as const` tuples + `z.enum` in insert schemas — mirroring `practice_cards`/news-board precedent.

### 3.1 `task_group_iterations` (new)

```
task_group_iterations
  id                varchar PK
  group_id          varchar NOT NULL  FK task_groups.id  onDelete:"cascade"
  iteration_number  integer NOT NULL            -- 1-based, monotonic per group
  status            text NOT NULL default 'running'  $type<TaskGroupStatus>  -- running|completed|failed|cancelled
  input             text NOT NULL              -- snapshot of group.input at run time (immutable record of what ran)
  output            jsonb                      -- aggregate (taskCount/completedCount/summaries), moved off task_groups
  trace_id          text                       -- links to task_traces.trace_id for this iteration
  triggered_by      text  FK users.id onDelete:"set null"   -- who clicked Run
  started_at        timestamp
  completed_at      timestamp
  created_at        timestamp NOT NULL defaultNow
INDEX iterations_group_id_idx ON (group_id)
UNIQUE iterations_group_number_uq ON (group_id, iteration_number)   -- prevents duplicate iteration N (TOCTOU on re-run)
```

`UNIQUE(group_id, iteration_number)` is the concurrency backstop: two concurrent `start` calls computing the same `max+1` collide on insert → second fails → second start 409s. (Mirrors `managerIterations` UNIQUE and the news-board idempotency pattern.)

### 3.2 `task_executions` (new)

```
task_executions
  id            varchar PK
  iteration_id  varchar NOT NULL  FK task_group_iterations.id  onDelete:"cascade"
  task_id       varchar NOT NULL  FK tasks.id  onDelete:"cascade"     -- the DEFINITION this execution ran
  group_id      varchar NOT NULL  FK task_groups.id  onDelete:"cascade"  -- denormalized for owner-join + activity
  status        text NOT NULL default 'pending'  $type<TaskStatus>   -- pending|blocked|ready|running|completed|failed|cancelled
  output        jsonb
  summary       text
  artifacts     jsonb $type<Record<string,unknown>[]>
  decisions     jsonb $type<string[]>
  error_message text
  model_slug    text                 -- the RESOLVED model actually used (records the #375 default, not just the pin)
  pipeline_run_id varchar            -- for pipeline_run executions
  started_at    timestamp
  completed_at  timestamp
  created_at    timestamp NOT NULL defaultNow
INDEX executions_iteration_id_idx ON (iteration_id)
INDEX executions_task_id_idx      ON (task_id)
UNIQUE executions_iter_task_uq    ON (iteration_id, task_id)   -- one execution per definition per iteration
```

`model_slug` records the **resolved** model (the #375 default-resolution result) — historically valuable, since the definition's `modelSlug` may be null/changed later.

### 3.3 `tasks` (DEFINITION) — changes

- **Add** `labels jsonb NOT NULL default '[]'::jsonb $type<string[]>` (composition/filtering — array, not a join table; see §3.5 decision).
- **Add** `template_id varchar` (nullable, FK `task_templates.id` `onDelete:"set null"`) — provenance of a copied-in definition (nullable: a group can have ad-hoc definitions too).
- **Execution columns become legacy** (`status`, `output`, `summary`, `artifacts`, `decisions`, `errorMessage`, `pipelineRunId`, `startedAt`, `completedAt`): kept nullable on the row for the migration window; new code **stops writing** them and reads execution from `task_executions`. `status` retains meaning ONLY as a transient "draft validity" hint during editing (`ready`/`blocked` from `dependsOn`) — orchestration no longer reads it.
- `tasks_status_idx` becomes low-value (execution status moved); keep it (harmless). **Do not drop in this migration** (additive only).

### 3.4 `task_traces` — changes

- **Add** `iteration_id varchar` (FK `task_group_iterations.id` `onDelete:"cascade"`), and `INDEX task_traces_iteration_id_idx`.
- `group_id` stays (a trace still belongs to a group); `trace_id` stays unique. The tracer keys the active trace by `iterationId` going forward; `getTaskTrace(groupId)` keeps working for legacy single-trace reads, and a new `getTaskTraceByIteration(iterationId)` is added.

### 3.5 `task_templates` (LIBRARY) — new

```
task_templates
  id             varchar PK
  name           text NOT NULL
  description    text NOT NULL
  execution_mode text NOT NULL default 'direct_llm'  $type<TaskExecutionMode>
  pipeline_id    varchar
  model_slug     text
  team_id        text
  input          jsonb NOT NULL default '{}'::jsonb
  labels         jsonb NOT NULL default '[]'::jsonb  $type<string[]>
  created_by     text  FK users.id  onDelete:"set null"     -- owner-scoped, same posture as task_groups
  created_at     timestamp NOT NULL defaultNow
  updated_at     timestamp NOT NULL defaultNow
INDEX task_templates_created_by_idx ON (created_by)
```

> Templates are **standalone** (no `group_id`, no `dependsOn` — dependencies are a *group-graph* concept, resolved at compose time). A template is a reusable single-task recipe + labels.

**Labels = array, not a join table.** Decision: a `labels: string[]` jsonb column on `tasks` and `task_templates` (mirrors `library_items.tags` at `schema.ts:1207` — the established in-repo idiom). Rejected a normalized `task_labels` table: labels here are free-text organizational tags, not first-class entities with their own lifecycle; the array keeps it KISS and matches existing precedent. Filtering uses a `jsonb` containment / `?|` operator in PG (and `.includes` in MemStorage).

---

## 4. Re-run flow & the configurable-between-runs rule

### 4.1 `POST /api/task-groups/:id/start` — now creates an iteration

```
1. authorizeTaskGroup(req,…)                                    // 401→404→403
2. orchestrator.startGroup(groupId, { triggeredBy: req.user.id })
   a. load group + its task DEFINITIONS (getTasksByGroup)
   b. GUARD: reject if an iteration is ACTIVELY running for this group
        - check: latest iteration status === 'running' → throw RunActiveError(409)
        - (replaces the old `group.status !== 'pending'` one-shot guard at :133)
   c. iterationNumber = (max existing iteration_number) + 1
   d. INSERT task_group_iterations { group_id, iteration_number, input: group.input snapshot,
        status:'running', triggered_by, started_at }   // UNIQUE backstops the race → 409 on collision
   e. for each DEFINITION: INSERT task_executions { iteration_id, task_id, group_id,
        status: dependsOn.length===0 ? 'ready' : 'blocked' }
   f. project group: updateTaskGroup { status:'running', startedAt:now, completedAt:null,
        traceId:<new>, output:null }                    // group row = latest-iteration mirror
   g. tracer.startIterationTrace(iterationId, …)         // trace keyed by iteration
   h. launch ready executions (concurrency MAX_CONCURRENT_TASKS), same engine, writing task_executions
3. respond 200 with { group (projected), iteration }
```

- **Each iteration's executions reset to pending/ready/blocked**; the **definitions are unchanged** (`dependsOn` graph reused verbatim).
- Orchestrator internals (`onTaskCompleted`/`onTaskFailed`/`checkGroupCompletion`) now read/write `task_executions` **scoped to the active iteration**, computing `ready/blocked` from the definition graph + completed *executions*. The `activeGroupTraces` map gains the `iterationId`. **`executeDirectLlm`'s real-model resolution (309–310) is preserved verbatim** and its result writes `task_executions.model_slug`.
- On settle, project terminal status + aggregate output onto BOTH the iteration row and the group row.

### 4.2 Configurable-between-runs (the editable rule, v2)

PR #374's rule was "editable only while `pending`". v2 generalizes:

> **Definitions are editable when NO iteration is actively running.** A group that has completed iteration 1 is editable again (to set up iteration 2). Running → **409**.

`TaskGroupEditor` change: replace `assertPending(group)` (209) with `assertNotRunning(group)` — load the **latest iteration**, and throw `TaskGroupEditError(409, "Cannot edit while an iteration is running")` iff that iteration's status === `'running'`. The persist-time re-read (TOCTOU) is preserved: re-check latest-iteration-running immediately before write. `input` edits: allowed when not running (each iteration snapshots `input` at run time, so editing it between runs simply affects the *next* iteration — no longer a 409-after-terminal case). `validateTaskGraph` still runs before every definition mutation.

### 4.3 Cancel / retry

- `cancelGroup` cancels the **active iteration**'s non-terminal executions + marks the iteration + group `cancelled`.
- `retryTask` (PR #374's per-task retry) re-targets a single **execution** within the **latest** iteration (`task_executions` for that iteration), preserving the "only failed → ready" guard. Route stays `POST /:id/tasks/:taskId/retry`; the C2 cross-group assert (`task.groupId === :id`, route 185) extends to "definition belongs to group AND has an execution in the latest iteration".

---

## 5. API contracts (all owner-gated via `authorizeTaskGroup` / new `authorizeTaskTemplate`)

### 5.1 Iterations

| Method | Path | Auth | Body / Query | Response |
|---|---|---|---|---|
| POST | `/api/task-groups/:id/start` | group owner | — | `200 { group, iteration }` · `409` if running · `400` no ready tasks |
| GET | `/api/task-groups/:id/iterations` | group owner | `?limit≤100&cursor=` (keyset, `iteration_number desc`) | `200 IterationSummary[]` (metadata-only: number/status/timing/triggeredBy-admin-only/counts) |
| GET | `/api/task-groups/:id/iterations/:n` | group owner | — | `200 { iteration, executions: TaskExecution[] }` (per-task execution detail incl. summary/error — owner-gated) |
| GET | `/api/task-groups/:id/iterations/:n/trace` | group owner | — | `200 TaskTraceRow` for that iteration · `404` no trace |

- `:id/trace` (legacy, `task-traces.ts`) keeps working → aliases the **latest** iteration's trace.
- All gated by `authorizeTaskGroup(:id)`; `:n` existence + `iteration.group_id === :id` re-checked (cross-group guard, mirrors route 185). `limit` clamped `Math.min(…,100)`; cursor an opaque Zod-validated keyset (reuse the `CursorSchema` idiom at `activity.ts:286`).

### 5.2 Task Library (templates) + labels

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/task-templates` | authed; own-filtered via `isVisible(created_by)` | `?label=` filter, `?limit&cursor`; strips `created_by` for non-admins (mirror list at 104) |
| POST | `/api/task-templates` | authed (stamps `created_by`) | `validateBody(TemplateSchema)` |
| GET | `/api/task-templates/:id` | `authorizeTaskTemplate` (owner-or-admin) | |
| PATCH | `/api/task-templates/:id` | `authorizeTaskTemplate` | partial; ≥1 field |
| DELETE | `/api/task-templates/:id` | `authorizeTaskTemplate` | `204` |

`authorizeTaskTemplate` = new closure mirroring `authorize-task-group.ts` exactly (401→404→403, admin bypass, ownerless-denied, `isVisible(template.createdBy)`).

### 5.3 Composition

- **Create-from-templates:** `POST /api/task-groups` body extended — each task may carry `templateId?`. When present, the orchestrator **copies the template's fields into the new `tasks` definition** and stamps `tasks.template_id` for provenance. `dependsOn` is still expressed by task-name within the create payload (group-graph concept).
- **Add-from-template:** `POST /api/task-groups/:id/tasks` body extended with optional `templateId` (copy-in on add).
- Labels flow through copy-in: the new definition inherits the template's `labels` (editable afterwards on the group's own copy).

---

## 6. Composition: COPY-IN vs REFERENCE (decision)

**Decision: COPY-IN (snapshot).** When a template is composed into a group, its fields are copied into a `tasks` definition row owned by the group; `tasks.template_id` records provenance (nullable, `onDelete:"set null"`).

**Justification:**
- **Stability / immutability:** an iteration's history must reflect *what actually ran*. If groups *referenced* live templates, editing or deleting a template would retroactively mutate the meaning of past iterations and break in-flight runs. Copy-in keeps the group's definition self-contained — the same property `task_executions` gives execution history.
- **Ownership boundary:** templates are owner-scoped; a copied-in definition belongs to the **group** (gated by `task_groups.createdBy`). No cross-resource authorization tangle at run time — the orchestrator never reads `task_templates` during a run, only at compose time (where the template is owner-checked once).
- **Blast radius:** deleting a template can never cascade-corrupt a group. `template_id` set-null keeps provenance soft.
- **Matches the repo idiom:** identical to how the create flow already snapshots the payload into `tasks` rows (orchestrator `createTaskGroup` 69–124). Templates just pre-fill that payload.

**Rejected (reference):** a group task pointing at a live `task_templates.id`. Smaller storage, but couples run history to mutable library state and creates a cross-owner authz surface inside the hot path. The library's value is *organization + reuse at compose time*, not live linkage.

---

## 7. UI

### 7.1 `TaskGroup.tsx` — Iterations

- New **Iterations** panel (right column or a tab): list iterations newest-first (number, status badge reusing `StatusBadge`, started/duration, completed/total counts). Driven by a new `useTaskGroupIterations(id)` hook (keyset "Load more", mirrors `useActivityHistory`).
- Selecting an iteration loads `GET …/iterations/:n` → renders the **per-task execution history** for that iteration by **reusing `buildTimeline`** (point it at `task_executions` instead of `tasks`) and the per-task summary/error cards already in the page (549–594). The **Trace** button targets `…/iterations/:n/trace`.
- The header **Start** button becomes **Run** (and **Run again** once ≥1 iteration exists), enabled whenever no iteration is running. **Edit** is enabled whenever not running (per §4.2). Live WS stream (`use-task-events`, keyed by groupId) annotates the **active** iteration.
- `TaskGroupTrace.tsx`: accept an optional `/iterations/:n/trace` route param; `useTaskTrace` gains an iteration-aware fetch. Waterfall rendering is unchanged.

### 7.2 Tasks / Library surface (new)

- New page `client/src/pages/TaskLibrary.tsx` + route — list/create/edit/delete standalone templates with a **labels** editor (chip input). Own-scoped list; admin sees owner column (mirror Activity history column rule).
- Reuse the shared `task-form` (`TaskRow` + `task-form-logic`) for the template editor; extend `TaskDraft` with `labels: string[]` and a label chip control. New hook `use-task-templates.ts` (CRUD + label filter), mirroring `use-task-groups`.

### 7.3 Composer (CreateTaskGroup + edit)

- `CreateTaskGroup.tsx`: a **"Add from library"** affordance — pick template(s) (filter by label) → seed `TaskDraft` rows (copy-in client-side; server re-copies authoritatively via `templateId`). Manual task creation stays.
- Labels visible on seeded rows (read-only chips) so the composer communicates provenance.
- a11y: chip inputs keyboard-operable (add/remove via Enter/Backspace), ARIA labels on label controls and the iteration list (`role="list"`/tablist as appropriate), reduced-motion respected. All user text rendered as **inert React text** (no `dangerouslySetInnerHTML`) — unchanged posture.

---

## 8. Migration plan (non-destructive, additive — `db:push`)

**Approach: additive tables + LAZY backfill.** No destructive column drops, no data rewrite up front.

1. **Schema additions only** (§3): new tables `task_group_iterations`, `task_executions`, `task_templates`; new nullable columns `tasks.labels`, `tasks.template_id`, `task_traces.iteration_id`. Existing `tasks` execution columns are **left in place** (nullable) for the migration window.
2. **Materialize via `db:push`** (`drizzle-kit push`, `package.json:12`) — same path as `practice_cards` / morning-news-board / debate-orchestrator (the migration **journal is gated at 0012**; numbered `migrations/*.sql` are record-only). **`db:push` caveat (flagged):** `drizzle-kit push` is **interactive/TTY-gated** — it prompts on ambiguous column changes and will hang on a non-TTY/CI runner. Because every change here is **purely additive** (new tables + new nullable columns, no renames/type-narrows), push applies without destructive prompts. Run it on the host against a scratch/dev DB and confirm clean apply (the news-board A1 task did exactly this). Do **not** wire it into non-interactive CI. R4 below asks the Lead to confirm the push path, consistent with the R5 precedent in `morning-news-board-mvp.md`.
3. **Backfill existing one-shot groups → "iteration 1" (lazy + optional one-time script):**
   - **Lazy (default):** a terminal pre-v2 group has zero iteration rows. On first GET of `…/iterations`, synthesize a read-only **virtual iteration 1** from the legacy `tasks` execution columns (the existing `getTasksByGroup` data) so old groups show their single historical run without a write. Zero-downtime and reversible.
   - **One-time backfill (preferred for cleanliness, runnable later):** a script inserts one `task_group_iterations` row (number 1, status/timing copied from the group) + one `task_executions` row per existing task (copying `status/output/summary/error/model/timing`) + sets `task_traces.iteration_id`. Idempotent (skip groups that already have iterations; the UNIQUE backstops). Can run after deploy; the lazy path covers the gap until then.
4. **Read path during the window:** new code reads execution from `task_executions`; for groups with no iteration rows yet it falls back to the legacy `tasks` columns (the virtual-iteration adapter). Once backfilled, the fallback is dead and the legacy columns can be dropped in a **separate, later, explicitly-reviewed** migration (out of scope here — additive-only now).
5. **Rollback:** because it's additive, rollback = stop writing the new tables; the legacy `tasks` columns still hold the last run. No data loss.

---

## 9. Security (extends PR #374 posture)

- **Iterations & executions are owner-gated via the parent group.** Every `…/iterations*` route calls `authorizeTaskGroup(:id)` first; `:n` and execution rows re-check `group_id === :id` (cross-group guard, mirrors route 185). Per-iteration execution **detail (summary/error/output)** is owner-gated (only the `…/iterations/:n` detail exposes it); the **list** is metadata-only (status/timing/counts), `triggeredBy`/`ownerId` admin-only — same split the Timeline/Activity already use.
- **Library templates owner-scoped:** new `authorizeTaskTemplate` mirrors `authorize-task-group.ts` byte-for-byte (401→404→403, admin bypass, **ownerless denied to non-admins**, fail-closed). List own-filters via `isVisible(created_by)` and strips `created_by` for non-admins.
- **Activity:** `task_group` activity references the **latest iteration**; `taskGroupUnit` reads `task_executions` for the active iteration but stays **metadata-only** (no task text, no summary) — unchanged contract. History keeps SQL-side owner filter + keyset.
- **Editable-only-when-not-running:** `assertNotRunning` with a **persist-time re-read** of the latest iteration (TOCTOU), exactly like #374's pending guard. The `UNIQUE(group_id, iteration_number)` is the DB-level race backstop for concurrent `start`.
- **WS:** `authorizeAndSubscribe` is unchanged (channel still keyed by groupId, gated by `isVisible(group.createdBy)`, fail-closed). Iteration ids are never used as subscribe keys, so no new WS authz surface.
- **No IDOR regressions:** the same class PR #374/#375 closed. No `any`; `unknown`-narrow external input; Zod at every boundary; generic error bodies (reuse `sendError`).

---

## 10. Ordered task breakdown (small units, dependencies)

Legend: ∥ = parallelizable with siblings. TDD ≥80% on new modules.

### Backend
- **BE1 — Schema + types** *(no deps)*: add `task_group_iterations`, `task_executions`, `task_templates` tables; add `tasks.labels`/`tasks.template_id`, `task_traces.iteration_id`; enums reuse `TASK_GROUP_STATUSES`/`TASK_STATUSES`; `Insert*`/`*Row` types + insert schemas. Verify **`db:push`** applies clean on a scratch DB (additive). *Tests: schema/insert-schema round-trip.*
- **BE2 — Storage (IStorage + Mem + Pg, lockstep)** *(BE1)*: `createIteration`, `getIterations(groupId,{limit,cursor})`, `getIteration(groupId,n)`, `getLatestIteration(groupId)`; `createExecution`, `getExecutionsByIteration`, `getExecution`, `updateExecution`; `getTaskTraceByIteration`; template CRUD (`getTaskTemplates({label,limit,cursor})`, `getTaskTemplate`, `createTaskTemplate`, `updateTaskTemplate`, `deleteTaskTemplate`); add the legacy→virtual-iteration adapter read. *Tests: CRUD, cascade delete, `UNIQUE(group,number)` + `UNIQUE(iter,task)`, keyset paging, owner filter, MemStorage/PgStorage parity.*
- **BE3 — Orchestrator: iteration-aware execution** *(BE2)*: replace one-shot guard (`startGroup` 133) with active-iteration guard; create iteration + executions on start; redirect `executeTask`/`onTaskCompleted`/`onTaskFailed`/`checkGroupCompletion` to `task_executions` for the active iteration; project terminal status/output onto iteration + group; **preserve `executeDirectLlm` real-model resolution (309–310)** and write resolved `model_slug`; key `activeGroupTraces` by iteration. *Tests: re-run creates iteration 2; per-iteration executions isolated; running→409; model-default still real (extend `task-orchestrator-default-model.test.ts`).*
- **BE4 — Tracer per-iteration** *(BE3)*: `startIterationTrace(iterationId,…)`; set `task_traces.iteration_id`; `getTaskTraceByIteration`; legacy `getTaskTrace(groupId)` aliases latest. *Tests: trace bound to iteration; latest alias.*
- **BE5 — Editor: editable-when-not-running** *(BE2)*: `assertPending`→`assertNotRunning` (latest-iteration re-read, TOCTOU); allow `input` edits between runs; keep `validateTaskGraph`. *Tests: edit after terminal allowed; edit during running 409; graph cycle 400.*
- **BE6 — Iteration routes** *(BE3,BE4)*: `GET …/iterations`, `GET …/iterations/:n`, `GET …/iterations/:n/trace`; extend `POST …/start` to return `{group,iteration}`; legacy `:id/trace` → latest. All `authorizeTaskGroup` + `:n` cross-group re-check + keyset/limit-clamp. *Tests: owner 200 / non-owner 403 / 401 / cross-group 404; metadata-only list; detail exposes summary owner-only; pagination.*

### Library (BE + FE)
- **BE7 — `authorizeTaskTemplate` + template routes** *(BE2)*: closure mirroring `authorize-task-group.ts`; CRUD routes; list own-filter + label filter + `created_by` strip. *Tests: 401→404→403, ownerless-denied, admin bypass, label filter, own-filter.*
- **BE8 — Composition copy-in** *(BE7,BE3)*: extend create + add-task to accept `templateId`, copy template fields into `tasks` definition, stamp `template_id`, inherit `labels`; owner-check template once at compose. *Tests: copy-in snapshot independent of later template edits/deletes; provenance set; cross-owner template denied.*

### Frontend
- **FE1 — Hooks** *(BE6,BE7)* ∥: `use-task-iterations.ts` (list keyset + detail + trace), extend `use-task-trace` for iteration param, `use-task-templates.ts` (CRUD + label filter). *Tests: query keys/invalidation, keyset append/de-dupe (mirror activity).*
- **FE2 — `TaskGroup.tsx` iterations** *(FE1)*: Iterations panel/tab; select → per-iteration execution history via `buildTimeline` repointed at executions; Run / Run again button (enabled when not running); Edit enabled when not running; Trace → `/iterations/:n/trace`. *Tests: pure helpers (iteration list shaping, run-enabled logic) node-testable in `task-form`-style spec.*
- **FE3 — Library surface** *(FE1)*: `TaskLibrary.tsx` + route + nav; template list/create/edit/delete; labels chip editor; reuse `task-form`. *Tests: label chip reducer, validate, owner column rule.*
- **FE4 — Composer "Add from library"** *(FE3)*: template picker (label filter) seeding `TaskDraft` rows incl. `templateId`; label chips on seeded rows. *Tests: seed reducer copies template fields + labels + templateId.*
- **FE5 — `buildTimeline` + `task-form-logic` extension** *(FE1)* ∥: `buildTimeline` accepts execution rows (same shape adapter); `TaskDraft` gains `labels`; reducers preserve labels. *Tests: timeline ordering on executions; labels reducer preserve.*

### Security & QA
- **SEC1 — Security review (VETO gate)** *(BE6,BE7,BE8)*: verify owner-gating on every `…/iterations*` + template route, cross-group `:n` re-check, metadata-only list vs owner-gated detail, ownerless-denied + fail-closed on `authorizeTaskTemplate`, persist-time not-running re-check, no IDOR, no `any`, generic error bodies, Mem/Pg parity.
- **QA1 — QA sign-off** *(all)*: `tsc --noEmit` clean; unit + integration green; coverage ≥80% on BE2/BE3/BE5/BE6/BE7/BE8 + new FE pure modules; explicit Mem/Pg parity check; **`db:push` clean-apply on scratch DB** verified and recorded.

**Critical path:** BE1 → BE2 → BE3 → BE6 → FE1 → FE2 → SEC1 → QA1. Library track (BE7/BE8/FE3/FE4) parallels after BE2.

---

## 11. Risks / open questions (for the Lead)

1. **R1 — Definition/execution split migration (HIGHEST).** Keeping `tasks` as the definition table while moving execution to `task_executions` leaves legacy execution columns on `tasks` during the window. **Decision needed:** approve **lazy virtual-iteration-1** (zero-write, reversible) as the default, with the one-time backfill script as a later cleanup, OR require the backfill up front. Recommend lazy-default + scripted backfill later (matches additive, zero-downtime posture). The eventual legacy-column drop is a **separate** reviewed migration.
2. **R2 — Copy-in vs reference (RESOLVED in §6, confirm).** Recommending **copy-in snapshot** (`template_id` provenance, set-null on delete) so iteration history is immutable and there's no cross-owner authz in the run hot path. Confirm the Lead accepts copy-in (slightly more storage) over live references.
3. **R3 — Volume of execution rows.** `task_executions` grows `tasks × iterations`. A frequently-re-run 100-task group accrues fast. **Decision:** is unbounded retention acceptable for the MVP, or do we cap iterations / add a retention/prune policy (e.g. keep last N iterations, soft-cap iteration count)? Recommend MVP keeps all + a `?limit≤100` keyset list (no prune yet); flag a follow-up for retention if volume bites. Indexes (`executions_iteration_id_idx`, `executions_task_id_idx`) keep reads bounded.
4. **R4 — `db:push` path (R5 precedent).** v2 ships via additive `db:push` (journal gated at 0012), consistent with practice_cards/news-board/debate-orchestrator. Confirm the Lead is comfortable (no numbered migration); note push is TTY-gated → run on host, never CI.
5. **R5 — Labels as array vs join table.** Recommending a `labels: string[]` jsonb column (mirrors `library_items.tags`) over a normalized `task_labels` table — KISS, matches repo idiom. Confirm we don't need label entities with their own lifecycle (rename-propagation, label ACLs). If we later do, the array is a forward-compatible denormalization.
6. **R6 — WS channel granularity.** The WS stream stays keyed by **groupId** (subscribers can't know iteration ids), annotating only the active iteration. Confirm there's no need to multiplex multiple concurrent iterations of the same group (there isn't — running→409 means at most one active iteration per group). If concurrent iterations are ever wanted, WS keying must change.
7. **R7 — `tasks.status` semantics.** After the split, `tasks.status` no longer drives orchestration (it becomes a transient edit-time `ready/blocked` validity hint). Confirm we keep the column (cheap, used by the editor) rather than dropping it now (additive-only).

---

## 12. Phase-1 gate resolutions (Security VETO + QA + Lead decisions) — BINDING on implementation

Security review = **APPROVE-WITH-CONDITIONS** (all design security claims verified against real code; no contradictions). QA = **testable**, with one blocking harness gap. Every item below is a binding requirement on the BE/FE/SEC1/QA1 tasks.

### 12.1 Security MUST-FIX (HIGH — enforcement-point pinning, not redesign)

- **MF-1 — group-scoped execution reads.** Storage signatures change: `getExecutionsByIteration(groupId, iterationId)` and `getExecution(groupId, executionId)` — the **group is a mandatory scope key**, never a bare child id. The detail route's `executions[]` must be fetched filtered to the authorized `:id`. (Closes a guessable-child-id IDOR — the #374 class on a new surface.) Amends §3.2, §5.1, BE2.
- **MF-2 — iteration LIST is a metadata-only ALLOWLIST.** `IterationSummary` is built by explicit field allowlist (mirror `buildTaskGroupHistoryRow` / `activity.ts:477-512`), **never a `...iteration` spread**. It exposes `number/status/startedAt/completedAt/duration/completedCount/taskCount` only. `iteration.input` (user prompt snapshot) and `iteration.output` (summaries) **must never** appear in the list. `triggeredBy`/`ownerId` are **admin-only**. Amends §5.1.
- **MF-3 — child-keyed trace/execution reads validate via the parent group.** `…/iterations/:n/trace` must: `authorizeTaskGroup(:id)` → load iteration → assert `iteration.group_id === :id` → only then fetch the trace scoped to that verified iteration. Never `getTaskTraceByIteration(rawParam)` off an unvalidated id. Amends §3.4, §5.1.
- **MF-4 — `authorizeTaskTemplate` + owner-filter-before-label.** The closure mirrors `authorize-task-group.ts` byte-for-byte (401→404→403, admin bypass, ownerless-denied-to-non-admins, fail-closed, `isVisible(created_by)`). On the list, the ownership filter (`created_by = :user` for non-admins) is applied **before/with** the `?label=` match so a non-admin cannot enumerate another tenant's templates by label; `created_by` is stripped for non-admins (mirror `task-groups.ts:104`). Amends §5.2.
- **MF-5 — lazy fallback is gated.** The virtual-iteration-1 adapter (§8) is invoked **inside the already-`authorizeTaskGroup`-authorized** route handler. There must be no `…/iterations*` code path that skips the gate when zero iteration rows exist. Amends §8 step 4.

### 12.2 Security SHOULD-FIX (MEDIUM)

- **SF-1 — atomic start.** Wrap the `task_group_iterations` insert (§4.1.d) + the per-task `task_executions` inserts (§4.1.e) so a failed start never leaves a partial/orphaned iteration (transaction in PgStorage; clean-up-on-failure in MemStorage). The UNIQUE backstop covers the duplicate-N race but not a half-built iteration.
- **SF-2 — clamp + parameterize the label query.** Zod-validate `?label=` (bounded string; bounded array if ever array-valued); the PG `jsonb`/`?|` operator input must be a Drizzle bind param, never string-interpolated.
- **SF-3 — cost guard.** `task_executions` grows `tasks × iterations` and each `direct_llm` resolves to a **real** model (#375) → real spend. **Lead decision (below): a configurable soft cap, generous default.**

### 12.3 QA additions (binding on QA1)

- **PARITY HARNESS (blocking, #1 to resource).** The repo has **no** PgStorage-backed test today — "Mem/Pg parity" is convention-only. Add `tests/integration/storage/mem-pg-parity.test.ts` running ONE shared case table against **both** impls, PG gated behind `DATABASE_URL` (`describe.skipIf(!process.env.DATABASE_URL)`) so unit CI stays DB-free. It must exercise the **DB-enforced** behaviors the design relies on: `UNIQUE(group_id,iteration_number)`, `UNIQUE(iteration_id,task_id)`, cascade delete, `?|`/containment label filter, keyset SQL ordering.
- **coverage.include is an allowlist** — every new server module (`storage-pg.ts` included) MUST be added to `vitest.config.ts coverage.include` or it is silently unmeasured. Targets ≥80%: BE2 (`storage.ts`+`storage-pg.ts`), BE3, BE5, BE6, BE7, BE8 + new FE pure modules.
- **Assertion inversions for v2:** in `tests/integration/task-groups/idor-and-edit.test.ts`, the existing "409 editing input on a completed group" case is **inverted** (input edit between runs is now allowed). The `task-orchestrator-default-model.test.ts` "persists the task summary" case now reads summary/status from `task_executions` (latest iteration), not the `tasks` definition row.
- **#375 regression on re-run:** assert a model-less `direct_llm` resolves to the real default (never `"mock"`) on first run **and** re-run, and that the **resolved** slug persists to `task_executions.model_slug`.
- **`tasks.status` staleness guard:** a test where `tasks.status` is deliberately wrong and orchestration still computes ready/blocked from the definition graph + completed executions (proves orchestration reads `task_executions`, not the legacy column).

### 12.4 Lead decisions (resolved)

- **R1 → LAZY-DEFAULT.** Lazy virtual-iteration-1 adapter is the default (zero-write, reversible); the one-time backfill script is a later, separately-reviewed cleanup. The eventual legacy-column drop is out of scope (additive-only now).
- **R2 → COPY-IN confirmed** (security-approved; immutable iteration history, no cross-owner authz in the run hot path).
- **R3 / SF-3 → configurable soft cap.** Add `pipeline.taskGroups.maxIterationsPerGroup` (zod knob, default **`0` = unlimited** for this local single-user MVP; when >0, `/start` returns `409` once the cap is reached). Re-runs are deliberate user actions (a click), so the default stays generous; the knob exists for when volume/cost bites. Documented as a fast-follow for a real prune/retention policy.
- **DELETE-WHILE-RUNNING → 409.** `DELETE /api/task-groups/:id` is rejected `409 "Cancel the running iteration first"` when the latest iteration is `running` (mirrors the `assertNotRunning` edit guard — consistent, conservative, no surprise force-cancel). Cancel first (`POST /:id/cancel`), then delete → cascade removes iterations/executions/traces.
- **R4/R5/R6/R7 → accepted as recommended** (additive `db:push` no numbered migration; labels as `string[]` jsonb; WS keyed by groupId; keep `tasks.status` column).
