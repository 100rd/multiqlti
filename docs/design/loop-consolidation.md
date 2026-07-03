# Design: One Cycle (Loop) — assess → plan → implement → converge

> Status: **proposal / evolving**. This is a living design we will refine as we test.
> It consolidates today's overlapping entities into a single user-facing unit of work
> and defines how agents inside it do a real software-development life cycle (SDLC).

## 1. Problem — entity proliferation

Today the platform exposes several overlapping concepts as co-equal, top-level things:

| Entity | What it really is | Layer |
|---|---|---|
| **Pipeline** | a recipe of steps (CLI/LLM stages) for *one* task | low — "how a step runs" |
| **Task group** | a DAG of tasks + iterations; a consilium dispute *is* a task group | mid — "a run" |
| **Consilium loop** | an FSM over a task group: review → decide → develop → re-review | high — "a lifecycle" |
| **execute-sdlc** *(recently added)* | "code the verdict's action points → Draft PR" | a 4th object I should not have added |

A user should not have to reason about *pipeline vs task-group vs loop vs SDLC*. There are
really only **two genuine ideas** — a *run* (task group, whose template is a pipeline) and a
*lifecycle* (loop) — and `execute-sdlc` bolted a third object onto the side. Worse, that
side-object is **invisible**: a live run coded 13 commits, then its push/PR failed silently
with no page to observe state, error, or recovery. That failure is the clearest argument for
this consolidation.

## 2. Principle

- **One top-level entity: the Loop** (the full cycle). The user opens *a cycle*, not a
  pipeline/task-group/SDLC.
- **SDLC is a methodology, not an object** — a *generated, criteria-grounded plan of skilled
  steps* that lives **inside** the loop's implementation phase.
- **Pipeline and task group are internal/advanced machinery** — the step engine and the
  planning substrate respectively. They stay, but leave the primary navigation.
- **Branch dynamically *inside* the one entity**, not by adding new entities.

## 3. The model — phases of one Loop

```
        ┌──────────────────────── one LOOP ────────────────────────┐
        │                                                            │
  ┌─────▼─────┐   ┌──────────────┐   ┌──────────────────┐   ┌───────▼────────┐
  │  ASSESS   │──▶│     PLAN     │──▶│    IMPLEMENT     │──▶│    CONVERGE    │
  │ discover  │   │ specify +    │   │ skilled agents + │   │ all acceptance │
  │ problems  │   │ choose skills│   │ controllers,     │   │ criteria       │
  │ (dispute) │   │ (intent)     │   │ iterate to green │   │ verified       │
  └───────────┘   └──────────────┘   └──────────────────┘   └────────────────┘
        ▲                                                            │
        └──────────────── (re-assess if not converged) ◀────────────┘
```

### A. ASSESS (discover)
The heavy-model cross-review (today's task-group dispute) reads the target — repo, an idea,
a question — grounded by the **engineer's instruction field** (already present: it sets the
tone + constraints + requirements for the discussion). Output: a prioritized list of
**problems** (P0/P1/P2/…).

### B. PLAN (specify + choose skills)
Two sub-steps, both new relative to today:
1. **Specify** — for *each* problem, produce an **acceptance criterion / Definition of Done**:
   a verifiable condition that only a correct result satisfies. This is what tests/checks are
   written against later. Without it the implement phase has no ground truth.
2. **Choose skills (intent → plan)** — a planner model reads the problems + criteria + the
   engineer's instructions and selects the **skills** (see §4) and their ordering — i.e. the
   *dynamic SDLC* for this task. This is a bounded selection from a skill library, not
   free-form generation (§6).

### C. IMPLEMENT (run the chosen skills to green)
Skilled agents (and controllers for fan-out, §4) execute the planned steps, **iterating until
the acceptance criteria are met** (objective ground truth, §5). The artifact depends on the
archetype: code + Draft PR, a researched report, or infrastructure + a live deploy-verify.

### D. CONVERGE
When **every acceptance criterion is verified by its method** (§5) → done / human gate.
Convergence is grounded (criteria met by their methods), not a subjective "the judge said
converged" — *grounded where possible, judged where not* (§5 keeps a `judge` method for
non-mechanical criteria, so the claim is honesty-bounded, not absolute).

**Verification is against the FINAL state, not the moment of implementation.** Action points
are implemented sequentially in one shared worktree, so a later step can regress what an
earlier step's check verified. A criterion counts as met only if it holds in the final
worktree state of the round (a final re-verification pass before the PR opens); per-step
green at implementation time is necessary but not sufficient.

**Convergence is keyed on `P0` by design — the non-P0 remainder is a first-class outcome
(finding #5).** A loop reaches CONVERGED the moment no `P0` action point remains, but the
judge may still leave actionable non-P0 items (P1/P2/…) standing. That remainder used to
silently drop out of the lifecycle unless an operator noticed the leftover verdict. It is now
surfaced as an explicit **"converged with remainder"** outcome: the loop detail response
computes, at read time from the last round's persisted `openActionPoints` (no schema/FSM
change), a count-by-priority summary, and the UI renders a *"Converged with N open non-P0
items (X P1, Y P2, …)"* callout. The remainder stays executable through the **existing
develop-from-terminal** flow (§9) — the callout's button drives the same `POST /:id/develop`
promotion into a visible `developing` round; convergence remains "no open P0", nothing new is
persisted, and the FSM is untouched.

## 4. Skills — the unit of agent capability

A loop's steps are executed by **agents**, each dynamically pulling a **skill**. multiqlti
already has a skills system (skills, specialization-profiles, model-skill bindings) and the
repo has agent definitions (QA, infra, security, terraform, …) — we *wire the loop's steps to
the existing skills*, we do not invent a new concept.

A **skill** is a capability bundle:
- **(a) behavior / prompt** — what the agent does;
- **(b) its own definition of "green"** — the skill's intrinsic success test. E.g. an
  infra-agent deploying an operator: *operator in `Running` state + no error logs + healthy
  k8s events*; a coder: *unit/integration tests pass*; a QA-engineer: *tests written and
  meaningful*;
- **(c) required permissions / secrets / tools** — scoped, and **optional** per skill (QA may
  need none; deploy-verify needs ephemeral-env creds).

**Controllers are skills too.** When a step fans out into several parallel agents — research
(controller + N researchers), or development (controller + N coders for N features: several
P0, two P1, …) — a **controller skill** splits the work, assigns skills + permissions to
workers, aggregates, and decides the **step's green = all workers' green + its aggregation
criterion**. This is exactly the existing *agent-team* pattern (lead + workers).

The loop is therefore **fractal and observable**: `loop → phase → controller-agent → N
skill-agents`, each with a skill, a green/red, and the permissions it used (§8).

### 4a. Parallel, dependency-aware develop (implemented — kill-switched)

The develop phase's "controller + N coders for N features" is realized as **wave-scheduled,
dependency-aware parallel execution**. It is gated by
`pipeline.consiliumLoop.implement.parallel.enabled` (**default false** → today's sequential
single-worktree loop runs byte-for-byte unchanged; `ap.dependsOn` is never read).

**Dependencies come from the dispute (the judge, not a config).** The graph is *discovered*,
not declared by an operator. Each `action_point` **may** carry an additive
`dependsOn: (number | string)[]` — the *other* action points that must complete before it
(1-based ordinal, numeric string, or exact title). The judge is instructed to declare a
dependency **only when a later fix genuinely requires an earlier one's result** (e.g. "confirm
CI green" depends on the fixes it verifies); the default is **no dependency → independent →
parallelizable**. The field rides the existing `verdict/openActionPoints` jsonb — **no
migration** — and is bounded/clamped alongside the other untrusted judge fields.

**The planner builds the wave schedule** (`buildWaveSchedule`, pure + unit-tested, sibling to
`normalizeActionPointMethods`). It validates the edges, then topologically sorts into **waves**
(levels): wave 0 = APs with no surviving dependency; wave *N* = APs whose deps all land in
waves `< N`. Adversarial guarantees baked into the planner, not left to the executor:

- a ref to a **nonexistent** AP (out-of-range index / unknown title) is **dropped** (+ warn);
- a **self**-dependency is dropped;
- a **cycle** (A→B→A) is **detected and broken** — the residue Kahn's algorithm cannot drain is
  scheduled as one final independent wave (+ warn), so a cyclic `dependsOn` can never deadlock
  or infinitely wait. Every AP appears exactly once; within a wave the original order holds.

**The executor fans out per wave, merges after** (`runWaveScheduledImplement`). The round's
existing round branch is the **integration branch**. For each wave: every AP runs
**concurrently** — bounded by `maxConcurrency` (1..8, default 3) — in its **own isolated git
worktree** on a dedicated `consilium/loop-<uuid>/round-<n>/ap-<k>` branch cut off the
**current integration HEAD** (the merged result of all prior waves), doing its full skilled
run (test-author → coder → per-criterion verification) exactly as the sequential path does.
After the wave, each AP's branch is **merged back into the integration branch sequentially in
deterministic ordinal order**:

- a **clean** merge (independent APs touching different files) → proceed;
- a **conflict** → the merge is **aborted** (integration tree restored) and the AP's coder is
  **re-run sequentially on the integrated tree** (the simpler, more robust of the two options —
  it reuses the exact per-AP machinery and cannot silently drop work). The conflict is
  **surfaced** on that AP's outcome/PR note, never hidden.

A per-AP failure, a create-worktree failure, a merge conflict, or the whole-run wall-clock
deadline degrades **that AP** to partial/failed and is surfaced — the round does **not** halt
(same partial-success contract as today: completed/partial/failed per AP, one PR if anything
committed). The PR opens from the final integration branch, and the existing **Stage-A final
verification runs the whole suite against the merged tree** — the safety net for two APs that
were each green in isolation but conflict when combined.

**Worktree lifecycle is unconditional.** Every per-AP worktree is removed in a `finally`
(mirroring the single-worktree cleanup) so a crash mid-wave leaks nothing; a git-admin mutex
serializes the fast `worktree add/remove` calls (the coder runs stay concurrent) so N workers
never race on `.git/worktrees`; and the whole-run wall-clock deadline stops new work so a
wedged run cannot leak forever.

**Config:** `implement.parallel: { enabled: bool = false, maxConcurrency: int 1..8 = 3 }`.
Independent of verification — it changes only *how* the round's coders are fanned out, not
*what* each AP does; the live per-AP status list (§8, #435/#480) already renders **multiple
concurrent `active`** rows (one per in-flight AP in a wave).

## 5. Acceptance criteria + verification methods

Two distinct levels of "green" — keep them separate:
- **Skill-green** — the skill's generic capability success ("the operator came up").
- **Acceptance-criterion** — the task-specific Definition of Done from PLAN ("the operator
  reconciles CRD X within 30s"). The criterion **parameterizes** the skill's green.

**Each acceptance criterion carries a verification method** — the ground-truth check:

| Method | For | Ground truth |
|---|---|---|
| `test-run` | code requirements | unit/integration tests pass |
| `live-deploy-smoke` | infra/operator | deploy to an ephemeral env + the skill's green (running, no errors, events) |
| `web-evidence` | research/decision | claim supported by cited sources |
| `judge` | non-mechanical criteria | a verifier model confirms the result meets the criterion |
| `manual-ops` | operational actions outside the repo (rotate a secret, revoke a key, file a ticket) | a human confirms the action was performed; the loop can only surface it, never close it |

**Convergence = every criterion confirmed by its method.** Sometimes a green test, sometimes a
live smoke-test, sometimes a judge against the criterion.

**The verification method is a per-criterion property, not an archetype property.** The
archetype (§6) supplies the *default* skill ordering, but a single verdict routinely mixes
criteria of different natures — e.g. a repo assessment whose P0 is "rotate the leaked
secrets" (a `manual-ops` action no unit test can verify) next to "gate coverage in CI"
(`test-run`). The planner assigns each criterion its method; a criterion the chosen pipeline
cannot verify is a first-class outcome ("not implementable by this pipeline — needs a human /
another archetype"), not something to silently force through the nearest test harness.

Honesty note: `judge` re-admits model subjectivity through the back door — that is a deliberate,
bounded concession for non-mechanical criteria, not a loophole. The share of mechanically
verified criteria (`test-run` / `live-deploy-smoke` / `web-evidence`) vs `judge`/none is a
first-class telemetry metric (§7): it measures how *grounded* the system actually is.

## 6. Archetypes — intent → a set of skills

A small **skill library** composed into typical orderings; real tasks *mix* them. The three
cases we have today are the common shapes:

| Archetype | Trigger (intent) | Skill ordering | Artifact / verification |
|---|---|---|---|
| **Repo assessment** | "review/assess repo X", spec change | `assess → (spec → test → code)*` | code + Draft PR; tests green + re-review |
| **Research / decision** | "compare X vs Y", "should we…", "find…" | `research → synthesize` | researched report/recommendation (**not** code); web-evidence + judge |
| **Infra / build** | "deploy a cluster in Brazil", "write a k8s operator" | `(research) → spec → code → deploy-verify` | IaC/code + **live deploy-smoke** in an ephemeral env |

**Intent classification** (a light model, not raw keywords — they are brittle) picks the
archetype + extracts parameters and proposes the skill set. The engineer can override. This
classification *is* the lightweight gate (§7), replacing a heavy "judge the plan" step.

> "Fix logger.go" is meaningless until ASSESS defines *what* the problem is; then PLAN gives a
> criterion; then a skill is chosen. Even abstract tasks (choose a CI provider) become
> criteria-driven: set requirements for the provider → research → recommend → verify against
> the requirements.

## 7. Security model

The real safety boundary is **capability-scoping per skill**, *independent* of whether we trust
the planner:
- **assess / research** — read-only (repo reads, web reads), Draft-PR-only.
- **code** — isolated git worktree, Draft-PR-only; agents never merge.
- **test-run** — **executing the repo's tests is executing arbitrary repo code.** The target
  repo is *untrusted input* end-to-end: its content can prompt-inject the agents that read it,
  and its test suite can run anything on the host. Test execution therefore requires the
  container sandbox (`features.sandbox`) or an explicit per-repo operator acknowledgement
  (`implement.trustedRepoAck`) — enforced as `effectiveVerificationEnabled`; without either,
  verification stays off. Env-allowlist + worktree + timeout bound credentials and commands,
  but NOT host fs/network — that is what the sandbox is for.
- **deploy-verify (infra)** — the one step that touches a live environment. It gets
  **ephemeral-env creds from a secret manager**, scoped to that env; **prod-apply never without
  explicit human approval** (the existing apply-gates / `never_apply` rules hold).

Prompt-injection posture: read-only skills cannot mutate anything directly, but what they
*read* shapes what the writers *do* — the repo is where injection enters. The backstops are
capability ceilings (a skill's tools can only be narrowed, never widened), Draft-PR-only
output, and the human merge gate.

**Trust the planner under observation.** Default: trust the planner model to choose the
archetype/skills with *no* hard human gate; run an **observation/telemetry process** (what
archetype was chosen, which skills + permissions were handed out, which step went green/red).
From the observed track record we decide whether agent-planning is trustworthy or a human gate
is needed. Crucially, because capabilities are bounded by skill-declared permissions + the
apply-gates, "trust by default" is **not** "no rails".

## 8. Observability

The Loop page renders the **phase / controller / agent tree**:
- each phase, each controller, each worker agent;
- the **skill** each carries, its **green/red**, the **permissions it used**;
- per acceptance criterion: its verification method + pass/fail;
- failures are first-class and recoverable here — the opposite of the invisible `execute-sdlc`
  that failed silently.

## 9. What changes — staged cleanup / redesign

Each stage is independently shippable and testable (evolutionary; refine while testing).

- **Stage 0 — stop the bleeding (cleanup).**
  Collapse `execute-sdlc` back into the loop's implement phase (remove the standalone object +
  its endpoints/registry). "Hand off action points" becomes "the loop runs an implement round"
  — visible on the loop page. Demote *Pipelines* and *Task Groups* from primary navigation to
  Advanced/internal.

- **Stage 1 — planning depth.**
  Add **Specify** (acceptance criterion / DoD per problem) to the verdict format, and the
  **intent → skill-set** planner step (with engineer confirm/override).

- **Stage 2 — skilled implement.**
  Implement phase runs **skill-agents + controllers** (wire to existing skills/agent-defs);
  add **verification-method-per-criterion**; convergence on criteria (not subjective verdict).
  **Phase 2 follow-up (done):** the legacy `dev-handoff` path — a DEV task-group whose tasks
  each carried a `devPipelineId` — is gone; the skilled SDLC executor is now the *only* implement
  path, so the loop no longer references the *pipelines* entity at all (`devPipelineId` removed
  end-to-end, `consilium_loops.dev_pipeline_id` dropped). When `implement.enabled=false` the
  develop phase **fails soft** with the loop error `"implement path disabled by config"` (same
  no-PR `dev_completed` convention as a disabled research archetype) rather than silently
  falling back to an unskilled coder — the operator turns the key on or the loop won't develop.

- **Stage 3 — archetypes.**
  Research archetype (web-evidence, report artifact) and Infra archetype with the
  **`deploy-verify`** skill (ephemeral env + scoped creds + apply-gates).

- **Stage 4 — observability tree.**
  The loop page's phase/controller/agent/skill/green tree.

### Partial success (implemented, previously undocumented)

The implement phase does **not** fail as a unit. Each action point ends `completed` /
`partial` (timed out or errored but committed work) / `failed` (no commit); a failed AP does
not halt the round. If *any* AP committed, one PR aggregates all commits and its body lists
per-AP status. If zero committed, the round reports "no commits produced". There is no
partial-develop FSM state on purpose: **the next reviewing round adjudicates partial work** —
the judge re-reads the branch diff against the prior findings and either confirms closure or
re-raises what is still open.

### Hardening stages (next arc — same rules: additive, kill-switched, inert by default)

- **Stage 5 — final-state re-verification.** One test-run pass over ALL `test-run` criteria
  against the final worktree state after the last AP, before the PR opens (+ a bounded fix
  loop on regression). Closes the sequential-AP regression hole (§3D). Trace gains
  `passedAtFinal` per criterion.
- **Stage 6 — verification method per criterion.** The judge proposes and the planner assigns
  a method per criterion (incl. `manual-ops`); "not implementable by this pipeline" becomes a
  legal outcome (§5). Engineer override, as with the archetype.
- **Stage 7 — criteria QA.** Lint each acceptance criterion at generation time (observable,
  falsifiable, "When X then Y" with a concrete condition); a criterion-less AP is forced to
  `judge`, never silently "tests green". Re-assess must state per closed item *how* it was
  verified and whether the DoD itself was adequate — an inadequate DoD becomes a new AP.
- **Stage 8 — trust telemetry.** Aggregate what the traces already record: grounding ratio
  (mechanically verified vs judged criteria), planner track record (proposed vs overridden,
  green-rate per skill). This is the §7 "observation process" made concrete — the data on
  which "trust the planner" is periodically re-decided.

## 10. Open questions (to settle while testing)

- Naming: "Loop" implies cycling; a one-shot review is not a loop. Candidate top-level name:
  *Cycle* / *Run* / *Review*? ("loop" becomes the iterate-until-converged behavior.)
- How much can the planner be trusted before a human gate is reintroduced (empirical, §7)?
- Where exactly task groups / pipelines surface for power users once demoted.
- Ephemeral-env provisioning for `deploy-verify` (what backs it — kind/k3d, a cloud sandbox?).
- How acceptance criteria are authored: model-proposed then engineer-edited?
- Converged-with-remainder (finding #5): should a `maxRounds > 1` loop **auto-develop** the
  non-P0 remainder instead of waiting for the operator to click develop-from-terminal? Today
  it stays a human-gated one-click action (convergence = no-P0, no auto-execution); the open
  question is whether a multi-round loop's leftover P1/P2 items should be promoted
  automatically, and if so under what guard (cost/round cap, priority floor).

---

*This document evolves. Treat each section as a hypothesis to validate in testing, not a frozen
spec.*
