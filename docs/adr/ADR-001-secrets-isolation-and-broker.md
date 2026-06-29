# ADR-001: Secrets Isolation and Credential Broker

**Status**: Proposed — **APPROVE-able pending the 10 security conditions designed in below**
**Revision**: **3 — incorporates security & cost review** (R1: initial; R2: re-grounded on origin/main `9029f54`; R3: security BLOCK→conditions + cost review folded in)
**Date**: 2026-06-27
**Authors**: Solution Architect (omniscience infra team)
**Reviewers**: Security Expert (verdict: BLOCK → 10 conditions, all designed in here), Cost Analyst (rec: HCP Vault Dedicated Standard + defer Phase 2)
**Applies to**: `multiqlti` — TypeScript/Node + Postgres/Drizzle agentic platform
**Verified against**: `origin/main` HEAD `9029f54` at working tree `/Users/lord/Develop/multiqlti-wt/cur`

> **Revision provenance.** R1 was written against a stale checkout (HEAD `30817e6`, ~149 commits behind) and wrongly concluded the platform was single-tenant — discarded. R2 re-grounded everything on `origin/main` `9029f54`. **R3 (this revision) folds in the security review (BLOCK, 10 mandatory conditions) and the cost review (HCP Vault Standard, defer Phase 2).** R3 additions are marked inline as **[R3‑SEC‑n]** (security condition n) or **[R3‑COST]**. File:line references introduced in R3 (e.g. `routes.ts:334/343`, `remote-agent-manager.ts:246`, `storage-pg.ts:1662/1683/1709`, `server/ws/manager.ts`) were confirmed by the security reviewer, not independently re-verified by the architect in this pass.

---

## 0.1 Open Questions Resolved by Review (R3)

| Question (R2 open) | Resolution (R3) | Source |
|--------------------|-----------------|--------|
| OSS policy-isolation vs Enterprise namespaces? | **Resolved → HCP Vault Dedicated Standard** (Enterprise namespaces = hard per-project API isolation). Self-host OSS kept only as a documented alternative requiring a named Vault owner. | Security C9 + Cost |
| Vault hosting (self-host k8s vs managed)? | **HCP Vault Dedicated Standard.** Fully-loaded TCO **$550–800/mo** < self-host OSS **$792–1062/mo** for a 2–4 eng team, and removes cluster/unseal/upgrade ops. | Cost |
| When to actually adopt Vault? | **Defer Phase 2** until one of triggers T1–T4 fires (Section 4.4). Phase 1 is the correct architecture for current scale; the interface makes Phase 2 a $0‑rework backend swap. | Cost |
| Staged-rollout bypass (`STRICT_PROJECT_SCOPING`)? | **Removed.** Replaced by environment-promotion gates (a broken background job is fixed, never bypassed). | Security C8 |
| Is the approval gate a caller convention? | **No** — `issueLease` enforces approval + run-state internally (Section 3.2). | Security C2 |

**Security verdict path**: BLOCK → the 10 conditions below are now first-class design elements → the ADR is APPROVE-able once Phase 0/1 PRs implement them as specified.

---

## 0. Current-State Baseline (verified against origin/main `9029f54`)

The multi-tenant data model is **partially built**. The scaffolding exists; enforcement and a few specifics do not.

### What ALREADY exists (the foundation we build on)

| Capability | Evidence (path:line) | State |
|------------|---------------------|-------|
| `projects` table (id, name, ownerId, timestamps) | `shared/schema.ts` `projects = pgTable(...)` | EXISTS |
| `project_members` (projectId, userId, role default `"editor"`, composite PK) | `shared/schema.ts` `projectMembers = pgTable(...)` | EXISTS |
| 31 tables carry `projectId: text("project_id")` | `shared/schema.ts` (31 matches) | EXISTS |
| Request context (`AsyncLocalStorage`, `getProjectId()` throws if unset) | `server/context.ts:9,11-17` | EXISTS |
| `requireProject` middleware (reads `x-project-id`, owner/member check, runs context) | `server/middleware/project.ts:7-60` | EXISTS but **unwired** |
| `withProject(table, condition)` query-scoping helper | `server/db.ts:32-45` | EXISTS but **fails open** |
| JIT credential seam: `spawnBuiltinServer(type, id, config, secrets, allowDestructive)` | `server/tools/mcp-client.ts:55-77` | EXISTS — secrets injected at spawn, docstring line 52 "MUST NOT be stored after this call" |
| `workspaceConnections` table with `secretsEncrypted`, API exposes only `hasSecrets` | `shared/schema.ts:1640,1659,1682`; `server/storage-pg.ts:1860` | EXISTS — good model |
| `mcpToolCalls` audit table (connectionId, pipelineRunId, toolName, startedAt) | `shared/schema.ts:1765-1806` | EXISTS |
| Stage approval gate (`approvalStatus` pending/approved/rejected) | `server/controller/pipeline-controller.ts` | EXISTS |
| `mcpServers` and `pipelines` carry `projectId` | `shared/schema.ts` (mcpServers, pipelines blocks) | EXISTS |
| `gitSkillSources` carries `projectId` | `shared/schema.ts` gitSkillSources block | EXISTS |

### What is BROKEN or MISSING (the Phase 0 hardening targets)

| Gap | Evidence (path:line) | Severity |
|-----|---------------------|----------|
| `requireProject` is **defined-but-unused** — wired onto zero routes; routes use only `requireAuth` | `server/routes.ts:125-161`; grep for `requireProject` outside its own file returns nothing | HIGH — isolation middleware is dead code |
| `withProject` **fails OPEN** — returns the bare condition without the project filter when no context is present | `server/db.ts:37-44` (returns `condition` at line 43; comment at 38-39 admits "In strict mode, you might want to throw here instead") | HIGH — cross-project leak |
| `withProjectInsert` silently drops `projectId` outside context | `server/db.ts:51-62` (catch returns `data` unchanged, line 59-61) | MEDIUM — orphan rows with null projectId |
| **[R3‑SEC‑1] System-context queries that will BREAK under fail-closed** — `getEnabledTriggersByType` (CronScheduler `routes.ts:334`, FileWatcher `routes.ts:343`), lease-expiry sweeper, WS broadcast handlers (`server/ws/manager.ts` — no ALS context survives the socket upgrade) | per security review | HIGH — fail-closed `withProject` causes outages unless `runAsSystem` exists |
| **[R3‑SEC‑4] `RemoteAgentManager.listAgents()` is unscoped** AND its 60s heartbeat uses the plaintext `authTokenEnc` | `server/remote-agents/remote-agent-manager.ts:246` (unscoped); `:121,:301` (plaintext token) | HIGH — cross-project read + plaintext credential in a hot loop |
| **[R3‑SEC‑5] `argoCdConfig` storage is a hard singleton** (`eq(id, 1)`) — column alone won't scope it | `server/storage-pg.ts:~1662` (get), `~1683` (save), `~1709` (delete) | HIGH — one global ArgoCD until the storage fns change |
| `provider_keys` has **no `projectId`**; `provider` is globally `.unique()` | `shared/schema.ts` providerKeys block | HIGH — global keys; unique constraint blocks per-project keys |
| `argocd_config` has **no `projectId`** (singleton `id = 1`) | `shared/schema.ts` argoCdConfig block | HIGH |
| `triggers` has **no direct `projectId`** (only `pipelineId`) | `shared/schema.ts` triggers block | MEDIUM — transitively scoped via `pipelines.projectId` |
| `trackerConnections.apiToken` stored **plaintext** | `shared/schema.ts:1500`; `server/storage.ts:2441`; `server/services/trackers/jira-adapter.ts` | HIGH |
| `remoteAgents.authTokenEnc` stored **plaintext** despite `_enc` | `shared/schema.ts:1544`; `server/remote-agents/remote-agent-manager.ts:80,97,121,301` | HIGH |
| Decrypted ARGOCD token written **plaintext** into `mcpServers.env` JSONB (incl. **historical rows** already persisted) | `server/routes/argocd-settings.ts:148→155,165,261,294` | HIGH — needs a data-cleanup migration, not just a code fix |
| Orthogonal env-var ArgoCD path `autoConnectArgoCdFromEnv()` bypasses DB entirely | `server/routes/argocd-settings.ts:289` | MEDIUM — needs a design note for broker fronting |
| `crypto.ts` **insecure dev-key fallback** (public key + static salt = zero security) | `server/crypto.ts:16-19`, salt `:6` | HIGH (P0 if any prod row used it) |
| **[R3‑SEC‑10] `mcpToolCalls.projectId`** must actually exist as a column, else fail-closed `withProject` throws Postgres column-not-found | verify `shared/schema.ts` mcpToolCalls block | MEDIUM — verify before PR-0a |
| No secret-access audit (distinct from tool-call audit) | no `credential_access_log` table | MEDIUM |

---

## 1. Context and Problem

### 1.1 Platform Overview

`multiqlti` is a multi-project agentic platform; each "project" is a separately managed platform with its own AWS accounts, git accounts, and secrets. LLM agents — run via pipelines in `server/controller/pipeline-controller.ts` — call MCP-based tools (`server/tools/registry.ts`, `server/tools/mcp-client.ts`, `server/mcp-servers/registry.ts`) acting against cloud APIs and git on behalf of tenants.

Two properties must hold simultaneously: **(1) dosed, scoped credential exposure** (only needed material, only for authorized ops, only at execution time) and **(2) hard project isolation** (project A cannot read/use project B's credentials). The tenant model exists but does not yet enforce either end-to-end.

### 1.2 Current State: Secrets Storage

App-layer AES-256-GCM; no external secret manager. `server/crypto.ts:1-49` (global key, static salt line 6, insecure fallback 16-19, no rotation); `server/services/trigger-crypto.ts` (separate key, correctly throws); `server/federation/encryption.ts` (ECDH+HKDF, out of scope). Correctly encrypted: `providerKeys.apiKeyEncrypted`, `gitSkillSources.encryptedPat`, `argoCdConfig.tokenEnc`, `triggers.secretEncrypted`, `workspaceConnections.secretsEncrypted`. Plaintext leaks: `trackerConnections.apiToken`, `remoteAgents.authTokenEnc`, `ARGOCD_TOKEN` in `mcpServers.env` (incl. historical rows).

### 1.3 Current State: Project Isolation

Model built, not enforced: `requireProject` unwired; `withProject` fails open (background jobs drop the filter); `providerKeys`/`argoCdConfig`/`triggers` lack direct `projectId`; **[R3‑SEC‑1]** several system paths query unscoped today and will break the moment `withProject` is made fail-closed unless a sanctioned system-context exists.

### 1.4 Current State: Credential Flow at Agent Execution

Good: `spawnBuiltinServer(...)` (`mcp-client.ts:55`) takes already-decrypted secrets at spawn, not persisted (docstring line 52); `workspaceConnections` exposes only `hasSecrets`; `mcpToolCalls` audits tool calls; approval gate exists. Gap: no plan-vs-exec split; secrets available from run start; no leasing; no secret-access audit.

### 1.5 Problem Summary

| Requirement | Current Reality |
|-------------|-----------------|
| Project-scoped credential isolation | Model exists; `requireProject` unwired, `withProject` fails open, 3 secret tables unpartitioned, several unscoped system paths |
| Plan-time: metadata only | No split; secrets available from run start |
| Exec-time: short-TTL scoped lease | No leasing; perpetual secrets |
| Secret-access audit | Only tool-call audit; no secret-access log |
| Key rotation | Static key, insecure fallback, no rotation |
| Encrypt all credential fields | 3 plaintext leaks + historical env rows |

---

## 2. Decision

**Phased: Credential Broker abstraction first, HashiCorp Vault as the backend later.**

- **Phase 0 — Isolation hygiene (hardening).** Fail-closed `withProject` **plus a sanctioned `runAsSystem` context**, wire `requireProject`, add `projectId` to 3 secret tables **and convert the `argoCdConfig` singleton storage**, encrypt the 3 plaintext leaks **and clean historical env rows**, **versioned rekey + dev-fallback removal as a separate post-migration deploy**, cross-project tests.
- **Phase 1 — `CredentialProvider` broker (DB+crypto backend).** Interface fronting the existing `spawnBuiltinServer` seam; plan-time (metadata only) vs exec-time (short-TTL lease); **broker enforces approval+run-state and `projectId` context internally**; secret-access audit incl. `lease_used`; **timestamp-based expiry sweeper + revoke-on-failure live here, not Phase 2**.
- **Phase 2 — Vault backend behind the same interface.** **HCP Vault Dedicated Standard** (namespaces); Transit; KV v2 per-project; dynamic AWS-STS/GitHub-App; Kubernetes auth; **project-onboarding CI/CD pipeline**; audit-device availability + KMS governance. Deferred until a T1–T4 trigger (Section 4.4).

Stakeholder-chosen, not relitigated. Broker-first ships security before Vault ops cost.

---

## 3. Target Architecture

### 3.1 Project Scoping: Close the Enforcement Gaps

We harden the existing model — we do **not** recreate `projects`/`project_members` or re-add `projectId` to the 31 tables that already have it.

**(a) Fail CLOSED `withProject`.** Replace the catch-and-return-condition fallback (`server/db.ts:37-44`) with a hard throw; same for `withProjectInsert` (`:51-62`).

```typescript
// REVISED server/db.ts — fail closed
export function withProject(table: any, condition?: SQL): SQL {
  const projectId = getProjectId(); // throws if no context — NO catch-and-fallback
  const projectFilter = eq(table.projectId, projectId);
  return condition ? and(projectFilter, condition)! : projectFilter;
}
```

**(b) Wire `requireProject`.** In `server/routes.ts` (requireAuth chain 125-161), append `requireProject` after `requireAuth` on every project-scoped router; keep `/api/projects`, auth, health public.

```typescript
app.use("/api/pipelines", requireAuth, requireProject);
app.use("/api/providers", requireAuth, requireProject);
app.use("/api/settings",  requireAuth, requireProject);
app.use("/api/triggers",  requireAuth, requireProject);
app.use("/api/tracker-connections", requireAuth, requireProject);
app.use("/api/remote-agents", requireAuth, requireProject);
// ... all routers touching project-scoped tables
```

**(c) Per-project background-job context.** Jobs that own a `projectId` (pipeline execution, a specific trigger firing) wrap work in the existing `requestContext`:

```typescript
export function runAsProject<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ projectId, userId: "system", role: "owner" }, fn);
}
```
A job whose record has a null `projectId` must **fail loudly**. Fail-closed `withProject` turns any forgotten context into a thrown error, not a leak.

**(d) [R3‑SEC‑1] Sanctioned system-context for legitimately cross-project background queries.** Some background work is *inherently* cross-project (e.g. "load all enabled triggers across every project to schedule them"). For these, add an explicit, audited bypass — never a silent one:

```typescript
// server/context.ts — system-context marker
export interface RequestContext { projectId?: string; userId?: string; role?: string; system?: boolean; }

export function runAsSystem<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  // (a) writes its own audit entry naming the reason + caller
  systemAccessAudit.record({ reason, at: new Date() });
  return requestContext.run({ system: true, userId: "system", role: "system" }, fn);
}

// db helper for system-context: explicit, greppable, cannot be confused with withProject
export function unscopedSystemQuery<T>(label: string, q: () => Promise<T>): Promise<T> { /* asserts ctx.system === true */ }
```

Hard rules for system-context:
- **(a)** every entry writes an audit record (who/why/when);
- **(b)** it is **forbidden from returning credential material and from calling `issueLease`** — enforced in the broker (Section 3.2 condition C3): broker methods assert `getProjectId()` succeeds, which throws under a `system` context.
- Naming convention: cross-project readers use `getAll*` / `unscopedSystemQuery` so the bypass is greppable in review.

**Known system entry points that MUST adopt `runAsSystem`** (else fail-closed causes outages): `getEnabledTriggersByType` (CronScheduler `routes.ts:334`, FileWatcher `routes.ts:343`); `RemoteAgentManager.listAgents()` (`remote-agent-manager.ts:246`) — **or** make it project-scoped, see (f); the lease-expiry sweeper (Section 3.3); WebSocket broadcast handlers (`server/ws/manager.ts` — establish a system or per-connection project context after the socket upgrade, since ALS does not survive it).

**(e) Add `projectId` to the three remaining secret tables.**

| Table | Change |
|-------|--------|
| `provider_keys` | Add `project_id text NOT NULL REFERENCES projects(id)`; drop global `unique(provider)` → `unique(projectId, provider)` |
| `argocd_config` | Add `project_id`; **[R3‑SEC‑5]** convert storage from the `eq(id,1)` singleton (`storage-pg.ts:~1662/1683/1709`) to `withProject` + per-project key — column alone is insufficient |
| `triggers` | Add `project_id` (denormalized from `pipelines.projectId`), backfilled via the trigger's pipeline |

**(f) [R3‑SEC‑4] `RemoteAgentManager.listAgents()`**: make project-scoped (preferred) or, if the heartbeat genuinely needs all agents, route it through `runAsSystem("agent-heartbeat", …)`. Independently, its token handling moves to real encryption in PR-0d.

### 3.2 The CredentialProvider Interface (Phase 1 Broker)

Two surfaces: **plan-time** (metadata only, mirrors `workspaceConnections.hasSecrets`) and **exec-time** (short-TTL scoped lease, after approval, revocable, audited).

```typescript
// server/credentials/types.ts
export interface CredentialMetadata {
  id: string; projectId: string; provider: string; scope: string;
  description: string; hasSecret: boolean; lastRotatedAt?: Date;
}
export type CredentialSecret =
  | { type: "static"; value: string }
  | { type: "aws-sts"; accessKeyId: string; secretAccessKey: string; sessionToken: string; region?: string }
  | { type: "github-app-token"; token: string; expiresAt: Date };
export interface CredentialLease {
  leaseId: string; credentialId: string; projectId: string;
  runId: string; stageId: string; issuedAt: Date; expiresAt: Date;
  secret: CredentialSecret; // ONLY surfaced here, never in CredentialMetadata
}

export interface CredentialProvider {
  // PLAN-TIME: metadata only. [R3-SEC-3] asserts projectId === getProjectId() at entry.
  listCredentials(projectId: string): Promise<CredentialMetadata[]>;
  getCredentialMetadata(projectId: string, credentialId: string): Promise<CredentialMetadata | null>;

  // EXEC-TIME. [R3-SEC-2] enforces approval + run-state INTERNALLY. [R3-SEC-3] asserts context.
  // [R3-SEC-10] rate-limited; emits credential_access_log.
  issueLease(p: {
    projectId: string; credentialId: string; runId: string; stageId: string;
    ttlSeconds?: number; requestedBy: string; justification?: string;
  }): Promise<CredentialLease>;

  revokeLease(leaseId: string): Promise<void>;
  revokeRunLeases(runId: string): Promise<void>;
  putCredential(p: { projectId: string; provider: string; scope: string; description: string; secret: string }): Promise<CredentialMetadata>;
  deleteCredential(projectId: string, credentialId: string): Promise<void>;
}
```

**Hardened broker contract (mandatory):**

- **[R3‑SEC‑2] `issueLease` enforces the gate itself.** It MUST read `stage_executions.approvalStatus === 'approved'` **AND** `pipelineRuns.status === 'running'`, and throw `ForbiddenError` otherwise. The approval gate is a broker invariant, not a caller convention.
- **[R3‑SEC‑3] Context-validated `projectId` on every public method.** Each method asserts `projectId === getProjectId()` at entry and throws on mismatch. Under a `runAsSystem` context `getProjectId()` throws — so **system-context callers structurally cannot call `issueLease` or read secret material** (satisfies 3.1(d)(b)).
- **[R3‑SEC‑10] Lease lifecycle hardening:**
  - emit `credential_access_log.action = 'lease_used'` **immediately before** `spawnBuiltinServer`, referencing `leaseId`;
  - the **expiry sweeper marks `expired` by `expiresAt < now()` regardless of backend/Vault state**;
  - **revoke on failure/timeout**, not only on success (`revokeRunLeases` in `finally`);
  - **rate-limit `issueLease`** per (projectId, runId) to bound a compromised-agent burst;
  - **verify `mcpToolCalls` has a real `projectId` column** before PR-0a (else fail-closed `withProject` throws column-not-found at runtime).

**Integration with the existing seam.** Phase 1 changes only *who produces* `secrets`: the controller obtains a `CredentialLease` and passes `lease.secret` into the unchanged `spawnBuiltinServer(type,id,config,secrets,allowDestructive)`. Minimal blast radius.

### 3.3 Audit Schema (extends, does not replace, `mcpToolCalls`)

```typescript
export const credentialLeases = pgTable("credential_leases", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  credentialId: text("credential_id").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id),
  runId: text("run_id").notNull(), stageId: text("stage_id").notNull(),
  requestedBy: text("requested_by").notNull(),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  status: text("status").notNull().default("active"), // active | revoked | expired
});

export const credentialAccessLog = pgTable("credential_access_log", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  leaseId: text("lease_id"), credentialId: text("credential_id").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id),
  runId: text("run_id"), stageId: text("stage_id"),
  // [R3-SEC-10] lease_used added:
  action: text("action").notNull(), // list_metadata | get_metadata | lease_issued | lease_used | lease_revoked | lease_expired
  requestedBy: text("requested_by").notNull(), justification: text("justification"),
  success: boolean("success").notNull().default(true), errorMessage: text("error_message"),
  ttlSeconds: integer("ttl_seconds"), createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

The **timestamp-based expiry sweeper ships in Phase 1** (Section 4, PR-1b) as the authoritative backstop independent of any backend lease state.

### 3.4 Plan → Approve → Execute Credential Flow (ASCII)

```
  PLANNING (pre-approval)
    agent → credentialProvider.listCredentials(projectId)
            → [{id,provider,scope,description,hasSecret:true}]   (NO secret material)
            │  controller sets stage_executions.approvalStatus='pending'
            ▼
  HUMAN APPROVAL GATE  (reviewer sees METADATA only)
            │  approvalStatus='approved'  (approvedBy, approvedAt)
            ▼
  EXECUTION
    [R3-SEC-2] issueLease() re-checks approvalStatus==='approved' AND run.status==='running' → else ForbiddenError
    [R3-SEC-3] asserts projectId===getProjectId()
    → writes credential_leases + credential_access_log(action='lease_issued')
    [R3-SEC-10] log action='lease_used'  ── immediately before ──▶ spawnBuiltinServer(type,connId,config,{TOKEN:lease.secret.value},allowDestructive)
    agent runs tools (mcpToolCalls audit)
    finally: revokeRunLeases(runId)  // [R3-COST] at-least-once retry + DLQ; sweeper is the backstop
            ▼
  AUDIT: credential_access_log (issued/used/revoked/expired) + Vault audit device (Phase 2)
  BACKSTOP: sweeper marks status='expired' where expiresAt < now()  (Phase 1, backend-independent)
```

### 3.5 Vault Topology (Phase 2) — **HCP Vault Dedicated Standard**

**[R3‑COST] Hosting = HCP Vault Dedicated Standard.** It provides **Enterprise namespaces** (hard, API-level per-project isolation — resolves security C9) and removes cluster/unseal/upgrade ops. Fully-loaded TCO **$550–800/mo** vs self-host OSS **$792–1062/mo** (2–4 eng team). **Self-host OSS remains a documented alternative ONLY if a named engineer owns Vault.** With namespaces, each project maps to a Vault **namespace**, not just a path prefix.

**Auth method.** App on Kubernetes (`helm/`, `docker-compose.yml`). **Vault Kubernetes auth**: the pod service account binds to a per-project Vault role that grants **only that project's policy in that project's namespace**. No static Vault tokens in the app; the app never holds Vault admin capability.

**Transit (replaces the app key).**
```
vault secrets enable transit
vault write transit/keys/multiqlti-app type=aes256-gcm96 auto_rotate_period=8760h
```

**KV v2 (per-project, inside the project namespace).** `secret/projects/<projectId>/credentials/<id>`, `.../aws/`, `.../github/`.

**Dynamic secrets.** AWS per-project STS (`aws/creds/project-<id>-deploy` via assumed-role); GitHub App installation tokens scoped to the project's repos.

**[R3‑COST] Isolation model — read carefully.** **Primary isolation = each project's k8s auth role grants only that project's policy (and, on HCP, its own namespace).** The `deny` rules below are **defense-in-depth, NOT the primary control** — do not over-trust them. The provider still validates `projectId` against `^[a-z0-9_-]{1,64}$` before constructing any path/namespace.

```hcl
# project-<id> policy (within its namespace on HCP; with explicit cross-project deny as DiD)
path "secret/data/projects/proj_abc123/*"     { capabilities = ["read"] }
path "secret/data/projects/proj_abc123/credentials/*" { capabilities = ["create","update"] }
path "aws/creds/project-proj_abc123-*"        { capabilities = ["read"] }
path "github/token/project-proj_abc123"       { capabilities = ["read"] }
path "transit/encrypt/multiqlti-app"          { capabilities = ["update"] }
path "transit/decrypt/multiqlti-app"          { capabilities = ["update"] }
# defense-in-depth only (NOT the primary boundary):
path "secret/data/projects/+"   { capabilities = ["deny"] }
path "secret/data/projects/+/*" { capabilities = ["deny"] }
```

**Leases/TTL/revocation.** Static KV 5 min default (max 15); dynamic engines use native leases; `revokeLease` → `vault lease revoke`; `revokeRunLeases` on failure/rejection. The Phase 1 timestamp sweeper remains the backend-independent backstop.

**[R3‑COST] Audit device availability dependency.** Vault **blocks ALL operations if no enabled audit device can write**. Provision either a **dedicated PVC (≥20Gi)** for a file audit device **or** a **socket audit device to a log aggregator**, and **alert at >80% utilization**. This is a hard availability dependency, specified in the Phase 2 Helm values.

**[R3‑COST] KMS auto-unseal governance** (for the self-host alternative, and good practice generally): key **deletion protection**; `kms:Decrypt` restricted to the Vault **IRSA role + a break-glass principal**; **CloudTrail alert on key-policy change**; **quarterly Raft-snapshot DR drill**.

---

## 4. Phased Migration Plan

### Phase 0: Isolation Hygiene (hardening)

> Scope is honestly larger than R2 implied — the security review added system-context, singleton-storage conversion, historical data cleanup, and a versioned rekey. Still no greenfield tenant model.

- **PR-0a — Fail-closed scoping + system-context.** Rewrite `server/db.ts:32-62` (throw outside context). Add `runAsProject()` and **[R3‑SEC‑1] `runAsSystem(reason, fn)` + `unscopedSystemQuery`** to `server/context.ts`. Convert the enumerated system entry points (`getEnabledTriggersByType` @ `routes.ts:334/343`, `RemoteAgentManager.listAgents()` @ `:246`, lease sweeper, `server/ws/manager.ts` broadcast) to either `runAsProject` or `runAsSystem`. **[R3‑SEC‑10]** verify `mcpToolCalls.projectId` exists first. **[R3‑SEC‑8]** NO `STRICT_PROJECT_SCOPING` flag — roll out env-by-env (see below).
- **PR-0b — Wire `requireProject`** after `requireAuth` (routes.ts:125-161); keep projects/auth/health public; route-coverage test (every scoped router 400s without `x-project-id`).
- **PR-0c — `projectId` on the 3 secret tables + [R3‑SEC‑5] argoCdConfig storage conversion.** Migration adds columns (providerKeys `unique(projectId,provider)`; argocd drop `id=1`; triggers denormalized). **Rewrite `getArgoCdConfig`/`saveArgoCdConfig`/`deleteArgoCdConfig` (`storage-pg.ts:~1662/1683/1709`) to `withProject` + per-project key** — not just the column. Backfill via sentinel project (Section 5).
- **PR-0d — Encrypt the 3 leaks + [R3‑SEC‑6] historical data cleanup.**
  - `trackerConnections.apiToken` → encrypt in storage (`storage.ts:2441`); migrate + **rotate**.
  - **[R3‑SEC‑4]** `remoteAgents.authTokenEnc` → real encryption before store (`remote-agent-manager.ts:80,97`); migrate + rotate; fix the heartbeat read path (`:121,:301`).
  - `argocd-settings.ts:155,165,261,294` → stop writing the token into `mcpServers.env`; inject via the spawn seam. **Data-cleanup migration**: `UPDATE mcp_servers SET env = env - 'ARGOCD_TOKEN' WHERE env ? 'ARGOCD_TOKEN'` (and other secret-shaped keys). CI lint fails if any `mcpServers.env` key matches `TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL`. **Design note**: the env-var path `autoConnectArgoCdFromEnv()` (`argocd-settings.ts:289`) bypasses the DB — when the broker fronts all credential access (Phase 1), this path must either be removed or wrapped so the broker remains the single source of truth.
- **PR-0e — [R3‑SEC‑7] Versioned rekey, THEN remove fallback (separate deploys).**
  1. Prefix all newly-encrypted values with `v2:`.
  2. Dual-key detection migration: try the real key → on GCM auth-tag failure, try the fallback key → re-encrypt as `v2:`. (`trigger-crypto.ts` rows use a different derivation — migrate separately.)
  3. **Verify ALL rows carry `v2:`** before touching the fallback.
  4. **Separate deploy**: remove `crypto.ts:14-21` fallback (throw, matching `trigger-crypto.ts`) + CI gate (fail if `ENCRYPTION_KEY` unset outside tests). Treat any fallback-encrypted prod row as **P0** (public key + static salt = zero security).
- **PR-0f — Cross-project isolation tests.** `x-project-id:A` cannot read B's `provider_keys`/`argocd_config`/`triggers`; a project-A job cannot read B's secrets; `withProject` no-context throws; `runAsSystem` cannot call `issueLease` or read secrets; member-of-A-not-B → 403 on B; every scoped router 400s without the header.

**[R3‑SEC‑8] Rollout governance (replaces the removed flag).** Promote PR-0a **environment by environment** (dev → staging → prod) and only after background-job health is verified green in the prior env. A broken job means **fix its context setup**, never disable the control.

### Phase 1: CredentialProvider Abstraction

- **PR-1a** — `credential_leases` + `credential_access_log` (with `lease_used`).
- **PR-1b** — `DbCryptoCredentialProvider`: metadata methods never `decrypt`; **[R3‑SEC‑2]** `issueLease` checks approval+run-state; **[R3‑SEC‑3]** asserts `projectId===getProjectId()`; **[R3‑SEC‑10]** rate-limit + `lease_used` emit; **timestamp-based expiry sweeper** marks `expired` where `expiresAt < now()` (backend-independent).
- **PR-1c** — Integrate into `pipeline-controller.ts`: plan-time `listCredentials`; post-approval `issueLease` → log `lease_used` → `spawnBuiltinServer(...)`; **revoke-on-failure/timeout in `finally`**; **[R3‑COST]** `revokeRunLeases` via **at-least-once retry + dead-letter** (BullMQ workers are in-process; on backend unavailability revoke can hang — the sweeper is the backstop).
- **PR-1d** — Route every remaining `decrypt()` through the broker; any decrypt outside `CredentialProvider` is a finding (incl. `argocd-settings.ts` and the env-var path note from PR-0d).
- **PR-1e** — Tests: plan-time yields no secret material; `issueLease` on unapproved/non-running stage throws `ForbiddenError`; project-A lease unusable in project-B context; expired-lease spawn fails; rate-limit trips; audit has issued+used+revoked; sweeper expires stale leases.

**[R3‑SEC‑8] Sunset rule.** `CREDENTIAL_BROKER_ENABLED` is a transition flag only and **must be removed at Phase 2 cutover** (no permanent bypass).

### Phase 2: Vault Backend (HCP Vault Dedicated Standard) — deferred (Section 4.4)

- **PR-2a** — HCP namespace/auth wiring + Kubernetes auth + base policies via Terraform; **audit-device PVC (≥20Gi) or socket device + >80% alert** in Helm; KMS governance (self-host alt). App holds **no** Vault admin.
- **PR-2b** — Transit round-trip integration test (gated by `VAULT_ADDR`).
- **PR-2c** — `VaultCredentialProvider` (same interface): KV v2, `aws/creds/...`, GitHub engine; per-project **namespace** + strict `projectId` validation; `deny` rules as DiD only.
- **PR-2d** — Data migration: decrypt via `crypto.ts` → re-encrypt via Transit (prefix `vault:transit:`); idempotent; per-batch transactions; `trigger-crypto.ts` rows separate.
- **PR-2e** — Cutover `CREDENTIAL_BACKEND=vault` with 48h shadow; promote; **remove `CREDENTIAL_BROKER_ENABLED`**; decommission DB backend after one sprint.
- **[R3‑COST] PR-2f — Project-onboarding pipeline (~1 eng-week).** A **restricted CI/CD job** (Terraform `vault_namespace`/`vault_policy` per project + AWS IAM role + GitHub App). The application must **NEVER** hold Vault admin capability; onboarding is operator-driven infra-as-code.

### 4.4 Phase 2 Adoption Triggers (defer until) — **[R3‑COST]**

Phase 1 is the correct architecture for current scale. **Defer Vault until the first of:**
- **T1** — a customer-contractual "no secrets stored on your infra" requirement;
- **T2** — a SOC 2 Type II / ISO 27001 audit in scope;
- **T3** — a key-rotation incident that forces a deploy cycle (proves the static-key model insufficient);
- **T4** — **>10 active projects with separate AWS accounts**, where "one SQL bug exposes all keys" becomes unacceptable.

Estimated **6–12 months post Phase-0**. Because all access already flows through `CredentialProvider`, Phase 2 is a **$0‑rework backend swap** (implement `VaultCredentialProvider`, migrate data, flip `CREDENTIAL_BACKEND`).

---

## 5. Backward-Compat & Data Migration

**Encrypted rows.** Valid while `ENCRYPTION_KEY` is set. **[R3‑SEC‑7]** the `v2:`-versioned dual-key rekey (PR-0e) runs **before** fallback removal; `trigger-crypto.ts` rows migrate separately. Phase 2 re-encrypts to Transit.

**Backfilling `projectId` on the 3 newly-scoped tables.** `triggers` → from `pipelines.projectId` via JOIN. `provider_keys`/`argocd_config` are genuinely ambiguous (global today): create a **sentinel "default" project**, backfill there, ship an admin reassign tool, and **refuse to create a second project until the operator acknowledges the default-project credential inventory** (otherwise isolation is nominal). **[R3‑SEC‑6]** the `mcp_servers.env` historical-row cleanup runs in the same wave.

**`provider_keys` unique swap.** Sequence: add column nullable → backfill → set NOT NULL → swap `unique(provider)`→`unique(projectId,provider)`.

---

## 6. Security Considerations

| Threat | Mitigation |
|--------|-----------|
| Cross-project credential leak | Fail-closed `withProject`; wired `requireProject`; `projectId` on all secret tables; **[R3‑SEC‑1]** audited `runAsSystem` for the few legitimate cross-project readers; **[R3‑SEC‑3]** broker asserts context; Vault **namespace** isolation (Phase 2) |
| Plan-time exfiltration via prompt injection | Plan-time surface = metadata only; **[R3‑SEC‑2]** secrets unobtainable before approval *and* run-state checks, enforced in the broker |
| Privilege via system-context | **[R3‑SEC‑3]** system-context callers structurally cannot call `issueLease`/read secrets (`getProjectId()` throws); **[R3‑SEC‑1(a)]** every system access is audited |
| Secret-in-logs | Secret only in the spawn closure for the lease TTL; **[R3‑SEC‑6]** never in `mcpServers.env` (lint + historical cleanup); log scrubber |
| App-key compromise / rotation | **[R3‑SEC‑7]** versioned rekey path; Phase 2 Transit removes key from the app process; auto-rotate |
| Vault availability | **[R3‑COST]** audit-device PVC/socket + >80% alert (Vault halts without a writable audit device); HCP-managed HA |
| Blast radius of a compromised agent | Lease TTL + per-(runId,stageId) scope; **[R3‑SEC‑10]** `issueLease` rate-limit; revoke-on-failure; sweeper backstop |
| Vault admin compromise | **[R3‑COST]** app never holds admin; onboarding is a restricted CI/CD job; audit device; KMS key-policy CloudTrail alert |
| Lease over-issuance / hung revoke | **[R3‑COST]** at-least-once revoke + DLQ; **[R3‑SEC‑10]** timestamp sweeper marks `expired` regardless of backend state |
| Dev-key fallback in prod | **[R3‑SEC‑7]** P0; versioned rekey then separate-deploy removal; CI gate |
| Runtime break from fail-closed | **[R3‑SEC‑10]** verify `mcpToolCalls.projectId` exists; **[R3‑SEC‑1]** system entry points enumerated and converted; **[R3‑SEC‑8]** env-by-env promotion |

**Most likely implementation defect**: a plan-time path that calls `decrypt()` or returns a `CredentialLease`. Every plan-time method is code-reviewed specifically for this; **[R3‑SEC‑3]** the context assertion is the structural backstop.

---

## 7. Risks, Trade-offs, Open Questions

**Risk 1 — System-context coverage.** Fail-closed throws in any background path lacking context. Mitigation: **[R3‑SEC‑1]** the enumerated entry points are converted in PR-0a; **[R3‑SEC‑8]** env-by-env promotion surfaces stragglers in staging (no bypass flag).

**Risk 2 — Fallback-key exposure (P0).** Public fallback key + static salt = zero security for any row written without `ENCRYPTION_KEY`. **[R3‑SEC‑7]** versioned dual-key rekey before removal; treat affected prod rows as a P0 incident.

**Risk 3 — Vault ops & cost — RESOLVED.** **[R3‑COST]** HCP Vault Dedicated Standard ($550–800/mo) < self-host OSS ($792–1062/mo) and removes cluster/unseal/upgrade ops; namespaces give hard isolation. Self-host OSS only with a named owner.

**Risk 4 — Isolation model clarity — RESOLVED.** **[R3‑COST]** primary isolation = per-project k8s auth role/namespace; `deny` rules are defense-in-depth only (prose fixed in 3.5).

**Risk 5 — `provider_keys` unique swap.** Sequence strictly (Section 5) to avoid collisions/orphans.

**Risk 6 — Onboarding privilege.** **[R3‑COST]** project onboarding (Vault namespace/policy + AWS IAM + GitHub App) is a restricted CI/CD Terraform job; the app never holds Vault admin. ~1 eng-week (PR-2f).

**Remaining open question (Cost/DevOps)**: confirm the HCP Standard tier (vs Plus) against the projected secret-read volume once Phase 1 metrics exist; revisit at the T4 trigger.

---

## 8. Rollback Plans (Summary)

| Phase | Rollback | Time |
|-------|----------|------|
| 0a (fail-closed + system-context) | **No bypass flag.** Revert the PR; re-deploy. Forward-fix preferred (env-by-env promotion limits blast radius) | 1 deploy |
| 0b (wire requireProject) | Remove `requireProject` from the chain | 1 deploy |
| 0c (projectId + argocd storage) | Down-migration; revert storage fns + unique constraint | migration |
| 0d (encrypt + env cleanup) | Revert encryption; **rotated tokens cannot be un-rotated**; env cleanup is one-way | 1 deploy |
| 0e (rekey → fallback removal) | Two separate deploys; rollback = restore fallback (keep CI gate) only if rekey incomplete | 2 deploys |
| 1 (broker) | `CREDENTIAL_BROKER_ENABLED=false` (transition only; **removed at Phase 2 cutover**) | config |
| 2 (Vault/HCP) | `CREDENTIAL_BACKEND=db`; legacy ciphertext retained during cutover window | config |
| 2 (post-decommission) | DB restore from backup | recovery op |

---

## Appendix A: File:Line Reference Index

Refs from R2 were architect-verified against `origin/main 9029f54` (tree `/Users/lord/Develop/multiqlti-wt/cur`, 2026-06-27). Refs marked **(R3/review)** were confirmed by the security reviewer in R3 and folded in without independent architect re-verification.

| Claim | File | Lines |
|-------|------|-------|
| `requireProject` UNWIRED (routes use only requireAuth) | `server/routes.ts` | 125-161 |
| `withProject` FAILS OPEN | `server/db.ts` | 37-44 |
| `withProjectInsert` drops projectId | `server/db.ts` | 51-62 |
| `getProjectId()` throws if unset | `server/context.ts` | 11-17 |
| `requireProject` defined | `server/middleware/project.ts` | 7-60 |
| `spawnBuiltinServer` JIT seam | `server/tools/mcp-client.ts` | 55-77 (secrets 59; docstring 52) |
| `workspaceConnections` / `hasSecrets` | `shared/schema.ts:1640,1659,1682`; `server/storage-pg.ts:1860` | — |
| `mcpToolCalls` audit table | `shared/schema.ts` | 1765-1806 |
| `provider_keys` no projectId; global unique | `shared/schema.ts` | providerKeys block (~296) |
| `argocd_config` no projectId (singleton id=1) | `shared/schema.ts` | argoCdConfig block |
| `triggers` no direct projectId | `shared/schema.ts` | triggers block |
| `trackerConnections.apiToken` plaintext | `shared/schema.ts:1500`; `server/storage.ts:2441`; jira-adapter | — |
| `remoteAgents.authTokenEnc` plaintext | `shared/schema.ts:1544`; `server/remote-agents/remote-agent-manager.ts` | 80,97,121,301 |
| ARGOCD token in `mcpServers.env` | `server/routes/argocd-settings.ts` | 148→155,165,261,294 |
| env-var ArgoCD path `autoConnectArgoCdFromEnv()` **(R3/review)** | `server/routes/argocd-settings.ts` | 289 |
| `crypto.ts` dev fallback / static salt | `server/crypto.ts` | 16-19 / 6 |
| **`getEnabledTriggersByType` system callers (R3/review)** | `server/routes.ts` | 334 (Cron), 343 (FileWatcher) |
| **`RemoteAgentManager.listAgents()` unscoped (R3/review)** | `server/remote-agents/remote-agent-manager.ts` | 246 |
| **`argoCdConfig` singleton storage fns (R3/review)** | `server/storage-pg.ts` | ~1662 (get), ~1683 (save), ~1709 (delete) |
| **WS broadcast no ALS context (R3/review)** | `server/ws/manager.ts` | (handlers) |
| k8s deployment | `helm/`, `docker-compose.yml` | present |

*End of ADR-001 — Revision 3 (security & cost review incorporated)*
