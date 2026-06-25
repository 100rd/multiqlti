# Dark Factory: OpenSpecs v6 — Consolidated Architecture

Final consolidation. v6 = v5 (nine SPECs covering log forgery, metric gaming, reward hacking, injections, over-privilege — all mitigated by out-of-LLM mechanisms) **plus three layers added in subsequent iterations:**

1. **Infrastructure Contour:** The system delivers the code's result into environments (migrations, deployments, dependencies), not just writes code. Introduces Type E tasks and SPEC-10.
2. **Observation/Memory Service:** A shared source of truth for the platform state, bridging observations over time across three layers of lifecycle. (Integrated with `Omniscience`).
3. **Auto-Triggered Planning:** Two modes (A: autonomous execution trigger; B-narrow: autonomous research/planning trigger, but no execution).

**The Overarching Principle (unchanged throughout evolution):** Autonomy is heterogeneous and stops exactly at the boundary of side-effects. Thinking, researching, planning, and testing in ephemeral environments is autonomous. Irreversible actions (applying to persistent state, deprecating, interpreting intent, defining correctness) remain with the human. This is not a weakness on the path to L5; this is mature design: we aim for **Level 4** (autonomous execution with human correctness definition), not L5.

---

# PART I. Core v5 (Nine SPECs) — Summary

*For full definitions, refer to v5 artifacts. Summarized here for context.*

- **SPEC-01** Dual Sandbox: Worker in Sandbox A, Test-Runner in Sandbox B (read-only mount), system verification scripts instead of project `package.json`.
- **SPEC-02** Proof Multiplicity: Type A (behavior/exit_code), B (visual/pixel_diff), C (heuristics+A); Out-of-LLM Zone-Based Security Gate; plan ≠ authorization.
- **SPEC-03** External UI Baselines: Figma baseline, deterministic Pixelmatch (no Vision-LLM), rigid task↔baseline binding via component path.
- **SPEC-04** HIL: Type D tasks parked for humans; gate on assigning Type D; limit on `awaiting_human` ratio.
- **SPEC-05** microVM (Firecracker/Kata/gVisor), default-deny network, no production secrets.
- **SPEC-06** Verifier Verification: locking + golden-set + file-instrumentation + isomorphic check + **spec-derived tests** (tests derived from OpenSpec, not implementation — breaks circularity of error).
- **SPEC-07** Meta-Loop: Layered stop conditions, circuit breakers, sliding window budget, self-aware termination, hacker-fixer loop (red-team from a different model family).
- **SPEC-08** Scope-Limited Credentials: Least-privilege OAuth, execution-time authorization (fail-closed), full audit.
- **SPEC-09** Transactional Rollback: Wrapper with rollback, interception of high-risk commands out-of-LLM, headless compatibility.

---

# PART II. Infrastructure Contour (New)

Once the system delivers code into an environment, **side-effecting actions that survive a git-rollback** emerge. Rolling back a commit is easy; rolling back a migration that dropped a column is not. The center of gravity shifts from "code correctness" to "action reversibility."

## SPEC-E0: Type E — Infrastructure Task Class
**Goal:** A distinct class for side-effecting actions (migrations, deployments, dependency changes) with its own proof and reversibility model.

**Requirements:**
- **[REQ-E0-A] Migration Proof Triad:** (1) forward script applied, (2) **rollback applied** (down-script is mandatory and tested; absence = pre-execution `fail`), (3) behavior on prod-like data did not break.
- **[REQ-E0-B] Infrastructure Zone-Gate:** Any task touching migrations/deployments/dependencies **cannot** be Type A or D — it is forced to Type E with all its proofs.
- **[REQ-E0-C] Deploy-Proof:** Application boots with dependencies in a prod-like environment, passes behavioral smoke/integration tests, and only then receives a verdict.

## SPEC-E1: Three Environments — Three Levels of Autonomy
**Goal:** Autonomy scales unevenly across environments by design.

| Environment | Reversibility | Autonomy Level | Mechanism |
|-------------|---------------|----------------|-----------|
| **Ephemeral (Dynamic envs)** | Throwing the env away | Maximum | Each run is a fresh IaC env, destroyed post-verdict. "Rollback" = "env didn't live past the test." Note: Cannot validate scale. |
| **Persistent prod-like** | Re-provision to baseline | Medium | Env survives the task → inter-task interference. Reset to baseline is a deterministic systemic re-provision, **not by the agent**. Used for load-testing and scale-dependent migrations. |
| **Prod (Read-only)** | No writes allowed | Read-only | Data source, not an action target. |

**Requirements:**
- **[REQ-E1-A] Default Ephemeral:** Behavioral tests (migrations, integrations) run in disposable environments.
- **[REQ-E1-B] Persistent Prod-like Reset:** Baseline reset between tasks is handled by system re-provisioning, not agent self-cleanup.
- **[REQ-E1-C] Scale & Load Gates:** Applying a migration or load-test to a persistent prod-like environment with non-empty state = irreversible candidate → requires approval (SPEC-04). Ephemeral environments require no approval (nothing to lose).

---

# PART III. Observation / Memory Service

Prod observations play two roles: **output proofs** (no degradation) and **planning inputs** (requirements derived from reality). The latter is dangerous because observation ≠ intent.

## SPEC-10: Observation/Memory Service
**Goal:** A shared, linked source of truth regarding platform state spanning three lifecycles. Isolated from untrusted code execution. **Backed by `Omniscience` repository.**

### Three Memory Layers

**Layer 1 — Observation Store (Raw Data)**
Raw aggregates and trends from production. Volatile, append-only, with a retention policy.
- **[REQ-10-A] PII Obfuscation:** Logs with PII are masked/redacted (e.g., CC numbers replaced with `***`) rather than fully stripped. This gives the agent the exact data syntax needed for debugging (e.g., malformed JSON structure) without leaking raw PII.
- **[REQ-10-B] Trend Storage:** Time-series distribution to distinguish regression from daily fluctuations.
- **[REQ-10-C] Execution Isolation:** Read-only prod channel is **never** mounted in the Worker sandbox; requires scoped-tokens (SPEC-08) and full audit.

**Layer 2 — Derived Requirements (Hypotheses)**
What the system extracted from observations: "MTTR budget is 1m", "Field X is a candidate for deprecation".
- **[REQ-10-D] Mandatory Provenance:** Every derived requirement stores a link to the observation, time window, and confidence.
- **[REQ-10-E] Interpretation Gate:** Deductions affecting irreversible actions (deprecating API, breaking changes) are flagged "requires human confirmation." Fact ("Traffic dropped to 5%") ≠ Decision ("Delete old format").

**Layer 3 — OpenSpec (Contract via `Omniscience`)**
Stable, human-readable source of truth.
- **[REQ-10-F] Reference, Don't Copy:** Specs link to derivations ("see derived-req-447"), preventing spec rot. `Omniscience` ensures data is fresh at the start of the planning phase.
- **[REQ-10-G] Drift-Detector:** Background tasks compare current observations with the baseline that generated the requirement; alerts if divergence exceeds thresholds.
- **[REQ-10-H] Graph Edges (Facts vs Hypotheses):** Relationships in the memory graph are strictly typed. Observable (tracing, code deps) vs Hypothesis (inferred correlation). Hypotheses must be confirmed by humans, preventing the memory service from halluncinating causality.

---

# PART IV. Auto-Triggered Planning: Two Modes

Self-started planning shifts the system from reactive to generative. We resolve this by splitting the **right to initiate** from the **right to decide**.

## Mode A — Execution Auto-Trigger (Pre-approved Rules)
**Intent is pre-defined by the human.** The trigger is automatic (cron or drift-threshold), but the action is pre-approved.
- **[REQ-A]** Drift-detector/cron spawns a task **only** for reversible/safe classes using an approved template.

## Mode B-narrow — Research Auto-Trigger (No Execution)
**Mode B on input, Mode A on output.** The system generates hypotheses and explores the memory graph, but outputs **a question or ranked candidates to the human, not a task**.
- **[REQ-B-1] Output is a Question:** "Field X shrank to 5%, here are 3 interpretations. Which is correct?", not "I decided to deprecate X."
- **[REQ-B-2] Anti-Bias Agenda:** The research must present top candidates *and* what was discarded and why, preventing the system from subtly steering human decisions.
- **[REQ-B-3] Strict Token/Budget Quota:** Autonomous research is strictly quota-limited (e.g., 10% of daily budget). This prevents "DDoS by Research" where noisy metrics exhaust the system's compute budget before actual work is done.

---

# PART V. The Human Boundary (Autonomy Matrix)

| Action | Autonomous | Human |
|--------|------------|-------|
| Writing code | Yes | — |
| Running tests, spec-derived verdicts | Yes | — |
| Execution in Ephemeral env | Yes | — |
| Migration/Deploy in Ephemeral env | Yes | — |
| Migration to Persistent state / Load testing | — | Approval |
| Deprecation / Breaking change | — | Decision |
| Starting Planning & Research | Yes | — |
| Setting goal from Research | — | Choice of candidates |
| Interpreting prod metric into requirement | — | Confirmation |
| Defining Correctness (Spec, Golden-set) | — | Curation |
| Hypothesis-edge in Memory Graph → Fact | — | Confirmation |

**In one sentence:** The machine discovers, executes reversible actions, and proves compliance; the human interprets, defines correctness, and sanctions the irreversible.

---

# PART VI. Open Boundaries (Known Limitations)

1. **Reward hacking is reduced, not eliminated:** Detectability drops without reasoning traces. Monitoring is fragile by design.
2. **Spec & Golden-set correctness relies on humans:** This is L4, not L5.
3. **Full generative goals (Mode B) are excluded:** Pushes circularity from tests to intents. Mode B is strictly narrowed to research.
4. **Memory links can be false:** Graph causality hallucinations are mitigated by REQ-10-H, not eliminated.
5. **Read-only Prod expands leak surface:** PII obfuscation (REQ-10-A) is mandatory. Autonomy ≠ total access.
6. **Irreversibility lives in data, not code:** No LLM-verdict secures data. Autonomy varies by environment.

---

## Conclusion
v6 integrates v5 (mature code-contour defense) with infrastructure, memory, and auto-triggering. No extension pushes autonomy past the boundary of side-effects. The system autonomously discovers, researches, and executes reversible actions, proving compliance against specs. However, interpretation, correctness definition, and irreversible sanctions remain human responsibilities. It is a factory where the lights are off on the execution floor, but on in the judgment room.
