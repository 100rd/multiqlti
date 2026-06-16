# Task Groups — Edit, History & Live-Activity History — Design

**Status**: Proposed
**Author**: solution-architect (DESIGN phase)
**Date**: 2026-06-16
**Branch**: `feature/task-groups-edit-and-history`
**Builds on**: `docs/design/live-run-activity-ui.md` (the already-shipped `/activity` lens).

> DESIGN ONLY. No implementation code in this change beyond this document. Every symbol/path below was verified against the current tree.

---

## 0. TL;DR for the Lead

Three features over the Task-Group + Live-Activity surfaces:

- **(A) Edit a Task Group** — group fields (name/description/input) + per-task fields, add/remove task, change `dependsOn`. New `PATCH`/`POST`/`DELETE` endpoints. **Editing is allowed only while `status === "pending"`** (not yet started). Once started, a group is a historical record (`running`/`completed`/`failed`/`cancelled`) and is **immutable except its `name`/`description` as a label**.
- **(B) Task-Group history** — interpreted (see §2) as **the execution timeline of THIS one-shot group**: its task lifecycle + the `task_traces` spans, surfaced as a panel on `TaskGroup.tsx`. **Plus** task-groups should *appear in the Live-Activity history* (feature C) and, while running, in the *live* `/activity` snapshot. No new per-run table.
- **(C) Live-Activity run history** — a **History tab** on `/activity` listing PAST runs (completed/failed/cancelled) across ALL modes **including task-groups**, DB-backed, owner/admin-scoped, metadata-only, paginated. New `GET /api/activity/history`.

**Two pre-existing security/correctness findings surfaced during grounding (flagged to Lead, §7):**

1. **IDOR on every task-group route.** `server/routes/task-groups.ts` is behind `requireAuth` (routes.ts:144) but **none of its handlers check ownership** (`task_groups.createdBy`). Any authenticated user can read/start/cancel/delete/retry/(soon edit) **any** group. This must be closed as part of (A) — the new mutations cannot ship un-gated, and the existing reads/mutations should be gated in the same pass (consistent with the `authorize-run.ts` + consensus IDOR work).
2. **Task-group live WS is currently dead.** `WsManager.authorizeAndSubscribe` (ws/manager.ts:86) resolves ownership via `storage.getPipelineRun(runId)` and **fails closed when no row** (`if (!run) return false`). Task-group events are broadcast on `broadcastToRun(groupId, …)` where `groupId` is a `task_groups.id`, which has **no `pipeline_runs` row** → the subscribe is **rejected**, so `TaskGroup.tsx`'s "Activity" stream never receives live events today (it survives only on the 3s `useTaskGroup` poll). Feature (B)'s live timeline depends on fixing this. Design in §4.3.

---

## 1. Verified data model (corrections + confirmations)

All confirmed against `shared/schema.ts`, `server/routes/task-groups.ts`, `server/services/task-orchestrator.ts`, `server/storage.ts`.

| Fact | Verified |
|------|----------|
| `task_groups` (schema.ts:1085) — one-shot lifecycle `pending → running → completed/failed/cancelled` (`TASK_GROUP_STATUSES`, :1082); fields `input`, `output` (jsonb), `traceId`, `startedAt`, `completedAt`, `createdBy` (FK `users.id`, `onDelete: set null`). | ✅ exactly as briefed |
| **No per-run table.** A group is created, **started once** (`POST :id/start` → `orchestrator.startGroup`, which throws if `status !== "pending"`, task-orchestrator.ts:122), runs, settles. It is never re-run into multiple "runs". | ✅ confirmed |
| `tasks` (schema.ts:1117) — per-group, FK `group_id` **cascade** (:1125); `status` (`TASK_STATUSES` incl. `blocked`/`ready`, :1111), `executionMode` (`direct_llm`\|`pipeline_run`, :1114), `dependsOn jsonb string[]` (:1130, stores **task IDs**, resolved from names at create — task-orchestrator.ts:91-98), `sortOrder`, `output`, `summary`, `errorMessage`, etc. | ✅ |
| `task_traces` (schema.ts:1232) — FK `group_id` cascade, `traceId` unique, `spans jsonb`, `totalDurationMs/Tokens/CostUsd`. One trace row **per group**. Visualized by `client/src/pages/TaskGroupTrace.tsx` via `use-task-trace.ts`. | ✅ |
| Routes (`task-groups.ts`): `GET /api/task-groups`, `GET :id`, `POST` (create, `validateBody(CreateTaskGroupSchema)`), `POST :id/start`, `POST :id/cancel`, `DELETE :id`, `POST :id/tasks/:taskId/retry`. **No PATCH/PUT.** | ✅ |
| **AuthZ gap**: handlers read `req.user?.id` only to stamp `createdBy` on create (task-groups.ts:75). **No owner check on any read or mutation.** `req.user.role`/admin never consulted. Errors use `res.json({ error: String(err) })` — leaks internals, not the `ApiResponse` envelope. | ✅ (IDOR — §7.1) |
| `IStorage` task methods (storage.ts:376-393): `getTaskGroups`, `getTaskGroup`, `createTaskGroup`, `updateTaskGroup(id, Partial<TaskGroupRow>)`, `deleteTaskGroup`, `getTasksByGroup`, `getTask`, `createTask`, `updateTask(id, Partial<TaskRow>)`, `getReadyTasks`, `getBlockedTasks`, `getTaskTrace`. **There is NO `deleteTask(id)`.** | ✅ (one new storage method needed — §3.1) |
| `TaskOrchestrator` has **no `activeRuns`/AbortController registry** like the controllers. It has a private `activeGroupTraces: Map<groupId, …>` (task-orchestrator.ts:40) populated only between `startGroup` and group settle. No public `getActiveGroupIds()` accessor. | ✅ (relevant to §4.3 live snapshot) |
| Task-group WS events (`taskgroup:started/progress/completed/failed`, `task:created/ready/started/completed/failed`) already exist in the `WsEventType` union (types.ts:495-504) and are broadcast via `wsManager.broadcastToRun(groupId, …)` with `runId = groupId` (task-orchestrator.ts:600). | ✅ |

**Correction vs. the brief's note that routes may not be owner-gated:** confirmed — they are **authenticated but not owner-gated at all**. There is no partial gating to extend; ownership must be added from scratch, keyed on `task_groups.createdBy` (NOT `pipeline_runs.triggeredBy`, since groups have no pipeline_runs row).

---

## 2. Feature (B) interpretation — STATED EXPLICITLY

> The brief flags the ambiguity ("в activity task-groups нужна история"). I read it two ways and **design for both**, because they are complementary and cheap together:

**Primary reading — "a Task Group's history is its own execution timeline."** Because a group is **one-shot** (no multiple runs), its "history" is the single execution it had: the **task lifecycle** (each task's status transitions, started/completed timestamps, summary/error) **plus** the **trace** (`task_traces` spans: durations, tokens, cost). This already half-exists: `TaskGroup.tsx` has a live "Activity" event log and a "Trace" button → `TaskGroupTrace.tsx`. The gap is that (a) the timeline is **ephemeral** (WS-only, lost on reload — and currently dead, §0.2) and (b) there is no consolidated, reload-survivable per-group timeline panel.
→ **Design: a "History / Timeline" panel on `TaskGroup.tsx`** built from durable data (the task rows' timestamps/status + the trace), with the live WS stream layered on top when the group is running. (§4.2)

**Secondary reading — "task-groups should appear in /activity, with a history entry."** This is reasonable and we honour it via **feature (C)**: task-groups become a first-class **mode** in the Activity *History* tab (past groups) and, while running, in the *live* Activity snapshot (§4.3). So "history in activity" = the group shows up in the Activity History list like any other run.

Both are delivered. Neither requires a new per-run table (§5).

---

## 3. Feature (A) — Edit a Task Group

### 3.1 The "editable only while pending" rule (the core invariant)

A group's `status` defines whether it is a **draft** (mutable) or a **historical record** (immutable):

| Group status | Group name/description | Group `input` | Tasks (fields / add / remove / dependsOn) |
|---|---|---|---|
| `pending` | ✅ editable | ✅ editable | ✅ fully editable |
| `running` | ❌ (409) | ❌ (409) | ❌ (409) |
| `completed` / `failed` / `cancelled` | ⚠️ **name/description only** (relabel a record) | ❌ (409) | ❌ (409) |

Rationale: once `startGroup` flips `status` to `running` (task-orchestrator.ts:124) and seeds task statuses/trace, mutating tasks or `input` mid/post-run corrupts the execution record and the dependency graph the orchestrator already resolved. `input` is the immutable objective the run was launched with. Only the human-facing **label** (`name`/`description`) may be corrected on a finished group. Enforced server-side; the UI mirrors it (read-only fields + disabled actions) but the server is authoritative.

This mirrors the existing guard in `startGroup` (`if (group.status !== "pending") throw …`, task-orchestrator.ts:122) — we generalise the same "pending = mutable" notion to edits.

### 3.2 Endpoints (all owner-gated, see §6)

A shared helper `authorizeTaskGroup(req, res, storage, groupId)` (new, sibling of `authorize-run.ts`, but keyed on `task_groups.createdBy`) gates every route below: `401` unauth → `404` missing → `403` non-owner (admin bypass; **ownerless `createdBy == null` denied to non-admins**, matching the strict `authorize-run` posture). On success returns `{ ownerId }`. **This same helper is retro-fitted onto the existing GET/start/cancel/delete/retry routes to close §7.1.**

```
PATCH  /api/task-groups/:id
```
Body (all optional; at least one required): `{ name?, description?, input? }`.
- Validation: `name` 1–200, `description` 1–5000, `input` 1–50000 (reuse the bounds from `CreateTaskGroupSchema`, task-groups.ts:9-12), via `validateBody`.
- **Guard:** if `input` present and `status !== "pending"` → **409** `{ error: "Cannot edit input after the group has started" }`. If `name`/`description` only, allowed in any status. Running → 409 for any field.
- Maps to `storage.updateTaskGroup(id, patch)`. Returns the updated `{ ...group, tasks }` (same shape as `GET :id`) in the `ApiResponse` envelope.

```
PATCH  /api/task-groups/:id/tasks/:taskId
```
Body (optional): `{ name?, description?, executionMode?, dependsOn?, pipelineId?, modelSlug?, teamId?, input?, sortOrder? }`.
- **Guard:** group `status` must be `pending` → else **409**. Task must belong to the group (`task.groupId === id`, else 404 — prevents cross-group taskId tampering).
- `dependsOn` is an array of **task IDs within this group**; validate every id exists in the group's tasks and **reject self-reference and cycles** (pure DAG check, §3.3). Reuse `CreateTaskGroupSchema`'s per-task field bounds.
- Maps to `storage.updateTask(taskId, patch)`. While `pending`, also **recompute initial status** (`ready` if `dependsOn` empty, else `blocked`) so the draft stays consistent (mirrors create-time logic, task-orchestrator.ts:98).

```
POST   /api/task-groups/:id/tasks
```
Body: a single task object (same per-task schema as create). **Guard:** group `pending` → else 409.
- `dependsOn` references resolved/validated against existing group tasks (by **ID**; the FE supplies ids it already knows). New task gets `sortOrder` = max+1 by default. Maps to `storage.createTask({ groupId: id, … })`. Returns the created task.

```
DELETE /api/task-groups/:id/tasks/:taskId
```
**Guard:** group `pending` → else 409. Task must belong to the group.
- **Requires a new `IStorage.deleteTask(id: string): Promise<void>`** (none exists — §1). Implement on `MemStorage` + `PgStorage` (additive interface method).
- **Referential cleanup:** after delete, **strip the removed task's id from every sibling's `dependsOn`** (the create/remove UI already does this client-side — CreateTaskGroup.tsx:491-499; the server must do it durably). Do it in the orchestrator/service layer (a small `removeTask(groupId, taskId)` that deletes + fixes siblings + re-derives their `ready`/`blocked` status), not raw in the route, to keep the route thin and the logic unit-testable. Returns `204`.

> **Edit orchestration lives in `TaskOrchestrator`** (or a thin `TaskGroupEditor` collaborator), not the route handler — the route validates + authorizes + delegates. This keeps it consistent with how create/start/cancel already delegate to the orchestrator, and gives a single TDD'd unit for the dependsOn-rewrite + status-recompute rules.

### 3.3 DAG / dependsOn integrity (pure, reused)

`dependsOn` edits and task removal can introduce **cycles** or **dangling refs**. Add a pure helper `validateTaskGraph(tasks: {id, dependsOn}[]): { ok: true } | { ok: false; reason }` (new `server/services/task-graph.ts`, unit-tested with a table): rejects (a) a dep id not in the group, (b) self-dependency, (c) any cycle (DFS/Kahn). Called by `PATCH task`, `POST task`, `DELETE task` before persisting. (The orchestrator's runtime unblock logic already assumes a DAG — task-orchestrator.ts:463-466 — so this just enforces the invariant the runtime already relies on.)

### 3.4 Frontend — edit mode on `TaskGroup.tsx`

- **Reuse, don't rebuild the form.** Extract `TaskRow`, `emptyTask`, `validate`, `hasErrors`, and the `TaskDraft`/`GroupDraft` types from `CreateTaskGroup.tsx` (lines 21-201) into a shared `client/src/components/task-groups/task-form.tsx` (+ `task-form-types.ts`). `CreateTaskGroup.tsx` imports them (behaviour-preserving refactor); the edit mode reuses the identical pieces. This is a pure DRY move — the create form already has every control edit needs (name/desc/input, add task, remove task with dependsOn cleanup, dependsOn toggle badges).
- **Edit affordance:** an "Edit" button on `TaskGroup.tsx` header, shown only when `effectiveStatus === "pending"` (full edit) OR always-but-limited-to-name/description when terminal. Toggles the detail view into an editable form seeded from `data` (the group + tasks). On save, fire the PATCH/POST/DELETE mutations (new hooks in `use-task-groups.ts`: `useUpdateTaskGroup`, `useUpdateTask`, `useAddTask`, `useDeleteTask`) then invalidate `["/api/task-groups", id]`.
- **dependsOn in edit uses IDs.** The create form toggles deps by **name** (CreateTaskGroup.tsx:130-156) because tasks have no ids yet. In edit, tasks have real ids; the shared `TaskRow` must accept `siblings: {id, name}[]` and toggle by id, mapping to names only for display. (Small generalisation of the shared component; covered by tests.)
- a11y: edit toggle is a real `<button>`; form fields keep their `<Label htmlFor>` wiring already present; disabled/read-only states announced.

---

## 4. Feature (B) — Task-Group history / timeline

### 4.1 No new data — read what exists

Durable per-group timeline is reconstructable from rows we already have:
- **Per-task lifecycle:** `tasks` rows carry `status`, `startedAt`, `completedAt`, `summary`, `errorMessage`, `sortOrder` — already returned by `GET :id`. That is the ordered task timeline.
- **Trace:** `task_traces` (spans + durations + tokens + cost) via the existing trace path that `TaskGroupTrace.tsx` already consumes (`use-task-trace.ts`). No change needed.
- **Group-level:** `task_groups.startedAt`/`completedAt`/`status`/`output`.

So **(B) needs no new endpoint** for the durable view — it composes existing reads.

### 4.2 Frontend — a "Timeline" panel on `TaskGroup.tsx`

- Add a **Timeline** panel/section (or a small tab toggle: "Tasks" | "Timeline") to `TaskGroup.tsx` that renders a durable, reload-surviving chronology built from the task rows' `startedAt`/`completedAt`/`status` + the group's `startedAt`/`completedAt`. Each entry: task name, status badge (reuse the page's existing `StatusBadge`, TaskGroup.tsx:23), start/end, duration, summary/error. Sorted by `startedAt` (fallback `sortOrder`).
- **Layer the live stream on top:** keep the existing WS "Activity" log (`use-task-events.ts`) for the running case — once §4.3 fixes the subscribe, it works live; until/independently, the durable timeline from rows is always correct on reload (the poll keeps it fresh, `useTaskGroup` refetchInterval 3s).
- **Link, don't duplicate, the trace:** the existing "Trace" button → `TaskGroupTrace.tsx` stays the deep span view. The Timeline panel is the lightweight per-task chronology; it can show trace totals (duration/tokens/cost) inline from `task_traces` and link out for the full span tree.
- This is FE-only (composition of existing hooks/data) plus the small WS fix in §4.3.

### 4.3 Should task-groups join the LIVE `/activity` snapshot? — Yes, and the prerequisite WS fix

The current `/activity` snapshot (activity.ts) unions `PipelineController.getActiveRunIds()` ∪ `ConsensusController.getActiveRunIds()`. Task-groups are **not** represented because (a) `TaskOrchestrator` exposes no active-id accessor, and (b) a group is keyed by `task_groups.id`, not `pipeline_runs.id`, so the per-run ownership gate in both the route and the WS layer doesn't apply to it.

**Decision: add task-groups as a fifth Activity mode (`"task_group"`), for BOTH the live snapshot and the history tab.** Concretely:

- **Active-id accessor (small):** add `getActiveGroupIds(): string[]` to `TaskOrchestrator`, backed by the existing `activeGroupTraces` map keys (already the set of in-flight groups). Sibling of the controllers' `getActiveRunIds()`.
- **Ownership for groups is `task_groups.createdBy`**, not `pipeline_runs.triggeredBy`. So `/api/activity` must branch: for group ids, load `getTaskGroup(id)` and gate on `createdBy`; for the existing modes, keep the `pipeline_runs.triggeredBy` gate. Build a metadata-only `ActivityRun` with `mode: "task_group"`, `currentUnit` = the running/last task (label `Task N`, agent = `executionMode`, model = `task.modelSlug`, status = task status), `title: "Task group"` (NEVER `group.name` if names can carry user text — use a fixed label or the group's short id; see §6 note on `title`).
- **WS live deltas for groups (the §0.2 fix):** the WS subscribe gate (ws/manager.ts:86) must learn that a `runId` can be a **task-group id**. Add a fallback: if `getPipelineRun(runId)` is null, try `getTaskGroup(runId)` and gate on `createdBy`. This (i) fixes the currently-dead `TaskGroup.tsx` live stream and (ii) lets the Activity page subscribe to group ids it got from the (owner-scoped) snapshot. Then extend the client `mergeWsEvent` (lib/activity.ts:115) to fold `taskgroup:*` / `task:*` events onto a `task_group` row (additive; mirrors the existing `orchestrator:step` handling).

> **Scope guard:** the WS-gate fallback is a **small, security-relevant** change to a shared hardening path. It is its own task (§8, T3.1) with its own tests (group owner can subscribe; non-owner denied; unknown id denied; admin bypass; existing pipeline behaviour unchanged). If the Lead wants to minimise blast radius, the **live** task-group Activity row (and the `TaskGroup.tsx` live-stream fix) can ship **after** the rest; the durable Timeline (§4.2) and the **History tab** (§5) do NOT depend on it (they are DB-backed/poll-backed).

---

## 5. Feature (C) — Live-Activity History tab

### 5.1 Endpoint

```
GET /api/activity/history?limit=&cursor=&mode=
```
- **DB-backed** (NOT the in-memory registries — history is by definition not active). Returns PAST runs (terminal statuses) across all modes **including task-groups**, newest first.
- **Auth/scoping:** `requireAuth` (already on `/api/activity`, routes.ts:120). Per row: non-admin sees only their own (pipeline-family via `pipeline_runs.triggeredBy`; task-groups via `task_groups.createdBy`); admin sees all + `ownerId`. Reuse the `authorizeRun` ownership *predicate* logic (don't re-implement the 401/404/403 flow — history filters a list, it doesn't authorize a single run; factor the boolean `isVisible(ownerId, user)` out of `authorize-run.ts` so both share it).
- **Metadata-only:** `mode`, `title` (fixed label), `runStatus`, `startedAt`, `completedAt`, optional `current`/last-unit summary (enum-derived agent/model), `ownerId` (admin only), `workspaceId`. **NO `output`, no `decisionText`, no transcripts, no `summary`/`errorMessage` free-text, no task `input`.** (The per-group durable detail with summaries lives behind the owner-gated `GET :id` on the group page, §4.2 — not in the cross-user history list.)
- **Pagination (mandatory, no unbounded query):** `limit` default 25, **hard max 100** (clamp server-side). Keyset/cursor pagination ordered by `(completedAt desc, id desc)` — cursor encodes the last `(completedAt, id)`. Response: `{ items: ActivityHistoryRow[], nextCursor: string | null, isAdmin }`.

### 5.2 Storage — the one real query addition

No table changes, but the cross-mode "terminal runs, owner-scoped, paginated" read needs storage helpers (current storage has only `getPipelineRuns(pipelineId?)` — unfiltered, unpaginated, storage.ts:213). Add **paginated, status-filtered, owner-filtered** finders:
- `listPipelineRunHistory({ ownerId?, limit, cursor })` over `pipeline_runs` where `status IN (completed, failed, cancelled, rejected)` (covers pipeline/manager/orchestrator/consensus since all FK pipeline_runs). Mode is then classified per-row as today (`getConsensusRun`/`getOrchestratorRun`/manager-iterations/else pipeline — reuse the exact classification in activity.ts `buildActivityRun`, extracted into a shared `classifyRun` so live + history agree).
- `listTaskGroupHistory({ ownerId?, limit, cursor })` over `task_groups` where `status IN (completed, failed, cancelled)`.
- The route **merges** the two keyset streams by `completedAt` and applies the global `limit`/`cursor`. (Two ordered sources merged is fine at this scale; document the merge-cursor encoding. If the Lead prefers, v1 can paginate the two lists independently behind a `mode` filter and merge only the "All" view client-side — call this out as an open question, §7.4.)
- Indexes: `pipeline_runs(status, started_at)` and `task_groups(status, created_at)` may be warranted if these tables grow; flag as a follow-up (the tables are modest today).

### 5.3 Frontend — History tab on `Activity.tsx`

- Convert the `/activity` page header into a **tabbed** view: **"Live"** (the existing snapshot view, unchanged) | **"History"** (new). Reuse the `@/components/ui` tabs (compound `Tabs` pattern) — keep the tab in **URL state** (e.g. `?tab=history`) so it's shareable/back-button friendly (per web patterns: URL as state).
- **Reuse the row rendering.** The History table reuses the same column model + `StatusPill` from `Activity.tsx` (lines 38-145). `RunRow`/`StatusPill`/`GroupTable` already live in the page; factor the row + status pill into small shared components so both tabs use them. History adds a **Completed** column and drops the live pulse.
- **Pagination UI:** "Load more" (cursor) — no infinite unbounded fetch; a `useActivityHistory` hook does `useInfiniteQuery` (TanStack) keyed by `["/api/activity/history", mode]`, passing `nextCursor`. Empty/loading/error states reuse `CenteredState` (Activity.tsx:64).
- Task-groups appear as a fifth group/section (`mode: "task_group"`, label e.g. "Task groups"). Extend `ACTIVITY_MODE_ORDER`/`ACTIVITY_MODE_LABELS` (lib/activity.ts:27-40) and the `ActivityMode` union (types.ts:3095) to include `"task_group"`.
- Each history row for a task-group **links to** `/task-groups/:id` (its detail/Timeline). Pipeline-family rows can link to their existing run views.

---

## 6. Security (consolidated)

| Concern | Decision |
|---|---|
| **Edit endpoints owner-gating** | New `authorizeTaskGroup` (keyed `task_groups.createdBy`): 401→404→403, admin bypass, **ownerless denied to non-admins**. Applied to ALL task-group routes (incl. retro-fitting the existing un-gated GET/start/cancel/delete/retry — closes §7.1). |
| **Editable-only-when-pending** | Server-authoritative 409 when mutating tasks/`input` on a non-`pending` group; only `name`/`description` editable post-terminal. UI mirrors but does not enforce. |
| **dependsOn integrity** | Pure `validateTaskGraph` rejects dangling refs, self-deps, cycles before persist (§3.3). taskId tampering blocked (task must belong to the path's group → else 404). |
| **History endpoint scoping** | Per-row owner filter (pipeline-family: `triggeredBy`; groups: `createdBy`); admin sees all + `ownerId`. Shared `isVisible` predicate with `authorize-run.ts`. |
| **Metadata-only (history + live)** | NO output/decisionText/transcripts/free-text summary/task input in any cross-user Activity payload. Only ids, enum-derived agent/model/phase, status, timestamps, workspaceId, mode. The live `activity.ts` already enforces this; the history endpoint follows the same rule. `title` for task-groups uses a **fixed label or short id**, not `group.name` (names are user free-text and could leak across the admin view) — OR scrub via `scrubAndTruncate` if a name is shown; **recommend the fixed-label/short-id approach** to avoid any leak vector. |
| **Pagination cap** | `limit` clamped to max 100 server-side; keyset cursor; never an unbounded `SELECT *`. |
| **WS subscribe (task-group fallback)** | The new `getTaskGroup` fallback in `authorizeAndSubscribe` is itself owner-gated (`createdBy`), fails closed on unknown id — does NOT widen the existing posture, it extends the same ownership rule to a second id space. |
| **Error envelope** | New routes return generic errors via the `ApiResponse` envelope (no `String(err)` leakage); the existing `String(err)` task-group handlers should be tightened in the same pass. |

---

## 7. Risks & Open Questions (for the Lead)

1. **(BLOCKER to ship-A) Pre-existing IDOR on all task-group routes (§0.1).** New edit mutations cannot ship without owner-gating, and shipping them gated while leaving GET/start/cancel/delete un-gated is inconsistent and still-exploitable. **Recommend: close the whole route file's gating in this change** (T1.1). Confirm.
2. **(Affects B-live + the TaskGroup live stream) Task-group WS is dead today (§0.2).** The WS subscribe gate fails closed for `task_groups.id`. **Recommend: add the `getTaskGroup`/`createdBy` fallback** (T3.1) — it both fixes the existing broken `TaskGroup.tsx` stream and enables live task-group rows in `/activity`. Acceptable to land **after** the DB-backed History + durable Timeline (which don't depend on it). Confirm sequencing.
3. **Post-terminal editability of name/description.** I allow relabelling `name`/`description` on finished groups (everything else 409). Alternative: lock everything once started (simpler, stricter). Confirm which.
4. **History pagination across two sources.** Merging two keyset streams (`pipeline_runs` + `task_groups`) by `completedAt` under one global cursor is the clean "All" view but adds cursor complexity. Simpler v1: paginate per `mode` and only merge the "All" tab client-side from the first page of each. Confirm appetite (recommend the merged keyset; fall back to per-mode if time-boxed).
5. **`deleteTask` storage method (§1).** Removing a task in edit mode needs a new hard-delete `IStorage.deleteTask` (none exists; group cascade only fires on group delete). Additive to `MemStorage` + `PgStorage`. Confirm acceptable (it is the only storage-surface addition; **no schema/migration**).
6. **"Task group" as a fifth Activity mode.** Extends the `ActivityMode` union + the page's mode grouping. Confirm task-groups should sit in the **same** `/activity` surface (recommended — one observability lens) vs. only on their own pages.
7. **Concurrency/perf of History.** Keyset + `limit ≤ 100` bounds it; classification does O(rows) `get*` lookups per page (same pattern as live `buildActivityRun`). If `pipeline_runs`/`task_groups` grow large, add the status/time indexes (§5.2). Lead to set expected history volume.

---

## 8. Task Breakdown (ordered, file-owned, small units)

> Standards on every code task: TDD ≥80% new modules, no `any` (narrow `unknown`), reuse-first, a11y, owner/admin scoping, metadata-only history, edit-guard, pagination cap. Server on host (`make dev`), never Docker. Feature branch + PR, no AI mentions.

### Phase 0 — Shared contract + storage primitives (BE; blocks most)
- **T0.1 (BE)** — Extend `ActivityMode` to include `"task_group"`; add `ActivityHistoryRow` + `ActivityHistoryPage` types to `shared/types.ts`. *Owns:* `shared/types.ts`.
- **T0.2 (BE)** — Add `IStorage.deleteTask(id)` + implement on `MemStorage` (`server/storage.ts`) and `PgStorage` (`server/storage-pg.ts`). *Owns:* those three. **TDD:** delete removes the row; group cascade unaffected.
- **T0.3 (BE)** — Add `listPipelineRunHistory` + `listTaskGroupHistory` (status-filtered, owner-optional, keyset-paginated) to `IStorage` + both impls. *Owns:* `storage.ts`, `storage-pg.ts`. **TDD:** terminal-only; owner filter; cursor ordering; limit clamp.

### Phase 1 — Edit (A) backend (Security-first)
- **T1.1 (Security/BE)** — `server/routes/authorize-task-group.ts` (`authorizeTaskGroup` keyed on `createdBy`; reuse the `isVisible` predicate extracted from `authorize-run.ts`). Retrofit it onto the existing GET/start/cancel/delete/retry handlers in `server/routes/task-groups.ts` (closes §7.1). *Owns:* new file + `task-groups.ts` (gating lines + error-envelope tightening). **TDD:** 401/404/403/owner/admin/ownerless on each verb.
- **T1.2 (BE)** — Pure `server/services/task-graph.ts` (`validateTaskGraph`: dangling/self/cycle). *Owns:* new file. **TDD:** table over valid DAGs, self-dep, 2- and 3-node cycles, dangling id.
- **T1.3 (BE)** — Edit orchestration in `TaskOrchestrator` (or `TaskGroupEditor`): `updateGroup`, `updateTask`, `addTask`, `removeTask` (delete + strip siblings' `dependsOn` + re-derive ready/blocked), all enforcing the pending-only rule + `validateTaskGraph`. *Owns:* `server/services/task-orchestrator.ts` (+ maybe a small new collaborator). **TDD:** pending-only 409 paths; dependsOn rewrite on remove; status recompute; cross-group taskId rejected.
- **T1.4 (BE)** — Routes: `PATCH /api/task-groups/:id`, `PATCH …/tasks/:taskId`, `POST …/tasks`, `DELETE …/tasks/:taskId` in `task-groups.ts`, each `authorizeTaskGroup` → `validateBody` → delegate to T1.3, `ApiResponse` envelope, 409 on guard. *Owns:* `task-groups.ts`. **TDD (integration):** happy edit on pending; 409 on running/completed (input + tasks); name/desc allowed post-terminal; owner-scoping; no cross-group leak.

### Phase 2 — Activity History (C) backend
- **T2.1 (BE)** — Extract `classifyRun` (mode + current-unit builder) from `activity.ts` `buildActivityRun` into a shared module so live + history agree; add a `task_group` classifier. *Owns:* `server/routes/activity.ts` (+ small shared helper). **TDD:** each mode incl. task_group classified.
- **T2.2 (BE)** — `GET /api/activity/history` in `server/routes/activity.ts` (or a sibling `activity-history.ts`): merge the two history finders, owner/admin filter via `isVisible`, metadata-only, `limit ≤ 100`, keyset cursor; register under the existing `/api/activity` requireAuth prefix. *Owns:* the route file + one line in `routes.ts` if a new file. **TDD (integration):** 401; non-admin sees only own (both id-spaces); admin sees all + ownerId; terminal-only; **no output/transcript/free-text field present** (explicit assertion); cursor paginates; limit clamps.

### Phase 3 — WS task-group enablement (Security; can trail)
- **T3.1 (Security/BE)** — `authorizeAndSubscribe` fallback: null `pipeline_runs` → try `getTaskGroup`, gate on `createdBy`, fail closed. *Owns:* `server/ws/manager.ts`. **TDD:** group owner subscribes; non-owner denied; unknown id denied; admin bypass; existing pipeline path unchanged.
- **T3.2 (BE)** — Add `getActiveGroupIds()` to `TaskOrchestrator`; include task-group ids (gated on `createdBy`) in the LIVE `/api/activity` snapshot as `mode: "task_group"`. *Owns:* `task-orchestrator.ts`, `activity.ts`. **TDD:** active group appears for owner only; metadata-only.

### Phase 4 — Frontend
- **T4.1 (FE)** — Extract the create-form pieces (`TaskRow`, `emptyTask`, `validate`, `hasErrors`, `TaskDraft`/`GroupDraft`) into `client/src/components/task-groups/task-form.tsx` (+ types); generalise `TaskRow` to toggle `dependsOn` by **id** with name display; rewire `CreateTaskGroup.tsx` to import them (behaviour-preserving). *Owns:* new files + `CreateTaskGroup.tsx`. **TDD/visual:** create flow unchanged.
- **T4.2 (FE)** — Edit mode on `client/src/pages/TaskGroup.tsx` (Edit button gated by status; reuse shared form; full edit when `pending`, name/desc-only when terminal) + new mutation hooks in `client/src/hooks/use-task-groups.ts` (`useUpdateTaskGroup`/`useUpdateTask`/`useAddTask`/`useDeleteTask`). *Owns:* `TaskGroup.tsx`, `use-task-groups.ts`.
- **T4.3 (FE)** — Timeline panel on `TaskGroup.tsx` (durable per-task chronology from rows + trace totals; reuse `StatusBadge`; link to existing Trace). *Owns:* `TaskGroup.tsx` (+ a small `TaskGroupTimeline` component). Extend `mergeWsEvent` (lib/activity.ts) + `use-task-events` consumption only if T3 landed.
- **T4.4 (FE)** — History tab on `client/src/pages/Activity.tsx`: tabbed Live|History (URL state), `useActivityHistory` infinite-query hook, reuse row/StatusPill, task_group section, "Load more", link group rows to `/task-groups/:id`. Extend `ACTIVITY_MODE_ORDER`/`LABELS` (lib/activity.ts). *Owns:* `Activity.tsx`, new hook, `lib/activity.ts`.

### Phase 5 — QA
- **T5.1 (QA/E2E)** — Playwright: (A) create a pending group → edit name + add/remove task + change dependsOn → save → reflected; start it → edit blocked (409 surfaced). (B) finished group shows Timeline + Trace; reload preserves timeline. (C) `/activity` History tab lists a completed group + a completed pipeline run; second user doesn't see another's; admin sees both + owner. *Owns:* `tests/e2e/task-groups-edit-history.spec.ts`.
- **T5.2 (QA)** — ≥80% coverage on new modules (`authorize-task-group`, `task-graph`, edit orchestration, history finders, history route, the FE hooks/shared form); a11y pass on edit mode + History tab (keyboard, labels, reduced-motion, contrast).

**Ordering:** T0.* → Phase 1 (T1.1 first — security) → Phase 2 → Phase 4 FE in parallel after its BE dep lands → Phase 3 (may trail; only the live task-group row + TaskGroup live stream depend on it) → Phase 5. The durable Timeline (T4.3) and History (T2.2/T4.4) do NOT block on Phase 3.

---

## 9. Reuse Inventory (no reinvention)

| Need | Reused symbol / file |
|------|----------------------|
| Group ownership | `task_groups.createdBy` (schema.ts:1095) — NOT `pipeline_runs.triggeredBy` |
| Pipeline-family ownership (history) | `pipeline_runs.triggeredBy` (schema.ts:152) |
| AuthZ predicate | `isVisible` extracted from `server/routes/authorize-run.ts` |
| Pending-only precedent | `startGroup` guard (task-orchestrator.ts:122) |
| Validation middleware + bounds | `validateBody` (`server/middleware/validate.ts:13`) + `CreateTaskGroupSchema` bounds (task-groups.ts:9-29) |
| Run classification (live=history parity) | `buildActivityRun` → extracted `classifyRun` (`server/routes/activity.ts:150`) |
| Active-id accessor pattern | `PipelineController.getActiveRunIds` / `ConsensusController.getActiveRunIds` |
| Trace view | `TaskGroupTrace.tsx` + `use-task-trace.ts` (unchanged) |
| Create-form controls | `TaskRow`/`emptyTask`/`validate`/`TaskDraft` (`CreateTaskGroup.tsx:21-201`) → shared module |
| Task-group mutation hooks | `use-task-groups.ts` (extend with edit hooks) |
| Live WS event log | `use-task-events.ts` (`taskgroup:*`/`task:*` already mapped) |
| Activity row + status pill | `RunRow`/`StatusPill`/`GroupTable` (`Activity.tsx:38-194`) |
| Activity merge + grouping | `mergeWsEvent`/`groupByMode`/`ACTIVITY_MODE_*` (`lib/activity.ts`) |
| WS subscribe ownership gate | `WsManager.authorizeAndSubscribe` (`ws/manager.ts:86`) — extend with group fallback |
| Pagination | TanStack `useInfiniteQuery`; keyset cursor (no offset) |
| API envelope | `ApiResponse<T>` (project patterns) |
