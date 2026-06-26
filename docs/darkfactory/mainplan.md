# Dark Factory: OpenSpecs v5 (Full Autonomy Architecture)

Revision of v4. The entire backbone is preserved (SPEC-01…09 close vulnerabilities like log forgery, metric gaming, prompt injections, and over-privilege via out-of-LLM mechanisms). Three substantial changes compared to v4:

1. **SPEC-06 extended** with a requirement against *circularity of error* — tests for a new task must be derived from the specification, not from the Worker's implementation. This closes the main remaining gap: "who writes the check for an unseen task."
2. **Appendix rewritten** — unsubstantiated claims replaced with links to 2026 industry sources, including honest disclaimers about boundaries.
3. **Autonomy Calibration** — the goal is explicitly designated as "Level 4 with a human curating the baselines," rather than "Level 5." Added a defense-list for debates.

**Core Principle:** Trust is built not on LLM evaluators, but on independent sources of truth, isolated in different sandboxes (microVMs), and deterministic mechanisms outside the LLM. Where determinism is impossible, the human remains — and this is an explicit, not a hidden, boundary of the method.

---

## SPEC-01: Context Isolation & Dual Sandbox
**ID:** DF-SPEC-01

**Requirements:**
- **[REQ-01-A] Worker Isolation:** Work is executed in an isolated Git Worktree (`Sandbox A`).
- **[REQ-01-B] Runner Sandbox (Read-Only):** The Test-Runner operates in `Sandbox B`, where code from `Sandbox A` is mounted **read-only**.
- **[REQ-01-C] System Scripts:** The Runner uses its *own* verification scripts, not the `package.json` inside the project.

---

## SPEC-02: Proof Multiplicity
**ID:** DF-SPEC-02

**Requirements:**
- **[REQ-02-A] Proof Structure:** Type A (Behavior, `exit_code: 0`), Type B (Visual, `pixel_diff`), Type C (Heuristics `SonarQube` + Type A green).
- **[REQ-02-B] Zone-Based Security Gate (Out-of-LLM):** Touching `/auth` or `/payments` → forcibly appends a Type A proof requirement.
- **[REQ-02-C] Planning ≠ Authorization:** The Gate verifies the plan but does not replace execution-time authorization (SPEC-08).

---

## SPEC-03: External Baselines for UI
**ID:** DF-SPEC-03

**Requirements:**
- **[REQ-03-A] External Baseline:** For Visual Proofs, the baseline comes from *outside* the loop (Figma/designer).
- **[REQ-03-B] Deterministic Diff:** Comparison via Pixelmatch, not Vision-LLM. Vision models act only as advisors to the Worker.
- **[REQ-03-C] Hard Binding:** The "task ↔ baseline" association is fixed deterministically by the component path, not chosen by the agent.

---

## SPEC-04: Parking and HIL (Human-In-The-Loop)
**ID:** DF-SPEC-04

**Requirements:**
- **[REQ-04-A] Pending Approval:** Tasks with Type D (subjective evaluation) are parked for human review.
- **[REQ-04-B] Gate on Type D:** Assigned only if the Zone-Gate confirms no protected zones are touched.
- **[REQ-04-C] HIL Limit:** Exceeding the allowed ratio of tasks in `awaiting_human` signals broken routing.

---

## SPEC-05: microVM-Level Sandbox
**ID:** DF-SPEC-05 — **Goal:** Protection against prompt-injection and execution of malicious code with access to secrets.

**Requirements:**
- **[REQ-05-A] microVM Isolation:** Both sandboxes run in Firecracker/Kata (gVisor as a lightweight option). Each task gets a dedicated guest kernel.
- **[REQ-05-B] Default-Deny Network:** The Worker only has access to an allow-list, immutable from the inside.
- **[REQ-05-C] No Production Secrets:** Keys are not mounted; integrations use scoped tokens (SPEC-08).

---

## SPEC-06: Verifying the Verifier (Evaluator Locking + Golden-Set + Spec-Derived Tests)
**ID:** DF-SPEC-06 — **Goal:** Protection against reward hacking and circularity of error.

**Requirements:**
- **[REQ-06-A] Evaluator Locking:** Verification scripts live in Sandbox B and are hashed before execution; any attempt by the Worker to modify them = `fail`.
- **[REQ-06-B] Golden-Set:** A new Evaluator/skill is admitted only upon achieving 100% on a baseline set outside the loop.
- **[REQ-06-C] File-Access Instrumentation:** Any access by the Worker to test files is logged and punished with a failure.
- **[REQ-06-D] Isomorphic Check:** Checking logic invariance on equivalent tasks (protection against hardcoding). **Scope: Classes A and C. Not applicable for Type B (visual).**
- **[REQ-06-E] Spec-Derived Tests:** For a new task, tests are generated from the `OpenSpec` (NL-description/contract), **not from the Worker's implementation**. 

> **Why REQ-06-E is critical:** Without it, a cycle emerges on unseen tasks: Worker writes code → Worker writes test for this code → test passes → bug is cemented as normal. Golden-sets only catch this if the new task resembles labeled ones. Deriving tests from a human-provided spec breaks the cycle and keeps the human at the correctness-definition level.

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
