# Consilium Loop — Design Doc

> Status: **PROPOSED** (plan-first; awaiting Lead approval before any code).
> Author: solution-architect. Date: 2026-06-22.
> Scope: A1 (judge convergence signal) → A2 (diff-context builder) → B (loop controller FSM) → C (Omniscience run plan, plan-only).

An **auto-versioned closed loop**: design-idea → multi-model debate (consilium) → development → re-review, until convergence. It automates what we ran by hand 3× on the Omniscience repo. It sits *on top of* the existing task-groups-v2 orchestrator — it adds a controller, a judge-output delta, and a context builder; it does **not** rewrite the orchestrator.

---

## 1. Grounding — what already exists (cited)

| Capability | Where | Reuse |
|---|---|---|
| Run a consilium iteration (N debaters + judge, DAG, fan-in) | `server/services/task-orchestrator.ts` `startGroup` (L261), `createIterationWithExecutions` | **REUSE as-is.** The loop calls `startGroup` per round. |
| The "Overall objective" fed to every task | `server/services/orchestrator/direct-llm-prompt.ts:39` (`iteration.input`), seeded from `group.input` (`task-orchestrator.ts:287`) | A2 writes this string. |
| Judge output `{verdict, pros, cons, action_points[]}` | parsed generically by `parseDirectLlmResponse` (`direct-llm-prompt.ts:125`); the judge *task description* is **authored per-group, not seeded** (confirmed — no judge constant exists) | A1 extends the parse + ships a canonical judge description constant. |
| Action-points → pipeline handoff (DEV step) | `client/.../verdict-panel.tsx:174` `sendToPipeline` → `POST /api/task-groups` with `executionMode:"pipeline_run"` | B's DEV step reuses this exact mechanism server-side. |
| HITL pause/resume for human approval | `server/controller/pipeline-controller.ts` `resumeRun` (L1119), `approveStage` (L528), status `paused`/`awaiting_approval` | The merge gate maps onto a pause. |
| Pipeline run lifecycle | `startRun(pipelineId, input, …): Promise<PipelineRun>` (L104), statuses `running|completed|failed|cancelled|paused|rejected`, `getActiveRunIds()` (L1386) | B polls run status the same way the orchestrator does (`pollRunCompletion`, `task-orchestrator.ts:571`). |
| Persisted FSM-with-status pattern | `orchestratorRuns` table (`shared/schema.ts:751`) — status enum, `output jsonb`, `error`, `*_approved_at/by`, `unique(run_id)` | **Mirror this table shape** for loop state. |
| Safe git access | `server/config-sync/git-wrapper.ts` — `simple-git` (arg-array API, **no shell strings**), never-throws, `GitResult<T>` discriminator | A2 reuses this pattern; `simple-git` is already a dep (`package.json:98`). |
| Config the project's way | `server/config/schema.ts` (zod, `pipeline.taskGroups.*`, L284) + `loader.ts` `ENV_MAPPINGS` (L185) | New `pipeline.consiliumLoop.*` block + env mappings. |
| Re-trigger after an external event | triggers subsystem: `triggers` table (`schema.ts:677`), `cron-scheduler.ts`, `webhooks.ts`; `fireTrigger` currently only logs (`routes.ts:285`) | Merge-gate re-trigger = a poller OR a `github_event`/webhook into a loop-resume endpoint. |
| Dual storage impls | `PgStorage implements IStorage` (`storage-pg.ts:138`) + `MemStorage` (`storage.ts:645`); migrations via `drizzle-kit push` (`package.json:12`), schema-first in `shared/schema.ts` | New table + storage methods land in **both** impls. |

---

## 2. Architecture (ASCII)

```
                         ┌──────────────────────────────────────────────────────┐
                         │            ConsiliumLoopController (FSM)              │
                         │  persisted: consilium_loops + consilium_loop_rounds   │
                         └──────────────────────────────────────────────────────┘
   POST /api/consilium-loops (create)          │ tick() — single-flight, idempotent
   POST /:id/start  ──────────────────────────▶│
   POST /:id/merge-approved (HITL gate) ──────▶│
   POST /:id/cancel                            │
                                               ▼
   ┌─────────┐   build input (A2)      ┌──────────────┐  startGroup()   ┌────────────────────┐
   │ BUILD_  │──────────────────────▶ │   REVIEW     │───────────────▶ │ task-orchestrator  │
   │ CONTEXT │  git diff <last>..HEAD  │ (consilium   │   (REUSE)       │  N debaters+judge  │
   │  (A2)   │  + test-results summary │  iteration n)│                 └─────────┬──────────┘
   └─────────┘                         └──────────────┘                           │ judge exec.output
        ▲                                     │                                   ▼
        │ on merge                            │ readConvergence(judge.output)  ┌──────────┐
        │                                     ▼                                │ A1 verdict│
   ┌─────────────┐  human clicks      ┌───────────────┐  converged||n==cap?   │ converged │
   │ AWAIT_MERGE │◀── Draft PR ◀──────│   DECIDE      │◀──────────────────────│ open_p0   │
   │  (HITL gate)│    pipeline_run    └───────┬───────┘                        │ open_aps[]│
   └─────────────┘         ▲                  │ NO                             └──────────┘
        │ approved          │ action_points    ▼
        ▼                   │ (verdict-panel   ┌──────┐  anti-stall: open_p0 flat ×2 → ESCALATED
   (loop n+1)               └─ handoff reuse)  │ DEV  │  cap hit → STOPPED_CAP
                                               └──────┘  clean verdict → CONVERGED
```

Terminal states: `CONVERGED` (clean), `STOPPED_CAP` (n==6), `ESCALATED` (anti-stall), `FAILED`, `CANCELLED`.

---

## 3. FSM — states & transitions

State machine lives in `ConsiliumLoopController`. State is **persisted** (survives restart); `tick()` is a pure-ish reducer that reads persisted state and drives exactly one transition, then returns. The controller never blocks on long work inside a transition — long work (a consilium round, a DEV pipeline) runs as the existing async orchestrator/controller jobs, and `tick()` re-checks their status.

| From | Event / guard | To | Action |
|---|---|---|---|
| `PENDING` | `start` | `BUILDING_CONTEXT` (round 1 special-cases to seed input only) | — |
| `BUILDING_CONTEXT` | A2 returns input string | `REVIEWING` | `startGroup(targetGroupId)` → store `currentIterationNumber` |
| `REVIEWING` | orchestrator iteration `status==completed` | `DECIDING` | read judge exec → A1 `readConvergence` |
| `REVIEWING` | iteration `status==failed/cancelled` | `FAILED` | record error |
| `DECIDING` | `converged===true` | `CONVERGED` ✅ | terminal |
| `DECIDING` | `round >= cap (6)` | `STOPPED_CAP` ✅ | terminal |
| `DECIDING` | anti-stall: `open_p0` not decreased for 2 consecutive rounds | `ESCALATED` ✅ | notify human |
| `DECIDING` | else (open P0s remain, room left) | `DEVELOPING` | hand off open action_points → pipeline_run group (verdict-panel mechanism) |
| `DEVELOPING` | DEV group completes (Draft PR opened) | `AWAITING_MERGE` 🔸HITL | store PR ref + `headCommitAtReview` |
| `AWAITING_MERGE` | `POST /:id/merge-approved` (human) | `BUILDING_CONTEXT` (round+1) | set `lastReviewedCommit = merged HEAD` |
| `AWAITING_MERGE` | `cancel` | `CANCELLED` | terminal |
| any non-terminal | `cancel` | `CANCELLED` | cancel child group/run |

**Round counter**: `round` increments on entering `REVIEWING`; cap compared in `DECIDING` so round 6's verdict is still honored (a clean v6 wins over the cap).

**Anti-stall**: persist `open_p0` per round in `consilium_loop_rounds`. In `DECIDING`, if `round>=3` and `p0[n] >= p0[n-1] >= p0[n-2]` (no decrease across 2 transitions) → `ESCALATED`. (Strictly: "did not decrease for 2 consecutive rounds".)

---

## 4. Data model (new tables + migration approach)

Schema-first in `shared/schema.ts`, applied via `npm run db:push` (drizzle-kit, the repo's convention — no hand-written SQL migration needed; mirrors how `taskGroups`/`orchestratorRuns` were added). Add to **both** `PgStorage` and `MemStorage`.

### 4.1 `consilium_loops` (the FSM head — mirrors `orchestratorRuns`)

```ts
export const CONSILIUM_LOOP_STATES = [
  "pending","building_context","reviewing","deciding","developing",
  "awaiting_merge","converged","stopped_cap","escalated","failed","cancelled",
] as const;
export type ConsiliumLoopState = typeof CONSILIUM_LOOP_STATES[number];

export const consiliumLoops = pgTable("consilium_loops", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  groupId: varchar("group_id").notNull()           // the consilium task group re-run each round
    .references(() => taskGroups.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("pending").$type<ConsiliumLoopState>(),
  round: integer("round").notNull().default(0),
  maxRounds: integer("max_rounds").notNull().default(6),
  repoPath: text("repo_path").notNull(),           // allowlisted target repo (validated, see §7)
  lastReviewedCommit: text("last_reviewed_commit"),// diff baseline; null on round 1
  currentIterationNumber: integer("current_iteration_number"),
  devPipelineId: varchar("dev_pipeline_id"),       // pipeline used for the DEV step
  devGroupId: varchar("dev_group_id"),             // the spawned pipeline_run handoff group
  prRef: text("pr_ref"),                           // Draft PR url/number (set in AWAITING_MERGE)
  openP0: integer("open_p0"),                       // latest convergence count (anti-stall mirror)
  error: text("error"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (t) => ({
  groupIdIdx: index("consilium_loops_group_id_idx").on(t.groupId),
  createdByIdx: index("consilium_loops_created_by_idx").on(t.createdBy),
}));
```

### 4.2 `consilium_loop_rounds` (per-round audit + anti-stall history)

```ts
export const consiliumLoopRounds = pgTable("consilium_loop_rounds", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  loopId: varchar("loop_id").notNull()
    .references(() => consiliumLoops.id, { onDelete: "cascade" }),
  round: integer("round").notNull(),
  iterationNumber: integer("iteration_number").notNull(), // FK-by-value to task_group_iterations
  converged: boolean("converged"),
  openP0: integer("open_p0"),
  openActionPoints: jsonb("open_action_points").$type<ActionPoint[]>(),
  baselineCommit: text("baseline_commit"),  // <last-reviewed> used to build this round's input
  headCommit: text("head_commit"),          // HEAD at build time
  testSummary: text("test_summary"),         // bounded summary fed into the input
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  loopRoundUnique: unique("consilium_loop_rounds_uq").on(t.loopId, t.round),
}));
```

Persisting `round`+`state`+`openP0` history is what makes the loop **restart-safe** and the anti-stall rule deterministic. No new state outside Postgres.

---

## 5. A1 — Judge convergence signal (exact delta)

**Goal:** the judge emits a machine-readable convergence verdict so the FSM decides deterministically instead of parsing prose.

### 5.1 New judge `output` fields (additive — backward compatible)

The judge JSON gains a `convergence` object alongside the existing fields:

```jsonc
"output": {
  "raw": "…", "verdict": "…", "pros": [...], "cons": [...],
  "action_points": [ {title, priority, effort, rationale, tradeoff} ],
  "convergence": {                 // NEW
    "converged": false,            // true ⟺ no P0 action points remain
    "open_p0": 3,                  // count of still-open P0 action points
    "open_action_points": [        // the still-open subset (the loop's DEV input)
      { "title": "...", "priority": "P0", ... }
    ]
  }
}
```

### 5.2 Code delta

- **NEW** `server/services/orchestrator/convergence.ts` — a pure module (unit-testable, no storage):
  - `interface ConvergenceVerdict { converged: boolean; openP0: number; openActionPoints: ActionPoint[]; }`
  - `export function readConvergence(judgeOutput: unknown): ConvergenceVerdict` — defensive:
    1. If `output.convergence` is present and well-typed → trust it (narrow with a small zod schema or hand guards; **no `any`**).
    2. **Fallback (resilience)** if the model omitted it: derive from `action_points` — `openActionPoints = aps.filter(priority==="P0")`, `open_p0 = that.length`, `converged = open_p0 === 0`. This means A1 works even against an *unmodified* judge that still emits action_points (important for the Omniscience group at v3, §C).
  - Mirrors the existing `extractVerdict` narrowing in `verdict-panel.tsx:54` — reuse the same `ActionPoint` shape (lift it to `@shared/types` so client+server share it).
- **EDIT** `direct-llm-prompt.ts` `parseDirectLlmResponse` (L125): currently it copies `output` through generically — `convergence` already survives untouched (it's inside `parsed.output`). **No change required to the parser** beyond optionally validating the nested object; the loop calls `readConvergence` on the persisted `execution.output`, not on the raw string. Keep the parser change to zero to avoid regressing the 4958-test suite.
- **NEW** `server/services/orchestrator/judge-prompt.ts` — export `JUDGE_CONVERGENCE_INSTRUCTIONS` constant: the canonical addition to a judge task's `description` instructing it to also emit the `convergence` object with the rule "*converged ⟺ zero P0 action points; list every still-open action point*". The loop's create path appends this to the judge task description so authored groups get the machine signal without hand-editing.

### 5.3 Where the priority taxonomy lives

`P0..P3` already exists client-side (`PRIORITY_COLOR`, `verdict-panel.tsx:87`). Lift `P0` as the convergence-blocking tier into a shared constant so A1, the judge prompt, and the UI agree.

---

## 6. A2 — Diff-context builder (interface)

**NEW** `server/services/consilium/diff-context.ts`. Pure-ish (depends only on `simple-git` + injected test-results), never throws (returns a result), bounded output.

```ts
export interface DiffContextRequest {
  repoPath: string;            // MUST be pre-validated against the allowlist (caller)
  baselineCommit: string | null; // <last-reviewed>; null ⇒ first round (no diff, objective only)
  objective: string;          // the standing design-idea / group.input header
  testSummary?: string;       // bounded summary of the last DEV run's test results
}
export interface DiffContextResult {
  ok: true;
  input: string;              // the assembled "Overall objective" string → iteration.input
  headCommit: string;
  baselineCommit: string | null;
  truncated: boolean;
} // | { ok: false; errorKind: GitErrorKind; message: string }  (reuse git-wrapper kinds)

export async function buildDiffContext(req: DiffContextRequest): Promise<DiffContextResult | GitFail>;
```

Internals (each helper <30 lines):
- `resolveHead(git)` → `git.revparse(["HEAD"])`.
- `collectDiff(git, baseline, head)` → `git.diff([`${baseline}..${head}`, "--stat"])` for the file-level summary **plus** a bounded unified diff `git.diff([`${baseline}..${head}`])` truncated to `maxDiffBytes` (config). **simple-git passes args as an array — no shell, no injection** (the whole reason we reuse `git-wrapper.ts`'s approach rather than `child_process` string exec).
- `assembleInput(objective, statText, diffText, testSummary, truncated)` → composes the markdown string that becomes `iteration.input` (the "Overall objective" every debater + the judge sees, `direct-llm-prompt.ts:39`). Includes a `## Changes since last review` section + `## Test results` section.
- Round 1: `baselineCommit===null` ⇒ skip the diff, input is just the objective (matches today's manual v1).

Test-results summary: A2 **does not run tests** — it consumes a `testSummary` string the DEV pipeline produces (the test seam, §9). Keeps A2 deterministic and unit-testable with a fake git.

---

## 7. B — Loop Controller API surface

**NEW** `server/services/consilium/consilium-loop-controller.ts` (the FSM) + **NEW** `server/routes/consilium-loops.ts` (HTTP). Wired in `routes.ts` next to `registerTaskGroupRoutes` (L246), sharing `storage` + `taskOrchestrator` + `pipelineController`.

New routes (all owner-scoped; mirror `authorizeTaskGroup` → a new `authorizeConsiliumLoop` that owner-checks the loop **and** its `groupId`):

| Method · Path | Purpose | Notes |
|---|---|---|
| `POST /api/consilium-loops` | Create a loop over an existing consilium `groupId` + `repoPath` + `devPipelineId` | Validates `repoPath` against allowlist; stamps `createdBy`. 201. |
| `GET /api/consilium-loops` | List caller's loops (owner-scoped, metadata only) | mirrors task-groups list (L105). |
| `GET /api/consilium-loops/:id` | Loop detail + rounds | gated. |
| `POST /api/consilium-loops/:id/start` | Begin round 1 (PENDING→BUILDING_CONTEXT) | 409 if not PENDING. |
| `POST /api/consilium-loops/:id/merge-approved` | **HITL gate**: human confirms PR merged → resume into round n+1 | the only manual step (req §3). Records merged HEAD as next baseline. |
| `POST /api/consilium-loops/:id/cancel` | Cancel + cascade-cancel child group/run | gated. |

**Driving the FSM (`tick`)**: a single-flight `tick(loopId)` advances one transition. Two trigger sources, both allowed:
1. **Event-driven** (preferred, low-latency): orchestrator already broadcasts `taskgroup:completed` (`task-orchestrator.ts:784`); the controller subscribes and calls `tick` when the loop's `currentIterationNumber` settles. Same for the DEV pipeline run.
2. **Poller backstop** (restart-safety): a lightweight interval (mirrors `cron-scheduler.ts` bootstrap) calls `tick` on every non-terminal loop every `pollIntervalMs`. Idempotent because `tick` reads persisted `state` and is single-flight per `loopId` (an in-memory `Set<loopId>` claim, same idea as `ExecutionClaims`).

The `merge-approved` HITL gate lives **here** (a route → `tick`), *not* inside the pipeline controller's `awaiting_approval` (that's per-stage). Rationale: the merge is an action on the *repo/PR* outside multiqlti; the cleanest signal is an explicit human POST (or a `github_event` PR-merged trigger wired to the same endpoint — §1 triggers reuse). The DEV pipeline's own internal approvals stay where they are.

---

## 8. Config additions (the project's way)

`server/config/schema.ts` — new block under `pipeline` (sibling of `taskGroups`, L284):

```ts
consiliumLoop: z.object({
  enabled: z.boolean().default(false),                                  // kill-switch
  maxRounds: z.coerce.number().int().min(1).max(6).default(6),          // hard cap (req §1)
  pollIntervalMs: z.coerce.number().int().min(1000).max(60_000).default(5000),
  maxDiffBytes: z.coerce.number().int().min(1024).max(2_000_000).default(200_000), // bound A2
  allowedRepoPaths: z.array(z.string()).default([]),                    // allowlist (req: repo-path allowlisting)
  devPipelineId: z.string().optional(),                                 // default DEV pipeline
}).default({}),
```

`server/config/loader.ts` — add `ENV_MAPPINGS` entries (L185): `CONSILIUM_LOOP_ENABLED`(boolean), `CONSILIUM_LOOP_MAX_ROUNDS`(number), `CONSILIUM_LOOP_POLL_INTERVAL_MS`(number), `CONSILIUM_LOOP_MAX_DIFF_BYTES`(number). (`allowedRepoPaths` via `config.yaml` only — arrays aren't env-mapped here, matching the existing pattern.)

---

## 9. Test strategy seam (for QA)

Pure / unit-testable (no DB, no network) — the deliberate seams:
- **A1 `readConvergence`** (`convergence.ts`): table-driven — clean verdict (0 P0 → converged), P0s present, missing `convergence` object (fallback path), malformed input. No model call.
- **A2 `buildDiffContext`**: inject a **fake `simple-git`** (or a tmp git repo fixture) — assert input assembly, byte-bounding/`truncated` flag, round-1 (null baseline) path, git-failure → `GitFail`. No real repo needed for unit; one integration fixture repo for the real-git path.
- **B FSM transitions**: the controller's `reduce(state, event) → nextState` is a pure function over persisted fields — test every row in §3's table, especially `cap`, `anti-stall` (open_p0 flat ×2 → ESCALATED), and `converged` precedence over cap at round 6. Drive with a fake storage + fake orchestrator (assert it *calls* `startGroup`, doesn't really run it).
- **DEV step**: assert the handoff payload shape matches `verdict-panel.tsx:187` (one `pipeline_run` task per open action point).

Test seam for the (TBD) DEV test specifics: the DEV pipeline returns a `testSummary` string in its run `output`; A2 consumes it as an opaque bounded string. So **what** tests run is a pipeline concern, decoupled from the loop — no hardcoding.

---

## 10. Security considerations

1. **Git/shell execution safety (A2)** — **Do NOT `child_process` a `git diff <interpolated>` string.** Reuse the `simple-git` arg-array API like `git-wrapper.ts`; commit refs go in as array elements, never concatenated into a shell command. Validate `baselineCommit`/HEAD as 7–64-char hex (or a `git rev-parse --verify` round-trip) before use. Bound output to `maxDiffBytes` to prevent memory blowups from a huge diff.
2. **Repo-path allowlisting** — `repoPath` MUST be in `config.consiliumLoop.allowedRepoPaths`; resolve + `realpath` and assert it's a prefix of an allowed root (defeat `../` traversal), reject symlinks escaping the root. Same defense-in-depth posture as `file-watcher.ts`'s `WATCH_BASE_PATH` + denylist.
3. **Authz on new routes** — every `/api/consilium-loops/*` route owner-scoped via `authorizeConsiliumLoop` (byte-mirror of `authorize-task-group.ts`), cross-owner → 404, list returns metadata-only (no `repoPath` leak to non-admins beyond owner). `merge-approved` requires the owner (and ideally `maintainer`/`admin`, mirroring trigger routes `routes.ts:240`).
4. **Runaway/cost controls** — hard `maxRounds` cap (6) enforced in `DECIDING`; the existing `taskGroups.maxIterationsPerGroup` cap (`schema.ts:292`) is a second backstop on the group itself; per-task `taskTimeoutMs` already bounds each debate call. `enabled` kill-switch. Anti-stall escalation prevents 6 wasted rounds. The DEV pipeline inherits the pipeline controller's existing token/timeout caps.
5. **No secrets** — the loop never logs the diff body at info level; `repoPath` + commit shas only. No credentials in `consilium_loops` rows.
6. **Merge gate integrity** — `merge-approved` records the *current* HEAD as the next baseline server-side; never trust a client-supplied commit sha (prevents replaying an old diff).

---

## 11. Phased implementation plan (A → B → C)

Sizing: each task is a discrete PR-able unit for a backend engineer. **[NEW]** = new file, **[EDIT]** = modify. Functions <30 lines, no `any`, narrow external input with zod/guards, both storage impls.

### Phase A1 — Judge convergence signal
- A1.1 **[EDIT]** `shared/types.ts` — lift `ActionPoint` + add `ConvergenceVerdict` interface (shared client/server). Add `P0` priority constant.
- A1.2 **[NEW]** `server/services/orchestrator/convergence.ts` — `readConvergence(judgeOutput): ConvergenceVerdict` with trust-then-derive fallback. Pure.
- A1.3 **[NEW]** `server/services/orchestrator/judge-prompt.ts` — `JUDGE_CONVERGENCE_INSTRUCTIONS` constant.
- A1.4 **[EDIT]** `client/.../verdict-panel.tsx` — import shared `ActionPoint`; optionally surface `convergence.open_p0` as a badge (read-only).
- A1.5 **[NEW]** `tests/unit/orchestrator/convergence.test.ts` — table-driven (§9).

### Phase A2 — Diff-context builder
- A2.1 **[NEW]** `server/services/consilium/diff-context.ts` — `buildDiffContext` + helpers, `simple-git`, bounded, never-throw `GitResult`.
- A2.2 **[NEW]** `server/services/consilium/repo-allowlist.ts` — `assertAllowedRepoPath(repoPath, config)` (realpath + prefix check).
- A2.3 **[EDIT]** `server/config/schema.ts` + `loader.ts` — `pipeline.consiliumLoop.*` block + env mappings (§8).
- A2.4 **[NEW]** `tests/unit/consilium/diff-context.test.ts` (fake git) + `tests/integration/consilium/diff-context-realgit.test.ts` (tmp repo).

### Phase B — Loop controller
- B.1 **[EDIT]** `shared/schema.ts` — `consiliumLoops` + `consiliumLoopRounds` tables + insert schemas + `ConsiliumLoopState` enum (§4).
- B.2 **[EDIT]** `server/storage.ts` (IStorage iface + MemStorage) + `server/storage-pg.ts` (PgStorage) — `createLoop / getLoop / getLoopsByOwner / updateLoop / appendLoopRound / getLoopRounds` (group-scoped reads, mirror task-group methods).
- B.3 **[NEW]** `server/services/consilium/consilium-loop-controller.ts` — the FSM: `start`, `tick` (single-flight reducer), `reduce(state,event)` pure transition fn, `onMergeApproved`, `cancel`. Calls `taskOrchestrator.startGroup`, `buildDiffContext`, `readConvergence`, and the DEV handoff builder.
- B.4 **[NEW]** `server/services/consilium/dev-handoff.ts` — `buildDevHandoffGroup(openActionPoints, devPipelineId, …)` returning the `createTaskGroup` payload (server-side port of `verdict-panel.tsx:187`).
- B.5 **[NEW]** `server/routes/consilium-loops.ts` + **[NEW]** `server/routes/authorize-consilium-loop.ts` — routes (§7) + owner guard.
- B.6 **[EDIT]** `server/routes.ts` — construct the controller (after L244), `registerConsiliumLoopRoutes`, start the poller backstop (guard on `config.consiliumLoop.enabled`, mirror cron-scheduler bootstrap L301), subscribe to `taskgroup:completed`.
- B.7 **[NEW]** `tests/unit/consilium/loop-fsm.test.ts` (every §3 transition, anti-stall, cap precedence) + `tests/integration/consilium/loop-routes.test.ts` (authz, 409s, HITL gate).

### Phase C — Omniscience run (PLAN ONLY — no code)
- C.1 Author/patch the Omniscience consilium group's **judge task description** to append `JUDGE_CONVERGENCE_INSTRUCTIONS` (via `PATCH /api/task-groups/:id/tasks/:taskId`). The existing group `569fcd76-…` keeps working — A1's fallback derives convergence from its current `action_points` even before the prompt is patched, so v3's 3 open P0s are read immediately.
- C.2 Create a loop: `POST /api/consilium-loops { groupId: "569fcd76-fc50-4c31-b330-6c8783467154", repoPath: "project/Omniscience" (must be added to allowedRepoPaths), devPipelineId: <Full SDLC> }`. Set `lastReviewedCommit` = the commit reviewed at v3 so round-4's diff is `v3..HEAD`.
- C.3 `start` → loop runs round 4 (REVIEW). With 3 P0s open it goes DEV → Draft PR → AWAITING_MERGE. Human reviews+merges, POSTs `merge-approved` → round 5, etc. Cap 6, anti-stall on the 3-P0 count.
- C.4 Validation: confirm restart-safety (kill+restart server mid-`AWAITING_MERGE`, loop resumes), confirm anti-stall fires if P0 count stays at 3 across two rounds.

---

## 12. Open risks + recommended default decisions

1. **Merge-gate signal mechanism** — explicit human `POST /merge-approved` vs auto-detect via a `github_event` PR-merged trigger. **Recommend default: explicit POST endpoint** (simplest, no external webhook dependency, satisfies "only manual step"); wire the optional `github_event` trigger to the *same* endpoint later. Low risk.
2. **`tick` drive: event vs poller** — **Recommend both** (event for latency, poller backstop for restart-safety), with `tick` idempotent + single-flight. Risk: double-tick race → mitigated by the in-memory claim + persisted-state reducer (an already-advanced state is a no-op).
3. **A1 fallback vs hard requirement of the `convergence` object** — **Recommend the trust-then-derive fallback** so the loop works against today's unmodified Omniscience judge (v3) and degrades gracefully if a model omits the field. Risk: a model that mis-tags priorities → mitigated because the judge prompt instruction makes `convergence` authoritative when present.
4. **DEV test specifics TBD** — sealed behind the `testSummary` string seam; no decision needed now. The DEV pipeline owns "what tests"; A2 owns "summarize whatever you're given."
5. **Round-1 input** — **Recommend**: round 1 has no diff (null baseline), input = the standing objective only — exactly reproducing the manual v1 we already ran.

---

## 13. Security Acceptance Criteria (BINDING — from the design-gate review)

The Security Engineer reviewed this design (VETO power). The following are **hard acceptance criteria**; A2/B code does NOT merge until every BLOCKER and HIGH is satisfied. Cited patterns verified in-repo.

### BLOCKER (must be coded, not "ideally")
- **B-1 Git argument injection (A2 §6/§10.1).** Arg-arrays stop *command* injection but NOT *argument* injection. `baselineCommit` is attacker-influenceable (create route / §C2) and a value like `--output=/etc/cron.d/x`, `--ext-diff`, or `--no-index <path>` is honored by git's own parser. Required, all three:
  1. Strict gate `^[0-9a-f]{7,64}$` on `baselineCommit` before use — reject branch names/ranges/refs.
  2. Round-trip `git.revparse(["--verify", "--end-of-options", `${sha}^{commit}`])`; use the *resolved* 40-char sha downstream, never the raw input.
  3. Pin every `git.diff` with `--end-of-options` before the `base..head` range (git ≥2.24; confirm bundled git supports it). HEAD is server-derived but still must be the resolved sha + same discipline.
- **B-2 Merge gate privilege (B §7/§10.3).** `POST /:id/merge-approved` is the autonomy→production boundary. Owner-alone is a self-approved rubber stamp (creator == approver). Required: gate with `requireRole("maintainer","admin")` **plus** loop visibility — owner-alone MUST be denied. Separation of duties; mirror `triggers.ts:191`.

### HIGH (in A2/B acceptance criteria)
- **H-1 Repo-allowlist defense-in-depth (§10.2).** `assertAllowedRepoPath` runs BOTH at the create route AND inside `buildDiffContext` (re-validate the persisted `repoPath` every round — never trust the caller). Byte-mirror `file-watcher.ts validateWatchPath:60`: `realpathSync`, reject post-resolution `..`, `resolved === root || startsWith(root + "/")` against realpath'd allow-roots, plus a denylist. Empty allowlist ⇒ every create fails (fail-closed).
- **H-2 baseline sha validated on write AND read (§4.1/§6).** Same hex-sha gate when set (create/§C2) and again when read from the row before git. A poisoned row must not re-inject each round.
- **H-3 Persisted single-flight, not in-memory (§7/§10.4).** Replace the in-memory `Set<loopId>` with an atomic CAS: `UPDATE consilium_loops SET state=… WHERE id=… AND state=<expected> RETURNING …`; no-op if zero rows. Add a partial-unique constraint so ≤1 non-terminal loop per `groupId` (or justify). `start` 409s if not `PENDING`; create rejects a second active loop over the same group.
- **H-4 Diff secret egress (§6/§10.5).** The diff body WILL be sent to external LLM providers — state this as a reviewed data-flow. Add a best-effort redactor (high-entropy / `-----BEGIN * PRIVATE KEY-----` / `AWS_` / `password=`) before the diff enters the prompt. Do NOT persist the raw diff/assembled input in `consilium_loop_rounds`. Scrub `error`/GitFail messages (leak fs layout) before persist/return.

### MEDIUM / LOW (review-time checklist)
- **M-1** Pick 404-vs-403 on owner mismatch and apply consistently (`authorizeConsiliumLoop`); 404 is stronger but then deviate from the 403 byte-mirror deliberately.
- **M-2** Ensure `cancel`→recreate / second `start` cannot reset `round` for another 6 rounds; the cap must bind the group's lifetime spend.
- **M-3** TOCTOU: capture `headCommitAtReview` on entering `AWAITING_MERGE`; `merge-approved` asserts merged HEAD matches (or records the delta) — don't blindly trust "HEAD now".
- **M-4** Scrub diff/paths at warn/error too, not just info.
- **M-5** Reject `NaN` from `z.coerce.number()` on bad env (`maxRounds`/`pollIntervalMs`/`maxDiffBytes`).
- **L-1** `prRef` display-only — never drives an auto-merge.
- **L-2** Bound `open_action_points` count + per-field length in `readConvergence` (anti-bloat / huge DEV handoff).  ← **also applies to A1**, fold in now.
- **L-3** Ownerless loop (creator deleted) must still be admin-cancellable.
```
