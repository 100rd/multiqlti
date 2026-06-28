/**
 * Credential Broker types — Phase 1 (ADR-001 §3.2)
 *
 * Two surfaces:
 *   PLAN-TIME  — listCredentials / getCredentialMetadata: metadata only, no secret material.
 *   EXEC-TIME  — issueLease: short-TTL scoped lease, approval + run-state gated, audited.
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

// ─── Provider interface ───────────────────────────────────────────────────────

/**
 * CredentialProvider — the broker interface (ADR-001 §3.2).
 *
 * Hard invariants enforced by every implementation:
 *
 *   [R3-SEC-3] Every public method asserts `projectId === getProjectId()` at entry
 *   and throws ForbiddenError on mismatch.  System context (runAsSystem) causes
 *   getProjectId() to throw, so system-context callers structurally cannot call
 *   any broker method.
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
