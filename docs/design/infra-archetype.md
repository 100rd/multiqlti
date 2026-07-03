# Design: The INFRA Archetype — `(research) → spec → code → deploy-verify`

> Status: **proposal / evolving**. Design-first, no code. Each section is a
> **hypothesis to validate in testing**, not a frozen spec — same contract as
> `loop-consolidation.md` and `loop-triggers.md`.
>
> This is the **third archetype** that `loop-consolidation.md` §6 names and defers
> (alongside `repo-assessment` and `research`). It is already a legal `Archetype`
> value (`shared/types.ts` → `ARCHETYPES = ["repo-assessment", "research", "infra"]`)
> that today selects **no** skill set (`catalog.ts` `selectSkillSet` → `default: []`
> → the unskilled coder path). This doc specifies how `infra` becomes real.
>
> **Why now:** it is the sole blocker for operational-signal triggers
> (`loop-triggers.md` §3.2 / Stage **T5**: monitoring/SLO-burn → investigate loop,
> ArgoCD-degraded / k8s-events → deploy-verify loop). T5 bindings cannot land until
> `deploy-verify` + `live-deploy-smoke` exist. `loop-triggers.md` §6 explicitly scopes
> this as its own design+build arc "before code" — this is that doc.
>
> **Risk posture:** this is the **highest-risk archetype in the system**. It is the
> only one whose intrinsic success criterion (`live-deploy-smoke`, `loop-consolidation.md`
> §5 verification table) requires an agent to run infrastructure against a **live
> cluster**. Everything below is built around one invariant: **deploy-verify touches
> an EPHEMERAL environment and only an ephemeral environment — never prod, never the
> operator's cluster — and prod-apply never happens without explicit human approval.**

---

## 1. Where this fits the existing model

`loop-consolidation.md` established the spine; this archetype is an additive branch on it,
kill-switched and inert-by-default, changing nothing that ships today:

- **§4 Skills** — a skill is `(behavior, its own "green", scoped permissions/tools)`.
  The infra set adds a `spec` step and a `deploy-verify` step; `deploy-verify` is the
  first skill that declares a **live-environment** capability (all prior capabilities —
  `read-only`, `worktree-write`, `web-read` — are host/network-read or worktree-write only).
- **§5 Verification methods** — the table already reserves `live-deploy-smoke`:
  *"deploy to an ephemeral env + the skill's green (running, no errors, events)"*. This
  doc makes that row executable. The method is a **per-criterion** property (§5), so a
  single infra verdict can still mix `live-deploy-smoke` criteria with `test-run` /
  `judge` / `manual-ops` ones — the archetype only supplies the **default** ordering.
- **§6 Archetypes** — infra ordering is `(research) → spec → code → deploy-verify`,
  artifact = IaC/code + a **live deploy-smoke** in an ephemeral env.
- **§7 Security** — infra is the `deploy-verify` bullet: *"the one step that touches a
  live environment … ephemeral-env creds from a secret manager, scoped to that env;
  prod-apply never without explicit human approval (the existing apply-gates /
  `never_apply` rules hold)."* This doc is the expansion of that one bullet into a
  buildable, staged plan.
- **§9 Stage 3** already lists "Infra archetype with the `deploy-verify` skill (ephemeral
  env + scoped creds + apply-gates)" as the sibling of the research archetype that
  Stage 3 shipped. This doc is that sibling's design.

**Structural precedent to mirror.** The `research` archetype (already shipped: `catalog.ts`
`case "research"`, `config/schema.ts` `implement.research`, out-of-band `report` on
`consilium_loop_rounds.report`) is the template. It proved the pattern for "an archetype
that produces a **non-code artifact** and has its **own finer kill-switch** on top of the
parent `consiliumLoop.enabled` + `implement.enabled`, and that returns an **inert no-PR
close-out** when disabled rather than silently falling through to the coder." Infra reuses
that exact anti-footgun shape (§5 below) and adds one thing research never needed: a
**live-environment host-exec gate** analogous to `effectiveVerificationEnabled`.

---

## 2. The skill set — `(research?) → spec → code → deploy-verify`

Four ordered `SkilledStep` entries (the `catalog.ts` shape: `id`, `skillName`, `capability`,
`verification`, `systemPrompt`), selected by `selectSkillSet("infra", params)`. `research`
is **conditional** — included only when the planner flags the task needs external grounding
(e.g. "which ingress controller for GKE", "what's the current EKS CNI recommendation");
omitted for a fully-specified ask ("apply this Helm chart to a fresh cluster").

| # | step id | skillName | capability | intrinsic "green" (skill-green, §5) | verification method |
|---|---|---|---|---|---|
| 0 | `infra/research` *(optional)* | `research` | `web-read` | grounded, cited findings for the infra decision | `web-evidence` |
| 1 | `infra/spec` | `infra-spec` | `read-only` | a structured **deploy spec** exists + is internally consistent | `judge` |
| 2 | `infra/code` | `infra-coder` | `worktree-write` | IaC/manifests written; static checks clean (see below) | `judge` *(static)* + deferred to step 3 for live |
| 3 | `infra/deploy-verify` | `deploy-verify` | **`deploy-live`** *(new)* | **deployed + running + no error events + healthy k8s events** in the ephemeral env | **`live-deploy-smoke`** *(new)* |

### 2.0 `infra/research` (optional, reused verbatim)
Identical to the existing `research` step — `web-read` capability (`web_search` only, no fs,
no shell), `web-evidence` verification. No new surface. Included only when
`archetype_params` marks the task as needing external grounding. Produces cited findings that
steer the `spec` step; it does **not** itself deploy anything.

### 2.1 `infra/spec` — author the deploy spec
- **Behavior:** turn the (researched) intent into a **declarative deploy spec** — the
  minimal machine-readable description of *what* to stand up and *how to know it is healthy*:
  target kind (k8s manifests / Helm chart / kustomize overlay), the artifact path(s) in the
  worktree, the namespace, and the **health assertion** (which workloads must reach `Ready`,
  which conditions/events count as green, a readiness timeout). This is the infra analogue of
  `repo-assessment`'s acceptance criteria — it **parameterizes** step 3's skill-green into a
  task-specific Definition of Done (`loop-consolidation.md` §5 skill-green vs
  acceptance-criterion).
- **Capability ceiling:** `read-only` (Read only — it inspects the repo to write a spec; it
  writes nothing itself, or writes only the spec artifact — see Open Question O3).
- **Skill-green:** the spec is present and internally consistent (references real artifact
  paths, names workloads, states a health assertion + timeout).
- **Verification:** `judge` — a verifier model confirms the spec is falsifiable and complete
  (mirrors Stage-7 criteria-QA in `loop-consolidation.md` §9). No live env is touched.

### 2.2 `infra/code` — write the IaC / manifests
- **Behavior:** the existing coder baseline (isolated worktree, Edit/Write/Read, **no Bash**,
  Draft-PR-only), specialized to author IaC/manifests satisfying the spec. Prefer the smallest
  correct change; follow the repo's existing infra conventions (chart values, overlay
  structure).
- **Capability ceiling:** `worktree-write` — **unchanged** from today's coder. The coder never
  gains cluster access; it only writes files. This keeps the blast radius of the *authoring*
  step identical to `repo-assessment`.
- **Skill-green:** manifests/IaC written; **static** checks clean — `kubeconform`/`helm
  template | kubeconform`, `helm lint`, `kustomize build`, or `terraform validate`/`fmt`
  as applicable (static only, **no apply**, run under the same sandbox discipline as the
  test-runner — see §4). Static-green is necessary but **not sufficient**; the live proof is
  step 3.
- **Verification:** `judge` on the diff for the static/authoring criteria; any criterion whose
  method is `live-deploy-smoke` is **carried to step 3**.

### 2.3 `infra/deploy-verify` — the one live step
The subject of §3. Capability `deploy-live` (**new**, §3.1), verification `live-deploy-smoke`
(**new**, §4). It provisions an ephemeral env, applies the step-2 artifact **into that env
only**, asserts the spec's health condition, captures the k8s events/logs as the ground-truth
summary, and **tears the env down unconditionally**. It never touches prod and never merges.

**Why the four are ordered, not merged:** each has a strictly different capability ceiling
(`web-read` < `read-only` < `worktree-write` < `deploy-live`). Keeping them separate means the
live-cred-bearing step is the *last, smallest, most-scrutinized* one, and the authoring steps
carry **zero** cluster credentials — the same "capabilities can only narrow" discipline
`catalog.ts` enforces today, extended one rung up.

---

## 3. `deploy-verify` / `live-deploy-smoke` — the live step in detail

### 3.1 The new `deploy-live` capability
`catalog.ts` today deliberately excludes a live capability:

> `SkillCapability = "read-only" | "worktree-write" | "web-read"`. `"deploy-live" (Stage 4
> infra) is deliberately NOT a member here.`

This archetype adds it. **Crucially, `deploy-live` is NOT a coder tool-surface** — it does
**not** flow through `capabilityTools()` into the coder's `--allowedTools` the way
`worktree-write` does. Like `web-read` (consumed by the research-runner, not the coder),
`deploy-live` is consumed by a **new `deploy-runner`** (§4), which reads the step's capability
+ verification directly and never hands the coder cluster access. The `deploy-runner` is the
infra analogue of `test-runner.ts` (the sandboxed subprocess runner) and `research-runner`.

`capabilityTools("deploy-live")` therefore returns **no coder tools** (or is never called for
that step); the runner's own allowed operations are a **fixed, code-defined** set (provision
env → apply artifact → read status/events → destroy env), never a widenable tool list and
never derived from untrusted text.

### 3.2 The ephemeral environment
**Recommendation: `kind` (Kubernetes-in-Docker) for local single-tenant.** Rationale:

- Single-tenant multiqlti runs on one host; `kind` needs only Docker, no cloud account, no
  standing cluster, no egress. `k3d` (k3s-in-Docker) is a near-equivalent fallback and is
  lighter; the **backend is a config choice** (§6), not hardcoded — see Open Question O1.
- A **fresh cluster per run** is the strongest isolation: no shared state to corrupt, no
  cross-run bleed, trivially disposable. It is also the highest per-run cost (O4).

**Lifecycle (per deploy-verify run):**
1. **Provision** — `deploy-runner` creates a uniquely-named ephemeral cluster
   (`kind create cluster --name mqlti-<loopId>-<round>-<rand>`), server-derived name only
   (never from AP/spec text — same rule as branch names in `executor.ts`). A **hard
   provisioning timeout** bounds cluster-up.
2. **Scope creds** — the runner mints/loads env-scoped credentials (§3.4): for `kind`, the
   kubeconfig `kind` writes for *this cluster only*, isolated to a temp `KUBECONFIG` path,
   never merged into `~/.kube/config`, never the operator's real context.
3. **Apply into the ephemeral env** — apply the step-2 artifact (`kubectl apply -f` /
   `helm install` / `kustomize build | kubectl apply`) against **the ephemeral kubeconfig
   only**. This is the *only* apply the system ever performs, and it targets a cluster that
   exists solely for this check.
4. **Assert health** — poll for the spec's health condition (workloads `Ready`, no `Failed`/
   `CrashLoopBackOff`, no `Warning`/`Error` events on the target objects) up to the spec's
   readiness timeout.
5. **Capture** — collect the ground-truth summary: pod/deployment status, `kubectl get events`
   (scrubbed, bounded), condition reasons. This is the `live-deploy-smoke` summary (§4).
6. **Tear down — unconditionally.** `kind delete cluster --name …` in a `finally` that runs on
   success, failure, timeout, or crash. The whole run is wrapped in a wall-clock deadline whose
   expiry SIGKILLs the process group **and** triggers teardown (the `test-runner.ts` #422
   process-group-kill lesson applies — a wedged `kubectl`/`helm` must be reaped and the
   cluster must not leak). A **reaper/GC** sweeps orphaned `mqlti-*` clusters older than N
   minutes on startup as a backstop (O4).

### 3.3 The skill's green
`live-deploy-smoke` green ≡ **deployed + running + no error events + healthy k8s events**,
parameterized by the spec's health assertion (§2.1):
- every target workload reached `Ready`/`Available` within the timeout;
- **zero** `CrashLoopBackOff` / `ImagePullBackOff` / `Failed` pods among the targets;
- **no** `Warning`/`Error` events on the target objects during the window;
- apply itself exited 0.

Anything else (timeout, error event, apply non-zero) ⇒ **red** — recorded, surfaced in the PR
body, and (like all runners) **never throws**, so the loop still closes out at the human gate.

### 3.4 Credential scoping
The security crux. Rules, strictest-first:
- **Ephemeral-env creds come from a secret manager** (`loop-consolidation.md` §7), scoped to
  *that env*. For `kind` the "cred" is simply the per-cluster kubeconfig the runner isolates to
  a temp path; for a **cloud** ephemeral backend (O1) it is a short-lived, least-privilege,
  scoped-to-the-sandbox-account credential minted per run from the secret manager, **never** a
  standing admin key and **never** a prod credential.
- **Env allowlist, fail-closed** — the `deploy-runner` subprocess gets a **stricter** subset
  than even the test-runner: `PATH`/`HOME`/locale + the single ephemeral `KUBECONFIG` path
  (and, for a cloud backend, only the minted scoped token). **No** `AWS_*`/`GH_TOKEN`/DB
  creds/API keys/`KUBECONFIG` pointing at any real cluster. A new secret env var is excluded by
  default (same posture as `TEST_ENV_ALLOWLIST` in `test-runner.ts`).
- **No shell** — provision/apply/destroy run via `spawn(binary, args, { shell: false })` with
  argv arrays; the spec/AP text never reaches argv (server-derived names + `--kubeconfig`
  paths only). The step-2 **artifact files** are the only untrusted input and they are applied
  as files into a throwaway cluster, not interpolated into commands.
- **The runner cannot reach prod.** By construction it only ever holds a kubeconfig for a
  cluster **it just created**; it is never handed the operator's context. This is the code-level
  expression of §3.5.

### 3.5 The apply-gate invariant (security boundary)
Non-negotiable, and the reason this archetype is safe to ship:

1. **Prod-apply NEVER without explicit human approval.** The existing apply-gates /
   `never_apply` rules (repo `.claude/rules/terraform.md`, `terragrunt.md`, `critical-decisions.md`)
   hold verbatim. `deploy-verify` does **not** relax them. Nothing in this archetype can apply
   to production, a real cluster, or the operator's infrastructure.
2. **`deploy-verify` touches the EPHEMERAL env and only the ephemeral env.** The one apply it
   performs targets a cluster the runner created seconds earlier and will delete seconds later.
   There is no code path from `deploy-verify` to a real backend.
3. **Two independent controls, both fail-closed:**
   - *Capability:* the step's live operations are a fixed, code-defined set consumed by the
     `deploy-runner`; they can only ever narrow, never widen (the `catalog.ts` invariant), and
     they never flow to the coder.
   - *Credential:* the runner only ever possesses ephemeral-env creds; a prod/real credential
     is not in its env allowlist, so even a maximally-adversarial artifact has nothing to apply
     *to*.
4. **Draft-PR-only, agents never merge.** Identical to every other archetype. The IaC lands as
   a Draft PR; a human reviews and merges; **real** apply, if any, runs from CI on `main` after
   merge — never from an agent, never from a feature branch. `deploy-verify` proves the IaC
   *works* in a throwaway cluster; it does not deploy it *for real*.
5. **Untrusted-input posture.** The target repo (its IaC) is untrusted end-to-end
   (`loop-consolidation.md` §7): it can prompt-inject the agents that read it and its manifests
   can define anything. The backstop is the same as `test-run`'s: a **container/isolation
   boundary** (the ephemeral cluster *is* a Docker-contained boundary for what gets deployed;
   the runner subprocess additionally wants the platform `features.sandbox` for host-exec
   confinement — see §5's enable-gate) + no prod creds + Draft-PR-only + human merge.

> **Security-boundary summary (one line):** deploy-verify holds *only* a
> just-created-ephemeral-cluster credential, performs its *single* apply into *that* throwaway
> cluster, tears it down unconditionally, and **cannot** reach prod or the operator's cluster —
> prod-apply stays behind the unchanged human apply-gate.

---

## 4. Verification — how `live-deploy-smoke` reports into the trace

`live-deploy-smoke` mirrors `test-run`'s result shape so the execution trace, PR body, and
convergence logic consume it **identically** — no new plumbing in the trace renderer.

`test-runner.ts` `TestRunResult` is `{ passed, summary, exitCode, timedOut, ran }`; the
per-AP `ApVerification` (`executor.ts`) is `{ method, ran, passed, summary, … }`. The infra
analogue, `DeploySmokeResult`, keeps the same three load-bearing fields and adds infra-specific
audit fields:

```
DeploySmokeResult {
  ran:      boolean   // did an ephemeral env get provisioned + an apply attempted?
                      //   false ⇒ no backend available / gate off ⇒ NOT green
  passed:   boolean   // deployed + running + no error events (§3.3). false ⇒ flagged in PR
  summary:  string    // bounded, fs/secret-scrubbed: workload status + k8s events tail
  timedOut: boolean   // readiness/provision/wall-clock timeout fired → SIGKILL + teardown
  // infra audit (display-only, never a shell/branch/PR-title sink):
  envBackend: "kind" | "k3d" | ...   // which backend served this run
  torndown:   boolean                // teardown confirmed (leak-detection signal)
}
```

`ApVerification.method` gains `"live-deploy-smoke"` alongside `"test-run" | "judge" |
"manual-ops"`, and `VerificationMethod` in `catalog.ts` gains `"live-deploy-smoke"` alongside
`"test-run" | "judge" | "web-evidence" | "none"`. The executor routes an AP whose method is
`live-deploy-smoke` to the `deploy-runner` exactly as it routes `test-run` to the `test-runner`
(the §5/Stage-6 per-criterion routing in `loop-consolidation.md`).

**Convergence** (`loop-consolidation.md` §5: *every criterion confirmed by its method*) treats a
`live-deploy-smoke` criterion as green **iff** `ran && passed`. `ran === false` (no backend /
gate off) is **not** silently green — it is "not implementable by this pipeline as configured"
(§5's first-class outcome), surfaced in the PR body, never forced. A regression across
sequentially-implemented APs is caught by the same **final-state re-verification** backstop
(`loop-consolidation.md` §9 Stage 5 / `finalVerification`): one whole-spec re-deploy-smoke
against the final worktree state before the PR opens (behind its own enable-gate — a re-deploy
is expensive, O4).

The `deploy-runner`, like all runners, **never throws**: any failure degrades to
`{ ran/passed:false, … }` so the round still produces its Draft PR at the unchanged human gate,
with the failure recorded in the trace + PR body.

---

## 5. Config / kill-switches (all default OFF)

Sibling to `implement.verification` / `implement.research` / `implement.finalVerification` under
`pipeline.consiliumLoop.implement` (`server/config/schema.ts`). New block `implement.infra`:

```
implement.infra: {
  enabled: boolean = false          // archetype kill-switch. false ⇒ infra close-out is INERT
                                    //   (no-PR, NEVER falls through to the coder) — the exact
                                    //   anti-footgun branch `research.enabled=false` uses today.
  envBackend: "kind" | "k3d" = "kind"          // ephemeral-env backend (O1)
  credSource: "none" | "kind-local" | "secret-manager" = "none"
                                    // where deploy-verify's scoped creds come from. "none"
                                    //   (default) ⇒ no live step can run (fail-closed).
  provisionTimeoutMs: number  = 300_000        // cluster-up hard bound → SIGKILL + teardown
  smokeTimeoutMs:     number  = 600_000        // whole deploy-verify wall-clock → SIGKILL + teardown
  reaperMaxAgeMs:     number  = 900_000        // GC sweep for orphaned mqlti-* clusters
}
```

**Enable-gate (fail-closed, the `effectiveVerificationEnabled` analogue).** A new
`effectiveInfraDeployEnabled(config)` returns true **only** when **all** hold — otherwise the
infra archetype degrades to spec+code (author-only, **no live step**), with a one-line load-time
warning (never a hard throw):

1. `implement.enabled === true` AND `consiliumLoop.enabled === true` (parent gates), AND
2. `implement.infra.enabled === true` (this archetype), AND
3. a **real ephemeral-env backend is available on the host** — `kind`/`k3d` + a reachable
   Docker daemon (probed, not assumed), AND
4. a **real cred source** — `credSource !== "none"` and it resolves (a kind-local kubeconfig
   path is writable, or the secret manager answers), AND
5. the host-exec sandbox gate is satisfied — `features.sandbox.enabled === true` **or** an
   explicit `implement.trustedRepoAck`-style ack, since the `deploy-runner` executes
   `kind`/`kubectl`/`helm` (arbitrary repo-supplied manifests) on the host. Same reasoning as
   `test-run`'s `effectiveVerificationEnabled`.

**What MUST be true to enable (operator checklist):** a working `kind`/`k3d` + Docker on the
host **and** a cred source (kind-local kubeconfig isolation, or a secret manager for a cloud
sandbox) **and** the sandbox/trusted-ack gate. Absent any one, the switch is a **no-op**, not a
foot-gun — spec+code still run and produce a Draft PR; only the live proof is skipped and marked
"not verified live (backend/cred/sandbox unavailable)".

---

## 6. Staging (INFRA-1…n) — incremental, shippable, inert-by-default

Same rules as every prior arc: **additive, kill-switched, inert by default, regresses nothing**.
Each stage is independently shippable and testable.

- **INFRA-1 — archetype skeleton + planner recognizes "infra" intent.**
  `selectSkillSet("infra", …)` returns the ordered `SkilledStep[]` for `(research?) → spec →
  code` (step 3 present as a **recorded-but-not-executed** step, exactly as Stage-2a *recorded*
  `test-run` without running it). `deploy-verify`'s `verification` is `live-deploy-smoke` in the
  audit only. Planner/intent-classifier maps infra-shaped intents to `archetype: "infra"`
  (already a legal enum value). **Nothing live executes.** Ships behind `implement.infra.enabled`
  default false. This alone turns infra from "returns `[]` → unskilled coder" into "an
  archetype-aware spec→code coder" — a strict superset, zero live risk.

- **INFRA-2 — ephemeral env provisioning (no apply yet).**
  The `deploy-runner`: `kind`/`k3d` provision + **unconditional teardown** + wall-clock
  timeout + process-group kill + orphan reaper. Prove the lifecycle (create → confirm API
  reachable → destroy) in isolation, with **no manifest applied**. This de-risks the hardest
  operational bit (leak-free cluster lifecycle) before any untrusted artifact touches it.

- **INFRA-3 — `deploy-verify` smoke.**
  Wire apply-into-ephemeral + health-assert + capture → `DeploySmokeResult`; route the
  `live-deploy-smoke` AP method to it; surface `{ran,passed,summary}` into the execution trace +
  PR body (§4). Behind the full §5 enable-gate. Now the archetype produces a **real live proof**.

- **INFRA-4 — secret-scoped creds.**
  Replace the kind-local kubeconfig path with `credSource: "secret-manager"` for cloud/scoped
  backends: per-run mint of a short-lived least-privilege credential, isolated env allowlist,
  destroy-on-teardown. This is what makes a **cloud** ephemeral backend safe (O1) and hardens
  the local path.

- **INFRA-5 — trigger integration (T5).**
  Unblock `loop-triggers.md` §3.2 / Stage T5 operational signals: ArgoCD-degraded / k8s-events /
  alertmanager webhook → a `deploy-verify` (or investigate) loop with the alert JSON as the work
  item. Rides the generic `webhook` trigger type. Behind the trigger-layer's own rails
  (`loop-triggers.md` §4) **and** `implement.infra.enabled` — both must be on.

Ordering rationale: **1** makes the archetype real but inert (planning only); **2** de-risks the
scariest operational piece (cluster lifecycle / leaks) with nothing untrusted applied; **3** adds
the live proof once teardown is trusted; **4** hardens creds for cloud; **5** connects the
operational-signal firehose last, once the loop it feeds is proven.

---

## 7. Open questions (to settle while testing)

- **O1 — ephemeral-env backing.** `kind` (recommended, Docker-native, single-tenant-friendly)
  vs `k3d` (lighter, k3s) vs a **cloud sandbox** (real EKS/GKE in a throwaway account — closer
  to prod fidelity but far costlier + needs cloud creds). `envBackend` is a config choice;
  which is the default and which we actually build first (recommend `kind` for INFRA-2/3, cloud
  deferred to INFRA-4+).
- **O2 — multi-step / multi-tool infra.** The spec here assumes k8s manifests / Helm / kustomize
  (declarative, `kubeconform`-checkable, `kubectl apply`-able into a cluster). **Terraform** is a
  different beast: `plan` is the static check, `apply` needs real (or LocalStack/cloud-sandbox)
  providers, and "ephemeral env" means a throwaway cloud account, not a `kind` cluster. Does the
  first cut scope to **k8s-only** (deploy-verify = apply-to-kind) and defer Terraform/Helm-charts-
  with-cloud-deps to a later stage? (Recommend: yes — k8s-into-kind first.)
- **O3 — how "spec" is expressed for infra.** Free-form judge-checked prose? A structured schema
  (target kind + artifact paths + health assertion + timeout)? Model-proposed then engineer-
  edited (like acceptance criteria, `loop-consolidation.md` §10)? Does `infra/spec` write a spec
  **artifact** into the worktree (making it `read-only`+one-file-write) or only emit it into the
  trace (keeping it strictly `read-only`)?
- **O4 — cost of a cluster per review.** Spinning a fresh `kind` cluster per deploy-verify (and
  again for `finalVerification` re-smoke) costs seconds-to-minutes + host resources each run.
  Reuse a warm cluster across runs (faster, but reintroduces cross-run state bleed — the very
  isolation we wanted)? Cap concurrent ephemeral clusters? A budget/round cap like the research
  archetype's `maxResearchIterations`? The reaper (§3.2) is the safety net regardless.
- **O5 — investigate vs deploy-verify for T5.** `loop-triggers.md` §3.2 maps *both*
  "monitoring/SLO-burn → **investigate** loop" and "ArgoCD-degraded/k8s-events → **deploy-verify**
  loop". Is "investigate" a distinct archetype/skill set, or is it `repo-assessment` seeded with
  the alert as the work item (read-only diagnosis, no live apply)? This doc covers deploy-verify;
  investigate may warrant its own scoping.

---

*This document evolves. Treat each section as a hypothesis to validate in testing, not a frozen
spec. Nothing here ships enabled: every new surface is behind `implement.infra.enabled` (default
false) and the fail-closed `effectiveInfraDeployEnabled` gate.*
