# ADR-003: Phase-3 Exec-Time Secret Delivery — Re-anchored to Consilium Loops

**Status**: Proposed — pending approval
**Amends**: ADR-001 §3.2 (`issueLease` contract) and its **[R3-SEC-2]** run-state/approval gate
**Date**: 2026-07-11
**Applies to**: `multiqlti` — TypeScript/Node + Postgres/Drizzle agentic platform
**Verified against**: `origin/main` HEAD `dc055a3`

> ADR-001 R3 designed the credential broker's **exec-time** surface (`issueLease` → short-TTL
> lease → `spawnBuiltinServer`) with an approval + run-state gate anchored on the
> `pipeline_runs` / `stage_executions` tables. **Those tables were deleted in the
> pipelines-retirement (PR #525).** Phase 1 (DB-crypto broker + audit) and Phase 2 (OpenBao
> value backend) shipped; **Phase 3 — actually delivering a leased/typed secret into a run —
> was never built.** This ADR re-anchors the Phase-3 gate onto the consilium-loop execution
> model that replaced pipelines, and specifies typed delivery (AWS / Kubernetes). All other
> ADR-001 security conditions ([R3-SEC-3], -10, decrypt-confinement, no-secret-in-metadata,
> audit-on-failure) are preserved verbatim.

---

## Context

- The exec-time driver is now `server/services/consilium/consilium-loop-controller.ts`, not a
  pipeline controller. A "run" is a **consilium loop**; a "stage" is a **loop phase / round**.
- `credentialLeases.runId` / `stageId` are plain `text` (not FKs) — they can carry a
  `consiliumLoop.id` and a phase string **without a migration** (`shared/schema.ts:2095-2124`).
- There is **no `stage_executions.approvalStatus`** table anymore; the ADR-001 approval gate
  as literally worded is unimplementable. A new approval anchor is required.
- **New requirement (operator):** before `developing`, a loop may run a **read-only infra
  refresh/plan** (e.g. `terraform plan -refresh-only`, read-only `kubectl get`) to reconcile
  remembered vs. actual infrastructure, feeding the drift summary into the **dispute**. This
  means a secret must be **leasable during `reviewing`**, not only `developing`.

---

## Decision

### D1 — Run-state gate (supersedes ADR-001 [R3-SEC-2])

`issueLease` MUST throw `ForbiddenError` unless **both** hold:

1. **`projectId === getProjectId()`** (unchanged [R3-SEC-3]); and
2. the referenced loop is in an **active, secret-consuming state**:
   `loop.state ∈ { "reviewing", "developing" }`, **and** the loop's `projectId` matches.

The gate is **consumer-scoped**, enforced by *which server-side call site* issues the lease:

| Loop state | Permitted consumer of the lease | Forbidden |
|---|---|---|
| `reviewing` | the **read-only infra refresh/plan exec step** only (server-invoked subprocess) | the reviewer/debater LLM prompt or env |
| `developing` | the coder, built-in MCP servers, exec tools (jira/gitlab/terraform) | — |

**A raw secret is NEVER placed in a reviewer LLM's prompt or environment.** At `reviewing`,
the secret is delivered only to a controlled subprocess (`terraform` / `kubectl`), and only
its **scrubbed output** (a drift/plan summary) is fed into the dispute context. Terminal /
`throttled` / `pending` / `building_context` / `awaiting_merge` / `deciding` states are NOT
eligible (fail-closed).

> Replaces the pipeline-anchored check
> (`stage_executions.approvalStatus === 'approved' AND pipelineRuns.status === 'running'`).

### D2 — Approval model: binding-at-create = approval

There is no separate per-stage human approval step (no `stage_executions` to carry it).
Instead, a loop **declares the named secrets it may use at creation time** — an explicit
operator act. That binding IS the approval. `issueLease` additionally verifies the requested
`credentialId` is in the loop's **bound set** (`consilium_loop_secrets`, D-migration below);
a secret not bound to the loop can never be leased, even in an eligible state.

- **Binding storage:** new join table `consilium_loop_secrets(loop_id, credential_id)` —
  many secrets per loop, additive **migration created but human-applied** (never auto-applied).
- **Create surface:** `secretNames?: string[]` on `CreateConsiliumReviewParams` and the two
  create routes; names sanitized before use; resolved to `credentialId`s at bind time.
- **Rate limit ([R3-SEC-10], preserved):** `issueLease` rate-limited per `(projectId, loopId)`
  to bound a compromised-loop burst.

### D3 — Typed secrets

A secret carries a **`type` ∈ { `static`, `aws`, `kubernetes` }**; `valueEncrypted` holds a
structured payload:

- `aws` → JSON `{ accessKeyId, secretAccessKey, sessionToken?, region? }`
- `kubernetes` → the kubeconfig (YAML)
- `static` → a single string (today's behavior)

`CredentialSecret` producers (`types.ts:71-80` `aws-sts` / `github-app-token`) live **only in
`db-crypto-provider.ts`** — the single sanctioned `decrypt()` site. No new decrypt path is
introduced anywhere else (and the **CI grep guard** confining `decrypt(` to that file +
`scripts/` is built in the same PR, closing the long-documented gap).

### D4 — Delivery shaping

- **AWS** → env layered over the sanitized allowlist in `envOverride`:
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (when present),
  `AWS_DEFAULT_REGION`.
- **Kubernetes** → the kubeconfig is written to a **per-run temp file, mode `0600`**, inside
  the run's sandbox; `KUBECONFIG=<path>` is set; the file is **removed in `finally`** and its
  path + contents are added to the run's dynamic scrub set.
- **Read-only posture at `reviewing`:** the refresh/plan consumer runs **plan/read only —
  never `apply`/`destroy`** (matches repo rule `.claude/rules/terraform.md` `never_apply`);
  read-only credentials are preferred for review-stage leases where the operator provides them.

### Preserved ADR-001 invariants (unchanged)

- **[R3-SEC-3]** `projectId === getProjectId()` on every broker method; **system-context
  callers structurally cannot `issueLease` or read secret material** (`getProjectId()` throws
  under `runAsSystem`).
- **decrypt-confinement** to `db-crypto-provider.ts` — now **CI-enforced**.
- **No secret value in `CredentialMetadata`** or any API response or log.
- **Audit on every access including failures**: populate the already-defined-but-unused
  `lease_issued` action + `ttlSeconds` column; emit `lease_used` immediately before spawn;
  `lease_revoked` / `lease_expired` via the (now-wired) sweeper + revoke-on-failure `finally`.
- **Scrub before any trust boundary** — extended to a **dynamic per-run value set** so a
  freshly-leased value that never sat in `process.env` (STS token, kubeconfig) is still
  redacted from stdout/stderr/trace (`secret-scrub.ts` gains a value-set parameter).

---

## Consequences

**Positive.** Loops can safely reconcile live infra before deciding/developing; secrets reach
only server-controlled subprocesses under a short-TTL, audited, rate-limited, revocable lease;
typed AWS/Kubernetes delivery removes hand-rolled env plumbing; the decrypt invariant becomes
enforced rather than merely documented.

**Risk — dispute-stage secret is a new surface.** `reviewing` is where untrusted repo content
is processed. Mitigations (all mandatory): (1) the secret is delivered only to a fixed exec
step, never to the LLM prompt/env; (2) that step is **read/plan-only**, never mutating; (3) its
output is scrubbed with the dynamic value set before it enters the dispute; (4) read-only
credentials preferred; (5) full lease audit. **This surface is the primary focus of the
Security-Engineer veto gate on Phase 3a.**

**Superseded.** ADR-001 §3.2 **[R3-SEC-2]** (pipeline-anchored approval/run-state check) and
the PR-1c "integrate into `pipeline-controller.ts`" step are replaced by D1/D2 above and
integration into `consilium-loop-controller.ts`. All other ADR-001 R3 conditions stand.

---

## Phasing

- **(0)** This ADR (approval gate re-anchor + typed-delivery decision). ← you are here
- **(3a)** Core delivery: `issueLease` (interface + DB + OpenBao-delegate) with the D1 gate and
  D2 binding; `consilium_loop_secrets` **migration (created, human-applied)**; create-surface +
  UI binding; injection seam serving both review-exec and dev (coder/MCP); **dynamic scrubber**;
  wire `markLeaseUsed` / `expireStaleLeases`; **CI decrypt guard**. `/dev-team`, Security veto.
- **(3b)** Typed secrets: `type` field + structured value; AWS→env and Kubernetes→kubeconfig
  shapers in `db-crypto-provider.ts`; typed create-secret UI.
- **(3c)** Infra refresh/plan step (separate): opt-in per loop, repo-type-aware, read/plan-only,
  drift summary → dispute context. Consumes the review-stage delivery from 3a/3b.
