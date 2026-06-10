# Adaptive-Stability Deliberation Engine + `/consensus` cycle

Status: PROPOSED (DESIGN phase — no implementation here)
Branch: `feature/consensus-deliberation-engine` (off `main`, which has PR #366 streaming + novelty)
Author: Solution Architect
Date: 2026-06-10

---

## 1. Problem & decision

PR #366 shipped an **interim** debate early-termination: a novelty dry-streak with
`debateNoveltyPatience` defaulting to **K=1** (`server/orchestrator/debate-runner.ts`
+ `server/orchestrator/novelty-marker.ts`). The marker channel and its security
hardening (C-1 strip, C-2 trailing-text rejection, fail-open) are solid, but
**K=1 risks premature/forceful convergence**: the debate can stop after a single
"no new argument" round before the disagreement space is genuinely explored.

The user decision (2026-06-10) is to **UNIFY** termination into ONE
**adaptive-stability deliberation engine** that powers BOTH:

- **(a)** the existing orchestrator **debate** step — converge on the best *answer*;
- **(b)** a NEW **`/consensus`** cycle — converge on a decision *verdict*
  (`APPROVE | REQUEST_CHANGES | REJECT`), later wired to PR review / plan approval.

The interim K=1 novelty loop is **superseded** by this engine.

### Research backing (cite in code + ADR)

- **Du et al. 2305.14325** (multi-agent debate / "society of minds"): debate raises
  factuality and reasoning, but returns diminish quickly with rounds.
- **Adaptive stability detection 2510.12697**: **2–3 rounds is the sweet spot**.
  A 4th round buys ≈ +1% stability AND *degrades* weaker models via
  context-overload / forceful-agreement. **Adaptive stopping** — a judge with
  *double duty*: (i) PREVENT premature convergence by forcing debate until the
  disagreement space is explored, and (ii) extract the answer once stable —
  beats any fixed round count. Optimal ensemble is **5–7** participants.

These three facts map directly to engine invariants:

| Research fact | Engine mechanism |
|---|---|
| 2–3 rounds sweet spot | `hardCap` default **3**, max **5** (matches `HARD.maxDebateRounds`) |
| 4+ rounds degrade weak models | confidence-by-speed: round 4–5 stop ⇒ **low** confidence |
| Premature convergence is the failure mode | **min-rounds floor ≥ 2** — stability can't fire before round 2 |
| Adaptive > fixed | stop signal = **adaptive-stability judge double-duty**, not a counter |
| Ensemble 5–7 | `/consensus` fields **5–7 independent voters** |

---

## 2. Reuse map — what the engine *composes* vs what is *new*

### 2.1 Reused UNCHANGED (compose, never edit)

| Symbol / path | Role in the engine | Why it stays untouched |
|---|---|---|
| `StrategyExecutor.executeDebate` (`server/services/strategy-executor.ts:189`) | The **per-round primitive**. The engine calls it once per round with `rounds: 1, stopEarly: false` (so its internal `checkConsensus` at `strategy-executor.ts:259` never fires — the engine decides). | SDLC presets share this primitive (blast-radius rule). PR #366 already proved `git diff strategy-executor.ts` empty; we keep it that way. |
| `Gateway.completeStreaming` (`server/gateway/index.ts:696`) | Per-turn transport when `debateStreaming.enabled`: idle/overall timeout, byte-cap, abort, secret-scrub, `StreamingStageOptions`. | PR #364/#366 verbatim. The engine reuses the existing decorator switch in `DebateRunner.buildDecoratedGateway`. |
| `Gateway.complete` (`server/gateway/index.ts:270`) | Blocking transport when streaming is off; also the natural fan-out call for `/consensus` voters (mirrors `executeVoting` parallel `Promise.all` at `strategy-executor.ts:360`). | Existing, budget-aware, scrub-aware. |
| `TokenBudget` / `TokenCeilingError` (`server/orchestrator/orchestrator-config.ts:88-121`) | C2 token ceiling — `checkBefore()` before every LLM call, `add()` after. Absolute backstop for both entry shapes. | Already the C2 substrate. |
| `resolveCaps` + `HARD` (`server/orchestrator/orchestrator-config.ts:11-86`) | Runtime re-clamp of every cap (defense-in-depth, never trust config). Extended with consensus + min-rounds caps. | Established clamp idiom. |
| `scrubSecrets` / `scrubAndTruncate` (`server/gateway/secret-scrub.ts`) | M1 secret-scrub on every persisted verdict / transcript / error and on WS broadcast (`strategy-executor.ts:254`). | Established trust boundary. |
| `wrapUntrusted` / `wrapManyUntrusted` (`server/orchestrator/untrusted-content.ts`) | C3 framing of any fetched/external material in the decision text before it enters a prompt. | Established injection boundary. |
| Config schema/loader pattern (`server/config/schema.ts:163-235`, `server/config/loader.ts:144-172`) | zod-bounded blocks + `MULTI_PIPELINE_*` / `PIPELINE_*` env rows. New `consensus` + `deliberation.minRounds` blocks follow it exactly. | Established config idiom + kill-switch default-OFF precedent (`orchestrator.enabled=false`, `schema.ts:206`). |
| Orchestrator route + `authorizeRun` (`server/routes/orchestrator.ts:53-81`) | Owner-or-admin authZ (DENY ownerless), 503 kill-switch, rate-limit, generic errors. The `/consensus` route is a sibling using the *same* helper idiom. | Established authZ idiom. |
| `AbortController` / `isAbortError` lifecycle (`server/controller/pipeline-controller.ts:1233`, `server/controller/stage-progress.ts`) | C1 abort → `cancelled`, partial output never promoted (mirrors `OrchestratorAgent.settleCancelled`, `orchestrator-agent.ts:302`). | Established settle idiom. |

### 2.2 Reused with a SMALL, additive change

| Symbol / path | Change | Constraint |
|---|---|---|
| `DebateRunner` (`server/orchestrator/debate-runner.ts`) | Replace the **dry-streak break condition** (`dryStreak >= patience`, lines ~253-258) with a call into the new `DeliberationController.shouldStop(...)`. The decorator, streaming switch, Q1 degrade, C-1 strip, `runJudge` all stay. | `DebateRunInput` (`debate-runner.ts:79`) gains `minRounds` + `hardCap` (it already has `noveltyPatience`, `rounds`, `streamingDebate`). The outer loop shape (N single-round `executeDebate`) is unchanged. |
| `buildStepExecutors().debate` (`server/orchestrator/steps/index.ts:90`) | Pass `minRounds` + `hardCap` from `ctx.caps` into `debateRunner.run(...)`. Persist the new `confidence` + `stopReason` onto the existing `orchestratorDebates` row (column `confidence` real already exists at `shared/schema.ts:831`; add `stop_reason`). | Additive only. `rounds` already stripped of markers (C-1). |
| `orchestrator-config.ts` `HARD` + `OrchestratorCaps` + `resolveCaps` | Add `deliberationMinRounds` (HARD floor logic: `2 ≤ minRounds ≤ hardCap`), and a `resolveConsensusCaps` for the new run mode. | Re-clamp HARD at runtime; overrides only tighten (mirror `tighten()` at `orchestrator-config.ts:56`). |

### 2.3 Genuinely NEW modules

| New file | Responsibility |
|---|---|
| `server/orchestrator/deliberation/stop-policy.ts` | **Pure** function `decideStop(state): StopDecision`. min-rounds floor + adaptive-stability signal + hard cap + budget/time/abort backstops + `confidenceByConvergenceSpeed`. No I/O. The single source of termination truth for BOTH entry shapes. |
| `server/orchestrator/deliberation/stability-judge.ts` | The judge double-duty marker channel — **supersedes `novelty-marker.ts`'s single-bit question** with a richer one (§4.3). `buildStabilitySuffix()`, `parseStabilityMarker()` (last-sentinel + brace-match + zod `.strict()` + trailing-text rejection + fail-open — same hardening as `novelty-marker.ts:110-144`), `stripStabilityMarker()`. |
| `server/orchestrator/deliberation/deliberation-controller.ts` | Thin orchestration shared by debate + consensus: owns the round-loop contract, calls `decideStop`, surfaces `{ roundsRun, stopReason, confidence }`. Debate plugs its `executeDebate`-per-round here; consensus plugs its review-round here. |
| `server/consensus/consensus-engine.ts` | The `/consensus` cycle: blind verdict → parallel independent review → adjudication → 4-condition AND stop. Uses `DeliberationController` for round bookkeeping + `decideStop` for caps/confidence; uses `Gateway.complete` fan-out for voters. |
| `server/consensus/consensus-voters.ts` | Bounded N=5–7 fan-out over antigravity variants (independent, no cross-talk). Pure assembly of voter requests + `Promise.allSettled` collection + per-voter parse. |
| `server/consensus/critical-issue-ledger.ts` | **Pure** open/closed critical-issue ledger with mandatory dismissal-justification. `applyAdjudication(...)`, `allClosed(...)`. |
| `server/consensus/verdict-schema.ts` | zod schemas: `VerdictSchema` (`APPROVE|REQUEST_CHANGES|REJECT` + rationale), `VoterReviewSchema` (`{verdict, critical_issues[]}`), `AdjudicationSchema`. Fail-closed parse (a voter whose output won't parse counts as **non-approving**, never silently approving). |
| `server/consensus/consensus-controller.ts` | Lifecycle glue (mirrors `PipelineController.startOrchestratorRun`, `pipeline-controller.ts:1199`): create run, blind verdict, loop rounds, settle. |
| `server/routes/consensus.ts` | Additive HTTP surface (sibling of `server/routes/orchestrator.ts`). |
| `shared/schema.ts` additions | `consensus_runs`, `consensus_rounds`, `consensus_critical_issues` tables (§5). |
| `shared/types.ts` additions | `ConsensusVerdict`, `ConsensusRunStatus`, `StopReason`, `Confidence` unions (alongside `OrchestratorRunStatus` at `shared/types.ts:3026`). |

### 2.4 How the orchestrator debate step migrates (without touching `StrategyExecutor`)

```
orchestrator-agent.ts ─ dispatch("debate") ─▶ steps/index.ts debate()
   └─▶ DebateRunner.run({ ..., minRounds, hardCap, streamingDebate })
         └─ outer loop: for round 1..hardCap
              └─ executeDebate(strategy{rounds:1, stopEarly:false})   ← UNCHANGED primitive
              └─ decorator: C1/C2/Q1/streaming + parse stability marker (was novelty) + STRIP (C-1)
              └─ DeliberationController.shouldStop(state)  ← was `dryStreak >= patience`
                    └─ stop-policy.decideStop(...)        ← min-rounds floor + adaptive + cap + budget
         └─ ONE real runJudge over the marker-free aggregate (unchanged)
```

`StrategyExecutor.executeDebate` never learns the engine exists — it still runs one
round of proposer/critic + a short-circuited judge, exactly as in #366. The only
behavioral delta vs #366 is **where the loop decides to stop** (policy module
instead of an inline counter) and **min-rounds ≥ 2** so it can no longer stop at
round 1.

---

## 3. Engine architecture (shared by both entry shapes)

### 3.1 Two entry shapes, one stop policy

```
                         ┌─────────────────────────────────────────┐
                         │   stop-policy.decideStop(state)  (pure)  │
                         │   min-rounds floor >= 2                   │
                         │   + adaptive-stability signal             │
                         │   + hard cap (<=5, default 3)             │
                         │   + budget / time / abort backstops       │
                         │   + confidenceByConvergenceSpeed          │
                         └───────────────▲───────────────▲──────────┘
                                         │               │
          shape (a) DEBATE = best ANSWER │               │ shape (b) CONSENSUS = VERDICT
   per-round primitive: executeDebate    │               │ per-round body: blind→review→adjudicate
   stability signal: judge "explored &   │               │ stability signal: 4-condition AND (§4.4)
   stabilized?" marker                   │               │ + adjudicator verdict
   answer extraction: runJudge verdict   │               │ verdict extraction: Claude final APPROVE
```

`decideStop` is a **pure** function of an immutable `DeliberationState`. The same
module gates both shapes; only the *stability signal* differs (judge marker for
debate, the 4-condition AND for consensus). This is the unification the user asked
for.

### 3.2 The round loop (contract)

```ts
interface DeliberationState {
  readonly round: number;            // 1-based, the round that just completed
  readonly minRounds: number;        // floor, >= 2 (resolveCaps HARD-clamped)
  readonly hardCap: number;          // <= 5, default 3
  readonly stabilitySignal: StabilitySignal; // shape-specific (see below)
  readonly budgetExhausted: boolean; // TokenBudget.checkBefore would throw
  readonly elapsedMs: number;
  readonly overallTimeoutMs: number;
  readonly aborted: boolean;
}

type StabilitySignal =
  | { kind: "explored-and-stable" }   // debate judge double-duty says: done
  | { kind: "still-diverging" }       // disagreement space NOT yet explored
  | { kind: "consensus-met" }         // consensus 4-condition AND all true
  | { kind: "consensus-not-met" }
  | { kind: "indeterminate" };        // parse miss / fail-open -> treat as continue

type StopReason =
  | "stable"            // adaptive signal fired AFTER min-rounds floor
  | "hard-cap"          // hit hardCap rounds
  | "budget"            // token ceiling
  | "timeout"           // overall wall-clock
  | "aborted";          // C1

type Confidence = "high" | "medium" | "low";

interface StopDecision {
  readonly stop: boolean;
  readonly reason?: StopReason;       // only when stop === true
  readonly confidence?: Confidence;   // only when stop === true
}
```

`decideStop` precedence (deterministic, testable):

1. `aborted` → `{stop:true, reason:"aborted", confidence:"low"}` (C1 absolute).
2. `budgetExhausted` → `{stop:true, reason:"budget", confidence:"low"}` (C2 absolute).
3. `elapsedMs > overallTimeoutMs` → `{stop:true, reason:"timeout", confidence:"low"}`.
4. **min-rounds floor**: if `round < minRounds` → `{stop:false}` **regardless** of
   the stability signal. *This is the anti-premature guarantee.* A "stable" signal
   at round 1 cannot stop the debate.
5. stability signal is a stop kind (`explored-and-stable` / `consensus-met`) →
   `{stop:true, reason:"stable", confidence: confidenceBySpeed(round)}`.
6. `round >= hardCap` → `{stop:true, reason:"hard-cap", confidence:"low"}`
   (we never converged; low by definition).
7. else `{stop:false}`.

### 3.3 confidence-by-convergence-speed

```ts
function confidenceBySpeed(round: number): Confidence {
  // Only reached AFTER the min-rounds floor (step 4 above), so "fast = high"
  // can NEVER be awarded for a premature round-1 stop.
  if (round <= 2) return "high";   // stable by round 2 = strong agreement
  if (round === 3) return "medium";
  return "low";                    // 4-5 = research says weak-model degradation risk
}
```

The user's nuance is encoded structurally: `confidenceBySpeed` is *only ever called
from step 5*, which is *only reachable once `round >= minRounds (>=2)`*. So "fast =
high" is literally unreachable before the floor is satisfied. A `hard-cap` stop is
always `low`. A backstop stop (budget/timeout/abort) is always `low`.

### 3.4 What survives from #366's novelty marker

- **Survives**: the marker *mechanism* (last-sentinel-wins, brace-match,
  zod `.strict()`, trailing-text rejection, **fail-open**, strip-before-broadcast/
  persist C-1, miss telemetry as bounded enum H-1). These are correctness/security
  primitives we keep verbatim in `stability-judge.ts`.
- **Replaced**: the marker's *question*. #366 asks a single bit
  (`newArgument: boolean`, `novelty-marker.ts:39`). The stability judge asks the
  **double-duty** question (§4.3): not just "did THIS turn add a new argument?" but
  "has the disagreement been *explored* AND has it *stabilized*?" — i.e. it can
  answer "no new argument this turn BUT the space isn't explored yet → keep going",
  which K=1 novelty cannot express. `novelty-marker.ts` is retired once
  `debate-runner.ts` points at `stability-judge.ts`; its tests are ported as
  regression coverage for the shared parser hardening.
- **Open question for Lead** (see §10): keep `novelty-marker.ts` as a thin
  re-export shim for one release, or delete outright. Recommendation: delete and
  port tests — `grep` confirms only `debate-runner.ts` imports it.

---

## 4. `/consensus` cycle — data model + protocol

The consensus cycle reaches a **decision verdict** on a freeform
"decision/plan/proposal". It is a **sibling** run mode that *reuses* `decideStop`
(caps/confidence/backstops) and the `DeliberationController` round bookkeeping, but
its per-round body is the 4-step protocol below, NOT `executeDebate`.

### 4.1 Protocol (per round)

```
Round r:
  ┌─ (only r === 1) ─────────────────────────────────────────────────────────┐
  │ 1. BLIND VERDICT  (Claude = claude-opus)                                   │
  │    Claude records {verdict, rationale} for the decision text ALONE.        │
  │    PERSISTED to consensus_rounds(round=1, phase="blind") BEFORE step 2.    │
  │    Structural guarantee: the DB write is awaited + the voter fan-out is     │
  │    only constructed AFTER that write resolves (see §4.2).                  │
  └────────────────────────────────────────────────────────────────────────────┘
  2. PARALLEL INDEPENDENT REVIEW (N = 5..7 external voters)
     Each voter receives ONLY: the (C3-wrapped) decision text + the current plan
     revision. NO voter sees Claude's verdict, and NO voter sees another voter's
     output. Returns {verdict, critical_issues[]}. Promise.allSettled fan-out.
  3. ADJUDICATION (Claude)
     Claude reads all voter reviews, may rewrite the plan, opens/closes ledger
     issues. Dismissing any OPEN critical issue REQUIRES a written justification
     (verdict-schema enforces a non-empty `dismissal_justification`); a dismissal
     without justification fails-closed (issue stays OPEN). Claude emits its
     (possibly revised) verdict + the adjudication record.
  4. STOP CHECK  (decideStop with the consensus stability signal — §4.4)
     If not stopping → next round (re-review the revised plan).
```

### 4.2 Blind-verdict-before-review structural guarantee (anti-anchoring)

The integrity property is "Claude commits its verdict before it can see any external
opinion." Enforced **structurally**, not by convention:

1. `consensusEngine.blindVerdict(decisionText)` calls `gateway.complete` with a
   prompt that contains *only* the C3-wrapped decision text (no voter slot exists in
   that prompt — the voters have not run).
2. The result is **persisted** via `storage.createConsensusRound({round:1,
   phase:"blind", claudeVerdict, claudeRationale})` and that promise is `await`ed.
3. The persisted row is **immutable for the blind phase**: `consensus_rounds` has a
   unique `(run_id, round, phase)` and the engine *never* issues an `UPDATE` to a
   `phase="blind"` row. A later round cannot back-edit round 1's blind verdict.
4. ONLY after (2) resolves does the engine call `consensusVoters.fanOut(...)`. The
   voter requests are *constructed* after the blind write, so there is no code path
   where a voter opinion exists before the blind verdict is committed.
5. Test (deterministic): inject a storage double whose `createConsensusRound`
   records call-order; assert the blind write index < the first voter `complete`
   call index. (See §9 T-CONS-1.)

### 4.3 Multi-voter fan-out (independent, bounded N=5–7)

Voters are realized as **antigravity provider variants** so "no self-approval" is
*real* — they are genuinely different models from Claude and from each other. The
slugs are the `slugifyModelLabel()` outputs (`server/gateway/providers/antigravity.ts:33`)
of the `agy models` labels (documented in `antigravity-cli.ts:22,46`):

| Label (`agy models`) | slug (`slugifyModelLabel`) |
|---|---|
| `Gemini 3.1 Pro (High)` | `gemini-3-1-pro-high` |
| `Gemini 3.1 Pro (Low)` | `gemini-3-1-pro-low` |
| `Gemini 3.5 Flash (High)` | `gemini-3-5-flash-high` |
| `Gemini 3.5 Flash (Medium)` | `gemini-3-5-flash-medium` |
| `Gemini 3.5 Flash (Low)` | `gemini-3-5-flash-low` |
| `GPT OSS 120B` | `gpt-oss-120b` |

Default ensemble = **5** voters, configurable **5–7** (`consensus.voterCount`,
zod `.min(5).max(7)`, `resolveCaps` HARD-clamp). The applied set is the configured
count taken from a fixed ordered roster (above) so the run is reproducible; the
roster is intersected with live `listModels()` so a missing CLI model degrades the
count (never silently substitutes Claude). **Independence is structural**:

- Each voter request is assembled **independently** from `{decisionText, planRev}` —
  there is no shared mutable conversation, no voter sees `claudeVerdict`, and the
  fan-out is `Promise.allSettled` (one voter's output is never threaded into
  another's prompt). Test asserts every voter prompt is byte-identical modulo the
  pinned model slug, and contains neither Claude's verdict nor any sibling's review.
- A voter whose output fails `VoterReviewSchema` parse is recorded as
  `{verdict: "REQUEST_CHANGES", parseError: <bounded enum>}` — **fail-closed**: an
  unparseable voter can never count as an APPROVE.
- Fan-out is bounded: `min(voterCount, roster∩live)`; each voter call is C2-budgeted
  (`budget.checkBefore()` / `add()`) and carries C1 signal + `voterTimeoutMs`. The
  antigravity CLI already caps concurrency at 4 (`antigravity-cli.ts:55`), so a 5–7
  fan-out queues safely (in waves).

### 4.4 The 4-condition AND stop

Consensus stops (signal kind `consensus-met`) **only when ALL hold simultaneously**:

1. **>= 1 external APPROVE** — at least one independent voter approved this round;
2. **none REJECT** — no voter returned `REJECT`;
3. **all critical issues closed** — `criticalIssueLedger.allClosed()` is true
   (every opened issue is either resolved by a plan edit or dismissed *with*
   justification);
4. **Claude's final verdict === APPROVE** for the current plan revision.

If any condition is false → `consensus-not-met` → next round. **Claude's own vote
ALONE cannot carry a round**: condition (1) requires an *external* APPROVE, so even
if Claude approves, the round does not stop without independent corroboration. This
is the structural "no self-approval" guarantee, tested directly (§9 T-CONS-3).

`decideStop` then applies the same precedence as §3.2: the `consensus-met` signal is
*ignored until `round >= minRounds (>=2)`* (consensus also cannot rubber-stamp on
round 1), and confidence-by-speed applies identically.

### 4.5 Unresolved-on-cap

If `round >= consensus.maxRounds` (≤5) without a `consensus-met` signal, the run
settles `status: "unresolved"` with `stopReason: "hard-cap"`, `confidence: "low"`,
and the open critical-issue ledger persisted. Never auto-approved on exhaustion.

---

## 5. `/consensus` persistence (new tables, mirror `orchestrator_*`)

All key on `runId → pipelineRuns.id ON DELETE cascade`; ownership + workspace
scoping inherited from the parent run (`triggeredBy + workspaceId`), exactly like
`orchestratorRuns` (`shared/schema.ts:751-775`). All persisted string fields pass
through `scrubSecrets` (M1) before write. Timestamps use the repo's Drizzle
convention (`timestamp(...).defaultNow()`, JS `Date`), matching
`orchestratorRuns.createdAt` (`shared/schema.ts:768`).

```
consensus_runs
  id, run_id (unique, fk->pipeline_runs cascade)
  decision_text            text  NOT NULL   (the proposal; scrubbed)
  subject_kind             text  ('freeform' | 'pr' | 'plan')   -- additive, freeform now
  subject_ref              text  nullable    (e.g. PR url / plan id, later)
  status                   text  ('deliberating'|'resolved'|'unresolved'|'failed'|'cancelled')
  rounds_run               int   default 0
  stop_reason              text  nullable    (StopReason)
  confidence               text  nullable    (Confidence)
  final_verdict            text  nullable    (ConsensusVerdict)
  voter_count              int   default 0
  total_tokens_used        int   default 0
  created_at, completed_at

consensus_rounds
  id, run_id (fk cascade), round int, phase text ('blind'|'review'|'adjudication')
  claude_verdict           text  nullable    (set on blind + adjudication phases)
  claude_rationale         text  nullable    (scrubbed)
  voter_reviews            jsonb nullable     (review phase: [{voterSlug, verdict, criticalIssues[], parseError?}])
  adjudication             jsonb nullable     (adjudication phase: {revisedPlan?, opened[], closed[], dismissals[]})
  tokens_used              int   default 0
  created_at
  UNIQUE (run_id, round, phase)              -- blind row immutable (§4.2)

consensus_critical_issues
  id, run_id (fk cascade)
  issue_key                text  NOT NULL    (stable id, e.g. hash of issue text)
  raised_by                text  NOT NULL    (voterSlug)
  summary                  text  NOT NULL    (scrubbed)
  status                   text  ('open'|'closed')
  resolution               text  ('fixed'|'dismissed') nullable
  dismissal_justification  text  nullable    (REQUIRED when resolution='dismissed')
  opened_round             int
  closed_round             int   nullable
  UNIQUE (run_id, issue_key)
```

`IStorage` additions (mirror `createOrchestratorRun` etc. at `server/storage.ts:302-315`):
`createConsensusRun`, `getConsensusRun`, `updateConsensusRun`, `createConsensusRound`,
`getConsensusRounds`, `upsertConsensusIssue`, `getConsensusIssues`. `MemStorage`
in-memory impl mirrors the `orchestratorRunsMap` doubles (`storage.ts:1515`) for tests.

---

## 6. API + surface (additive)

There is **no client-side slash-command registry** in this repo — "commands" are
authenticated HTTP routes under the `requireAuth` `/api/runs` prefix (the
orchestrator route is the precedent). So **`/consensus` = an additive HTTP API**,
plus an optional docs/skill entry; the user's "skill/command + API endpoint?" is
answered as: **API endpoint is primary**; a thin `consensus` skill/command doc can
wrap it later (no new client subsystem needed for MVP).

New routes in `server/routes/consensus.ts` (sibling of `orchestrator.ts`, same
`authorizeRun`-style helper, generic errors, rate-limited via
`checkManagerRunRateLimit`, `runs.js`):

| Method + path | Auth | Body / effect |
|---|---|---|
| `POST /api/runs/consensus` | requireAuth + kill-switch (503 if `consensus.enabled=false`) + rate-limit + owner-gate any `workspaceId` | `{ decisionText: string<=50_000, subjectKind?, subjectRef?, workspaceId?, caps? }` → creates the run, runs blind verdict + first review round, returns `{ runId, consensusRunId, status }`. |
| `GET  /api/runs/:id/consensus` | `authorizeRun` (owner-or-admin, DENY ownerless) | run summary: status, roundsRun, finalVerdict, confidence, voterCount. |
| `GET  /api/runs/:id/consensus/rounds` | `authorizeRun` | per-round transcripts (blind/review/adjudication), scrubbed. |
| `GET  /api/runs/:id/consensus/issues` | `authorizeRun` | the critical-issue ledger (open/closed + dismissal justifications). |

The run executes server-side to completion (bounded; §8) like the orchestrator —
MVP has **no human gate** mid-cycle (the cycle *is* the deliberation). A future
PR-review wiring can add an approval gate, but that is out of scope and additive.

Owner-scoping + what it operates on: the run is owned by `req.user.id`
(`triggeredBy`); transcripts are never world-readable (DENY ownerless, mirroring
`orchestrator.ts:73-78`). `decisionText` is treated as **untrusted** and C3-wrapped
before any prompt; if `subjectKind` later fetches material (a PR diff), that fetch
goes through the same `wrapUntrusted` boundary.

---

## 7. Config (zod-bounded + env)

Two additive blocks in `server/config/schema.ts` `pipeline`, matching the
`orchestrator` / `debateStreaming` pattern (`schema.ts:188-234`):

```ts
// pipeline.deliberation — shared min-rounds floor for the unified engine.
deliberation: z.object({
  /** Min rounds before any stability/consensus stop can fire. 2..5. ANTI-PREMATURE. */
  minRounds: z.coerce.number().int().min(2).max(5).default(2),
}).default({}),

// pipeline.consensus — the /consensus run mode. Kill-switch default FALSE.
consensus: z.object({
  /** Kill-switch: false → POST /api/runs/consensus returns 503. */
  enabled: z.boolean().default(false),
  /** Max consensus rounds before "unresolved". 1..5 (matches HARD cap). */
  maxRounds: z.coerce.number().int().min(1).max(5).default(3),
  /** Independent external voters per round (ensemble 5-7). */
  voterCount: z.coerce.number().int().min(5).max(7).default(5),
  /** Token ceiling for the whole cycle (C2). 1000..2M. */
  maxTotalTokens: z.coerce.number().int().min(1000).max(2_000_000).default(400_000),
  /** Wall-clock cap for the whole cycle. 10s..1h (30min default). */
  overallTimeoutMs: z.coerce.number().int().min(10_000).max(3_600_000).default(1_800_000),
  /** Per-voter / per-turn timeout. 1s..10min (90s default). */
  voterTimeoutMs: z.coerce.number().int().min(1_000).max(600_000).default(90_000),
}).default({}),
```

`server/orchestrator/orchestrator-config.ts`:
- `HARD` gains `deliberationMinRounds: 5` (and the floor is *also* re-derived as
  `min(minRounds, hardCap)` so min can never exceed the cap);
- `resolveCaps` clamps `deliberationMinRounds` to `[2, maxDebateRounds]`;
- a new `resolveConsensusCaps(config, overrides)` returns `ConsensusCaps`
  (maxRounds/voterCount/tokens/timeouts) with the same HARD re-clamp + tighten-only
  override semantics (reusing `clamp()`/`tighten()` at `orchestrator-config.ts:50-60`).

`server/config/loader.ts` env rows (both `MULTI_PIPELINE_*` and `PIPELINE_*`
aliases, mirroring `loader.ts:144-172`):
`MULTI_PIPELINE_DELIBERATION_MIN_ROUNDS`,
`MULTI_PIPELINE_CONSENSUS_ENABLED`, `_MAX_ROUNDS`, `_VOTER_COUNT`,
`_MAX_TOTAL_TOKENS`, `_OVERALL_TIMEOUT_MS`, `_VOTER_TIMEOUT_MS`.

---

## 8. Cost / runaway + security framing

| Concern | Control | Where |
|---|---|---|
| Runaway rounds | `hardCap` ≤ 5 (default 3) re-clamped HARD; `decideStop` step 6 | `stop-policy.ts`, `resolveCaps` |
| Runaway voters | `voterCount` 5–7 zod + HARD clamp; fan-out `= min(count, roster∩live)`; CLI concurrency cap 4 | `consensus-voters.ts`, `antigravity-cli.ts:55` |
| Token runaway | `TokenBudget.checkBefore()` before **every** LLM call (blind, each voter, each adjudication, judge) + `maxTotalTokens` | `orchestrator-config.ts:102`, engines |
| Wall-clock runaway | `overallTimeoutMs` checked each round; `decideStop` step 3 | `stop-policy.ts` |
| Abort | C1 signal threaded everywhere; `decideStop` step 1 → `cancelled`; partial never promoted | engines + settle helpers |
| **Blind-verdict integrity** | DB write awaited before voter fan-out is constructed; `(run_id,round,phase)` unique + never UPDATE a `blind` row (no back-edit after seeing others) | §4.2, `consensus-engine.ts` |
| **Voter independence** | each request assembled from `{decisionText, planRev}` only; no shared conversation; no `claudeVerdict` or sibling review in any voter prompt; `Promise.allSettled` | `consensus-voters.ts` |
| **No self-approval** | 4-condition AND requires ≥1 *external* APPROVE; Claude's vote alone can't carry a round | `consensus-engine.ts` §4.4 |
| **Mandatory dismissal justification** | `verdict-schema` requires non-empty `dismissal_justification` to close an issue as `dismissed`; missing → fail-closed, issue stays OPEN | `critical-issue-ledger.ts`, `verdict-schema.ts` |
| Untrusted decision text | `wrapUntrusted` C3 before any prompt; structural control never derived from wrapped content | `untrusted-content.ts` |
| Secret leakage | `scrubSecrets` on every persisted verdict/transcript/issue + WS; `scrubAndTruncate` on errors | `secret-scrub.ts` |
| Prompt-injection of the stability/consensus marker | last-sentinel + brace-match + trailing-text rejection + zod `.strict()` + **fail-open** (debate) / **fail-closed** (voter verdict) | `stability-judge.ts`, `verdict-schema.ts` |
| Fail direction | debate stability marker fails **OPEN** (miss → keep debating, can only extend); voter/adjudication verdicts fail **CLOSED** (unparseable → non-approving, can never rubber-stamp) | both |
| **Kill-switch** | `consensus.enabled` default **FALSE** → route 503 + controller refuses; engine not constructed | `schema.ts`, `consensus-controller.ts`, route |
| No swallowed errors | every settle path persists a scrubbed reason; voter parse errors recorded as bounded enums (never raw text, mirrors H-1 at `debate-runner.ts:266`) | engines |

Worst-case cost is bounded: `rounds (≤5) × (1 adjudication + voterCount (≤7) voters)
+ 1 blind` LLM calls, each under `voterTimeoutMs` and the shared `maxTotalTokens`
ceiling — i.e. ≤ ~46 bounded calls for the absolute max config, and the
`TokenBudget` cuts it off earlier if tokens exhaust.

---

## 9. Task breakdown (ordered, file-owned, small units, TDD)

Each unit is RED→GREEN→REFACTOR, ≥80% coverage on changed modules, `tsc --noEmit`
clean (`npm run check`), no `any`, immutable, explicit errors. Tests run via
`npm run test:unit`; the route via `npm run test:integration`. Server is run on the
host (`make dev` / `npm run dev`), never Docker.

### Phase A — Shared stop policy (foundation, pure, no I/O)

- **A1 [BE] `stop-policy.ts`** — `decideStop(state): StopDecision` + `confidenceBySpeed`.
  Pure. Owner: backend.
  - Tests (deterministic, no timers — pure): **T-STOP-1** min-rounds floor blocks a
    `explored-and-stable` signal at round 1 (`stop:false`); **T-STOP-2** same signal
    at round 2 → `stop:true reason:"stable" confidence:"high"`; T-STOP-3 round 3 →
    `medium`; T-STOP-4 round 4/5 → `low`; T-STOP-5 hard-cap stop → `low`; **T-STOP-6**
    budget/timeout/abort precedence over a stop signal → respective reason + `low`;
    T-STOP-7 `consensus-met` gated by floor identically.
- **A2 [BE] `stability-judge.ts`** — port `novelty-marker.ts` hardening; new
  double-duty schema. Owner: backend.
  - Tests: port the `novelty-marker.test.ts` cases (last-sentinel, brace-match,
    trailing-text fail-open, `.strict()`, strip) onto the new schema; add T-STAB-1
    "no-new-argument-but-not-explored" parses to `still-diverging` (the case K=1
    couldn't express).

### Phase B — Migrate the debate step onto the engine (no `StrategyExecutor` edit)

- **B1 [BE] `orchestrator-config.ts`** — add `deliberationMinRounds` to `HARD` +
  `OrchestratorCaps` + `resolveCaps` clamp `[2, maxDebateRounds]`; `min ≤ cap` invariant.
  - Tests (extend `resolve-caps.test.ts`): clamp 1→2, 9999→cap, NaN→2, `minRounds`
    never exceeds `maxDebateRounds`.
- **B2 [BE] `deliberation-controller.ts`** — round-loop contract + `shouldStop`
  delegating to `decideStop`. Owner: backend.
- **B3 [BE] `debate-runner.ts`** — swap the inline `dryStreak >= patience` break
  (lines ~253-258) for `DeliberationController.shouldStop(...)`; thread
  `minRounds`/`hardCap`; point the decorator's marker parse at `stability-judge.ts`.
  Decorator/streaming/Q1/C-1/`runJudge` unchanged. Owner: backend.
  - Tests (extend `debate-runner.test.ts`, fake timers): **T-DEB-1** cannot stop
    before round 2 even with an immediate stable signal (anti-premature); T-DEB-2
    stable at round 2 stops with `high`; T-DEB-3 hard-cap stop at 3; T-DEB-4
    streaming Q1 degrade still works; **T-DEB-5** C-1 strip still holds (marker
    absent from rounds + WS); T-DEB-6 abort/budget backstops still fire.
- **B4 [BE] `steps/index.ts`** — pass `minRounds`/`hardCap`; persist `confidence` +
  `stop_reason` onto the debate row. Owner: backend.
  - Tests (extend `step-handlers.test.ts`): forwarding + persisted hygiene (no marker).
- **B5 [BE] retire `novelty-marker.ts`** — delete; confirm no other importer
  (`grep` shows only `debate-runner.ts`). Owner: backend.

### Phase C — `/consensus` core (pure → engine → lifecycle)

- **C1 [Security/BE] `verdict-schema.ts`** — zod `VerdictSchema`/`VoterReviewSchema`/
  `AdjudicationSchema`; fail-closed parse. Owner: backend (security reviews).
  - Tests: unparseable voter → `REQUEST_CHANGES` + bounded enum; dismissal without
    justification rejected.
- **C2 [BE] `critical-issue-ledger.ts`** — pure open/closed + dismissal. Owner: backend.
  - Tests: T-LEDG-1 open issue stays open until fixed or justified-dismissed;
    T-LEDG-2 `allClosed()` false while any open; **T-LEDG-3** dismiss requires
    justification.
- **C3 [BE] `consensus-voters.ts`** — bounded N=5–7 fan-out over the antigravity
  roster; independent assembly; `Promise.allSettled`; C2/C1/timeout per voter. Owner: backend.
  - Tests: **T-CONS-FANOUT-1** fan-out bounded to `min(count, roster∩live)`;
    **T-CONS-FANOUT-2** every voter prompt independent (no `claudeVerdict`, no
    sibling review); T-CONS-FANOUT-3 a failed voter (rejected promise) doesn't sink
    the round.
- **C4 [BE] `consensus-engine.ts`** — blind → review → adjudication → 4-condition AND;
  `decideStop` for caps/confidence; unresolved-on-cap. Owner: backend.
  - Tests: **T-CONS-1** blind verdict persisted *before* first voter `complete`
    (call-order assertion via storage double); **T-CONS-3** Claude APPROVE alone with
    zero external APPROVE does NOT stop (no self-approval); T-CONS-4 stop only when all
    4 conditions true; **T-CONS-5** min-rounds floor blocks a round-1 consensus;
    **T-CONS-6** unresolved at `maxRounds`; T-CONS-7 a `REJECT` voter blocks stop.
- **C5 [BE] `consensus-controller.ts`** + `IStorage`/`MemStorage` additions + schema
  tables + `shared/types.ts` unions. Owner: backend.
  - Tests: lifecycle settle paths (resolved/unresolved/cancelled/failed); abort →
    cancelled, partial never promoted; blind row never UPDATEd.

### Phase D — Config + route + security hardening

- **D1 [BE] `schema.ts` + `loader.ts`** — `deliberation` + `consensus` blocks + env rows.
  - Tests (extend `config.test.ts` / new `consensus-schema.test.ts`): bounds enforced;
    env override; kill-switch default false.
- **D2 [BE] `routes/consensus.ts`** + register under `/api/runs`. Owner: backend.
  - Tests (integration): 503 when disabled; 401/404/403 ordering (DENY ownerless);
    workspace owner-gate; rate-limit; generic errors.
- **D3 [Security] review gate** — security-expert verifies, each with a backing test:
  blind-verdict-before-review (T-CONS-1), voter independence (T-CONS-FANOUT-2),
  no-self-approval (T-CONS-3), dismissal-justification (T-LEDG-3, C1), bounded
  rounds/voters/tokens, secret-scrub on persisted rows, kill-switch off, fail-open
  (debate) vs fail-closed (voter), C3 framing of decision text, no swallowed errors.
- **D4 [QA] end-to-end deterministic harness** — drive `/consensus` with a stubbed
  gateway returning scripted voter verdicts to exercise: converge-at-round-2 (high),
  unresolved-at-cap, and a poisoned `decisionText` (forged marker / forged END
  delimiter) proving structural control is unmoved.

### Phase E — Docs + ADR

- **E1 [BE/doc]** the "Decisions" section below is the authoritative ADR record; add
  a short cross-link from the orchestrator docs. Optional thin `consensus`
  command/skill doc wrapping `POST /api/runs/consensus`.

Suggested merge order: A → B (debate fully migrated + green, an independently
shippable PR if the Lead wants to split) → C → D → E. Phase B is self-contained and
could land first to remove the premature-convergence risk immediately.

---

## 10. Risks / open questions for the Lead

1. **Sibling vs shared loop (the central architectural call).** This design makes
   `decideStop` (caps + min-rounds floor + confidence) the **shared** core, but
   `/consensus` keeps its **own per-round body** (blind→review→adjudicate) rather
   than reusing `executeDebate`. Rationale: consensus rounds are *structurally
   different* (parallel independent voters + an adjudicator + a ledger), not
   proposer/critic turns; forcing them through `executeDebate` would distort the
   primitive (and we are forbidden to touch it). **Confirm**: shared *policy*,
   sibling *bodies* — agreed? The alternative (one loop, consensus as a "strategy")
   would pressure `StrategyExecutor`.
2. **How much of `novelty-marker.ts` survives.** Recommendation: the *mechanism*
   (parser hardening) survives verbatim in `stability-judge.ts`; the single-bit
   *question* is replaced by the double-duty question; `novelty-marker.ts` is
   deleted (only `debate-runner.ts` imports it). **Confirm** delete vs keep a
   one-release re-export shim. Also: the `debateNoveltyPatience` config key
   (`schema.ts:233`) — keep as a deprecated alias mapping to nothing, or remove?
   (Removing is cleaner; it only landed in #366 days ago.)
3. **Antigravity voter latency + independence under the emulated stream.** The
   `agy` CLI is one-shot and `stream()` *emulates* streaming by yielding the full
   completion once (`antigravity.ts:114-121`), and concurrency is capped at 4
   (`antigravity-cli.ts:55`). So a 5–7 voter fan-out **serializes in waves of 4**,
   adding latency, and per-voter "streaming" gives no early-token benefit.
   **Confirm**: (a) wave-serialized latency is acceptable for an async, bounded
   `/consensus` run (I believe yes — it is not interactive), and (b) voters use
   blocking `complete` (simpler, no false streaming benefit) — this design assumes
   **yes, blocking `complete` for voters**, reserving `completeStreaming` for the
   long Claude turns (blind/adjudication) where idle-reset matters.
4. **Voter "independence" vs identical-prompt determinism.** Voters get
   byte-identical prompts (modulo model slug) for testability, so diversity comes
   *only* from model variance, not prompt variance. Acceptable? An alternative is
   lightly role-varied prompts (e.g. "focus on security" vs "focus on correctness")
   to widen coverage — but that complicates the independence test. This design picks
   **identical prompts, model-variance diversity** for MVP.
5. **Min-rounds for consensus vs debate.** Both share `deliberation.minRounds=2`.
   For consensus, a min of 2 means even a unanimous round-1 APPROVE forces a second
   review round. Is that the intended anti-rubber-stamp strength, or should
   consensus have its own (possibly =1) floor? This design applies the floor
   uniformly (strongest anti-premature stance); flag if consensus should be allowed
   a fast single-round approve.
6. **Where the consensus engine is owned.** This design hangs it off
   `PipelineController` (like the orchestrator) for run lifecycle + `activeRuns`
   abort registry reuse, but it could be a standalone `ConsensusController`.
   Confirm placement (affects `server/routes.ts` wiring + DI).
7. **PR/plan wiring (explicitly out of scope here).** `subjectKind`/`subjectRef`
   columns are reserved so a later PR can feed a real PR diff (fetched + C3-wrapped)
   without a migration. Confirm we keep MVP **freeform-only** and defer the
   PR-review gate.

---

## Decisions (ADR-style record)

- **D-1**: One **shared stop policy** (`decideStop`, pure) gates both entry shapes;
  the **min-rounds floor ≥ 2** is the structural anti-premature-convergence
  guarantee; `confidenceBySpeed` is only reachable *after* the floor, so "fast =
  high" can never reward a round-1 stop.
- **D-2**: `StrategyExecutor.executeDebate` stays **byte-for-byte unchanged**; the
  debate step migrates by swapping only the loop's stop condition. SDLC presets
  unaffected (they never pass through `DebateRunner`).
- **D-3**: The novelty marker's *security mechanism* is preserved (now in
  `stability-judge.ts`); its single-bit *question* is replaced by the judge's
  double-duty "explored AND stabilized?" question.
- **D-4**: `/consensus` is a **sibling** run mode (own per-round body) that reuses
  the shared policy + `Gateway` + budget + scrub + authZ. It is an **additive HTTP
  API** (no client slash-command subsystem exists); kill-switch default **OFF**.
- **D-5**: Anti-rubber-stamp is **structural + tested**: blind verdict committed
  before review (DB-ordered), independent fan-out, ≥1 *external* APPROVE required
  (no self-approval), mandatory written dismissal justification, voter verdicts
  fail **closed**.
- **D-6**: Voters are **5–7 antigravity variants** (`gemini-3-1-pro-high/low`,
  `gemini-3-5-flash-high/medium/low`, `gpt-oss-120b`) so cross-model independence is
  real; blocking `complete` for voters (emulated stream gives no benefit), with C2
  budget + C1 abort + per-voter timeout.
