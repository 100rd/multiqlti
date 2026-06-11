# Live Run Activity UI — Design

**Status**: Proposed
**Author**: solution-architect (DESIGN phase)
**Date**: 2026-06-11
**Issue/Feature**: Live "what's happening right now" observability surface for debugging across all run modes.

---

## 1. Context & Goal

A consolidated **Live Activity** surface that answers, at a glance and updating live:

- **Which runs are active right now** (across all modes).
- **Who is working on each step** — the agent/team/role.
- **Which model** that step is using.
- **The current status** — running / paused / awaiting-approval / completed / failed.

Purpose is **visual debugging** — "see what's actually going on" — not a heavy bespoke dashboard.

This is a **read-only observability lens** over data that already exists. The design deliberately **reuses** the in-memory active-run registries + existing per-run/stage/step storage + the existing WS stream, and adds the **minimum** new surface (one snapshot endpoint, one thin live-merge hook, one page) plus the **minimum** payload additions to close real gaps.

### Run modes in scope

| Mode | Controller | Per-unit storage | "Active" registry |
|------|-----------|------------------|-------------------|
| Pipeline (linear + DAG) | `PipelineController` | `stage_executions` | `PipelineController.activeRuns` |
| Manager | `PipelineController` → `ManagerAgent` | `manager_iterations` | `PipelineController.activeRuns` |
| Orchestrator | `PipelineController` → `OrchestratorAgent` | `orchestrator_steps` | `PipelineController.activeRuns` (registered at `pipeline-controller.ts:1142`) |
| Consensus | `ConsensusController` | `consensus_rounds` | `ConsensusController.activeRuns` (`consensus-controller.ts:38`) |

Key structural fact: **every mode's `runId` is a `pipeline_runs.id`.** `orchestrator_runs.runId`, `consensus_runs.runId`, and `manager_iterations.runId` all FK to `pipeline_runs.id`. Therefore **`pipeline_runs.triggeredBy` is the single source of run ownership** for all four modes (`shared/schema.ts:152`). This makes a uniform owner/admin authZ check trivial.

---

## 2. Data-Source Map (per mode: where agent/role + model + status live, and what is MISSING)

> Legend: ✅ present in a row/event we can read · ⚠️ present in storage but NOT in any live WS event · ❌ missing entirely (must be added).

### 2.1 Pipeline mode (linear + DAG)

| Field | Source (file:field) | Live WS? |
|-------|--------------------|----------|
| **run id / status** | `pipeline_runs.status` (`shared/schema.ts:146`); WS `pipeline:started/completed/failed/cancelled` (`pipeline-controller.ts:138,452,462`) | ✅ |
| **agent / role** | `stage_executions.teamId` (`shared/schema.ts:173`). Live: `stage:started`/`stage:completed`/`stage:awaiting_approval` payloads all carry `teamId` (`pipeline-controller.ts:237,323,943`) | ✅ |
| **model** | `stage_executions.modelSlug` (`shared/schema.ts:174`). Live: `stage:started` payload carries `modelSlug` (`pipeline-controller.ts:238,278,701`) | ✅ (on `stage:started`) |
| **status (per stage)** | `stage_executions.status` (`shared/schema.ts:175`); live via the `stage:*` event type itself | ✅ |
| **live progress text** | WS `stage:progress` payload `{ stageIndex, teamId, deltaText, cumulativeChars }` (`pipeline-controller.ts:1414-1418`) | ⚠️ **`modelSlug` is MISSING from this payload** |

**GAP P-1 (must fix):** `stage:progress` carries `teamId` but **not `modelSlug`**. The Activity row's "model" column would be blank for a stage that is mid-stream if the row was first seen via `stage:progress` (e.g. page opened mid-run). The snapshot endpoint covers the cold-load case (it reads `modelSlug` from the row), but the live-only path is incomplete. **Add `modelSlug` to the `stage:progress` payload** in `buildStreamingBlock` (`pipeline-controller.ts:1412`). It is already in scope there via the stage config; thread it through `buildStreamingBlock`'s signature (which currently takes `teamId` but not `modelSlug`).

### 2.2 Manager mode

| Field | Source (file:field) | Live WS? |
|-------|--------------------|----------|
| **run id / status** | `pipeline_runs.status`; manager settles run status in `pipeline-controller.ts:157-171` | ✅ |
| **agent / role (current team)** | `manager_iterations.decision.teamId` (`ManagerDecision.teamId`, `shared/types.ts:1536`). Live: `manager:decision` payload carries `teamId` (`manager-agent.ts:397`) | ✅ |
| **status (current)** | Derived: a `manager:decision` with `action:"dispatch"` ⇒ running team `teamId`; `manager:complete`/`manager:error` ⇒ terminal (`manager-agent.ts:392,415,430`) | ✅ |
| **model** | The model the dispatched team uses is resolved from **config** (per-team default / `ManagerConfig`), NOT stored on the iteration row and NOT in the `manager:decision` payload | ❌ **MISSING everywhere** |

**GAP M-1 (must fix, small):** Manager mode has no per-iteration model anywhere — not on `manager_iterations`, not on the `manager:decision` event. The cheapest correct fix: **add `modelSlug` to the `manager:decision` WS payload** (`manager-agent.ts:386`) sourcing it from the same place the agent resolves the team's model before dispatch. For the snapshot/cold-load path, the manager has no per-step row to read a model from, so the snapshot will report the manager's **current team** and resolve its model from config (`SDLC_TEAMS[teamId].defaultModelSlug`, `shared/constants.ts:247`) or the `ManagerConfig` stage override when present. Document this as "best-effort model for manager mode."

### 2.3 Orchestrator mode

| Field | Source (file:field) | Live WS? |
|-------|--------------------|----------|
| **run id / status** | `orchestrator_runs.status` (`shared/schema.ts:761`); WS `orchestrator:plan/completed/failed/cancelled` (`orchestrator-agent.ts:159,281,298,310`) | ✅ |
| **agent / role (step type)** | `orchestrator_steps.type` ∈ {research, analyze-code, debate, ground, synthesize} (`shared/schema.ts:792`) | ⚠️ **No per-step WS event** (see O-1) |
| **status (per step)** | `orchestrator_steps.status` (`shared/schema.ts:794`), written in `runStep` (`orchestrator-agent.ts:227,237,245`) | ⚠️ **No per-step WS event** |
| **model** | Fixed per step type via `OrchestratorModels` slugs (`orchestrator-agent.ts:32-39`): plan→`planModelSlug`, synthesize→`synthesizeModelSlug`, debate→proposer/critic/judge slugs. NOT stored on the step row | ⚠️ derivable from step `type` + run config; not in any event |

**GAP O-1 (must fix, small):** `runStep` (`orchestrator-agent.ts:220`) updates `orchestrator_steps` status to `running`/`completed`/`failed` but **broadcasts nothing**. The only orchestrator WS events are run-lifecycle (`plan/completed/failed/cancelled`). The client `use-orchestrator.ts` already leans on the shared `stage:progress` event for live step progress (`use-orchestrator.ts:226`), but `stage:progress` is only emitted by the pipeline streaming path, not by orchestrator steps — so orchestrator per-step transitions are effectively **poll-only today**. Minimal fix: **emit a lightweight `orchestrator:step` WS event** in `runStep` on the running/completed/failed transitions, payload `{ stepIndex, type, status, modelSlug }` where `modelSlug` is the fixed slug for that step `type`. (Add `orchestrator:step` to the `WsEventType` union.) The snapshot endpoint covers cold-load by reading `orchestrator_steps` + mapping `type → model` from the run's caps/config.

### 2.4 Consensus mode

| Field | Source (file:field) | Live WS? |
|-------|--------------------|----------|
| **run id / status** | `consensus_runs.status` ∈ deliberating/resolved/unresolved/cancelled/failed (`shared/schema.ts:913`) | ❌ no WS |
| **agent / role (phase)** | `consensus_rounds.phase` ∈ blind/review/adjudication (`shared/schema.ts:945`) | ❌ no WS |
| **model** | `claudeModelSlug` for blind/adjudication (`consensus-engine.ts:49,258,318`); voter slugs for review (resolved from the antigravity roster) | ❌ no WS |
| **status (round)** | implied by which `consensus_rounds` rows exist + `consensus_runs.status` | ❌ no WS |

**GAP C-1 (largest gap):** **Consensus emits ZERO WS events.** There are no `consensus:*` members in the `WsEventType` union (`shared/types.ts:424-516`) and no `broadcast`/`wsManager` calls in `consensus-engine.ts` or `consensus-controller.ts`. Consensus is **entirely poll-only** today. Two options:

- **C-1a (recommended for MVP):** Activity shows consensus runs from the **snapshot endpoint** (reads `consensus_runs` + latest `consensus_rounds` row → current phase + model + status). Live freshness for consensus comes from the **poll fallback** (§5.3), not WS. No new WS surface. Smallest blast radius; keeps the just-shipped consensus engine untouched.
- **C-1b (follow-up):** Add `consensus:round` / `consensus:phase` / `consensus:settled` WS events. Larger change to a freshly-reviewed security-sensitive module; defer unless live consensus updates are explicitly required.

**Decision:** ship **C-1a** now; track C-1b as a follow-up. This keeps the consensus engine (which has strict fail-closed/no-self-approval invariants) out of this change's blast radius.

### 2.5 Gap summary

| Gap | Mode | Severity | Fix |
|-----|------|----------|-----|
| P-1 | Pipeline | Low | Add `modelSlug` to `stage:progress` payload |
| M-1 | Manager | Medium | Add `modelSlug` to `manager:decision` payload; snapshot derives model from config |
| O-1 | Orchestrator | Medium | Emit new `orchestrator:step` WS event with `{ stepIndex, type, status, modelSlug }` |
| C-1 | Consensus | High (no live) | MVP = snapshot + poll only (C-1a); WS events deferred (C-1b) |

The **snapshot endpoint** is the common floor that makes every mode render correctly on cold load regardless of WS coverage. The WS additions (P-1/M-1/O-1) are pure additive enrichments for live freshness.

---

## 3. Backend Design

### 3.1 Authoritative "active runs" source

There is **no** DB query for "runs where status=running and owner=X" (only `getPipelineRuns(pipelineId?)`, `getPipelineRun(id)`, and by-runId accessors for the mode rows). Inventing one would be lossy (DB status lags the in-memory truth; a run can be `running` in the row after its controller has moved on).

The **authoritative live truth** is the two in-memory registries:
- `PipelineController.activeRuns: Map<runId, AbortController>` (`pipeline-controller.ts:42`) — covers pipeline + manager + orchestrator.
- `ConsensusController.activeRuns: Map<runId, AbortController>` (`consensus-controller.ts:38`) — covers consensus.

**New (small) public accessors** — add `getActiveRunIds(): string[]` to each controller (both registries are currently `private`; `PipelineController` already exposes `isRunActive(runId)` at line 1377, so this is a natural sibling). No registry restructuring.

### 3.2 Snapshot endpoint

```
GET /api/activity
```

**Auth scoping (owner/admin):** reuse the **exact `authorizeRun` idiom** already implemented (and duplicated) in `server/routes/orchestrator.ts:53` and `server/routes/consensus.ts:44`:
- 401 if `!req.user`.
- A user sees **only runs whose `pipeline_runs.triggeredBy === req.user.id`**.
- `req.user.role === "admin"` sees **all** active runs.
- `triggeredBy == null` (ownerless) runs are **never** shown to non-admins (matches the stricter orchestrator/consensus rule — transcripts/activity are never world-readable).

> **Refactor note (Security task):** `authorizeRun` is currently copy-pasted in two route files with identical logic. Extract it to a shared helper (e.g. `server/routes/authorize-run.ts`) and have orchestrator/consensus/activity all import it. This avoids a third copy and is the DRY-correct move.

**Algorithm:**
1. Collect candidate active run ids: `pipelineController.getActiveRunIds()` ∪ `consensusController.getActiveRunIds()`.
2. For each runId: load `pipeline_runs` row → apply owner/admin filter (drop if not visible). This is the single ownership gate for all modes.
3. Classify mode + build the current-unit summary from the **already-loaded mode rows**:
   - **consensus** present (`getConsensusRun`) → phase from latest `consensus_rounds` row; model = `claudeModelSlug` (blind/adjudication) or "voters" (review); status = `consensus_runs.status`.
   - else **orchestrator** present (`getOrchestratorRun`) → current step = the `orchestrator_steps` row with `status="running"` (else last completed); agent = step `type`; model = `type→slug` map; status = step status.
   - else **manager** (run has `manager_iterations` / managerConfig) → current = latest `manager_iterations.decision.teamId`; model = config-resolved (best-effort, M-1); status derived from run + last decision action.
   - else **pipeline** → current stage = `stage_executions` row with `status="running"` (else `currentStageIndex`); agent = `teamId`; model = `modelSlug`; status = stage status.
4. Return the envelope.

**Response shape** (`ApiResponse<T>` envelope per project patterns):

```ts
// shared/types.ts — new
export type ActivityMode = "pipeline" | "manager" | "orchestrator" | "consensus";

export interface ActivityUnit {
  /** Human label of the current unit: stage index, step index, or round number. */
  label: string;          // e.g. "Stage 3", "Step 2", "Round 1 · review"
  /** Agent/team/role/phase identifier — ENUM-derived, never untrusted text. */
  agent: string;          // teamId | orchestrator step type | consensus phase
  /** Model slug for this unit (best-effort for manager mode). */
  modelSlug: string | null;
  /** Status of this unit. */
  status: string;         // StageStatus | OrchestratorStepStatus | ConsensusRoundPhase-derived
}

export interface ActivityRun {
  runId: string;
  mode: ActivityMode;
  /** Run-level title/label. NEVER the raw task/decision text (see security). */
  title: string;          // e.g. pipeline name, or "Orchestrator run" — metadata only
  runStatus: RunStatus | string;
  workspaceId: string | null;
  current: ActivityUnit | null;
  startedAt: string | null;
  /** Owner id — present for admins only (so admins can attribute runs). */
  ownerId?: string | null;
}

export interface ActivitySnapshot {
  runs: ActivityRun[];
  /** Whether the caller is admin (so the FE can show owner column). */
  isAdmin: boolean;
}
```

**Security — payload is metadata-only (scrubbed):**
- **No transcripts, no prompts, no decision/task text, no step output, no reasoning.** The activity payload carries only: run id, mode, enum-derived agent/role/phase, model slug, status, timestamps, workspace id. `title` is a non-sensitive label (pipeline name / mode name) — explicitly **not** the user's free-text task or `decisionText`.
- Model slugs and team/step/phase identifiers are **enum-derived**, so there is no untrusted-text leak vector. If any string that could carry user/model text were ever added, it MUST pass `scrubSecrets` (`server/gateway/secret-scrub.ts:74`) — but the MVP shape avoids needing it.
- Rate-limit the endpoint (reuse `checkManagerRunRateLimit` idiom or a light limiter) since it's pollable.

**Reuse vs new (backend):**
- **Reuse:** `authorizeRun` idiom, `pipeline_runs.triggeredBy` ownership, `getPipelineRun`/`getOrchestratorRun`/`getConsensusRun`/`getStageExecutions`/`getManagerIterations`/`getOrchestratorSteps`, `SDLC_TEAMS[teamId].defaultModelSlug`, `scrubSecrets`, `ApiResponse` envelope.
- **New (small):** `getActiveRunIds()` on both controllers; one route file `server/routes/activity.ts`; the `Activity*` types; the extracted shared `authorizeRun`; the type→model map for orchestrator (a tiny pure helper, testable).

### 3.3 Which WS events drive live updates

The Activity FE subscribes to the **existing** WS stream (no new global channel). For each run in the snapshot, the FE issues `wsClient.subscribe(runId)` and updates that row from:

| Event | Drives |
|-------|--------|
| `pipeline:started/completed/failed/cancelled` | run status |
| `stage:started` | current stage + agent + **model** + running |
| `stage:progress` | current stage + agent (+ **model** after P-1) — keeps the row "live" |
| `stage:completed/failed/awaiting_approval` | stage status transitions |
| `manager:decision` | current team + (+ **model** after M-1) + running |
| `manager:complete/error` | run terminal |
| `orchestrator:plan/completed/failed/cancelled` | run status |
| `orchestrator:step` (**new, O-1**) | current step + type + **model** + status |
| consensus | **none today** — poll fallback only (C-1a) |

---

## 4. Frontend Design

### 4.1 Route & placement

- **New route:** `/activity` in `client/src/App.tsx` (sibling of `/pipelines`), wrapped in `ErrorBoundary`, page `client/src/pages/Activity.tsx`.
- **Nav:** add one item to `navItems` in `client/src/components/layout/MainLayout.tsx:58` (e.g. `{ icon: Activity, label: "Live Activity", href: "/activity" }`, lucide `Activity`/`Radio` icon).
- It is a **page**, not a dashboard widget (the brief allows either; a dedicated page is cleaner for a debugging lens and avoids cluttering the Dashboard). A small "N runs active" count could later link from the Dashboard.

### 4.2 Row model & grouping

Runs grouped by `mode` (Pipeline / Manager / Orchestrator / Consensus sections). Each **row** shows:

| Column | Source (FE) |
|--------|-------------|
| run id / title | `ActivityRun.title` + short id |
| current unit | `ActivityUnit.label` (e.g. "Stage 3", "Round 1 · review") |
| **agent / role** | `ActivityUnit.agent` — rendered via reused badges |
| **model** | `ActivityUnit.modelSlug` (muted "—" when null) |
| **status** | status badge (reused) |
| live progress | reuse `stage:progress` rendering (a thin progress/“streaming…” indicator) |
| owner (admin only) | `ActivityRun.ownerId` when `isAdmin` |

### 4.3 Component reuse

- **Status badges:** reuse `StepStatusBadge` / `StepTypeBadge` from `client/src/components/orchestrator/StepBadges.tsx` (already pure, enum-only, `motion-safe:animate-pulse` on running, reduced-motion-aware) — these are the closest existing "agent + status" badges and were explicitly built to render only enum-derived labels (never untrusted text), which matches our security posture.
- **Base UI:** `@/components/ui/badge`, `@/components/ui/card` (the "SurfaceCard" role) for each mode section, `cn` from `@/lib/utils`.
- **Run status meta:** reuse `RUN_STATUS_META` / `STEP_STATUS_META` color maps from the orchestrator lib (`client/src/lib/orchestrator.ts`) rather than inventing a new color scheme.
- **Tokens/a11y:** existing CSS tokens; `data-testid` on rows/badges (matches existing convention) for QA hooks.

### 4.4 Live-update wiring

A new thin hook `client/src/hooks/use-activity.ts`:
1. **Initial load + fallback:** TanStack Query `useQuery(["/api/activity"])` via the existing `getQueryFn` (`client/src/lib/queryClient.ts:39`), with `refetchInterval` (e.g. 5 s) as the **poll fallback** (and the **only** freshness source for consensus, C-1a).
2. **Live merge:** on snapshot load, for each `runId` call `wsClient.subscribe(runId)`; register a single `wsClient.onAny(handler)` (`client/src/lib/websocket.ts:74`) that merges events into the in-memory row map by `event.runId` (immutable `Map` updates, mirroring `usePipelineEvents` in `use-websocket.ts:88` but **multi-run** — i.e. NOT filtered to a single `runId`).
3. **Cleanup:** on unmount / when a run leaves the snapshot, `wsClient.unsubscribe(runId)` and remove the row.

> Reuse note: `usePipelineEvents` (`use-websocket.ts:74`) is the per-run reducer. `use-activity.ts` is its multi-run sibling: same event→state mapping, keyed by `runId` instead of stage index, and seeded by the snapshot rather than starting empty.

### 4.5 Empty / loading / error states

- **Loading:** skeleton rows (reduced-motion-safe) while the first `/api/activity` resolves.
- **Empty:** "No runs are active right now." (the common, healthy case) with a hint linking to `/pipelines`.
- **Error:** the `ErrorBoundary` wrapper + a small inline retry; a 401 falls through to the existing auth redirect.
- **WS disconnected:** show a subtle "reconnecting…" indicator (the poll keeps data fresh meanwhile — graceful degradation).

---

## 5. Live-update mechanism (summary)

1. **Snapshot first** (`GET /api/activity`) for the authoritative owner-scoped list + cold-load current unit for every mode (including consensus).
2. **WS for live deltas** — subscribe per visible `runId`, merge `stage:*` / `manager:*` / `orchestrator:*` (+ new `orchestrator:step`) events. No new global WS channel; reuse `wsClient`.
3. **Poll as fallback** — `refetchInterval` keeps the list correct (runs starting/ending) and is the sole freshness path for consensus until C-1b.

### 5.1 AuthZ on the WS path (important)

`WsManager.broadcastToRun` only delivers to clients that explicitly `subscribe` to a `runId`, but **the WS `subscribe` handler performs NO ownership check** (`server/ws/manager.ts:38-54`) — any authenticated socket can subscribe to any `runId`. This is a **pre-existing** posture (the single-run views already rely on it). The Activity feature **must not widen** it: the FE only ever subscribes to run ids returned by the **owner-scoped** `/api/activity` snapshot, so a user never learns another user's run ids through Activity. Closing the WS-subscribe IDOR is **out of scope** here but should be flagged to the Lead (see Open Questions) — and is a strong argument for adding an owner check in the WS `subscribe` handler as a separate hardening task.

---

## 6. Task Breakdown (ordered, file-owned, small units)

> Standards apply to every code task: TDD ≥80% on new modules, no `any`, reuse-first, a11y, owner/admin scoping, no secret/transcript leak. Server runs on host (`make dev`), never Docker. Feature branch + PR, no AI mentions.

### Phase 0 — Shared contract (BE, blocks all)
- **T0.1 (BE)** — Add `ActivityMode`, `ActivityUnit`, `ActivityRun`, `ActivitySnapshot` to `shared/types.ts`. Add `orchestrator:step` to the `WsEventType` union. *Owns:* `shared/types.ts`.

### Phase 1 — Backend snapshot
- **T1.1 (Security/BE)** — Extract the duplicated `authorizeRun` into `server/routes/authorize-run.ts`; update `server/routes/orchestrator.ts` + `server/routes/consensus.ts` to import it (behavior-preserving; existing route tests must stay green). *Owns:* new file + the two route files (import lines only). **TDD:** unit tests for 401/404/403/owner/admin/null-owner.
- **T1.2 (BE)** — Add `getActiveRunIds(): string[]` to `PipelineController` (`server/controller/pipeline-controller.ts`) and `ConsensusController` (`server/consensus/consensus-controller.ts`). *Owns:* those two files. **TDD:** registry add/remove reflected.
- **T1.3 (BE)** — Pure helper `server/routes/activity-model-map.ts`: `orchestratorStepModel(type, models)` and `managerTeamModel(teamId, config)` (best-effort). *Owns:* new file. **TDD:** table test over all step types + team ids.
- **T1.4 (BE)** — `server/routes/activity.ts`: `GET /api/activity` — collect active ids from both controllers, owner/admin-filter via shared `authorizeRun` logic + `pipeline_runs.triggeredBy`, build `ActivityRun[]` per §3.2, metadata-only payload (no transcripts), rate-limited. Register in `server/routes.ts`. *Owns:* new file + one registration line in `routes.ts`. **TDD (integration):** 401; user sees only own runs; admin sees all; null-owner hidden from non-admin; each mode classified correctly; **no transcript/prompt/output field present in the response** (explicit assertion).

### Phase 2 — Backend WS gap fixes (additive, parallel-safe after Phase 0)
- **T2.1 (BE)** — P-1: thread `modelSlug` into `buildStreamingBlock` and add it to the `stage:progress` payload (`server/controller/pipeline-controller.ts:1397-1420`). *Owns:* that method. **TDD:** progress event includes `modelSlug`.
- **T2.2 (BE)** — M-1: add `modelSlug` to the `manager:decision` payload (`server/pipeline/manager-agent.ts:386`), sourced from the resolved team model. *Owns:* that method. **TDD:** decision event includes `modelSlug`.
- **T2.3 (BE)** — O-1: emit `orchestrator:step` in `runStep` on running/completed/failed with `{ stepIndex, type, status, modelSlug }` (`server/orchestrator/orchestrator-agent.ts:220-252`). *Owns:* that method. **TDD:** event emitted on each transition with correct model-for-type; abort path emits nothing/cancelled consistently.

### Phase 3 — Frontend
- **T3.1 (FE)** — `client/src/hooks/use-activity.ts`: snapshot `useQuery` + `refetchInterval` + multi-run `wsClient.onAny` merge + per-run subscribe/unsubscribe. *Owns:* new file. **TDD:** snapshot seeds rows; a `stage:started` event updates the matching row's model/status; a run leaving the snapshot unsubscribes; events for unknown runIds are ignored.
- **T3.2 (FE)** — `client/src/pages/Activity.tsx`: page grouping rows by mode, reusing `StepStatusBadge`/`StepTypeBadge` + `ui/card` + `ui/badge`; admin-only owner column; loading/empty/error/disconnected states; `data-testid`s. *Owns:* new file.
- **T3.3 (FE)** — Wire the route in `client/src/App.tsx` and the nav item in `client/src/components/layout/MainLayout.tsx`. *Owns:* those two files (additive).

### Phase 4 — QA
- **T4.1 (QA/E2E)** — Playwright: start a pipeline run → `/activity` shows it with team + model + running badge; status flips to completed live; a second user does **not** see it; admin sees both. *Owns:* `tests/e2e/activity.spec.ts` (or repo E2E location).
- **T4.2 (QA)** — Verify ≥80% coverage on new modules (`activity.ts`, `use-activity.ts`, `activity-model-map.ts`, `authorize-run.ts`); a11y pass (keyboard, reduced-motion, contrast) on `/activity`.

**Ordering:** T0.1 → {T1.1, T1.2, T1.3} → T1.4 (and Phase 2 in parallel with Phase 1 after T0.1) → Phase 3 → Phase 4. Phase 2 is independent additive enrichment; the FE works on snapshot+poll even if Phase 2 slips (consensus already relies on poll-only).

---

## 7. Risks & Open Questions (for the Lead)

1. **Per-user vs admin-all scoping** *(recommend, needs sign-off)* — Proposed: a user sees only their own active runs (`triggeredBy === user.id`); admin sees all; ownerless runs hidden from non-admins. This matches the **stricter** orchestrator/consensus idiom (`triggeredBy == null` ⇒ deny). Confirm admins should see all (the debugging value is highest for admins/operators). Should the admin view include `ownerId` per row (proposed: yes)?

2. **modelSlug / agent already in WS events?** *(answered by study)* — Mostly **no** for the live path:
   - `stage:started` ✅ has `modelSlug`; `stage:progress` ❌ (P-1).
   - `manager:decision` ❌ no model (M-1).
   - Orchestrator ❌ has **no per-step event at all** (O-1).
   - Consensus ❌ has **no WS events at all** (C-1).
   The snapshot endpoint closes all cold-load gaps; the WS additions (Phase 2) are additive. Lead to confirm Phase 2 is in-scope now vs deferred (FE works without it via poll).

3. **Consensus live updates (C-1)** — MVP is **snapshot + poll only** (C-1a) to keep the just-shipped, security-sensitive consensus engine out of the blast radius. Adding `consensus:*` WS events (C-1b) is a follow-up. Confirm poll-only consensus freshness is acceptable for MVP.

4. **Performance with many concurrent runs** — `/api/activity` does O(active-runs) row lookups (a handful of `get*` calls per run). With many runs this is N small queries. Mitigations if needed: cap the number of rows returned, add a short server-side cache (e.g. 1–2 s) keyed by user, and tune the FE `refetchInterval`. The WS path is already bounded (per-run subscribe; only visible runs). Lead to set an expected concurrency ceiling.

5. **WS subscribe IDOR (pre-existing)** — `WsManager`'s `subscribe` handler performs **no ownership check** (`server/ws/manager.ts:38`); any authed socket can subscribe to any `runId`. Activity does not widen this (it only subscribes to owner-scoped ids), but it makes the gap more visible. **Out of scope** here — flag whether to open a separate hardening task to add an owner check in the WS `subscribe` handler.

6. **"Active" definition** — Driven by the in-memory `activeRuns` registries (the live truth), not DB status. A run mid-`awaiting_approval` (paused) is still in `activeRuns` (pipeline) — good, we want to show it. Confirm paused/awaiting-approval runs should appear in Activity (proposed: yes — that's exactly the "what's stuck" debugging signal). Edge: a process restart clears the in-memory registries, so in-flight runs from before a restart won't appear until/unless re-driven — acceptable for a live-debugging lens; document it.

---

## 8. Reuse Inventory (no reinvention)

| Need | Reused symbol / file |
|------|----------------------|
| Run ownership | `pipeline_runs.triggeredBy` (`shared/schema.ts:152`) |
| AuthZ idiom | `authorizeRun` (`server/routes/orchestrator.ts:53`, `consensus.ts:44`) → extract shared |
| Active-run truth | `PipelineController.activeRuns` / `ConsensusController.activeRuns` |
| Per-mode rows | `getStageExecutions`, `getOrchestratorSteps`, `getManagerIterations`, `getConsensusRun`/`getOrchestratorRun` |
| Team→model default | `SDLC_TEAMS[teamId].defaultModelSlug` (`shared/constants.ts:247`) |
| Secret scrub | `scrubSecrets` / `scrubAndTruncate` (`server/gateway/secret-scrub.ts`) |
| WS client | `wsClient` (`client/src/lib/websocket.ts`) — `onAny`, `subscribe` |
| Per-run reducer pattern | `usePipelineEvents` (`client/src/hooks/use-websocket.ts:74`) |
| Status/agent badges | `StepStatusBadge` / `StepTypeBadge` (`client/src/components/orchestrator/StepBadges.tsx`) |
| Status color maps | `RUN_STATUS_META` / `STEP_STATUS_META` (`client/src/lib/orchestrator.ts`) |
| Query/fetch | `getQueryFn` / `queryClient` (`client/src/lib/queryClient.ts`) |
| API envelope | `ApiResponse<T>` (project patterns) |
