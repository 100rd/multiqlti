# ADR-002: HashiCorp Vault as the Credential Backend (Phase 2)

**Status**: Proposed — **deferred** (do not implement until an adoption trigger T1–T4 fires, §9)
**Date**: 2026-06-27
**Authors**: Solution Architect (multiqlti infra team)
**Reviewers**: Security Expert, Cost/DevOps Analyst
**Depends on**: [ADR-001](./ADR-001-secrets-isolation-and-broker.md) — the `CredentialProvider` broker (Phase 1) MUST be in production first
**Applies to**: `multiqlti` — multi-project agentic platform (TypeScript/Node + Postgres/Drizzle, k8s/Helm)

---

## 1. Context

`multiqlti` is a **multi-project** platform: each "project" is a separately managed platform with its **own AWS accounts, git accounts, and application secrets**. LLM agents plan and execute infra/dev work on behalf of each project, calling MCP tools against real cloud and git APIs.

ADR-001 established a phased program:
- **Phase 0** — close the project-isolation gaps (fail-closed scoping, wired `requireProject`, `projectId` on all secret tables, encrypt plaintext tokens, remove the dev-key fallback).
- **Phase 1** — a `CredentialProvider` broker (DB + AES-256-GCM backend): plan-time **metadata only**, execution-time **short-TTL scoped lease** after approval, with audit and revocation, fronting the existing `spawnBuiltinServer` seam.
- **Phase 2** — *this ADR* — swap the broker's backend to **HashiCorp Vault** without changing the interface.

### What Phase 1 already gives us (and its ceiling)

Phase 1 delivers per-project isolation at the DB layer, the plan/exec split, lease TTL + revocation tracking, and a secret-access audit log. It is **the correct architecture for the current scale** and is *not* a stopgap.

What Phase 1 **cannot** do — the gap this ADR closes:

| Limitation of Phase 1 (DB + crypto) | Vault capability |
|---|---|
| AWS/git credentials are **static, long-lived**, stored at rest in Postgres | **Dynamic secrets** — short-lived AWS STS creds / GitHub App tokens minted per request, auto-revoked on lease expiry |
| The AES key lives in the **app process env** | **Transit engine** — encryption-as-a-service; key material never leaves Vault |
| `revokeRunLeases` marks a DB row but **cannot invalidate a leaked cloud key** | Native **lease revocation** invalidates the actual credential |
| Per-project isolation is **policy-in-code** (one SQL bug → all keys) | **Namespace** isolation = hard, API-level tenant boundary |
| Audit log lives **in the same Postgres** a compromised app can tamper with | **Independent audit device** outside the app's trust boundary |
| Key rotation requires a **deploy + migration** | Transit **auto-rotation**; dynamic creds rotate every lease |

---

## 2. Decision

**Adopt HashiCorp Vault as the `CredentialProvider` backend, hosted on HCP Vault Dedicated (Standard tier), behind the unchanged ADR-001 interface — deferred until an adoption trigger fires.**

- **Hosting = HCP Vault Dedicated Standard** (managed). Rationale in §7. Self-hosted Vault OSS on k8s is a documented alternative **only if a named engineer owns Vault operations**.
- **Isolation = one Vault namespace per project** (HCP Standard includes Enterprise namespaces — a hard, API-level boundary, not policy-by-path).
- **Integration =** implement `VaultCredentialProvider implements CredentialProvider`; the pipeline controller, plan/exec split, lease lifecycle, and audit semantics from ADR-001 are unchanged. Cutover is a backend flag flip.
- **Defer** implementation until trigger T1–T4 (§9). Because all credential access already flows through `CredentialProvider`, Phase 2 is a **$0-rework backend swap**.

---

## 3. Target Architecture

### 3.1 Topology overview

```
                         HCP Vault Dedicated (Standard tier)
                         ┌───────────────────────────────────────────────┐
   k8s pod (multiqlti)   │  namespace: project-A                          │
   ┌─────────────────┐   │   ├── transit/        (encrypt/decrypt only)   │
   │ SA JWT          │── k8s auth ─▶ role project-A                       │
   │ VaultCredential │   │   ├── secret/ (KV v2)  projects/A/...           │
   │ Provider        │   │   ├── aws/creds/A-deploy   (dynamic STS)        │
   │                 │   │   └── github/token/A       (dynamic App token)  │
   └─────────────────┘   │  namespace: project-B   …(fully isolated)…     │
        │                │  namespace: admin/  (Terraform-only, onboarding)│
        │                │  audit device ──▶ external log aggregator       │
        ▼                └───────────────────────────────────────────────┘
   spawnBuiltinServer(config, lease.secret)   ← unchanged ADR-001 seam
```

The application holds **no Vault admin capability**. Each pod authenticates with its Kubernetes service-account JWT and receives a token scoped to **exactly one project's namespace** for the duration of the operation.

### 3.2 Authentication — Kubernetes auth

The Helm deployment already mounts a per-release service-account JWT (`automountServiceAccountToken: true`). Phase 2 adds only `VAULT_ADDR`/`VAULT_NAMESPACE` env wiring — no manifest changes.

- Enable `auth/kubernetes` per project namespace.
- Bind a Vault **role per project**: `bound_service_account_names` + `bound_service_account_namespaces` → `token_policies = [project-<id>]`, short token TTL (e.g. 10m), namespace = `project-<id>`.
- The provider obtains a project-scoped token **per credential operation** using the validated `projectId` from the request/lease context (`projectId === getProjectId()`, ADR-001 §3.2). A compromised token can only reach its own namespace.

### 3.3 Transit engine — replace the app key

```hcl
vault secrets enable transit
vault write transit/keys/multiqlti-app type=aes256-gcm96 auto_rotate_period=8760h
```

Replaces the single scrypt-derived `ENCRYPTION_KEY` in `server/crypto.ts`. Ciphertext carries Vault's `vault:v1:` key-version prefix (interoperates with the `v2:` versioning introduced in ADR-001 PR-0e — migration in §6). The app never holds raw key material; it calls `transit/encrypt` / `transit/decrypt`.

### 3.4 KV v2 — static per-project secrets

Path layout inside each project namespace:
```
secret/projects/<projectId>/credentials/<id>     # opaque app secrets
secret/projects/<projectId>/aws/<account-alias>  # AWS role config (not keys)
secret/projects/<projectId>/github/<install>     # GitHub App install config
```
Default lease 5 min, max 15 min for read tokens.

### 3.5 Dynamic secrets — the core "dosed" win

**AWS STS (per project).** Each project's AWS account is reached via an assumed role; Vault mints short-lived STS credentials on demand:
```hcl
vault secrets enable -path=aws aws
vault write aws/roles/project-<id>-deploy \
    credential_type=assumed_role \
    role_arns=arn:aws:iam::<project-acct>:role/multiqlti-deploy \
    default_sts_ttl=15m max_sts_ttl=1h
```
An agent that needs AWS gets a 15-minute credential bound to (project, run, stage), auto-revoked at lease end. No long-lived AWS keys exist anywhere.

**GitHub App tokens (per project).** A GitHub secrets engine (or a thin custom engine) issues short-lived installation tokens scoped to the project's repos, replacing stored PATs.

### 3.6 Authorization — policy + namespace

**Primary isolation is the namespace + the per-project k8s auth role** — a project-A token physically cannot address project-B paths because it lives in project-A's namespace. The policy below is **defense-in-depth, not the primary boundary** (a misread of `deny` rules as "the security" is the most common Vault design error):

```hcl
# policy "project-<id>" — applied within namespace project-<id>
path "secret/data/projects/<id>/*"             { capabilities = ["read"] }
path "secret/data/projects/<id>/credentials/*" { capabilities = ["create","update"] }
path "aws/creds/project-<id>-*"                { capabilities = ["read"] }
path "github/token/project-<id>"              { capabilities = ["read"] }
path "transit/encrypt/multiqlti-app"          { capabilities = ["update"] }
path "transit/decrypt/multiqlti-app"          { capabilities = ["update"] }
# defense-in-depth only — a namespaced token already cannot see other projects:
path "secret/data/projects/+"   { capabilities = ["deny"] }
path "secret/data/projects/+/*" { capabilities = ["deny"] }
```
The provider also validates `projectId` against `^[a-z0-9_-]{1,64}$` before composing any path/namespace.

### 3.7 Leases, TTL, revocation

- Static KV: 5 min default / 15 min max.
- Dynamic engines: native Vault leases (AWS 15m/1h, GitHub per-install TTL).
- `revokeLease(leaseId)` → `vault lease revoke`; `revokeRunLeases(runId)` runs in the pipeline `finally` (success **and** failure/timeout).
- **The ADR-001 Phase-1 timestamp sweeper remains the backend-independent backstop** — it marks `credential_leases` rows `expired` by `expiresAt < now()` regardless of Vault availability.

### 3.8 Audit device — a hard availability dependency

> **Vault blocks ALL operations if no enabled audit device can write.** This is the #1 first-deployment incident.

- HCP-managed audit log shipped to an external aggregator (Datadog/Loki/CloudWatch), **or** (self-host) a dedicated PVC (≥20Gi) **or** a `socket` audit device with a local buffer.
- Alert at **>80%** audit-storage utilization before it becomes Vault-blocking.

### 3.9 KMS auto-unseal governance (self-host alternative)

For the self-host path, auto-unseal via cloud KMS is an **IAM governance** risk, not an availability one:
- KMS key **deletion protection** on.
- `kms:Decrypt` restricted to the Vault IRSA role **+ a break-glass principal**.
- **CloudTrail alert** on any KMS key-policy change.
- **Quarterly Raft-snapshot DR drill** (restore in staging, verify unseal + read).

### 3.10 Project onboarding pipeline

Creating a project must provision its Vault namespace/policy + AWS IAM assumed-role + GitHub App installation. This is a **restricted CI/CD Terraform job** (`vault_namespace`, `vault_policy`, `vault_kubernetes_auth_backend_role`, AWS IAM) — **the application must never hold Vault admin capability.** ~1 engineer-week to build. Manual onboarding is acceptable only below ~20 projects.

---

## 4. The integration point (no interface change)

```typescript
// server/credentials/vault-provider.ts
export class VaultCredentialProvider implements CredentialProvider {
  // PLAN-TIME: metadata only — reads KV metadata + lists configured engines.
  //            NEVER returns secret material. Asserts projectId === getProjectId().
  async listCredentials(projectId: string): Promise<CredentialMetadata[]> { … }

  // EXEC-TIME: enforces approval + run-state INTERNALLY (ADR-001 §3.2), then mints.
  async issueLease(p): Promise<CredentialLease> {
    assertContext(p.projectId);                 // projectId === getProjectId()
    await assertStageApprovedAndRunning(p);     // reads stage_executions + pipeline_runs
    const token = await this.tokenForProject(p.projectId);   // k8s-auth, namespaced
    const secret = await this.mint(token, p);   // KV read | aws/creds | github/token
    await this.recordLease(p, secret.lease_id, secret.expiresAt);  // credential_leases + access_log
    return { …, secret };                       // secret ONLY here, never in metadata
  }

  async revokeLease(id)      { await vault.lease.revoke(id); }
  async revokeRunLeases(run) { /* at-least-once retry + DLQ; sweeper is the backstop */ }
}
```

The pipeline controller, the plan→approve→execute flow, `credential_leases` / `credential_access_log`, the `lease_used` audit emit before `spawnBuiltinServer`, and the rate-limit are all **inherited unchanged from ADR-001**. Cutover = implement this class + flip `CREDENTIAL_BACKEND=vault`.

---

## 5. Plan → execute flow with Vault

```
PLANNING        agent → listCredentials(projectId) → metadata only (hasSecret:true), NO secret
                controller sets stage approvalStatus='pending'
   │
HUMAN APPROVAL  reviewer sees metadata only → approvalStatus='approved'
   │
EXECUTION       issueLease(): assert approved+running, assert projectId===ctx,
                k8s-auth → project-<id> namespace token → mint dynamic STS / KV read
                write credential_leases + access_log(lease_issued)
                log access_log(lease_used) ──▶ spawnBuiltinServer(config, {AWS_*: lease.secret})
                agent runs tools (mcpToolCalls audit)
   finally:     revokeRunLeases(runId) → vault lease revoke (retry+DLQ)
   │
AUDIT           credential_access_log (issued/used/revoked) + Vault audit device
BACKSTOP        timestamp sweeper marks expired; Vault lease TTL auto-revokes the cloud cred
```

---

## 6. Migration (Phase 1 → Phase 2)

| Step | Action | Risk |
|------|--------|------|
| 6.1 | Provision HCP Standard, namespaces, k8s auth, base policies via Terraform; enable audit device (§3.8) | low |
| 6.2 | Transit round-trip integration test gated by `VAULT_ADDR` | low |
| 6.3 | Implement `VaultCredentialProvider` (KV, aws/creds, github) | medium |
| 6.4 | **Data migration**: decrypt each encrypted column via `crypto.ts` → re-encrypt via Transit (prefix `vault:transit:`); idempotent, per-batch transactions. `trigger-crypto.ts` rows migrate separately. | medium — missed decrypt paths surface here |
| 6.5 | **48h shadow mode**: DB primary, Vault shadow, discrepancy logging (rate-sample to avoid flooding the audit device) | medium |
| 6.6 | Cutover `CREDENTIAL_BACKEND=vault`; monitor one sprint; **remove `CREDENTIAL_BROKER_ENABLED`** | low (flag rollback) |
| 6.7 | Decommission DB backend; drop legacy ciphertext **only after** one stable sprint | irreversible → gated |

Estimated **4–6 engineer-days** for the migration mechanics, plus ~1 engineer-week for the onboarding pipeline (§3.10).

---

## 7. Hosting decision & cost

| Option | Infra $/mo | Ops $/mo (loaded) | Effective | Isolation | Verdict |
|--------|-----------:|------------------:|----------:|-----------|---------|
| **HCP Vault Dedicated Standard** | 350–500 | 200–300 | **550–800** | **Namespaces (hard)** | **Recommended** |
| Self-host Vault OSS (3-node Raft + KMS unseal) | 42–62 | 750–1000 | 792–1062 | Policy+path only | Only with a named Vault owner |
| HCP Vault Plus (+DR) | 700–1100 | 200–300 | 900–1400 | Namespaces + cross-region DR | If regulated / DR-mandated |
| AWS Secrets Manager + STS (no Vault) | 80–4000+ | 150–300 | breaks >50 projects | IAM per project, **no lease revoke** | Not recommended (cost explodes; STS 1h min TTL) |

**Why HCP Standard:** for a 2–4 engineer team without a dedicated SRE, fully-loaded TCO is **lower** than self-host OSS, and it includes **Enterprise namespaces** — the hard per-project boundary this platform's threat model needs. Self-host OSS adds the audit-device-disk failure mode, rolling-upgrade coordination, and split-brain runbooks that consume disproportionate time.

**Dynamic-secret scaling inflection:** manual onboarding fine ≤10 projects; Terraform onboarding mandatory by ~50; IAM-role proliferation becomes an audit finding by ~100; ~1000 projects require namespaces (OSS becomes untenable).

---

## 8. Security considerations

| Threat | Mitigation |
|--------|-----------|
| Cross-project credential read | **Namespace** isolation + per-project k8s auth role; provider asserts `projectId===getProjectId()`; `deny` policy as DiD |
| App/server compromise blast radius | Pod token is namespaced + short-TTL → only its own project; no static cloud keys to steal (dynamic STS); leaked lease auto-revokes |
| Plan-time exfiltration (prompt injection) | Plan-time surface = metadata only; `issueLease` enforces approval+run-state **inside** the provider |
| Vault admin compromise | App never holds admin; onboarding is a restricted Terraform CI job; namespace separation |
| Vault unavailability | HCP-managed HA; audit-device alerting; timestamp sweeper backstop; revoke retry+DLQ |
| Key compromise / rotation | Transit auto-rotation; key never in app process; dynamic creds rotate per lease |
| Audit tampering | Independent audit device outside the app's Postgres trust boundary |

---

## 9. Adoption triggers — defer until the first fires

Phase 1 is sufficient for current scale. Adopt Vault when **any** of:

- **T1** — a customer contractually requires that their cloud credentials **not be stored on our infrastructure** (dynamic STS removes static storage entirely).
- **T2** — a **SOC 2 Type II / ISO 27001** audit comes into scope (Phase-1 DB crypto is defensible but will generate a finding).
- **T3** — a **key-rotation incident** forces a deploy cycle (proves the static-key model insufficient; dynamic STS pays for itself immediately).
- **T4** — **>10 active projects with separate AWS accounts**, where "one SQL bug exposes all keys" becomes an unacceptable blast radius.

Estimated **6–12 months** after Phase 0 completion.

---

## 10. Consequences

**Positive:** dynamic, auto-revoking cloud credentials; key material out of the app process; hard namespace isolation; independent audit; rotation without deploys; the broker interface makes adoption a backend swap.

**Negative / cost:** a new managed dependency (~$550–800/mo); a project-onboarding pipeline to build and maintain; the audit-device availability dependency; migration + shadow-run effort; an operational learning curve (leases, namespaces, auth roles).

**Neutral:** `trigger-crypto.ts` (federation/webhook secrets) stays on its own key derivation unless a separate decision folds it into Transit.

---

## 11. Rollback

| Step | Rollback |
|------|----------|
| Pre-cutover (shadow) | Disable shadow; no production impact |
| Cutover | `CREDENTIAL_BACKEND=db` (legacy ciphertext retained during the cutover window) |
| Post-decommission | Restore Postgres from snapshot (gated on one stable sprint before legacy rows are dropped) |

---

*ADR-002 — depends on ADR-001 (Phase 0/1). Status: deferred until T1–T4.*
