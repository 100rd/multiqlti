/**
 * Credential Broker types — Phase 1 (ADR-001 §3.2)
 *
 * Two surfaces:
 *   PLAN-TIME  — listCredentials / getCredentialMetadata: metadata only, no secret material.
 *   EXEC-TIME  — issueLease: short-TTL scoped lease, approval + run-state gated, audited.
 *
 * Wave 2 adds:
 *   NON-LEASE  — accessSecret: direct decrypt with project-scope + audit, no lease gating.
 *                Routes ALL crypto.decrypt() calls outside db-crypto-provider.ts through
 *                the broker.  After Wave 2, crypto.decrypt() is called only inside
 *                db-crypto-provider.ts.
 *
 * CredentialSecret is discriminated by `type`.  Wave 1 only produces `static`.
 * `aws-sts` and `github-app-token` variants are reserved for Wave 2 (Vault backend).
 */

// ─── Error types ─────────────────────────────────────────────────────────────

/** Thrown when an operation is denied due to project context mismatch,
 *  unapproved stage, non-running pipeline run, or rate-limit breach. */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

// ─── Plan-time shape ─────────────────────────────────────────────────────────

/**
 * Public metadata for a credential.  Never contains secret material.
 * Mirrors the `hasSecrets` convention from `workspaceConnections`.
 *
 * [R3-SEC-3] listCredentials / getCredentialMetadata MUST only return this shape —
 * never the decrypted secret.
 */
export interface CredentialMetadata {
  /** Corresponds to workspaceConnections.id — the ID passed to issueLease. */
  id: string;
  /** Project that owns this credential. */
  projectId: string;
  /** Connection type — e.g. "github", "kubernetes", "gitlab". */
  provider: string;
  /** Workspace ID the connection belongs to (scope hint for the caller). */
  scope: string;
  /** Human-readable name of the workspace connection. */
  description: string;
  /** True when secretsEncrypted IS NOT NULL for the underlying connection. */
  hasSecret: boolean;
  /** Last time the connection (and thus its secrets) was updated. */
  lastRotatedAt?: Date;
}

// ─── Exec-time shapes ────────────────────────────────────────────────────────

/**
 * Discriminated union of secret variants.
 *
 * Wave 1: only `static` is produced by DbCryptoCredentialProvider.
 * Wave 2: `aws-sts` and `github-app-token` are produced by VaultCredentialProvider.
 *
 * The `value` field in `static` contains the JSON-serialised Record<string,string>
 * of all decrypted secrets from the workspace connection.  The pipeline controller
 * (Wave 2) parses it back to pass to spawnBuiltinServer.
 */
export type CredentialSecret =
  | { type: "static"; value: string }
  | {
      type: "aws-sts";
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken: string;
      region?: string;
    }
  | { type: "github-app-token"; token: string; expiresAt: Date };

/**
 * A short-TTL credential lease.  The `secret` field ONLY appears here, never in
 * CredentialMetadata.  The caller MUST NOT store or log `secret` after handing
 * it to spawnBuiltinServer.
 */
export interface CredentialLease {
  leaseId: string;
  credentialId: string;
  projectId: string;
  runId: string;
  stageId: string;
  issuedAt: Date;
  expiresAt: Date;
  /** Secret material — do not persist or log. */
  secret: CredentialSecret;
}

// ─── Non-lease access shape (Wave 2) ─────────────────────────────────────────

/**
 * Parameters for accessSecret — the non-lease, direct-decrypt surface.
 *
 * accessSecret is the SYSTEM/non-run analogue of issueLease.  It has no approval
 * or run-state gate.  Every call writes a credential_access_log row
 * (action='secret_accessed') unless projectId is empty (legacy row).
 *
 * Context rules:
 *   - Project context (getProjectId() returns a string): asserts
 *     params.projectId === getProjectId() before decrypting.
 *   - System context (requestContext.getStore()?.system === true): skips
 *     the project assertion.  The caller must pass the correct projectId for audit.
 *   - No ALS context at all: throws — requires runAsProject or runAsSystem.
 */
export interface AccessSecretParams {
  /** Pre-fetched ciphertext to decrypt. */
  ciphertext: string;
  /** Logical credential ID for the audit log (not a DB foreign key — can be any
   *  stable identifier like "trackerConn:<id>" or "providerKey:<provider>"). */
  credentialId: string;
  /** Project that owns this credential.  Empty string skips the audit log (legacy rows). */
  projectId: string;
  /** Human-readable purpose for the audit log. */
  purpose: string;
  /** Optional override for the requestedBy audit field.  Defaults to projectId or "system". */
  requestedBy?: string;
}

// ─── Provider interface ───────────────────────────────────────────────────────

/**
 * CredentialProvider — the broker interface (ADR-001 §3.2).
 *
 * Hard invariants enforced by every implementation:
 *
 *   [R3-SEC-3] Every public method asserts `projectId === getProjectId()` at entry
 *   and throws ForbiddenError on mismatch.  System context (runAsSystem) causes
 *   getProjectId() to throw, so system-context callers structurally cannot call
 *   issueLease or lease-management methods.
 *
 *   accessSecret is the exception: it accepts BOTH project and system context,
 *   enforcing project assertion only in project context and skipping it in system
 *   context (while still auditing the access).
 *
 *   [R3-SEC-2] issueLease reads stage_executions.approvalStatus === 'approved' AND
 *   pipeline_runs.status === 'running' from the DB and throws ForbiddenError
 *   otherwise.  The approval gate is a broker invariant, not a caller convention.
 *
 *   [R3-SEC-10] issueLease is rate-limited per (projectId, runId).
 */
export interface CredentialProvider {
  // ── PLAN-TIME ─────────────────────────────────────────────────────────────

  /** Returns metadata for all credentials in the project.  Never decrypts. */
  listCredentials(projectId: string): Promise<CredentialMetadata[]>;

  /** Returns metadata for a single credential, or null if not found.  Never decrypts. */
  getCredentialMetadata(
    projectId: string,
    credentialId: string,
  ): Promise<CredentialMetadata | null>;

  // ── NON-LEASE DIRECT ACCESS (Wave 2) ──────────────────────────────────────

  /**
   * Decrypt a pre-fetched ciphertext and write a credential_access_log row
   * (action='secret_accessed').
   *
   * Context behaviour:
   *   - Project context: asserts params.projectId === getProjectId() before decrypting.
   *     The DB query that fetched the ciphertext must already be scoped via withProject.
   *   - System context: skips the project assertion (getProjectId() would throw).
   *     The caller is responsible for passing the correct projectId for audit.
   *
   * This is the SYSTEM/non-run analogue of issueLease — no approval/run gating but
   * always project- or system-scoped and always audited.
   *
   * After Wave 2, the ONLY place crypto.decrypt() may be called is INSIDE the broker
   * (DbCryptoCredentialProvider.accessSecret) and rekey/migration scripts.
   * Add a CI-grep check to enforce this: no decrypt() outside credentials/ and scripts/.
   */
  accessSecret(params: AccessSecretParams): Promise<string>;

  // ── EXEC-TIME ─────────────────────────────────────────────────────────────

  /**
   * Issue a short-TTL credential lease.
   *
   * Enforces internally:
   *   - stage_executions.approvalStatus === 'approved'
   *   - pipeline_runs.status === 'running'
   *   - rate-limit per (projectId, runId)
   *
   * Writes credential_leases row + credential_access_log(action='lease_issued').
   * TTL default 300 s, max 900 s.
   */
  issueLease(p: {
    projectId: string;
    credentialId: string;
    runId: string;
    stageId: string;
    ttlSeconds?: number;
    requestedBy: string;
    justification?: string;
  }): Promise<CredentialLease>;

  /** Mark a lease revoked.  No-op if already revoked (idempotent). */
  revokeLease(leaseId: string): Promise<void>;

  /**
   * Revoke all active leases for a run.  Safe to call in a `finally` block —
   * must NOT throw when no active leases exist or when leases are already revoked.
   */
  revokeRunLeases(runId: string): Promise<void>;

  // ── CREDENTIAL STORE ──────────────────────────────────────────────────────

  /** Create or update a credential for the project (project-scoped write). */
  putCredential(p: {
    projectId: string;
    provider: string;
    scope: string;
    description: string;
    secret: string;
  }): Promise<CredentialMetadata>;

  /** Delete a credential for the project (project-scoped write). */
  deleteCredential(projectId: string, credentialId: string): Promise<void>;
}
