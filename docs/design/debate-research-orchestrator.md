# Debate-Driven Research & Planning Orchestrator — Design

Status: Proposed (MVP)
Author: Architect
Date: 2026-06-10
Headline feature: a flexible research-and-planning orchestrator where **claude-opus** is the architect/arbiter that *dynamically* decides what to do (research / analyze-code / debate / ground / synthesize), with a bounded **debate** between claude-opus and a Gemini-Flash model (antigravity provider) as the convergence mechanic.

> **Additive, not a replacement.** The orchestrator is a THIRD sibling execution mode on the existing run lifecycle, alongside the linear SDLC path and `manager` mode. The 7-stage SDLC pipeline is untouched. This mirrors how `managerConfig` already forks `PipelineController.startRun` into `ManagerAgent.run(...)`.

---

## 1. Reuse map (compose existing, build little)

| Concern | REUSE (existing symbol / path) | NEW |
|---|---|---|
| Run lifecycle + WS + abort | `PipelineController.startRun` (`server/controller/pipeline-controller.ts:98`) branches on `managerConfig`; `cancelRun` (:1148) `AbortController` per run in `activeRuns`; `broadcast` (:1215) | A third branch: `if (orchestratorConfig != null) → orchestrator.run(...)`, identical shape to the manager branch (:146-168). |
| Dynamic decision loop pattern | `ManagerAgent` (`server/pipeline/manager-agent.ts`): bounded `for` loop, `SYSTEM_MAX_ITERATIONS=20`, `RUN_TIMEOUT_MS` hard cap, JSON-decision parse+validate, allowlist enforcement, token accumulation, WS `manager:*` events, `MAX_TEAM_RESULT_BYTES` storage cap | `OrchestratorAgent` modeled on it but emitting a **typed plan of steps** (not one team/iteration) and gated by human approval. |
| Debate mechanic | `StrategyExecutor.executeDebate` (`server/services/strategy-executor.ts:178`): rounds loop, `participants`/`judge`/`arbitrator`, `stopEarly`+`checkConsensus` (:702), cross-provider ordering (`preferCrossProviderOrder`), `DebateDetails` transcript, `strategy:debate:round/judge/arbitrator` WS events | A **preset** + thin wrapper. Opus=proposer/judge, gemini-flash=critic/arbitrator. NO parallel debate engine. |
| Debate types | `DebateStrategy`, `DebateParticipant`, `JudgeConfig`, `ArbitratorConfig`, `DebateDetails`, `ArbitratorVerdict` (`shared/types.ts:108-132,276,290`) | Reused verbatim. |
| Strategy presets | `EXECUTION_STRATEGY_PRESETS` (`shared/constants.ts:438`), `computeCostMultiplier` (:622) | Add one cross-provider preset `debate_cross_provider`. |
| Streaming long Opus turns | `Gateway.completeStreaming` (`server/gateway/index.ts:692`), `StreamingStageOptions` (`shared/types.ts:835`), `pipeline.streaming` config (`server/config/schema.ts:163`), `StageProgressCoalescer` + `isAbortError` (`server/controller/stage-progress.ts`), idle/overall/byte caps, `ConcurrencyLimiter.acquireSlot` (`cli-spawn.ts:146`) | A `StreamingStageOptions` block built per orchestrator turn (same coalescer pattern as `buildStreamingBlock`, :1231). |
| Single-model chokepoint | `Gateway.complete` / `completeStreaming` (the orchestrator calls the gateway directly, like `ManagerAgent.callManagerLLM` at :268) | none |
| Research fetch | `safeFetch` + `validateUrlForFetch` (`server/knowledge/safe-fetch.ts`), `isAllowedSource` (`server/knowledge/source-allowlist.ts`) | **Extend `ALLOWED_HOSTS`** with research hosts; add a small fan-out+synthesize service. ONE allowlist, no parallel weak gate. |
| Workspace code-search | `StageContext.workspaceId/workspacePath` (`shared/types.ts:720`), the `code_search`/`file_read` tools via `toolRegistry`, `storage.getWorkspace` | Orchestrator threads `workspacePath` into an analyze-code step that calls the same tools. |
| Grounding | `OmniscienceBoardProvider` (`server/memory/omniscience-board-provider.ts`: `blastRadius`/`incidentTimeline`/`sourceStats`), `OmniscienceProvider.search` (`omniscience-provider.ts`), `isOmniscienceSelected` + `omniscience.board.enabled` (`server/config/schema.ts:152`), `mock-omniscience-board.ts` | A `GroundingStep` that no-ops gracefully when the flag is off. |
| Persistence | Drizzle patterns: `pipelineRuns` (`shared/schema.ts:136`), `managerIterations` (:713, FK+unique+index), `createInsertSchema().omit()` | 4 new tables via `db:push` (§3). |
| Routes / auth | `registerRunRoutes` (`server/routes/runs.ts`), global `app.use("/api/runs", requireAuth)` (`server/routes.ts:109`), `requireOwnerOrRole(() => ws.ownerId, ...)` (`server/auth/middleware.ts:97`), the manager rate-limiter (`runs.ts:11-29`), `validateBody` (`server/middleware/validate.js`) | `registerOrchestratorRoutes` mounted under the same `/api/runs` auth prefix (§4). |
| Wiring | `new ManagerAgent(...)` + `new PipelineController(...)` (`server/routes.ts:98-99`) | `new OrchestratorAgent(...)` constructed there + passed into the controller (new ctor arg) + `registerOrchestratorRoutes` (:146). |

**Genuinely new (small):** `OrchestratorAgent` (the step engine, split into engine + step modules, each <800 lines), `DebateRunner` (thin wrapper over `StrategyExecutor`), `ResearchService` (fan-out over `safeFetch`), `GroundingStep`, 4 DB tables, zod config block `pipeline.orchestrator`, the routes file, and minimal FE panels reusing the run/WS surface.

---

## 2. Architecture

### 2.1 Execution mode plug-in

`PipelineController.startRun` already has the seam. Today (`pipeline-controller.ts:146`):

```
if (managerConfig != null && this.managerAgent != null) { this.managerAgent.run(...); return run; }
```

We add a sibling branch *before* the DAG/linear fork (same settle/abort/trace shape, :146-168):

```
if (orchestratorConfig != null && this.orchestrator != null) {
  this.orchestrator.run(run.id, input, orchestratorConfig, abortController.signal, run.workspaceId)
    .then(({status}) => storage.updatePipelineRun(run.id, {status, completedAt})...)
    .catch(...);
  return run;
}
```

**Orchestrator config home (decision):** the orchestrator is *task-scoped per run*, not pipeline-template-scoped. So instead of adding a column to the hot `pipelines`/`pipelineRuns` tables, a run is "orchestrator mode" when an `orchestrator_runs` row exists for it. The controller's `startOrchestratorRun` creates the `pipelineRuns` row (reusing all its workspace/owner scoping: `workspaceId` + `triggeredBy`) AND the `orchestrator_runs` row. (Open question #6 records the alternative.)

The orchestrator reuses the SAME per-run `AbortController` (so `POST /api/runs/:id/cancel` already cancels it), the SAME `broadcast(runId, ...)` WS fan-out, and the SAME tracer hooks (`tracer?.startTrace`/`flushTrace`).

### 2.2 The step engine (OrchestratorAgent)

A bounded loop, structurally identical to `ManagerAgent.run` but plan-oriented:

1. **Plan turn (Opus, streamed).** Opus receives `{task, needs, workspaceId?, omniscienceAvailable}` and emits a strict-JSON **ordered plan** of typed steps. Each step is one of `research | analyze-code | debate | ground | synthesize`, with per-step args. Reuses the `callManagerLLM` JSON-parse+validate idiom (`manager-agent.ts:283`) and the streaming idle/overall budget. The plan is validated by `plan-schema.ts` (never trust raw LLM JSON — the manager allowlist lesson), persisted (`orchestrator_steps`), and broadcast (`orchestrator:plan`).
2. **Human gate.** Run pauses (`status="paused"` on the run; `orchestrator_runs.status="awaiting_plan_approval"`), like the approval gate at `pipeline-controller.ts:979`. FE shows the plan; user approves or edits. A new `approvePlan(runId)` resolves a pending promise-handle (same mechanism as `waitForApproval`/`approveStage`, :512/:522). No execution before approval.
3. **Execute steps in order.** For each step the engine dispatches to a typed handler (§2.6), accumulating `tokensUsed` and enforcing the global token ceiling **before** each step (terminate if the next step would exceed). Each step result is persisted (truncated to `stepOutputMaxBytes`) + broadcast (`orchestrator:step:started/completed`). Steps are sequential in MVP (parallel groups deferred — YAGNI).
4. **Synthesize turn (Opus, streamed).** Final structured deliverable: the plan, the debate recommendation (+confidence +dissent), cited research, grounding. Persisted as the run `output` + a `chatMessage` (`storage.createChatMessage`, as the SDLC path does at `:969`).
5. **Terminate** on: plan complete, Opus `action:"fail"`, max-steps, token ceiling, overall-timeout, or abort. Every exit path settles the run row + flushes the tracer (mirror `finishDAGRun` :429 / the linear catch :1011), maps abort→`cancelled` via `isAbortError`, and never promotes partial output (streaming-feature invariant H3).

```
server/orchestrator/orchestrator-agent.ts     engine loop + terminate/settle  (<300 lines)
server/orchestrator/steps/research-step.ts     → ResearchService
server/orchestrator/steps/analyze-code-step.ts  → workspace tools via toolRegistry
server/orchestrator/steps/debate-step.ts        → DebateRunner
server/orchestrator/steps/ground-step.ts        → GroundingStep
server/orchestrator/steps/synthesize-step.ts     → Opus streamed
server/orchestrator/debate-runner.ts             thin StrategyExecutor wrapper
server/orchestrator/research-service.ts          safeFetch fan-out + synthesis
server/orchestrator/plan-schema.ts                zod plan + step arg schemas
server/orchestrator/orchestrator-config.ts        caps resolution from AppConfig
```

### 2.3 The debate loop (built on the existing strategy primitive)

The debate is **not** a new engine. `DebateRunner` builds a `DebateStrategy` and calls `StrategyExecutor.execute(...)`. The orchestrator constructs its own `StrategyExecutor(gateway, wsManager)` exactly as `base.ts:31` does.

- participants: `[{modelSlug:"claude-opus", role:"proposer"}, {modelSlug:<gemini-flash>, role:"critic"}]` (optional 3rd `devil_advocate` when `debate.participants===3`).
- `judge: {modelSlug:"claude-opus", criteria}`. `arbitrator: {modelSlug:<gemini-flash>}` — `validateArbitratorConfig` (`strategy-executor.ts:492`) forbids arbitrator==judge and arbitrator∈participants. gemini-flash is the critic (a participant), so it CANNOT also be arbitrator. **Decision:** MVP uses Opus as judge and **no separate arbitrator** (the judge verdict is the arbitration of record), which satisfies the invariant cleanly. If we want the structured `ArbitratorVerdict` JSON, we must introduce a *third distinct* slug (e.g. `claude-sonnet`) as arbitrator — recorded as a follow-up, not MVP, to keep the debate to exactly the two named models.
- `rounds`: from config (default 3), hard-capped (§5); `validateDebateStrategy` (:474) already rejects `rounds>5`.
- `stopEarly: true` → reuses `checkConsensus` (:702) for early convergence.
- Cross-provider ordering is automatic (`preferCrossProviderOrder`); `providerDiversityScore` lands in the transcript.
- The full `DebateDetails` transcript (rounds + judge verdict) is persisted into `orchestrator_debates` and surfaced via the WS `strategy:debate:*` events the FE already understands.

Confidence + dissent: the Opus synthesis turn consumes `DebateDetails.verdict` and emits `{recommendation, confidence:0..1, dissent:string[]}`.

### 2.4 Research step

`ResearchService` implements the deep-research fan-out on the existing SSRF-safe transport:

- Input: a query + a bounded list of candidate URLs (Opus proposes them in the step args; the service NEVER fetches an arbitrary model-chosen URL without the gate).
- Each URL goes through `safeFetch` → `validateUrlForFetch` → `isAllowedSource`. Off-allowlist URLs throw `AllowlistError` and are skipped (counted, logged, non-fatal).
- `maxResearchSources` (config, default 12, hard max 50) bounds fan-out; `maxResearchConcurrency` bounds parallelism (reuse the worker-pool idiom from `swarm-executor.ts:348` `runClonesWithConcurrency` — no new dep).
- When the run is workspace-bound, the separate `analyze-code` step runs `code_search`/`file_read` against `workspacePath` for in-repo evidence.
- Synthesis: one Opus `complete`/`completeStreaming` call produces **cited** findings (each finding carries its `finalUrl` from `SafeFetchResponse`). Persisted into `orchestrator_research`.

**Allowlist extension** (`source-allowlist.ts`): add curated research hosts. github.com stays path-scoped (its comment explicitly warns against the weak string-only gate) — "survey GitHub" uses curated org/repo prefixes the team names, NOT host-level. medium.com is a flat host add. This is the single decision the Security reviewer must sign off (§7 risk #5).

### 2.5 Grounding step

`GroundingStep` queries Omniscience only when `isOmniscienceSelected(config) && config.memory.retrieval.omniscience.board.enabled`. It composes the existing `OmniscienceBoardProvider` (`blastRadius` for "what does changing X break", `sourceStats` for freshness) and/or `OmniscienceProvider.search`. When the flag is off it returns `{grounded:false}` and the engine continues — never blocks (the connection is already fallback-tolerant). Tests use `mock-omniscience-board.ts`.

### 2.6 Data flow

```
POST /api/runs/orchestrator {task, needs, workspaceId?}
  → controller.startOrchestratorRun → pipelineRuns row + orchestrator_runs row
  → OrchestratorAgent.run(signal):
       [plan turn: Opus streamed] → validate → persist plan → WS orchestrator:plan → pause
       ── human approvePlan ──
       for step in plan (token-checked before each):
          research     → ResearchService.run (safeFetch fan-out)   → cited findings
          analyze-code → workspace tools (toolRegistry)            → code evidence
          debate       → DebateRunner → StrategyExecutor.execute    → transcript
          ground       → GroundingStep → Omniscience (or no-op)
          synthesize   → Opus streamed                              → deliverable
       → persist output → WS pipeline:completed → flush trace
```

---

## 3. Data model (Drizzle, `db:push`, scoped via the parent run)

All tables key on `runId → pipelineRuns.id ON DELETE cascade` (same as `managerIterations` :721). Ownership/visibility is inherited from the parent run (`triggeredBy`) + its `workspaceId`; routes enforce it (§4). All follow `createInsertSchema(...).omit({id,createdAt})`. Timestamps are Drizzle `timestamp(...)` (Postgres `timestamptz`, ISO-8601 — same UTC convention as `omniscience-board-provider.ts` `UTC_SUFFIX_RE`).

```
orchestrator_runs            (one per orchestrator run)
  id pk uuid
  runId fk→pipeline_runs cascade  UNIQUE
  task text notnull
  needs text                       (freeform "needs"; nullable)
  workspaceId varchar              (denormalized copy for query convenience; nullable)
  status text default 'planning'   ('planning'|'awaiting_plan_approval'|'executing'|'completed'|'failed'|'cancelled')
  planApprovedAt timestamp
  planApprovedBy text
  totalTokensUsed integer default 0
  stepCount integer default 0
  createdAt / completedAt timestamps
  index(runId)

orchestrator_steps           (the dynamic plan; one row per step)
  id pk uuid
  runId fk cascade
  stepIndex integer notnull
  type text notnull            ('research'|'analyze-code'|'debate'|'ground'|'synthesize')
  args jsonb notnull           (typed per step; validated by plan-schema.ts)
  status text default 'pending'('pending'|'running'|'completed'|'failed'|'skipped')
  output jsonb                 (step result; truncated to stepOutputMaxBytes before write)
  tokensUsed integer default 0
  error text                   (scrubAndTruncate'd, like stageExecutions.error :191)
  startedAt / completedAt timestamps
  UNIQUE(runId, stepIndex); index(runId)

orchestrator_debates         (one per debate step; the transcript)
  id pk uuid
  runId fk cascade
  stepId fk→orchestrator_steps cascade
  question text notnull
  rounds jsonb notnull         ($type<DebateDetails["rounds"]>  — reuse existing type)
  judgeVerdict text notnull
  arbitratorVerdict jsonb      ($type<ArbitratorVerdict | null>  — null in MVP, see §2.3)
  providerDiversityScore real
  recommendation text          (Opus synthesis)
  confidence real              (0..1)
  dissent jsonb                ($type<string[]>)
  totalTokensUsed integer default 0
  createdAt timestamp
  index(runId), index(stepId)

orchestrator_research         (one per research step; cited findings)
  id pk uuid
  runId fk cascade
  stepId fk→orchestrator_steps cascade
  query text notnull
  findings jsonb notnull       ($type<{claim:string; sourceUrl:string; snippet:string}[]> — capped count + per-field length)
  sourcesFetched integer       (passed the allowlist)
  sourcesSkipped integer       (off-allowlist / fetch-failed)
  workspaceEvidence jsonb      (code-search hits when workspace-bound; nullable)
  createdAt timestamp
  index(runId), index(stepId)
```

Storage methods (extend `IStorage` + Drizzle impl, mirroring the manager-iteration methods at `runs.ts:339`): `createOrchestratorRun`, `getOrchestratorRun(runId)`, `updateOrchestratorRun`, `createOrchestratorStep`, `updateOrchestratorStep`, `getOrchestratorSteps(runId)`, `createOrchestratorDebate`, `getOrchestratorDebates(runId)`, `createOrchestratorResearch`, `getOrchestratorResearch(runId)`.

---

## 4. API contracts (zod-validated, under the `requireAuth` `/api/runs` prefix)

New file `server/routes/orchestrator.ts` → `registerOrchestratorRoutes(app, storage, controller)`, called from `server/routes.ts` next to `registerRunRoutes` (:146). Each route 404s if the run/orchestrator row is missing, then gates on owner-or-admin using the run's `triggeredBy` (the idiom at `runs.ts:310-331` manager-iterations + the `/compare` ownership check :111-120). A per-user rate limiter identical to `checkManagerRunRateLimit` (`runs.ts:16`) guards the start endpoint.

```
POST /api/runs/orchestrator                       (start)
  body  StartOrchestratorSchema = z.object({
          task: z.string().min(1).max(50_000),
          needs: z.string().max(50_000).optional(),
          workspaceId: z.string().max(100).optional(),   // validated to exist + owner-gated
          caps: z.object({                                 // optional per-run overrides, ALL clamped to config hard-max
            maxDebateRounds:    z.number().int().min(1).max(5).optional(),
            maxResearchSources: z.number().int().min(1).max(50).optional(),
            maxSteps:           z.number().int().min(1).max(20).optional(),
            maxTotalTokens:     z.number().int().min(1000).max(2_000_000).optional(),
          }).optional(),
        })
  201   → { runId, orchestratorRunId, status:'awaiting_plan_approval', plan:[...] }   // plan turn runs, then pauses
  429   → rate-limited (Retry-After header)
  503   → when pipeline.orchestrator.enabled === false (kill-switch)

GET  /api/runs/:id/orchestrator                   (inspect: run + plan + step statuses + token usage)
  200 → { orchestratorRun, steps, totalTokensUsed }

POST /api/runs/:id/orchestrator/approve-plan      (human gate)
  body  ApprovePlanSchema = z.object({
          approvedBy: z.string().max(200).optional(),
          steps: z.array(StepSchema).max(20).optional(),   // optional plan edits, re-validated by plan-schema
        })
  200 → { status:'executing' }                     // resumes the engine
  409 → if not in awaiting_plan_approval

POST /api/runs/:id/orchestrator/reject-plan        (abort cleanly)
  200 → { status:'cancelled' }

GET  /api/runs/:id/orchestrator/debates            (transcripts)
  query offset/limit (coerced min/max, like ManagerIterationsQuerySchema :304)
  200 → { runId, debates:[...], total, offset, limit }

GET  /api/runs/:id/orchestrator/research           (cited findings)
  200 → { runId, research:[...] }
```

Cancel reuses the existing `POST /api/runs/:id/cancel` (the orchestrator shares the run `AbortController`) — no new cancel route.

**Boundary validation everywhere:** plan/step args via `plan-schema.ts` (strict zod) before persist/exec; analyze-code tool calls via the gateway's `validateToolCallArgs` (`gateway/index.ts:800` — 64KiB + unknown-arg guard); research URLs via `isAllowedSource`. Never trust raw LLM JSON.

---

## 5. Cost-bound + termination design (FIRST-CLASS)

Every loop is bounded; nothing is unbounded. New config block `pipeline.orchestrator` in `server/config/schema.ts`, same `.min()/.max()` discipline as `pipeline.streaming` (:163), env-mapped in `loader.ts`:

```
pipeline.orchestrator: z.object({
  enabled:                z.boolean().default(false),                                   // kill-switch (opt-in)
  maxSteps:               z.coerce.number().int().min(1).max(20).default(8),
  maxDebateRounds:        z.coerce.number().int().min(1).max(5).default(3),
  maxResearchSources:     z.coerce.number().int().min(1).max(50).default(12),
  maxResearchConcurrency: z.coerce.number().int().min(1).max(10).default(4),
  maxTotalTokens:         z.coerce.number().int().min(1000).max(2_000_000).default(400_000),
  overallTimeoutMs:       z.coerce.number().int().min(10_000).max(3_600_000).default(1_800_000), // 30min hard cap
  stepOutputMaxBytes:     z.coerce.number().int().min(4096).max(1_048_576).default(100_000),      // per-step persist cap
}).default({})
```

Enforcement (defense-in-depth — config bounds AND runtime guards, like `swarm-executor.ts:51` re-checking the cap even if zod was bypassed):

1. **Steps** — engine loop `for (i < min(plan.length, maxSteps))`; a plan longer than `maxSteps` is rejected at plan-validation time (`plan-schema.ts`).
2. **Debate rounds** — passed into `DebateStrategy.rounds`, AND `validateDebateStrategy` (:474) hard-rejects `rounds>5`. `computeCostMultiplier` (:622) surfaces projected cost (`participants*rounds+1`) for the approval screen.
3. **Research sources** — `ResearchService` truncates candidates to `maxResearchSources` and re-asserts the cap at runtime; concurrency bounded by `maxResearchConcurrency`.
4. **Token ceiling** — running `totalTokensUsed` (summed from every gateway response `tokensUsed`, as `ManagerAgent` :100). **Before each step:** `if (totalTokensUsed >= maxTotalTokens) → terminate('token_ceiling')`. Hard stop, scrubbed reason persisted.
5. **Wall-clock** — `Date.now()-start > overallTimeoutMs → terminate` (mirror `ManagerAgent` :78 `RUN_TIMEOUT_MS`).
6. **Streaming budget per Opus turn** — each Opus `completeStreaming` carries the `pipeline.streaming` idle/overall/byte caps + the run `signal`; a hung Opus turn is killed by the existing idle/overall timeout. Gemini-Flash turns are blocking `complete` with an EXPLICIT `timeoutMs` + the run `signal` (antigravity CLI honors `signal` to kill the child, `antigravity-cli.ts:143`; default 120s, :49) — see §7 risk #1.
7. **Abort** — the shared `AbortController` (`POST /api/runs/:id/cancel`) propagates `signal` into every gateway call; `isAbortError` maps abort→`cancelled` (not `failed`), never promotes partial output (streaming invariant H3).
8. **Storage DoS** — every persisted step/debate/research `output` truncated to `stepOutputMaxBytes` before write (mirror `ManagerAgent.MAX_TEAM_RESULT_BYTES` :361). Errors `scrubAndTruncate`'d (`gateway/secret-scrub.ts`).
9. **Concurrency** — streamed Opus turns acquire a `ConcurrencyLimiter` slot (`cli-spawn.ts:146`) for the full generator lifetime; the fork-bomb guard from the streaming feature is inherited by going through the gateway.

---

## 6. Task breakdown (ordered, file-owned, small units; <800-line files, <30-line funcs, TDD ≥80%)

Legend: **[BE]** backend, **[FE]** frontend, **[SEC]** security, **[QA]**, **[DO]** devops/config. `→` = depends on. ∥ = parallelizable.

### Wave 0 — Foundations (parallel)
- **T1 [DO] Config block** `pipeline.orchestrator` in `server/config/schema.ts` + env mapping in `server/config/loader.ts` (the `MULTI_*` pattern). Tests: bounds clamp, kill-switch default false. ∥
- **T2 [BE] Schema + storage** 4 tables in `shared/schema.ts` + `Insert*`/`*Row` types + `IStorage` methods + Drizzle impl. `db:push` (NOT a hand-written migration — repo uses push). Tests: round-trip CRUD, cascade delete, UNIQUE(runId,stepIndex). ∥
- **T3 [BE] plan-schema.ts** zod schemas for the plan + each step's args (strict, `.max()` on arrays/strings). Pure module. Tests: accept valid plans, reject unknown step types / oversized / >maxSteps / bad args. ∥

### Wave 1 — Step services (parallel, each its own module)
- **T4 [BE] DebateRunner** (`server/orchestrator/debate-runner.ts`): build `DebateStrategy` (Opus proposer+judge, gemini-flash critic), call `StrategyExecutor.execute`, map `DebateDetails`→`orchestrator_debates` row (WS already emitted by the executor). Tests: builds a strategy that passes `validateDebateStrategy`, respects `maxDebateRounds`, transcript persisted, mocked gateway. → T2,T3 ∥
- **T5 [BE] ResearchService** (`server/orchestrator/research-service.ts`): bounded fan-out over `safeFetch` (`maxResearchSources`+`maxResearchConcurrency`), skip off-allowlist (`AllowlistError`) non-fatally, Opus synthesis with citations, persist `orchestrator_research`. Tests: injectable `requestFn`/`lookupAll` (safe-fetch supports both), cap enforced, off-allowlist skipped, citations carry finalUrl. → T2,T3 ∥
- **T6 [SEC+BE] Allowlist extension** (`server/knowledge/source-allowlist.ts`): add curated research hosts + cautious github prefixes; medium.com. Tests: new hosts allowed, punycode/port/userinfo still rejected, github still path-scoped. **Security-owned decision.** ∥
- **T7 [BE] GroundingStep** (`server/orchestrator/steps/ground-step.ts`): compose `OmniscienceBoardProvider`/`OmniscienceProvider`, no-op when flag off. Tests: flag off → `{grounded:false}` no call; flag on → uses `mock-omniscience-board.ts`. → T2 ∥

### Wave 2 — Engine (sequential core)
- **T8 [BE] OrchestratorAgent** (`server/orchestrator/orchestrator-agent.ts` + `orchestrator-config.ts`): bounded loop — plan turn (streamed) → validate → persist+WS+pause → execute steps via handlers → synthesize → settle/terminate with all §5 guards (token ceiling, wall-clock, abort→cancelled, scrub). Models `ManagerAgent`. Tests: plan parse+validate, token-ceiling termination, max-steps, wall-clock, abort path, fail action. → T3,T4,T5,T7
- **T9 [BE] Step handlers** (`server/orchestrator/steps/*.ts`) wiring each step type to its service + the analyze-code step (workspace tools via `team.execute`/`toolRegistry` with `workspaceDefaults`). Tests per handler with mocked services. → T8

### Wave 3 — Controller + routes
- **T10 [BE] Controller branch** in `pipeline-controller.ts`: `startOrchestratorRun` (creates rows, starts the agent on the run's `AbortController`), `approvePlan`/`rejectPlan` (resolve a pending handle like `approveStage`), settle/trace shape mirroring the manager branch; new ctor arg `orchestrator?`. Wire in `server/routes.ts:99`. Tests: start→pause→approve→execute→complete; cancel→cancelled; reject→cancelled. → T8
- **T11 [BE+SEC] Routes** `server/routes/orchestrator.ts` + register in `routes.ts`: 5 endpoints, zod bodies, owner-or-admin gate via run `triggeredBy`, rate-limit on start, 503 on kill-switch, `validateBody`. Tests: auth/owner 403, 404 missing, 429 rate-limit, 409 wrong-state, 503 disabled, happy paths. → T10,T2

### Wave 4 — FE (parallel; minimal, reuse run/WS surface)
- **T12 [FE] Plan panel**: render the proposed plan from `orchestrator:plan` WS + `GET /orchestrator`, Approve/Reject → the approve/reject endpoints; show projected cost (risk #4). Reuse the run-detail layout + existing WS hook. → T11
- **T13 [FE] Debate transcript + synthesis view**: consume the already-emitted `strategy:debate:round/judge` events + `GET /orchestrator/debates`; show recommendation/confidence/dissent + cited research (`GET /orchestrator/research`). A tab/section on the run view — no new heavy page. → T11

### Wave 5 — Quality gates
- **T14 [QA] Integration + E2E**: end-to-end orchestrator run on (a) a workspace-bound task and (b) a research-grounded task (mock gateway + mock omniscience + injected safe-fetch). Coverage ≥80% on new modules. → T9-T13
- **T15 [SEC] Security review**: SSRF (single allowlist, no parallel weak gate), bounded loops/tokens/sources, streamed timeout + abort→cancelled, tool-arg validation, MCP token env-only, no swallowed errors, scrubbed persistence. Sign-off gate. → all

**Parallelization:** Wave 0 (T1∥T2∥T3) → Wave 1 (T4∥T5∥T6∥T7) → Wave 2 (T8→T9) → Wave 3 (T10→T11) → Wave 4 (T12∥T13) → Wave 5 (T14,T15). Critical path: **T2/T3 → T8 → T10 → T11 → T14/T15**.

---

## 7. Risks & open questions (for the Lead)

1. **Gemini-Flash-via-antigravity is NOT truly streaming.** `antigravity.ts:111` `stream()` is *emulated* — it calls blocking `complete()` and yields once; no `streamEvents` channel. So the streaming idle/overall caps protect the **Opus** turns (claude-cli streams for real) but a Gemini-Flash debate turn is a single blocking CLI spawn (default 120s, `antigravity-cli.ts:49`). **Mitigation:** pass an explicit `timeoutMs` + the run `signal` on every Gemini turn (abort kills the child, `antigravity-cli.ts:143`). **Open question:** is a 120s blocking Gemini turn acceptable inside a 30-min orchestrator budget, or do we want a shorter per-turn cap / "fast-fail then Opus-only critic" fallback? Recommendation: explicit 90s per Gemini turn + 1 retry, then degrade that round to Opus-only critic.

2. **Debate convergence / termination.** `checkConsensus` (`strategy-executor.ts:702`) is crude (critic response < 15% of proposer length). For a cross-provider Opus↔Flash debate it may rarely trigger, so debates usually run the full `rounds` — bounded (good for cost) but possibly wasteful when convergence is early. **Open question:** accept full-rounds for MVP (simple, bounded), or add an Opus self-rated "converged" flag per round? Recommendation: full-rounds for MVP; Opus convergence flag in v2.

3. **How much `StrategyExecutor` is reuse vs extend?** `executeDebate` is **fully reusable as-is** for a 2–3 participant Opus↔Flash debate (cross-provider ordering, transcript, WS events all present). The ONLY gap: no per-call `signal`/streaming threading (it uses blocking `gateway.complete` at :215). **Decision needed:** (a) MVP — call it as-is (blocking debate turns, bounded by rounds + the agent wall-clock), zero edit to the shared executor used by the SDLC presets; OR (b) thread `StreamingStageOptions` through `StrategyExecutor` so Opus debate turns stream too. **Recommendation: (a) for MVP** (zero blast radius on the shared primitive); do (b) only if Opus debate turns hit the 120s blocking cap.

4. **Cost ceiling realism.** Default `maxTotalTokens=400k` with Opus (orchestrator+judge) across ~8 steps incl. a 3-round debate + research synthesis is a real spend. **Open question:** is 400k a sane default, and should we surface a *projected* cost (`estimateCostUsd` + `computeCostMultiplier`) on the plan-approval screen so the human gate is cost-informed? Recommendation: yes — show projected cost at the gate.

5. **Allowlist widening for "survey GitHub/Medium" is the sharpest security edge.** github.com is deliberately path-scoped (`source-allowlist.ts:38`, with an explicit warning against the weak string-only gate). A generic "survey 50+ GitHub repos" needs either (a) curated org/repo prefixes named per-run, or (b) host-level github — which I do **not** recommend. **Open question for Lead + Security:** which research hosts are in-scope, and do we accept curated-prefix GitHub only + host-level medium.com? Recommendation: curated prefixes only; medium.com host-level.

6. **Orchestrator config home.** I chose "an `orchestrator_runs` row marks a run as orchestrator-mode" to avoid touching `pipelineRuns`/`pipelines`. Alternative: add `orchestratorConfig jsonb` to `pipelines` (symmetry with `managerConfig`). The orchestrator is task-scoped per run, not template-scoped, so a per-run row fits better — **confirm**.

7. **Plan editing scope at the gate.** `approve-plan` accepts an optional replacement `steps[]`, re-validated through `plan-schema`. It lets a user inject a `research` step with URLs — but those still pass through `isAllowedSource`, so it's contained. **Confirm** plan-editing in MVP (recommendation: yes; cheap, and the safety gate holds).

---

## 8. Explicitly NOT in MVP (YAGNI)
- Parallel step execution (`parallelGroup`) — sequential only.
- Threading streaming into the shared `StrategyExecutor` (risk #3 option b).
- A bespoke orchestrator UI page — reuse the run view with two panels.
- A separate structured `ArbitratorVerdict` (would need a 3rd distinct model slug; §2.3).
- Re-planning mid-run (Opus revising the plan after a step) — the plan is fixed at approval.
- Multi-workspace / cross-repo research in one run.
