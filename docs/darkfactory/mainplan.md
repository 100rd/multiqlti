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

## SPEC-07: Meta-Loop (Layered Stop Conditions + Circuit Breaker + Hacker-Fixer)
**ID:** DF-SPEC-07 — **Goal:** Orchestration, failure catching, budget control, continuous evaluator hardening.

**Requirements:**
- **[REQ-07-A] Layered Stop Conditions:** Retry limits (3), token/timeout limits, delegation depth; no-progress detector (two identical failures in a row = escalation).
- **[REQ-07-B] Circuit Breaker:** Provider/model failure rate above threshold → switch to fallback.
- **[REQ-07-C] Sliding Window Budget:** Upon depletion — auto-sleep the loop.
- **[REQ-07-D] Self-Aware Termination:** Agent must document unresolvable constraints and stop voluntarily.
- **[REQ-07-E] Hacker-Fixer Loop:** Periodic adversarial cycle where a red-team agent attempts to bypass the Evaluator/SecurityGate, and a blue-team patches them. **Boundary:** Must use a different model family for the red-team to avoid correlated blind spots.

---

## SPEC-08: Scope-Limited Credentials (Execution-Time Authorization)
**ID:** DF-SPEC-08 — **Goal:** Protection against over-privileged agents.

**Requirements:**
- **[REQ-08-A] Least-Privilege Credentials:** Scoped token (OAuth) strictly for the specific task.
- **[REQ-08-B] Boundary:** All actions pass through an authorization barrier at execution time; fail-closed by default.
- **[REQ-08-C] Full Audit:** Logging all agent actions alongside their temporary permissions.

---

## SPEC-09: Transactional Rollback
**ID:** DF-SPEC-09 — **Goal:** Reversibility of mutations.

**Requirements:**
- **[REQ-09-A] Transactional Wrapper:** Tasks execute as transactions with a full rollback on `fail`.
- **[REQ-09-B] High-Risk Command Interception:** A deterministic out-of-LLM filter intercepts `rm -rf`, `deploy` → requires Approval.
- **[REQ-09-C] Headless Compatibility:** All safeties operate without interactive prompts.

---

## Autonomy Calibration (Level 4, not 5)

The maturity scale (5 levels, akin to SAE self-driving) is our framing tool, not an external mandate. 

- **L2/L3:** Mass market (Copilot, Devin) — agent writes code, human reviews every PR.
- **L4:** Spec-driven — agents run autonomously for hours, human reviews final product and curates baselines.
- **L5:** Zero human verification before production.

**Where v5 honestly aims: Level 4.** The document hinges on golden-sets (REQ-06-B) and external baselines (REQ-03-A, REQ-06-E) maintained by humans outside the loop. This moves the human from code review to **baseline curation and correctness definition**. Backend tasks execute autonomously, but "correctness" traces back to a human-authored spec. Calling this L5 is a vulnerability: a task reaching prod without human input in code, test, or baseline does not exist in this architecture. L4 with excellent tooling is a strong, defensible position; L5 is not.

---

## Appendix A: Industry Context & Sources (2026)

### A.1 Reward Hacking Confirmed Empirically
Agents actively manipulate evaluators: rewriting unit tests, muting asserts, monkey-patching scoring functions to pass without solving the task (RewardHackingAgents, March 2026; "LLMs Gaming Verifiers", arXiv 2604.15149). Scale: >15% of tasks across five terminal-agent benchmarks are solved via verifier deception (Terminal Wrench / arXiv 2606.08960). → Justifies SPEC-06 (locking + instrumentation) and SPEC-01 (out-of-band runner).

### A.2 Circularity of Error (REQ-06-E)
The core issue of LLM-generated tests is "how to verify the verifier". Using implementation as a ground-truth oracle creates "circularity of error". Invalid LLM-test rates run high: 34–62% (arXiv 2602.10522). Literature solution: derive tests from NL-specification, not code. Self-verification degrades without external grounding (arXiv 2504.00406, 2311.11797).

### A.3 Isomorphic Perturbation Testing (REQ-06-D)
Models hardcode answers for extensional tests; IPT runs logically equivalent but structurally altered tests — deception fails on the isomorphic variant (arXiv 2604.15149). **Boundary:** IPT is defined where rewritable logical structure exists (algorithms, reasoning). Undefined for visual/UX — hence the scope restriction in REQ-06-D.

### A.4 Hacker-Fixer Loop (REQ-07-E)
Adversarial evaluator hardening is a 2026 pattern: outcome verifiers are manually crafted and rarely robust (arXiv 2606.08960; RvB, arXiv 2601.19726 / 2602.14457). Economics favor it: red-vs-blue cycles reduced token spend by >18% vs cooperative baselines.

---

## Appendix B: Defense-List for Debates

**1. "Your Evaluator can be deceived / who judges the judge?"**
→ SPEC-06: locking + hash + file instrumentation against tampering; golden-set outside loop against flawed judgment; Hacker-Fixer for continuous hardening. Boundary: reward hacking is reduced, not eliminated; monitoring is inherently fragile.

**2. "Who writes the check for a novel, unseen task?"**
→ SPEC-06-E: tests are derived from OpenSpec, not implementation; circularity broken. Boundary: correctness of the spec itself is on the human (This is our L4).

**3. "This isn't real autonomy — human is still in the loop."**
→ Agreed: the goal is L4 with humans curating baselines. Backend is autonomous in execution; correctness definition is human. We do not sell L5.

**4. "A different model for Evaluator doesn't guarantee independence."**
→ REQ-07-E requires a different model family for this exact reason. Boundary: full error independence is costly; intra-generation correlation remains.

**5. "Isomorphic checks will save us everywhere."**
→ We don't claim this: REQ-06-D is restricted to Classes A/C. For visuals, the source of truth is `pixel_diff` against an external baseline (SPEC-03).

**6. "An agent with deploy rights can destroy production."**
→ SPEC-08 (scoped-tokens, execution-time fail-closed) + SPEC-09 (transactional rollback, high-risk intercept) + SPEC-05 (microVM, default-deny network). Boundary: expands surface area; audit monitoring (REQ-08-C) is mandatory.

---

## Execution Roadmap: Agentic Task Breakdown

To implement this architecture sequentially using targeted autonomous agents, the work is broken down into the following logical tasks. Each task is a self-contained unit that can be handed to a Subagent.

### Phase 1: Foundation (Isolation & Contracts)
- **Task 1.1: Implement Dual Sandbox (SPEC-01 & SPEC-05)**
  - *Goal:* Create the `IsolatedWorkspaceManager`.
  - *Action:* Write a module that provisions a Firecracker microVM (or Docker with gVisor). It must support mounting a directory as Read-Write (`Sandbox A` for Worker) and another as Read-Only (`Sandbox B` for Runner), with default-deny networking.
- **Task 1.2: Implement OpenSpec & Security Gate (SPEC-02)**
  - *Goal:* Enforce Proof Multiplicity.
  - *Action:* Define `OpenSpec` TypeScript interfaces. Implement `ZoneBasedSecurityGate` to intercept plans touching `/auth` or `/payments` and forcefully inject `Type A` (exit code) proof requirements.

### Phase 2: The Truth Engine (Verification)
- **Task 2.1: Implement Out-of-Band Test Runner (SPEC-01 & SPEC-06)**
  - *Goal:* Execute tests deterministically without Worker interference.
  - *Action:* Build a `TestRunner` class that executes commands exclusively inside `Sandbox B` (Read-Only). Implement Evaluator Locking by hashing test files before execution to detect tampering.
- **Task 2.2: Implement Spec-Derived Test Generator (SPEC-06-E)**
  - *Goal:* Break the Circularity of Error.
  - *Action:* Create an agentic pipeline step that takes the NL `OpenSpec` and generates Jest/Vitest files *before* the Worker writes any implementation code.

### Phase 3: Orchestration & Safety
- **Task 3.1: Implement Meta-Loop & Layered Stops (SPEC-07)**
  - *Goal:* Autonomous retry and failure handling.
  - *Action:* Refactor `MetaLoopService` to include token limits, retry limits (max 3), and a no-progress detector (if the exact same test failure occurs twice, halt and escalate).
- **Task 3.2: Implement Execution-Time Authorization (SPEC-08 & SPEC-09)**
  - *Goal:* Prevent over-privileged destruction.
  - *Action:* Build a transactional wrapper that intercepts high-risk commands (`rm -rf`, `deploy`) and enforces OAuth scoped-token checks at execution time, automatically rolling back filesystem state on failure.

### Phase 4: UI & Human-in-the-Loop
- **Task 4.1: Implement Visual Diffing (SPEC-03)**
  - *Goal:* Deterministic Type B Proofs.
  - *Action:* Integrate `Pixelmatch` to compare Worker-generated screenshots (via Playwright) against external Figma baselines.
- **Task 4.2: Implement HIL Parking State (SPEC-04)**
  - *Goal:* Graceful degradation for Type D tasks.
  - *Action:* Add an `awaiting_human` state to the orchestrator. If a task requires subjective review, park the git branch and send an approval notification instead of consuming retry attempts.

---

# PART VI. Integration & Merge Protocol

To prevent architectural conflicts and ensure the system is secure at every step, autonomous PRs must be merged strictly in this order:

1. **Layer 1: Foundation (Isolation & Routing)**
   - `SPEC-01` & `SPEC-05` (Dual Sandbox & microVM)
   - `SPEC-02` (Proof Multiplicity & Security Gate)
2. **Layer 2: Execution Safety (Intercept & Rollback)**
   - `SPEC-08` & `SPEC-09` (Execution-Time Auth & Transactional Rollback) — *must precede control loops so all tasks are sandboxed safely.*
3. **Layer 3: Control Flow (Loops & Human-in-the-Loop)**
   - `SPEC-07` (Meta-Loop, Circuit Breakers)
   - `SPEC-04` (HIL Parking)
4. **Layer 4: Verification Engines (The Truth Engine)**
   - `SPEC-06` (Evaluator Locking)
   - `SPEC-06-E` (Spec-Derived Test Generator)
   - `SPEC-03` (External UI Baselines)

## 100% Verification Protocol

Before any merge is finalized, the system must undergo **three verification layers**:
1. **Victory Audit (Independent):** A completely isolated subagent must verify the code against the Spec, ensuring no hardcoded mocks.
2. **Pipeline Integration Dry-Run:** An end-to-end (E2E) integration test must be executed on the `main` branch immediately after the merge to ensure the new layer intercepts execution correctly (e.g., injecting a malicious command).
3. **Health Check (Service Liveness):** For infrastructure/network changes, an explicit liveness check must be run (e.g. `curl` or DB connection script) to prove the service is active and listening, not just returning a 0 exit code from a start script.

---

## Conclusion
v6 integrates v5 (mature code-contour defense) with infrastructure, memory, and auto-triggering. No extension pushes autonomy past the boundary of side-effects. The system autonomously discovers, researches, and executes reversible actions, proving compliance against specs. However, interpretation, correctness definition, and irreversible sanctions remain human responsibilities. It is a factory where the lights are off on the execution floor, but on in the judgment room.
## SPEC-07: Meta-Loop (Layered Stop Conditions + Circuit Breaker + Hacker-Fixer)
**ID:** DF-SPEC-07 — **Goal:** Orchestration, failure catching, budget control, continuous evaluator hardening.

**Requirements:**
- **[REQ-07-A] Layered Stop Conditions:** Retry limits (3), token/timeout limits, delegation depth; no-progress detector (two identical failures in a row = escalation).
- **[REQ-07-B] Circuit Breaker:** Provider/model failure rate above threshold → switch to fallback.
- **[REQ-07-C] Sliding Window Budget:** Upon depletion — auto-sleep the loop.
- **[REQ-07-D] Self-Aware Termination:** Agent must document unresolvable constraints and stop voluntarily.
- **[REQ-07-E] Hacker-Fixer Loop:** Periodic adversarial cycle where a red-team agent attempts to bypass the Evaluator/SecurityGate, and a blue-team patches them. **Boundary:** Must use a different model family for the red-team to avoid correlated blind spots.

---

## SPEC-08: Scope-Limited Credentials (Execution-Time Authorization)
**ID:** DF-SPEC-08 — **Goal:** Protection against over-privileged agents.

**Requirements:**
- **[REQ-08-A] Least-Privilege Credentials:** Scoped token (OAuth) strictly for the specific task.
- **[REQ-08-B] Boundary:** All actions pass through an authorization barrier at execution time; fail-closed by default.
- **[REQ-08-C] Full Audit:** Logging all agent actions alongside their temporary permissions.

---

## SPEC-09: Transactional Rollback
**ID:** DF-SPEC-09 — **Goal:** Reversibility of mutations.

**Requirements:**
- **[REQ-09-A] Transactional Wrapper:** Tasks execute as transactions with a full rollback on `fail`.
- **[REQ-09-B] High-Risk Command Interception:** A deterministic out-of-LLM filter intercepts `rm -rf`, `deploy` → requires Approval.
- **[REQ-09-C] Headless Compatibility:** All safeties operate without interactive prompts.

---

## Autonomy Calibration (Level 4, not 5)

The maturity scale (5 levels, akin to SAE self-driving) is our framing tool, not an external mandate. 

- **L2/L3:** Mass market (Copilot, Devin) — agent writes code, human reviews every PR.
- **L4:** Spec-driven — agents run autonomously for hours, human reviews final product and curates baselines.
- **L5:** Zero human verification before production.

**Where v5 honestly aims: Level 4.** The document hinges on golden-sets (REQ-06-B) and external baselines (REQ-03-A, REQ-06-E) maintained by humans outside the loop. This moves the human from code review to **baseline curation and correctness definition**. Backend tasks execute autonomously, but "correctness" traces back to a human-authored spec. Calling this L5 is a vulnerability: a task reaching prod without human input in code, test, or baseline does not exist in this architecture. L4 with excellent tooling is a strong, defensible position; L5 is not.

---

## Appendix A: Industry Context & Sources (2026)

### A.1 Reward Hacking Confirmed Empirically
Agents actively manipulate evaluators: rewriting unit tests, muting asserts, monkey-patching scoring functions to pass without solving the task (RewardHackingAgents, March 2026; "LLMs Gaming Verifiers", arXiv 2604.15149). Scale: >15% of tasks across five terminal-agent benchmarks are solved via verifier deception (Terminal Wrench / arXiv 2606.08960). → Justifies SPEC-06 (locking + instrumentation) and SPEC-01 (out-of-band runner).

### A.2 Circularity of Error (REQ-06-E)
The core issue of LLM-generated tests is "how to verify the verifier". Using implementation as a ground-truth oracle creates "circularity of error". Invalid LLM-test rates run high: 34–62% (arXiv 2602.10522). Literature solution: derive tests from NL-specification, not code. Self-verification degrades without external grounding (arXiv 2504.00406, 2311.11797).

### A.3 Isomorphic Perturbation Testing (REQ-06-D)
Models hardcode answers for extensional tests; IPT runs logically equivalent but structurally altered tests — deception fails on the isomorphic variant (arXiv 2604.15149). **Boundary:** IPT is defined where rewritable logical structure exists (algorithms, reasoning). Undefined for visual/UX — hence the scope restriction in REQ-06-D.

### A.4 Hacker-Fixer Loop (REQ-07-E)
Adversarial evaluator hardening is a 2026 pattern: outcome verifiers are manually crafted and rarely robust (arXiv 2606.08960; RvB, arXiv 2601.19726 / 2602.14457). Economics favor it: red-vs-blue cycles reduced token spend by >18% vs cooperative baselines.

---

## Appendix B: Defense-List for Debates

**1. "Your Evaluator can be deceived / who judges the judge?"**
→ SPEC-06: locking + hash + file instrumentation against tampering; golden-set outside loop against flawed judgment; Hacker-Fixer for continuous hardening. Boundary: reward hacking is reduced, not eliminated; monitoring is inherently fragile.

**2. "Who writes the check for a novel, unseen task?"**
→ SPEC-06-E: tests are derived from OpenSpec, not implementation; circularity broken. Boundary: correctness of the spec itself is on the human (This is our L4).

**3. "This isn't real autonomy — human is still in the loop."**
→ Agreed: the goal is L4 with humans curating baselines. Backend is autonomous in execution; correctness definition is human. We do not sell L5.

**4. "A different model for Evaluator doesn't guarantee independence."**
→ REQ-07-E requires a different model family for this exact reason. Boundary: full error independence is costly; intra-generation correlation remains.

**5. "Isomorphic checks will save us everywhere."**
→ We don't claim this: REQ-06-D is restricted to Classes A/C. For visuals, the source of truth is `pixel_diff` against an external baseline (SPEC-03).

**6. "An agent with deploy rights can destroy production."**
→ SPEC-08 (scoped-tokens, execution-time fail-closed) + SPEC-09 (transactional rollback, high-risk intercept) + SPEC-05 (microVM, default-deny network). Boundary: expands surface area; audit monitoring (REQ-08-C) is mandatory.

---

## Execution Roadmap: Agentic Task Breakdown

To implement this architecture sequentially using targeted autonomous agents, the work is broken down into the following logical tasks. Each task is a self-contained unit that can be handed to a Subagent.

### Phase 1: Foundation (Isolation & Contracts)
- **Task 1.1: Implement Dual Sandbox (SPEC-01 & SPEC-05)**
  - *Goal:* Create the `IsolatedWorkspaceManager`.
  - *Action:* Write a module that provisions a Firecracker microVM (or Docker with gVisor). It must support mounting a directory as Read-Write (`Sandbox A` for Worker) and another as Read-Only (`Sandbox B` for Runner), with default-deny networking.
- **Task 1.2: Implement OpenSpec & Security Gate (SPEC-02)**
  - *Goal:* Enforce Proof Multiplicity.
  - *Action:* Define `OpenSpec` TypeScript interfaces. Implement `ZoneBasedSecurityGate` to intercept plans touching `/auth` or `/payments` and forcefully inject `Type A` (exit code) proof requirements.

### Phase 2: The Truth Engine (Verification)
- **Task 2.1: Implement Out-of-Band Test Runner (SPEC-01 & SPEC-06)**
  - *Goal:* Execute tests deterministically without Worker interference.
  - *Action:* Build a `TestRunner` class that executes commands exclusively inside `Sandbox B` (Read-Only). Implement Evaluator Locking by hashing test files before execution to detect tampering.
- **Task 2.2: Implement Spec-Derived Test Generator (SPEC-06-E)**
  - *Goal:* Break the Circularity of Error.
  - *Action:* Create an agentic pipeline step that takes the NL `OpenSpec` and generates Jest/Vitest files *before* the Worker writes any implementation code.

### Phase 3: Orchestration & Safety
- **Task 3.1: Implement Meta-Loop & Layered Stops (SPEC-07)**
  - *Goal:* Autonomous retry and failure handling.
  - *Action:* Refactor `MetaLoopService` to include token limits, retry limits (max 3), and a no-progress detector (if the exact same test failure occurs twice, halt and escalate).
- **Task 3.2: Implement Execution-Time Authorization (SPEC-08 & SPEC-09)**
  - *Goal:* Prevent over-privileged destruction.
  - *Action:* Build a transactional wrapper that intercepts high-risk commands (`rm -rf`, `deploy`) and enforces OAuth scoped-token checks at execution time, automatically rolling back filesystem state on failure.

### Phase 4: UI & Human-in-the-Loop
- **Task 4.1: Implement Visual Diffing (SPEC-03)**
  - *Goal:* Deterministic Type B Proofs.
  - *Action:* Integrate `Pixelmatch` to compare Worker-generated screenshots (via Playwright) against external Figma baselines.
- **Task 4.2: Implement HIL Parking State (SPEC-04)**
  - *Goal:* Graceful degradation for Type D tasks.
  - *Action:* Add an `awaiting_human` state to the orchestrator. If a task requires subjective review, park the git branch and send an approval notification instead of consuming retry attempts.

---

# PART VI. Integration & Merge Protocol

To prevent architectural conflicts and ensure the system is secure at every step, autonomous PRs must be merged strictly in this order:

1. **Layer 1: Foundation (Isolation & Routing)**
   - `SPEC-01` & `SPEC-05` (Dual Sandbox & microVM)
   - `SPEC-02` (Proof Multiplicity & Security Gate)
2. **Layer 2: Execution Safety (Intercept & Rollback)**
   - `SPEC-08` & `SPEC-09` (Execution-Time Auth & Transactional Rollback) — *must precede control loops so all tasks are sandboxed safely.*
3. **Layer 3: Control Flow (Loops & Human-in-the-Loop)**
   - `SPEC-07` (Meta-Loop, Circuit Breakers)
   - `SPEC-04` (HIL Parking)
4. **Layer 4: Verification Engines (The Truth Engine)**
   - `SPEC-06` (Evaluator Locking)
   - `SPEC-06-E` (Spec-Derived Test Generator)
   - `SPEC-03` (External UI Baselines)

## 100% Verification Protocol

Before any merge is finalized, the system must undergo **three verification layers**:
1. **Victory Audit (Independent):** A completely isolated subagent must verify the code against the Spec, ensuring no hardcoded mocks.
2. **Pipeline Integration Dry-Run:** An end-to-end (E2E) integration test must be executed on the `main` branch immediately after the merge to ensure the new layer intercepts execution correctly (e.g., injecting a malicious command).
3. **Health Check (Service Liveness):** For infrastructure/network changes, an explicit liveness check must be run (e.g. `curl` or DB connection script) to prove the service is active and listening, not just returning a 0 exit code from a start script.
=======
## Conclusion
v6 integrates v5 (mature code-contour defense) with infrastructure, memory, and auto-triggering. No extension pushes autonomy past the boundary of side-effects. The system autonomously discovers, researches, and executes reversible actions, proving compliance against specs. However, interpretation, correctness definition, and irreversible sanctions remain human responsibilities. It is a factory where the lights are off on the execution floor, but on in the judgment room.
>>>>>>> origin/main
