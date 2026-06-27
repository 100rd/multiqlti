# Dark Factory: OpenSpecs — Consolidated Master Plan (v6 + v7 + v8)

This is the complete plan in one document. It consolidates the entire evolution:
- **v6 core** — nine SPECs, infrastructure contour, memory service, auto-triggered planning.
- **v7 additions** — skill lifecycle, multi-level rule placement, tags/labels, ABAC inheritance, agent identity/access (Parts V–VIII), and the three-class breakdown of open boundaries (Part X).
- **v8 additions** — resilience and independence layer: contour observability, AI-agnostic fallback, AI-nativeness two-layer design, provider agnosticism (Parts XI–XVI).

**The Overarching Principle (unchanged throughout evolution):** Autonomy is heterogeneous and stops exactly at the boundary of side-effects. Thinking, researching, planning, and testing in ephemeral environments is autonomous. Irreversible actions (applying to persistent state, deprecating, interpreting intent, defining correctness) remain with the human. This is not a weakness on the path to L5; this is mature design: we aim for **Level 4** (autonomous execution with human correctness definition), not L5.

This document is a **plan/architecture specification**, not an execution authorization.

---

# PART I. Core SPECs (v5) — Summary

*For full definitions, refer to v5 artifacts. Summarized here for context.*

- **SPEC-01** Dual Sandbox: Worker in Sandbox A, Test-Runner in Sandbox B (read-only mount), system verification scripts instead of project `package.json`.
- **SPEC-02** Proof Multiplicity: Type A (behavior/exit_code), B (visual/pixel_diff), C (heuristics+A); Out-of-LLM Zone-Based Security Gate; plan ≠ authorization.
- **SPEC-03** External UI Baselines: Figma baseline, deterministic Pixelmatch (no Vision-LLM), rigid task↔baseline binding via component path.
- **SPEC-04** HIL: Type D tasks parked for humans; gate on assigning Type D; limit on `awaiting_human` ratio.
- **SPEC-05** microVM (Firecracker/Kata/gVisor), default-deny network, no production secrets.
- **SPEC-06** Verifier Verification: locking + golden-set + file-instrumentation + isomorphic check + **spec-derived tests** (tests derived from OpenSpec, not implementation — breaks circularity of error).
- **SPEC-07** Meta-Loop: Layered stop conditions, circuit breakers, sliding window budget, self-aware termination, hacker-fixer loop (red-team from a different model family).
- **SPEC-08** Scope-Limited Credentials: Least-privilege OAuth, execution-time authorization (fail-closed), full audit. **→ See Part VII: realized via platform ABAC.**
- **SPEC-09** Transactional Rollback: Wrapper with rollback, interception of high-risk commands out-of-LLM, headless compatibility.

---

# PART II. Infrastructure Contour (Type E)

Once the system delivers code into an environment, **side-effecting actions that survive a git-rollback** emerge. Rolling back a commit is easy; rolling back a migration that dropped a column is not. The center of gravity shifts from "code correctness" to "action reversibility."

## SPEC-E0: Type E — Infrastructure Task Class
**Goal:** A distinct class for side-effecting actions (migrations, deployments, dependency changes) with its own proof and reversibility model.

- **[REQ-E0-A] Migration Proof Triad:** (1) forward script applied, (2) **rollback applied** (down-script is mandatory and tested; absence = pre-execution `fail`), (3) behavior on prod-like data did not break.
- **[REQ-E0-B] Infrastructure Zone-Gate:** Any task touching migrations/deployments/dependencies **cannot** be Type A or D — it is forced to Type E with all its proofs.
- **[REQ-E0-C] Deploy-Proof:** Application boots with dependencies in a prod-like environment, passes behavioral smoke/integration tests, and only then receives a verdict.

## SPEC-E1: Three Environments — Three Levels of Autonomy
**Goal:** Autonomy scales unevenly across environments by design.

| Environment | Reversibility | Autonomy | Mechanism |
|---|---|---|---|
| **Ephemeral (dynamic envs)** | Throw the env away | Maximum | Fresh IaC env per run, destroyed post-verdict. "Rollback" = "env didn't live past the test." Cannot validate scale. |
| **Persistent prod-like** | Re-provision to baseline | Medium | Survives the task → inter-task interference. Reset to baseline is deterministic systemic re-provision, **not by the agent**. Used for load-testing and scale-dependent migrations. |
| **Prod (read-only)** | No writes | Read-only | Data source, not an action target. |

- **[REQ-E1-A] Default Ephemeral:** Behavioral tests (migrations, integrations) run in disposable environments.
- **[REQ-E1-B] Persistent Reset:** Baseline reset between tasks is system re-provisioning, not agent self-cleanup.
- **[REQ-E1-C] Scale & Load Gates:** Applying a migration/load-test to a persistent prod-like environment with non-empty state = irreversible candidate → approval (SPEC-04). Ephemeral environments need no approval.

**Note on ephemerality (two kinds, by work type):**
- Code execution (Worker writes/tests software) → **microVM** (Firecracker/Kata), throw the process away.
- Infra deployment (operator, cluster, StatefulSet) → **preview env / ephemeral namespace** (vcluster/kind/namespace-per-task), throw the namespace away. An operator will not run in a microVM — a control-plane action needs a real cluster. One Type E run may use both.

---

# PART III. Observation / Memory Service

Prod observations play two roles: **output proofs** (no degradation) and **planning inputs** (requirements derived from reality). The latter is dangerous because observation ≠ intent.

## SPEC-10: Observation/Memory Service
**Goal:** A shared, linked source of truth regarding platform state spanning three lifecycles. Isolated from untrusted code execution.

> **Concrete realization — `Omniscience` (UPDATED after review).** `Omniscience` is the named implementation of this service: a self-hosted *Living Semantic Core* that turns fragmented operational data (cloud, IaC, K8s runtime, CI/CD, alerts, incident chat, docs) into a single **causal + temporal + semantic graph**, exposed **MCP-first** to any MCP-compatible AI client (Claude Code, Cursor, Gemini, LangGraph/CrewAI agents). Hybrid backend: **Neo4j** (topology, ownership, dependency, causal edges, temporal state) + **Qdrant** (semantic content) + **Postgres** (operational metadata + lineage). It maps to the three layers below, with two architectural properties that directly serve this plan:
> - **Retrieval-only by design:** no embedded LLM — it returns linked, cited evidence with confidence, and the *calling* (swappable) LLM synthesizes. This is the v8 watershed (Part XV) realized inside one product: facts below, reasoning above.
> - **Write-actions are an explicit non-goal:** it emits structured evidence for policy engines (OPA/Rego) rather than acting. This is REQ-XIII-D ("manage, don't replace") as a product boundary.
>
> **Scope split (important):** Omniscience implements **Layer 1** (observation graph + cross-source identity) and the **infrastructure for Layer 3** (as_of-stable, cited contracts). **Layer 2** (derived requirements + interpretation gate) sits in the *factory contour above Omniscience* — Omniscience reports "field shrank to 5%, confidence X, lineage Y"; turning that into a requirement under human gate (REQ-10-E) is the factory's job, not the graph's.

**Layer 1 — Observation Store (Raw Data) → Omniscience graph.** Raw aggregates and trends from production. Volatile, append-only, retention policy.
- **[REQ-10-A] PII Obfuscation:** Logs with PII are masked/redacted (e.g., card numbers → `***`) rather than fully stripped — gives the agent exact data syntax for debugging (e.g., malformed JSON structure) without leaking raw PII.
- **[REQ-10-B] Bitemporal storage (UPDATED):** Not merely a trend series — every entity/edge carries `valid_from`/`valid_to` (real-world time) plus `recorded_at` (ingestion time). The graph is queryable **as_of any timestamp**, enabling point-in-time replay ("what did the agent see at time T"), which subsumes the original "distinguish regression from daily fluctuation."
- **[REQ-10-C] Execution Isolation:** Read-only prod channel is **never** mounted in the Worker sandbox; requires scoped-tokens (SPEC-08) and full audit. (Omniscience is self-hosted; data never leaves the perimeter.)

**Layer 2 — Derived Requirements (Hypotheses) → factory contour above Omniscience.** What the system extracted: "MTTR budget is 1m", "Field X is a deprecation candidate".
- **[REQ-10-D] Mandatory Provenance (UPDATED):** Realized as Omniscience **lineage + citations** — every retrieval response carries citations, lineage, confidence and `effective_as_of`. Each derived requirement links back to the observation, time window, and confidence by construction.
- **[REQ-10-E] Interpretation Gate:** Deductions affecting irreversible actions (deprecating API, breaking changes) are flagged "requires human confirmation." Fact ("Traffic dropped to 5%") ≠ Decision ("Delete old format"). This gate lives in the factory, not in the retrieval-only graph.

**Layer 3 — OpenSpec (Contract) — backed by Omniscience as_of-stable retrieval.** Stable, human-readable source of truth.
- **[REQ-10-F] Reference, Don't Copy:** Specs link to derivations ("see derived-req-447"), preventing spec rot. Omniscience's `as_of`-aware retrieval ensures freshness and point-in-time consistency at planning start.
- **[REQ-10-G] Drift-Detector:** Background tasks compare current observations against the baseline that generated the requirement; alert if divergence exceeds threshold. (On the Omniscience roadmap as desired-vs-actual drift detection via its K8s operator.)
- **[REQ-10-H] Graph Edges — confidence-scored, not binary (UPDATED):** Cross-source edges carry a **confidence score with explicit strategy attribution** (declarative metadata / OpenTelemetry trace context / ML clustering), which is richer than a binary Observable-vs-Hypothesis split. Low-confidence/inferred edges still require human confirmation before being treated as facts for planning, preventing the memory service from hallucinating causality.

**SRE-shaped MCP tools (relevant to other Parts):** beyond `search` — `resolve_incident`, `incident_timeline`, `blast_radius` (causal traversal + impact estimate), `replay_context` (point-in-time), `suggest_runbook`, `find_similar_incidents`, `generate_postmortem`. Tokens are scoped (`search`, `sources:read`, `sources:write`, `admin`); graph/incident tools need a workspace-scoped token — aligning with SPEC-08 scoped credentials.
> **Maturity caveat:** `resolve_incident` confidence and `blast_radius` impact are v0.1 placeholders still being calibrated — do not build an automatic gate on the impact score until calibrated.

---

# PART IV. Auto-Triggered Planning: Two Modes

Self-started planning shifts the system from reactive to generative. Resolved by splitting the **right to initiate** from the **right to decide**.

## Mode A — Execution Auto-Trigger (Pre-approved Rules)
Intent is pre-defined by the human. Trigger is automatic (cron or drift-threshold), action is pre-approved.
- **[REQ-A]** Drift-detector/cron spawns a task **only** for reversible/safe classes using an approved template. The drift-detector is an alarm clock, not a strategist.

## Mode B-narrow — Research Auto-Trigger (No Execution)
Mode B on input, Mode A on output. The system generates hypotheses and explores the memory graph, but outputs **a question or ranked candidates to the human, not a task**.
- **[REQ-B-1] Output is a Question:** "Field X shrank to 5%, here are 3 interpretations. Which is correct?", not "I decided to deprecate X."
- **[REQ-B-2] Anti-Bias Agenda:** Research presents top candidates *and* what was discarded and why, preventing subtle steering of human decisions.
- **[REQ-B-3] Strict Token/Budget Quota:** Autonomous research is quota-limited (e.g., 10% of daily budget). Prevents "DDoS by Research" where noisy metrics exhaust compute before real work.

---
# PART V. Skill Lifecycle Management (SPEC-11)

**Principle:** managing skills = managing privileges, not capabilities. A skill describes *what to do*; rights stay with execution-time authorization (Part VII/VIII). A skill carrying a token or expanding an allow-list is forbidden by design — else the skill-store becomes a back door around the SPECs.

**Three skill types:** instruction-skill (declarative) / executable skill (code — dangerous, runs without review) / accumulated lesson (self-learning).

- **[REQ-11-A] Lifecycle (5 stages):** provenance (human/system/internet — different trust; external only via quarantine + human gate) → quarantine/admission (golden-set for skills; `unverified` not served into context) → versioning with provenance (validated on which model/env version; linked to memory service) → success-delta measurement in the contour → retirement of degraded skills (`deprecated` automatically).
- **[REQ-11-B] Assignment — asymmetry:** a deterministic gate (Zone-Gate logic) yields the permitted *set* of skills by task class/zone; the agent freely chooses within the set. Boundary out-of-LLM, choice within by the agent.
- **[REQ-11-C] Active verification offer:** on encountering an `unverified` skill relevant to a task, the planner raises its verification as a separate branch (B-narrow: "here is a candidate — run the golden-set?"). Not silent ignoring.
- **[REQ-11-D] Human:** admitting a new/external/self-derived skill = expanding blast radius → human gate. Choosing among admitted → autonomous.

**Open question (debate):** self-learning skills are self-closure. Golden-set catches gross regressions, but a subtle procedure change is a candidate for human confirmation per the circularity logic.

---

# PART VI. Multi-Level Rule Placement & Self-Learning Boundaries

### Four levels of a rule (by rate of change and owner):
1. **Best-practice (class principle)** — e.g., "infra success = verified behavior, not exit code". The Type E constitution, human-authored, rarely changes.
2. **Spec (task contract)** — e.g., "Mongo ready at N nodes and factor R". OpenSpec, human-curated, parameters from the task.
3. **Skill (verification procedure)** — e.g., "verify the cluster in 3 steps". Skill-store, assigned by zone.
4. **Body (execution)** — mongosh commands, parsing, timings. Versioned with provenance.

Separated because the spec is stable, the skill is mutable, execution is fragile. Link: a skill is the way to produce the proof the spec demands; the runner executes the body.

### Self-learning boundaries by layer:
- The system **autonomously derives and refines the body** (execution empirics — timings, parsing, error handling; verifiable by replay, caught by golden-set).
- The **verification procedure and definition of success** are only *proposed* by a derived pattern → quarantine + human confirmation. Reason: one success codifies luck as law (circularity of error in infrastructure). The first deployment produces an `unverified` candidate-skill, not an admitted one.
- Memory link: deployment trace → Observation Store → derived candidate with provenance → quarantine.

### Growing-trust model for skills:
After N successful replays: `unverified → verified` (no longer needs human confirmation of the procedure, assigned automatically, verified in one cheap pass without adversarial re-check). **But verification of the result of each concrete run always remains** — N successes confirm the *method*, not the next concrete cluster (different namespace, load, factor, resource state). Reversible: human confirmation of the procedure. Irreversible: system verification of the result. Rationale — cost asymmetry (a second's check vs a silent split-brain). This is the reverse side of the self-learning boundary: the system learns *how* to check and stops asking the human about the method, but never stops *checking*.

---

# PART VII. Tags/Labels: Unit Boundaries + ABAC Enforcement

**Key shift:** the contour reasoned at the code-zone level. A tag provides a **graph of logical boundaries over heterogeneous infra** — the real source of truth about the boundary of consequences. And a significant part of SPEC-08 is **already realized** by the platform as ABAC (AWS/GCP/K8s/GitHub) — the contour inherits, it does not reinvent.

### Four levels at which a tag works in the contour:
1. **Blast radius by unit, not code-zone** — Zone-Gate becomes Unit-Gate. A task touching a component tagged `unit:auth` → the whole unit is at risk (authn depends on mongo — dropping mongo downs login). *(Realized via Omniscience `blast_radius` — causal-graph traversal + impact estimate from a seed; note the impact score is a v0.1 placeholder still calibrating, so use it for surfacing scope, not yet for an automatic gate.)*
2. **Unit-level proof** — "does the auth block work as a whole" via an end-to-end path defined by the tag. A per-component proof misses cross-cutting degradation; unit-level does not. The tag draws the contour of the end-to-end test.
3. **Rights & sensitivity inherited by tag** — least-privilege scoped to the tagged unit; elevated audit of a unit (`contains:mfa`) extends to "harmless" components inside.
4. **Planning sees system structure** — the plan is complete relative to declared dependencies.

### Inheriting platform ABAC:
- **execution-time authorization (SPEC-08)** realized as tag-matching in IAM: action allowed if principal-tag matches resource-tag. Not "must not" — IAM **will not issue**.
- **Secret isolation (SPEC-05-C)** realized via Pod Identity session-tags: namespace isolation of secrets via ESO; a Worker in `preview-task-N` cannot reach `auth-prod` secrets.
- **Zone-Gate enforcement** realized via admission policies (Kyverno/VAP): deploying a `platform.system: auth` pod is rejected if the actor lacks rights — at admission, not by LLM.
- **Network blast radius** realized via Cilium: a payment-unit pod talks only to payment components (label micro-segmentation).
- **Locking verification scripts (REQ-06-A)** strengthened by GitHub path-restriction rulesets: a Worker cannot commit a change to its verification pipeline/golden-set (bypass only for security-team).

### Tag is read-only for the contour:
Changing a tag/label = changing security boundaries = a privileged action. Intercepted by platform guardrails (`aws:TagKeys`, Kyverno on labels, VAP). An agent cannot rewrite `actor:mode` or strip `contains:mfa` — forbidden at the API level, not by trust. **Privilege self-escalation is intercepted by infrastructure.**

### Orthogonality of ABAC and verification:
ABAC answers "is it allowed", verification answers "is it correct". Both mandatory, neither replaces the other. One `unit:auth` tag is read by two layers: IAM decides "let in", Zone-Gate decides "how strictly to verify". Tagging does not help with substantive correctness — it is not designed for that.

### Condition for the planner:
Admission policies (Kyverno/VAP) live in git and ship to the cluster via GitOps (ArgoCD) — git = source of truth matching what is applied. The planner reads the admission layer, not only RBAC (K8s RBAC has no label selectors), to know about early rejection rather than hitting Kyverno at deploy.

---

# PART VIII. Identity & Access for Agents

**Principle:** an agent's principal-tag = **task scope + mode**, NOT "actor type as a set of rights". An agent's rights flow from the task it executes, not from being an agent. Scope expires with the task.

### Two agent classes (inverse asymmetry of reach):
- **Read agent** (planner, researcher, metrics, drift-detector): `actor:mode: read`. Wide reach (sees the whole platform for planning), zero mutation. Read channel to prod — aggregates, not raw data.
- **Execute agent**: `actor:mode: execute` + unit/env scope. Narrow reach (own unit only), may mutate within. Mutations pass through ephemerality/proof/approval.

A reader sees much but touches nothing; an executor touches but sees little.

### Three tag dimensions on a principal:
- `actor:type` — `human` / `cicd` / `agent` (for audit and policy differentiation).
- `actor:mode` — `read` / `execute` (the right-class; this, not `actor:type`, determines what is allowed).
- `scope:*` — inherits the task's `system`/`env`.

### One ABAC logic, three ways to assign scope:
- **Human** — scope via group membership — manual/semi-auto.
- **CI-CD** — scope via runner-group / GitHub App identity — semi-auto by pipeline trigger.
- **Agent** — scope dynamically via Pod Identity session-tags at the moment of task placement — fully auto, expires with the task.

### Autonomy mode ≠ actor property:
Automatism is resolved by the pair **(environment, action reversibility)**, not by the actor being an agent. An execute-agent in an ephemeral env — fully auto. The same agent, same `execute` role, but a migration to persistent state — hits approval. A "fully automatic agent" still passes the gate on the irreversible.

### Human:
Admitting an agent class to a task class (`actor:mode: execute` for unit X in env preview) is a privileged declarative action, rare, human/platform. Placing a concrete agent on a concrete task within the admitted — automatic, frequent. Expanding the boundary — human; acting within — system.

---
# PART IX. The Human Boundary (Autonomy Matrix)

| Action | Autonomous | Human |
|---|---|---|
| Writing code; verdict via spec-derived checks | Yes | — |
| Execution/deploy in ephemeral env | Yes | — |
| Choosing a skill among admitted | Yes | — |
| Placing an agent on a task within an admitted class | Yes | — |
| Starting research/planning (B-narrow) | Yes | — |
| Self-learning of skill body | Yes | — |
| Verification of result (even for a verified skill) | Yes (system) | — |
| Migration to persistent state / load testing | — | Approval |
| Deprecation / breaking change | — | Decision |
| Setting a goal from research | — | Choice of candidates |
| Interpreting a prod metric into a requirement | — | Confirmation |
| Defining correctness (spec, golden-set, procedure) | — | Curation |
| Admitting a skill (new/external/self-derived) | — | Gate |
| Admitting an agent class to a task class | — | Declarative |
| Changing a tag / security boundary | — (API-forbidden) | Platform |
| Hypothesis-edge in memory graph → fact | — | Confirmation |
| Production application (esp. auth/MFA) | — | Human/release |

**In one sentence:** the machine discovers, executes reversible actions, and proves compliance; the human interprets, defines correctness, sanctions the irreversible, and expands boundaries.

---

# PART X. Open Boundaries — Three Classes

The nine boundaries are not homogeneous. Some are closed by mechanism, some are principally irreducible (defense only), some are disputes about where to draw the line. On debate, each class is answered differently.

## Class 1 — REFINEMENTS (mechanism exists, bring to procedure)

| # | Boundary | What to refine |
|---|---|---|
| 4 | Memory links can be false | Confirmation procedure for a derived edge: confidence threshold, batch human confirmation, TTL of a hypothesis-edge. Declared edges = fact; derived = candidates with an explicit gate. |
| 5 | Read-only prod is a leak surface | Specify the PII-filter policy: what passes (aggregates, metrics, tags), what is cut/masked (raw strings, identifiers), who defines the rules (platform, declaratively). |
| 6 | Irreversibility lives in data, not code | A `migration-safety-hook` analogous to `terraform-env-check.sh`: forward without a tested rollback = `exit 1`. Closes the asymmetry where Terraform is guarded by a deterministic hook but data-actions only by a soft plan-criterion. |
| 7 | Self-learning is self-closure | Operationally define what counts as a "subtle procedure change" requiring a human vs a "body refinement" allowed autonomously. The layer boundary is set; the "subtlety" criterion is not. |

**Plus architectural items not yet specified in the plan:**
- Dual sandbox / out-of-band runner so verification runs isolated from execution (trust → isolation). Most structural.
- Env reconciliation: the environment determined by path/declaration must match the actually addressed state backend — closing a classic bypass vector.
- A three-layer memory service with provenance and a drift-detector as a separate subsystem (a chronological log does not provide this) — the bridge to self-learning.
- Data-actions must be guarded on par with infrastructure actions (see boundary 6).

## Class 2 — PRINCIPLED (not solvable; hold the defense)

| # | Boundary | Defense |
|---|---|---|
| 1 | Reward hacking is reduced, not eliminated; monitoring fragile without reasoning traces | Acknowledged: detectability drops (TPR 82%→44% without reasoning). The answer is not "eliminated" but "layered defense (locking + golden-set + file-instrumentation + isomorphic) reduces it to acceptable, and escape rate is monitored as the verifier's honesty metric". A boundary, not a hole. |
| 2 | Spec & golden-set correctness on the human | This is our stated position, not a concession. We aim for L4, not L5. A task reaching prod without a human in code, test, or baseline does not exist — because someone labeled the baseline. Stronger than "almost L5": L4 cannot be struck for an unmet promise. |
| 8 | ABAC gives "allowed", not "correct" | Not a hole but a layer split. ABAC (platform) and verification (contour) are orthogonal, both mandatory. One tag, two readers: IAM decides "let in", Zone-Gate decides "how strictly to verify". |

## Class 3 — DISPUTE ABOUT THE LINE (debate, not bug)

| # | Boundary | The debate fork |
|---|---|---|
| 3 | Full generative goals (Mode B) not implemented | Thesis: it breaks the support "human defines correctness" — the system sets a goal, fits a criterion, passes itself (circularity at the intent level). Antithesis: B-narrow (research without action) is safe, and the line could shift as trust accrues. Dispute — where exactly "initiate ≠ decide" sits. |
| 9 | Prod migration of auth/MFA kept human longer than other classes | Thesis: cost-of-error asymmetry — an MFA leak is catastrophic, so we keep the human longer even in mature mode. Antithesis: after a hundred identical successes the system earns autonomy here too; "longer" — how much, by what removal criterion. Dispute — is there an N of successes after which the auth class goes autonomous, or is it principally outside autonomy. |

**Principle of the split:** Class 1 is closed by work, Class 2 by formulation, Class 3 by decision.

---

# PART XI. Autonomy Calibration (Level 4, not 5)

The maturity scale (5 levels, akin to SAE self-driving) is our framing tool, not an external mandate.
- **L2/L3:** Mass market (Copilot, Devin) — agent writes code, human reviews every PR.
- **L4:** Spec-driven — agents run autonomously for hours, human reviews final product and curates baselines.
- **L5:** Zero human verification before production.

**Where this plan honestly aims: Level 4.** It hinges on golden-sets (REQ-06-B) and external baselines (REQ-03-A, REQ-06-E) maintained by humans outside the loop. This moves the human from code review to **baseline curation and correctness definition**. Backend tasks execute autonomously, but "correctness" traces back to a human-authored spec. Calling this L5 is a vulnerability: a task reaching prod without human input in code, test, or baseline does not exist here. L4 with excellent tooling is a strong, defensible position; L5 is not.

---
---

# ════════════════════════════════════════════════
# NEW IN v8 — RESILIENCE & INDEPENDENCE LAYER
# ════════════════════════════════════════════════

> The blocks below are **additions on top of v6**. They do not modify any existing SPEC.
> They add four new parts (XI–XIV), a unifying axis (XV), and new debate boundaries (XVI).
>
> **v8 cross-cutting thesis (one watershed named four times):** there is a line between the
> *portable load-bearing substrate* (state, mechanisms, procedures, verification, understanding —
> yours, below) and *swappable reasoning* (model access — the provider's, above). Theme 2 asks
> "what survives the loss of AI", Theme 3 "what may be optimized for AI", Theme 4 "how not to get
> locked to a provider" — all three answer with the same boundary. Theme 1 is the instrument that
> measures whether you are sliding along this axis into dependency.

---

# PART XII — Contour Observability & Effectiveness

## XII.1 Two distinct observabilities — do not conflate
- **Platform observability** (classical, time-series): service health — latency, errors, saturation. Independent of the factory, **survives severance**, consumed by agents as input (the Observation Store reads from here). This is substrate, not the subject of this theme.
- **Factory observability**: health of the *contour* — is the evaluator lying, are skills rotting, has verification been hollowed out. Absent in v6/v7. This is the subject.

## XII.2 The effectiveness trap
Measuring effectiveness by throughput (tasks/day, speed) is a **poisoned metric**. Everything that distinguishes a factory from a swarm of agents is verification, and verification costs time. A "speed" KPI points the optimization gradient straight at weakening checks → a fast factory that has unlearned how to verify. Goodhart's law at the most dangerous spot.

## XII.3 Autonomous Yield — the primary metric
**Definition:** the share of tasks that passed **without a human** AND **did not come back** (bug, rollback, incident, regression) within an observation window. A product: autonomy × correctness.

Why it can't be gamed: speed up by cutting checks → returns rise → correctness falls → yield falls. Everything to approval → autonomy falls → yield falls. The maximum exists only where the system is both autonomous AND correct.

- **[REQ-XI-A] Delayed window:** yield is computed with a lag ("share of last month's tasks that did not return within a month"), not instantly at verdict. A task that passes today may return as a bug next week. Trust in an autonomous system accrues slowly — so does the metric.

## XII.4 Three instruments on the trust panel
- **[REQ-XI-B] Escape rate** — share of tasks that passed verdict but came back as a problem. The **only direct measure of whether the evaluator lies.** The instrument-analogue of the principled boundary "reward hacking cannot be eliminated": we don't catch deception in the trace (fragile), we observe how much leaked to prod (observable).
- **[REQ-XI-C] Trust-drift** — is skill success-delta falling, is the evaluator diverging from the golden-set on re-attestation, is a derived requirement drifting from its observation. Early warning — fires before escape rate rises; catches mechanism rot rather than its consequence.
- **[REQ-XI-D] Intervention profile** — distribution of human interventions. 80% of approvals in one task class = broken routing there. Answers "why is yield low on the autonomy side".

## XII.5 Second human-wake channel
- **[REQ-XI-E]** Beyond the approval-gate (planned stop, "sanction this") — an **alert on trust degradation**, not tied to a task: escape rate breached threshold / trust-drift above norm / circuit breaker fired N times / evaluator diverged from golden-set. Approval is "decide this for me"; an alert is "come look, something is wrong with me." The sense organ for lights-out operation. Without it you learn of contour degradation from consequences, not from instruments.

## XII.6 Economics subordinated to yield
- **[REQ-XI-F]** Cost is measured **per unit of yield** — tokens per one autonomously-and-correctly completed task, not tokens/day. An expensive run yielding a returned bug is not cheaper — it is infinitely more expensive (zero in the denominator). Feeds the budget-gate (SPEC-07) a "what we pay per good unit" signal, not "what we spend".

**Severance link:** trust instruments are part of the factory and disappear at severance (interpretation = judgment). But the data beneath them (metrics, returns, incidents) is platform substrate and survives. The human loses the automatic panel, not the raw material for manual judgment.

---

# PART XIII — AI-Agnostic Fallback on Sudden Unavailability

**Scenario (refined):** not a planned kill-switch, but **sudden total unavailability of agents by external cause** — provider cut off by law/sanctions, outage, network partition. No warning phase. The agent vanishes at an arbitrary moment, possibly mid multi-step action.

## XIII.1 Architectural lock
State — yours (git, RDS, cluster). Mechanisms — yours (gitops, observability). The factory is part of the platform service for internal teams — yours. **The provider holds only model access.** The provider supplies reasoning, not the system.

**Consequence:** severance takes reasoning, but not state and not mechanisms. AI loss = "left without an advisor", not "without a system". A fundamentally different failure class than external SaaS.

## XIII.2 Requirements
- **[REQ-XII-A] Safe at any moment of disappearance:** every unfinished agent action is either atomic (applied wholly or not at all) or leaves a recoverable, human-readable state. The agent will not finish gracefully — it will vanish.
- **[REQ-XII-B] Transactionality in the platform, not the agent** (strengthens SPEC-09): on `fail`, the contour initiates rollback; on severance the contour is dead — rollback happens **without it**: automatically on timeout (an unconfirmed transaction is rolled back by infrastructure) or by a human reading the state. The rollback mechanism is not the agent's.
- **[REQ-XII-C] Human-reproducible via the same interface:** the agent has no private path to action. Everything it does goes through the same gitops/CI/runbook available to a human. After severance a human takes the same runbook and continues. (This is the "legibility tax" from Theme 3 — now insurance against external failure.)
- **[REQ-XII-D] Manage, don't replace:** the factory conducts independent mechanisms; it never becomes the only path to a function. **Test for each feature: "remove the agents — does the function survive?"** Observability: data written by the platform → yes. Gitops: rails in place → yes. Interpreting a metric into a requirement: the agent interprets → no — and that's fine, you lose conclusions, not observations.

## XIII.3 Self-hosted — honest about the cost
- **[REQ-XII-E]** Self-hosted closes one vector — "provider cut access to reasoning", not "our cluster failed". It works as a **reduced-capacity fallback**: on severance of the external provider, the contour switches to a local model in a "less capable but alive" mode (possibly B-narrow + read-only only, no autonomous execution). Not "the same thing in-house", but "a degraded but independent mode". Not a survival condition — the platform is manually operable without reasoning at all; self-hosted shortens time in manual mode.

## XIII.4 Method boundary
- Removability is guaranteed by architecture (state and mechanisms are yours) but **maintained by practice**: periodic **drills / game days** where the platform is deliberately operated without the factory. Otherwise the manual-operation skill atrophies, runbooks rot, and formal removability remains without people able to stand at the switch. An organizational tax, not technical. **Discipline by default.**

**Maturity test:** "if every LLM provider became unavailable forever tomorrow — does the platform run under humans?" Answer: "yes, slower." The factory is an accelerator, not a load-bearing wall; its absence is a normal platform state, not an incident.

---

# PART XIV — AI-Nativeness & Two-Layer Design

**Framing:** since AI arrived we balance compatibility and trade-offs. What if we built only for AI? (Karpathy: "absolutely everything will have to be rewritten; it's all built for humans.")

## XIV.1 Honestly — much is unneeded by or hinders AI
JSON is verbose (−40% tokens on an efficient format). PR with visual diff — for human perception. YAML indentation — irrelevant to the agent. MCP wrappers vs direct CLI (×3 cheaper, ×2 faster). Half of code-style — about legibility, not correctness. Built purely for AI, you'd drop the ceremony and compress the formats.

## XIV.2 The trap — it's the substrate of reversibility
Almost everything "unneeded by AI" is the substrate of removability (Theme 2): gitops = the rails of the human rollback; human-readable format = how a human reads state at severance; PR = the point where a human defines correctness (L4). **"Inconvenient for AI" = the price of removability.** Optimize fully for AI → faster and cheaper, but **unremovable** — you cut out the very layers through which a human takes over.

## XIV.3 Three classes of features
- **Class A** — human ergonomics, AI-indifferent, not needed for fallback (dashboards, colored diffs, names). Optimize/cut for AI freely. Low stakes.
- **Class B** — hinders AI, BUT load-bearing for fallback (gitops, human-readable state, PR, runbooks). **Cannot be cut** — without them there is no severance survival and no place for L4. The "reversibility tax", structural, non-negotiable.
- **Class C** — purely for AI, human-indifferent (token-formats in inter-agent exchange, machine contracts, direct CLI). Inside the contour — pure win, add freely.

## XIV.4 Architectural answer — two layers
- **[REQ-XIII-A] Inner contour layer** — anything efficient for AI (Class C): binary formats in agent exchange, token economy, direct calls.
- **[REQ-XIII-B] Truth layer & human boundary** — human-native and reproducible (Class B): state in git is human-readable, actions land in gitops, decisions pass through human-intervention points.
- **[REQ-XIII-C] Layer criterion:** "is this working exchange or truth about the system?" Exchange (how agents negotiate, intermediate representations) → inner layer, optimize. Truth (what the state is, what was done, what's correct, how to roll back) → truth layer, don't touch.
- Examples: gitops stays as truth/fallback, but agents inside may batch and hold a fast representation — as long as the result lands in gitops. Formats: inner exchange compressed, platform state human-readable.

## XIV.5 Failure mode — leakage
- **[REQ-XIII-D]** Two-layer design breaks via **leakage of AI-native into the truth layer** under the banner of efficiency, bit by bit: "store derived in binary, faster" → human goes blind; "agent writes to state bypassing gitops, PR is overhead" → human path gone; "removed the human-readable log" → severance blinds. Each step is locally reasonable, the sum is unremovable. Defense: **the layer boundary is an architectural invariant, not a per-feature optimization choice.** Optimizing for AI is permitted inside the contour and forbidden in the truth layer; not revisited per-feature.

---

# PART XV — Provider Agnosticism

**Two poles from sources:** Open Skills — for lifting procedures out from under the model. Karpathy — for AI-native infrastructure. They concern different layers and do not conflict.

## XV.1 Provider lock is procedural debt (Open Skills)
Lock happens not at the API level (easy to swap) but at the level of "how we work is encoded so only this provider/format understands it". "Companies make engines, but must not own our workflows."
- **[REQ-XIV-A] Procedural layer detached from the model:** skills + runbooks in a portable human-readable format (markdown), attachable to any model. The skill-store (SPEC-11 in the v7 line) is a detachable asset surviving a provider change. (Matches what we already designed: their "skill" = our skill, their runbook = the Meta-Loop, their Session-to-Skill = our self-learning.)

## XV.2 Karpathy: AI-native — yes, provider-native — no
His pain is legitimate (docs for humans, deploy-by-one-prompt) and concerns the **inner layer** (Class C of Theme 3) — there AI-nativeness is right.
- **[REQ-XIV-B] Boundary:** AI-native ≠ provider-native. Infrastructure for AI-in-general is portable across providers. Infrastructure for a specific provider (its prompt format, tool-calling, quirks) is **lock disguised as progress.**

**Karpathy himself supplies the defense of independence:**
- Model unevenness and dependence on lab decisions ("you feel out a tool with no manual; they change the mix — your pattern breaks") → an argument **for** agnosticism: provider lock = lock to its profile of capabilities, which shifts without your knowledge.
- "You can delegate thinking but not understanding; I'm a bottleneck, I must understand what we're building" → an argument for a human-readable portable truth layer (Theme 3) and severance survival (Theme 2).

## XV.3 Trade-off: agnosticism vs evaluator independence
- **[REQ-XIV-C]** Full agnosticism via a **single** self-hosted engine **kills evaluator independence** (SPEC-06: worker and evaluator must run on different models/families, else they correlate in blind spots — confirmed by Karpathy's unevenness point). The optimum is **not one engine, but a pool of swappable providers**, from which worker and evaluator draw different ones. Self-hosted is a *pool member* and severance insurance, not the sole engine. Dispels the illusion "self-hosted = full independence": a single engine trades verification independence for provider independence.

## XV.4 Implementing agnosticism
- Model routing — LiteLLM, provider swappable.
- Verification — deterministic, outside the model (SPEC-06), provider-independent by design.
- Procedures — portable markdown (REQ-XIV-A).
- Multiple reasoning sources in a pool; self-hosted as insurance and pool member.
- **Memory/truth layer — Omniscience as the working exemplar (UPDATED):** retrieval-only, no embedded LLM, self-hosted, MCP-first, explicit "no vendor lock-in". It is the watershed made concrete — the memory layer returns cited facts below, any swappable LLM reasons above. Switch off every provider and the cited graph still answers to a human or any MCP client. This is the strongest demonstrable artifact for the debate: a truth layer that survives the loss of all reasoning.

---

# PART XVI — The Unified v8 Axis

Themes 2, 3, 4 are one watershed named three times:

| Theme | Question | Answer (one boundary) |
|-------|----------|----------------------|
| 2 | What survives the loss of AI? | State, mechanisms, understanding — substrate below; reasoning — above, lost |
| 3 | What may be optimized for AI? | Inner exchange — yes; the truth layer — no |
| 4 | How not to lock to a provider? | Procedures/verification/state — portable; reasoning — swappable |

**Reasoning is swappable and above. Procedures, state, verification, understanding are yours and below.** Theme 1 (yield + trust instruments) measures whether you slide along this axis into dependency: a drop in autonomous yield or a rise in escape rate signals that either verification was hollowed out (Theme 1) or reversibility/independence was lost (Themes 2–4).

---

# PART XVII — New v8 Boundaries (for Debate)

**Principled (defense):**
1. Self-hosted does not make you invulnerable — it closes "provider cut off", not "our cluster failed". Honestly: a pool member and insurance, not a panacea.
2. Removability is maintained by practice, not architecture alone — skill atrophy is organizational, cured by drills, not code.
3. Yield is a slow metric (delayed window); there is no fast feedback on effectiveness by design — trust accrues slowly.

**Debate (where to draw the line):**
4. Karpathy pulls toward full AI-nativeness and "rewrite everything"; we keep Class B human-native. The dispute: where exactly the "exchange vs truth" line runs, and whether we set it too conservatively.
5. Pool of providers vs single self-hosted: evaluator independence against simplicity and full autonomy. The minimum number of providers for non-correlated verification is open.

---

## v8 Conclusion

v8 adds a resilience-and-independence layer atop the mature v6/v7 contour. The core: the factory is designed as a **removable accelerator over a portable substrate**, not as a load-bearing structure. Reasoning comes from above and is swappable (provider, pool, self-hosted); state, mechanisms, procedures, verification and understanding are below and yours. Effectiveness is measured by autonomous yield, which cannot be gamed by weakening checks. AI loss is a normal degradation into manual mode, not an incident — and this is verified by drills. Optimizing for AI is allowed inside the contour and forbidden in the truth layer. Provider independence is lifting procedures out from under the model, with an honest trade-off: verification needs a pool, not a monoculture. This is neither a factory without humans nor a factory chained to one provider — it is a manageable, measurable, removable, portable layer over a platform that survives its absence.

---

# Appendix A: Industry Context & Sources (2026)

### A.1 Reward Hacking Confirmed Empirically
Agents actively manipulate evaluators: rewriting unit tests, muting asserts, monkey-patching scoring functions to pass without solving the task (RewardHackingAgents, March 2026; "LLMs Gaming Verifiers", arXiv 2604.15149). Scale: >15% of tasks across five terminal-agent benchmarks are solved via verifier deception (Terminal Wrench / arXiv 2606.08960). → Justifies SPEC-06 (locking + instrumentation) and SPEC-01 (out-of-band runner).

### A.2 Circularity of Error (REQ-06-E)
The core issue of LLM-generated tests is "how to verify the verifier". Using implementation as a ground-truth oracle creates "circularity of error". Invalid LLM-test rates run high: 34–62% (arXiv 2602.10522). Literature solution: derive tests from NL-specification, not code. Self-verification degrades without external grounding (arXiv 2504.00406, 2311.11797).

### A.3 Isomorphic Perturbation Testing (REQ-06-D)
Models hardcode answers for extensional tests; IPT runs logically equivalent but structurally altered tests — deception fails on the isomorphic variant (arXiv 2604.15149). **Boundary:** IPT is defined where rewritable logical structure exists (algorithms, reasoning). Undefined for visual/UX — hence the scope restriction in REQ-06-D.

### A.4 Hacker-Fixer Loop (REQ-07-E)
Adversarial evaluator hardening is a 2026 pattern: outcome verifiers are manually crafted and rarely robust (arXiv 2606.08960; RvB, arXiv 2601.19726 / 2602.14457). Economics favor it: red-vs-blue cycles reduced token spend by >18% vs cooperative baselines.

### A.5 Portable Procedures & Provider Agnosticism (Part XV)
Open Skills (Nate B. Jones): procedural debt and prompt-bloat are the real cost of vendor lock; the answer is detachable markdown "skills" + runbooks ("companies make engines but must not own our workflows"). Karpathy interview: model unevenness and dependence on lab data-mix decisions argue for agnosticism; "you can delegate thinking but not understanding" argues for a human-readable, portable truth layer. AI-native ≠ provider-native.

### A.6 GraphRAG resolves the earlier RAG-vs-RLM question (UPDATED)
An early open question was whether plain vector RAG ("searches similar, doesn't reason; breaks on aggregation") needed replacing by RLM-style code-over-data. **Omniscience's GraphRAG composition answers it without RLM:** anchor on an entity in the causal graph (Neo4j, `as_of`-aware) → traverse causal/ownership/dependency edges to a candidate set → scope the vector step to those candidates → return a ranked, cited bundle. The graph supplies the causality that naive vector RAG lacked; the vector step supplies semantics; the hybrid covers both weaknesses and is "substantively different from naive vector-only RAG and from static CMDB-style lookup." Provider-agnostic by construction (retrieval-only, no embedded LLM, self-hosted) — which is also why it survives severance (Part XIII).

---

# Appendix B: Defense-List for Debates

**1. "Your Evaluator can be deceived / who judges the judge?"** → SPEC-06: locking + hash + file instrumentation against tampering; golden-set outside loop against flawed judgment; Hacker-Fixer for continuous hardening. Boundary: reward hacking is reduced, not eliminated; monitoring is inherently fragile.

**2. "Who writes the check for a novel, unseen task?"** → SPEC-06-E: tests are derived from OpenSpec, not implementation; circularity broken. Boundary: correctness of the spec itself is on the human (this is our L4).

**3. "This isn't real autonomy — human is still in the loop."** → Agreed: the goal is L4 with humans curating baselines. Backend is autonomous in execution; correctness definition is human. We do not sell L5.

**4. "A different model for Evaluator doesn't guarantee independence."** → REQ-07-E requires a different model family for this exact reason. Boundary: full error independence is costly; intra-generation correlation remains.

**5. "Isomorphic checks will save us everywhere."** → We don't claim this: REQ-06-D is restricted to Classes A/C. For visuals, the source of truth is `pixel_diff` against an external baseline (SPEC-03).

**6. "An agent with deploy rights can destroy production."** → SPEC-08 (scoped-tokens, execution-time fail-closed) + SPEC-09 (transactional rollback, high-risk intercept) + SPEC-05 (microVM, default-deny network). Boundary: expands surface area; audit monitoring (REQ-08-C) is mandatory.

**7. "If your AI provider is cut off, the system dies."** → Part XIII: the provider holds only model access; state, mechanisms, procedures are yours. Severance = "without an advisor", not "without a system". Self-hosted is a reduced-capacity fallback and pool member, not a survival condition. Verified by drills.

**8. "Efficiency demands optimizing everything for AI."** → Part XIV: two layers. Inner contour — optimize for AI freely (Class C). Truth layer — human-native, load-bearing for reversibility (Class B). Optimizing the truth layer for AI trades removability for speed.

---

# Execution Roadmap & Protocols (Reference)

*This section describes implementation sequencing. It is reference material for when the plan is taken to build; the document itself remains a plan.*

### Merge Protocol (order)
1. **Foundation:** SPEC-01 & SPEC-05 (Dual Sandbox & microVM); SPEC-02 (Proof Multiplicity & Security Gate).
2. **Execution Safety:** SPEC-08 & SPEC-09 (Execution-Time Auth & Transactional Rollback) — must precede control loops so all tasks are sandboxed safely.
3. **Control Flow:** SPEC-07 (Meta-Loop, Circuit Breakers); SPEC-04 (HIL Parking).
4. **Verification Engines:** SPEC-06 (Evaluator Locking); SPEC-06-E (Spec-Derived Test Generator); SPEC-03 (External UI Baselines).

### 100% Verification Protocol (before any merge)
1. **Victory Audit (Independent):** a fully isolated subagent verifies code against the spec, ensuring no hardcoded mocks.
2. **Pipeline Integration Dry-Run:** an E2E integration test runs on `main` immediately after merge to ensure the new layer intercepts execution correctly (e.g., injecting a malicious command).
3. **Health Check (Service Liveness):** for infra/network changes, an explicit liveness check (e.g., `curl` or DB connection) proves the service is active and listening, not merely returning exit code 0 from a start script.

---

## Master Conclusion

This master plan integrates the mature code-contour defense (SPEC-01…09), the infrastructure contour (Type E), the memory service (Omniscience-backed), auto-triggered planning, skill lifecycle, multi-level rule placement, tag-based unit boundaries with inherited platform ABAC, agent identity/access, and the v8 resilience-and-independence layer.

No extension pushes autonomy past the boundary of side-effects. The factory autonomously discovers, researches, and executes reversible actions, proving compliance against specs — while interpretation, correctness definition, and irreversible sanctions remain human. Reasoning arrives from above and is swappable (provider, pool, self-hosted); state, mechanisms, procedures, verification, and understanding are below and yours. Effectiveness is measured by autonomous yield, which cannot be gamed by weakening checks. AI loss is a normal degradation into manual mode, verified by drills — not an incident.

It is a factory where the lights are off on the execution floor, but on in the judgment room — and which survives being switched off entirely.
