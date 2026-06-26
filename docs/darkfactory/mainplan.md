# Dark Factory: OpenSpecs v6 — Consolidated Architecture

Final consolidation. v6 = v5 (nine SPECs covering log forgery, metric gaming, reward hacking, injections, and over-privilege — all via out-of-LLM mechanisms) **plus three layers added in subsequent rounds:**

1. **Infrastructure Contour** — the system delivers code results into environments (migrations, deployments, dependencies), rather than just writing code. A new class of tasks: Type E + SPEC-10.
2. **Memory Service with Connections and Time** — a unified source of truth regarding platform state for all agent types; three layers with different lifetimes.
3. **Auto-Triggered Planning** — two modes (A: auto-triggering execution by rule; B-narrow: auto-triggering research/planning, but not action).

**Cross-cutting principle, never shifted throughout the evolution:** autonomy is heterogeneous and strictly stops at the side-effect boundary. Thinking, researching, planning, running in an ephemeral environment — autonomous. Irreversible actions (applying to persistent state, deprecating, interpreting intent, determining correctness) — require a human. This is not a weakness on the path to L5; it is a mature design: we are aiming for **Level 4** (autonomous execution with human determination of correctness), not L5.

---

# PART I. Core v5 (Nine SPECs) — Summary

- **SPEC-01** Dual Sandbox: Worker in Sandbox A, Test-Runner in Sandbox B (read-only mount), system verification scripts.
- **SPEC-02** Proof Multiplicity: Type A (behavior/exit_code), B (visual/pixel_diff), C (heuristics+A); Zone-Based Security Gate out-of-LLM.
- **SPEC-03** External UI Baselines: baseline from Figma, deterministic Pixelmatch (no Vision-LLM).
- **SPEC-04** HIL (Human-in-the-Loop): Type D parked for human; gate on assigning Type D; limit on `awaiting_human` ratio.
- **SPEC-05** microVM: Firecracker/Kata/gVisor, default-deny network, no production secrets.
- **SPEC-06** Verifying the Verifier: locking + golden-set + file-instrumentation + isomorphic check + **spec-derived tests**.
- **SPEC-07** Meta-Loop: layered stop conditions, circuit breaker, budget window, self-aware termination, hacker-fixer loop.
- **SPEC-08** Scope-Limited Credentials: least-privilege OAuth, execution-time authorization (fail-closed).
- **SPEC-09** Transactional Rollback: wrapper with rollback, high-risk command interception out-of-LLM.

---

# PART II. Infrastructure Contour (New)

Once the system delivers code into an environment, **actions with side-effects that survive a git-revert emerge**. Reverting a commit is easy; reverting a database migration that dropped a column is not. The center of gravity shifts from "code correctness" to "action reversibility".

## SPEC-E0: Type E — Infrastructure Task Class
**Goal:** A separate class for side-effecting actions (migrations, deployments, dependency changes) with its own proof model.

**Requirements:**
- **[REQ-E0-A]** Triad of proofs for migration: (1) forward applied, (2) **rollback applied** — down-script is mandatory and tested (absence = `fail`), (3) behavior on prod-like data did not break.
- **[REQ-E0-B]** Zone-Gate expanded to Infra: Tasks touching migrations/deployment/dependencies **cannot** be Type A or D — they are forcibly Type E.
- **[REQ-E0-C]** Deploy-proof: Application boots with dependencies in a prod-like environment, passes behavioral checks (smoke/integration).

## SPEC-E1: Three Environments — Three Levels of Autonomy

| Environment | Reversibility | Autonomy Level | Mechanism |
|-------------|---------------|----------------|-----------|
| **Ephemeral (dynamic envs)** | By trashing the env | Maximum | Fresh IaC env per run, destroyed after verdict. |
| **Persistent prod-like** | Re-provision to baseline | Medium | Survives tasks → interference. Reset to clean baseline via deterministic re-provisioning by the system (not the agent). |
| **Prod (read-only)** | No writes | Read-only | Source of truth, not a target for action (see Part III). |

- **[REQ-E1-C]** Applying a migration to a persistent environment with non-empty state = candidate for irreversibility → approval (SPEC-04).

---

# PART III. Memory Service: Observability as Source of Truth

Prod observations play two roles: **proof output** (no degradation) and **planning input** (requirement derived from reality). The latter is more powerful but dangerous, because observation ≠ intent.

## SPEC-10: Observation/Memory Service
**Goal:** Unified source of truth about platform state.

### Three Layers of Memory

**Layer 1 — Observation Store.** Raw aggregates/trends from prod.
- **[REQ-10-A]** PII filtering at entry: Agents receive aggregates/metrics ("p99 = 340ms"), never raw strings or PII.
- **[REQ-10-B]** Trend storage, not point-in-time, to distinguish regression from daily fluctuation.
- **[REQ-10-C]** Execution Isolation: Read-only prod channel is **never** mounted in the Worker sandbox.

**Layer 2 — Derived Requirements.** What the system extracted ("MTTR budget 1min").
- **[REQ-10-D]** Provenance is mandatory: every derivation stores a link to the observation.
- **[REQ-10-E]** Interpretation Gate: Derivations affecting irreversible actions (deprecating API) require human confirmation.

**Layer 3 — OpenSpec (Contract) via Omniscience.** Stable human-readable source of truth.
- **[REQ-10-F]** Specs **reference, rather than copy** observations. Uses `Omniscience` repository.
- **[REQ-10-G]** Drift-detector: Background task compares current observation against the one that spawned the requirement.

### Graph Links (Causality)
- **[REQ-10-H]** Graph edges are of two types: **observed** (traces, code dependencies) and **hypotheses** (derived correlations). Hypotheses require human confirmation before being treated as facts for planning.

---

# PART IV. Auto-Triggered Planning: Two Modes

## Mode A — Auto-Trigger Execution by Approved Rule (Main)
- **[REQ-A]** Drift-detector triggers tasks **only** for reversible/safe classes using pre-approved human templates.

## Mode B-narrow — Auto-Trigger Research/Planning, but NOT Action
- **[REQ-B-1]** The output of auto-triggered planning is a **question or ranked proposal to a human**, not a task.
- **[REQ-B-2]** Anti-bias agenda: Research must present not only the top choice, but also **what was discarded and why**.
- **[REQ-B-3]** Budget-gate on research (from SPEC-07): Autonomous research is triggered (drift/schedule), not continuous. Strict token quotas apply.

---

# PART V. The Human Boundary (Map)

| Action | Autonomous | Human |
|--------|------------|-------|
| Writing code | Yes | — |
| Running tests, verdict via spec-derived | Yes | — |
| Ephemeral env execution | Yes | — |
| Migration to persistent state | — | Approval |
| Deprecation / breaking change | — | Decision |
| Starting planning and research | Yes | — |
| Assigning target from research | — | Choice from candidates |
| Determining correctness | — | Curation |
