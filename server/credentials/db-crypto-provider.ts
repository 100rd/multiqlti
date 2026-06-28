/**
 * DbCryptoCredentialProvider — Phase 1 broker implementation (ADR-001 §3.2).
 *
 * Credential SOURCE: `workspaceConnections` table.
 * Each workspace connection that has `secretsEncrypted !== null` is a credential.
 * Project scoping is resolved by joining with `workspaces` (which carries projectId).
 *
 * Hardened contract [ADR-001 §3.2]:
 *   [R3-SEC-2] issueLease reads approvalStatus + run.status from DB; throws ForbiddenError.
 *   [R3-SEC-3] Every public method asserts projectId === getProjectId() at entry.
 *   [R3-SEC-10] issueLease rate-limited per (projectId, runId); lease_used emitted by
 *               markLeaseUsed() helper (called by the Wave-2 pipeline controller).
 *
 * Expiry sweeper: expireStaleLeases() is exported for Wave-2 scheduling.
 * markLeaseUsed():  exported for Wave-2 to call immediately before spawnBuiltinServer.
 *
 * NOT wired into the pipeline controller yet — that is Wave 2.
 */

import { eq, and, lt } from "drizzle-orm";
import { db } from "../db.js";
import { getProjectId } from "../context.js";
import { decrypt } from "../crypto.js";
import {
  workspaceConnections,
  workspaces,
  pipelineRuns,
  stageExecutions,
  credentialLeases,
  credentialAccessLog,
} from "../../shared/schema.js";
import type {
  CredentialMetadata,
  CredentialLease,
  CredentialProvider,
  CredentialSecret,
} from "./types.js";
import { ForbiddenError } from "./types.js";

// ─── Rate limiting ────────────────────────────────────────────────────────────
//
// In-memory, process-local.  Sufficient for Wave 1.  A process restart clears the
// window — the DB-level sweeper is the authoritative backstop.
//
// Limits: max RATE_LIMIT_MAX lease requests per (projectId, runId) within
// RATE_LIMIT_WINDOW_MS.  Exceeding throws ForbiddenError so a compromised agent
// cannot burst-issue credentials.

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10;           // 10 leases per (projectId, runId) per window

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const _rateLimitStore = new Map<string, RateLimitEntry>();

/** Exported for test reset between cases. */
export function _resetRateLimitStore(): void {
  _rateLimitStore.clear();
}

function checkRateLimit(projectId: string, runId: string): void {
  const key = `${projectId}:${runId}`;
  const now = Date.now();
  const entry = _rateLimitStore.get(key);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    _rateLimitStore.set(key, { count: 1, windowStart: now });
    return;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    throw new ForbiddenError(
      `Rate limit exceeded: too many lease requests for runId=${runId} in project ${projectId}. ` +
        `Max ${RATE_LIMIT_MAX} per ${RATE_LIMIT_WINDOW_MS / 1000}s window.`,
    );
  }

  entry.count++;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Asserts that the provided projectId matches the current ALS context.
 * Throws ForbiddenError on mismatch.
 * getProjectId() already throws in system context and when context is absent —
 * those errors propagate as-is (they are also security barriers).
 */
function assertProject(projectId: string): void {
  const ctx = getProjectId();
  if (ctx !== projectId) {
    throw new ForbiddenError(
      `Context projectId (${ctx}) does not match provided projectId (${projectId}). ` +
        "Cross-project credential access is forbidden.",
    );
  }
}

/**
 * Write one row to credential_access_log.  Uses db directly (no withProject) so
 * it works both from project-context methods and from the system-scoped sweeper.
 */
async function writeAccessLog(entry: {
  leaseId?: string | null;
  credentialId: string;
  projectId: string;
  runId?: string | null;
  stageId?: string | null;
  action: typeof credentialAccessLog.$inferInsert["action"];
  requestedBy: string;
  justification?: string | null;
  success: boolean;
  errorMessage?: string | null;
  ttlSeconds?: number | null;
}): Promise<void> {
  await db.insert(credentialAccessLog).values({
    leaseId: entry.leaseId ?? null,
    credentialId: entry.credentialId,
    projectId: entry.projectId,
    runId: entry.runId ?? null,
    stageId: entry.stageId ?? null,
    action: entry.action,
    requestedBy: entry.requestedBy,
    justification: entry.justification ?? null,
    success: entry.success,
    errorMessage: entry.errorMessage ?? null,
    ttlSeconds: entry.ttlSeconds ?? null,
  });
}

/**
 * Resolve a workspace connection that belongs to the given project.
 * Returns null if not found or if the connection's workspace belongs to a
 * different project (project-isolation check in the query itself).
 */
async function getConnectionForProject(
  credentialId: string,
  projectId: string,
): Promise<typeof workspaceConnections.$inferSelect | null> {
  // JOIN workspace_connections → workspaces to verify project ownership.
  // workspaceConnections has no direct projectId column; projectId lives on workspaces.
  const [row] = await db
    .select({
      id: workspaceConnections.id,
      workspaceId: workspaceConnections.workspaceId,
      type: workspaceConnections.type,
      name: workspaceConnections.name,
      configJson: workspaceConnections.configJson,
      secretsEncrypted: workspaceConnections.secretsEncrypted,
      status: workspaceConnections.status,
      lastTestedAt: workspaceConnections.lastTestedAt,
      createdAt: workspaceConnections.createdAt,
      updatedAt: workspaceConnections.updatedAt,
      createdBy: workspaceConnections.createdBy,
    })
    .from(workspaceConnections)
    .innerJoin(workspaces, eq(workspaces.id, workspaceConnections.workspaceId))
    .where(
      and(
        eq(workspaceConnections.id, credentialId),
        eq(workspaces.projectId, projectId),
      ),
    );

  return row ?? null;
}

/** Convert a workspace connection row to CredentialMetadata. */
function toMetadata(
  row: typeof workspaceConnections.$inferSelect,
  projectId: string,
): CredentialMetadata {
  return {
    id: row.id,
    projectId,
    provider: row.type,
    scope: row.workspaceId,
    description: row.name,
    hasSecret: row.secretsEncrypted !== null,
    lastRotatedAt: row.updatedAt,
  };
}

// ─── DbCryptoCredentialProvider ───────────────────────────────────────────────

export class DbCryptoCredentialProvider implements CredentialProvider {
  // ── PLAN-TIME ───────────────────────────────────────────────────────────────

  /**
   * List all workspace connections for the project.
   * Writes a credential_access_log row per call (action='list_metadata').
   * NEVER returns secret material — only CredentialMetadata.
   */
  async listCredentials(projectId: string): Promise<CredentialMetadata[]> {
    assertProject(projectId);

    const rows = await db
      .select({
        id: workspaceConnections.id,
        workspaceId: workspaceConnections.workspaceId,
        type: workspaceConnections.type,
        name: workspaceConnections.name,
        configJson: workspaceConnections.configJson,
        secretsEncrypted: workspaceConnections.secretsEncrypted,
        status: workspaceConnections.status,
        lastTestedAt: workspaceConnections.lastTestedAt,
        createdAt: workspaceConnections.createdAt,
        updatedAt: workspaceConnections.updatedAt,
        createdBy: workspaceConnections.createdBy,
      })
      .from(workspaceConnections)
      .innerJoin(workspaces, eq(workspaces.id, workspaceConnections.workspaceId))
      .where(eq(workspaces.projectId, projectId));

    const metadata = rows.map((r) => toMetadata(r, projectId));

    await writeAccessLog({
      credentialId: "*",
      projectId,
      action: "list_metadata",
      requestedBy: projectId,
      success: true,
    });

    return metadata;
  }

  /**
   * Get metadata for a single workspace connection.
   * Returns null if not found or if it belongs to a different project.
   * NEVER returns secret material.
   */
  async getCredentialMetadata(
    projectId: string,
    credentialId: string,
  ): Promise<CredentialMetadata | null> {
    assertProject(projectId);

    const row = await getConnectionForProject(credentialId, projectId);

    await writeAccessLog({
      credentialId,
      projectId,
      action: "get_metadata",
      requestedBy: projectId,
      success: row !== null,
    });

    return row ? toMetadata(row, projectId) : null;
  }

  // ── EXEC-TIME ───────────────────────────────────────────────────────────────

  /**
   * Issue a short-TTL credential lease.
   *
   * Enforcement order (ALL must pass before any secret is decrypted):
   *   1. [R3-SEC-3] projectId === getProjectId()
   *   2. [R3-SEC-10] Rate limit (projectId, runId)
   *   3. [R3-SEC-2] stage_executions.approvalStatus === 'approved'
   *   4. [R3-SEC-2] pipeline_runs.status === 'running'
   *   5. Credential exists in project
   *   6. Credential has a secret
   *
   * Writes credential_leases row + credential_access_log(action='lease_issued').
   */
  async issueLease(p: {
    projectId: string;
    credentialId: string;
    runId: string;
    stageId: string;
    ttlSeconds?: number;
    requestedBy: string;
    justification?: string;
  }): Promise<CredentialLease> {
    // [R3-SEC-3] Context assertion — FIRST, before any DB access.
    assertProject(p.projectId);

    // [R3-SEC-10] Rate limit — SECOND, before expensive DB reads.
    checkRateLimit(p.projectId, p.runId);

    // [R3-SEC-2] Check stage execution approval status.
    // Look up by stage execution ID AND runId to prevent cross-run confusion.
    const [stageExec] = await db
      .select()
      .from(stageExecutions)
      .where(
        and(
          eq(stageExecutions.id, p.stageId),
          eq(stageExecutions.runId, p.runId),
          eq(stageExecutions.projectId, p.projectId),
        ),
      );

    if (!stageExec) {
      const msg =
        `Stage execution ${p.stageId} not found for run ${p.runId} ` +
        `in project ${p.projectId}`;
      await writeAccessLog({
        credentialId: p.credentialId,
        projectId: p.projectId,
        runId: p.runId,
        stageId: p.stageId,
        action: "lease_issued",
        requestedBy: p.requestedBy,
        justification: p.justification,
        success: false,
        errorMessage: msg,
      });
      throw new ForbiddenError(msg);
    }

    if (stageExec.approvalStatus !== "approved") {
      const msg =
        `Stage ${p.stageId} is not approved ` +
        `(approvalStatus=${stageExec.approvalStatus ?? "null"})`;
      await writeAccessLog({
        credentialId: p.credentialId,
        projectId: p.projectId,
        runId: p.runId,
        stageId: p.stageId,
        action: "lease_issued",
        requestedBy: p.requestedBy,
        justification: p.justification,
        success: false,
        errorMessage: msg,
      });
      throw new ForbiddenError(msg);
    }

    // [R3-SEC-2] Check pipeline run status.
    const [run] = await db
      .select()
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.id, p.runId),
          eq(pipelineRuns.projectId, p.projectId),
        ),
      );

    if (!run) {
      const msg = `Pipeline run ${p.runId} not found in project ${p.projectId}`;
      await writeAccessLog({
        credentialId: p.credentialId,
        projectId: p.projectId,
        runId: p.runId,
        stageId: p.stageId,
        action: "lease_issued",
        requestedBy: p.requestedBy,
        justification: p.justification,
        success: false,
        errorMessage: msg,
      });
      throw new ForbiddenError(msg);
    }

    if (run.status !== "running") {
      const msg =
        `Pipeline run ${p.runId} is not in 'running' state ` +
        `(status=${run.status})`;
      await writeAccessLog({
        credentialId: p.credentialId,
        projectId: p.projectId,
        runId: p.runId,
        stageId: p.stageId,
        action: "lease_issued",
        requestedBy: p.requestedBy,
        justification: p.justification,
        success: false,
        errorMessage: msg,
      });
      throw new ForbiddenError(msg);
    }

    // Get the credential (workspace connection), verify it belongs to this project.
    const conn = await getConnectionForProject(p.credentialId, p.projectId);

    if (!conn) {
      const msg =
        `Credential ${p.credentialId} not found in project ${p.projectId}`;
      await writeAccessLog({
        credentialId: p.credentialId,
        projectId: p.projectId,
        runId: p.runId,
        stageId: p.stageId,
        action: "lease_issued",
        requestedBy: p.requestedBy,
        justification: p.justification,
        success: false,
        errorMessage: msg,
      });
      throw new ForbiddenError(msg);
    }

    if (!conn.secretsEncrypted) {
      const msg = `Credential ${p.credentialId} has no secret`;
      await writeAccessLog({
        credentialId: p.credentialId,
        projectId: p.projectId,
        runId: p.runId,
        stageId: p.stageId,
        action: "lease_issued",
        requestedBy: p.requestedBy,
        justification: p.justification,
        success: false,
        errorMessage: msg,
      });
      throw new Error(msg);
    }

    // Decrypt — only here, after all checks have passed.
    const secrets: Record<string, string> = JSON.parse(
      decrypt(conn.secretsEncrypted),
    );

    // Compute TTL: default 300 s, max 900 s.
    const ttl = Math.min(p.ttlSeconds ?? 300, 900);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    // Persist the lease row.
    const [leaseRow] = await db
      .insert(credentialLeases)
      .values({
        credentialId: p.credentialId,
        projectId: p.projectId,
        runId: p.runId,
        stageId: p.stageId,
        requestedBy: p.requestedBy,
        issuedAt: now,
        expiresAt,
        status: "active",
      })
      .returning();

    // Audit: lease_issued.
    await writeAccessLog({
      leaseId: leaseRow.id,
      credentialId: p.credentialId,
      projectId: p.projectId,
      runId: p.runId,
      stageId: p.stageId,
      action: "lease_issued",
      requestedBy: p.requestedBy,
      justification: p.justification,
      success: true,
      ttlSeconds: ttl,
    });

    // Build the static secret — Wave 1 serialises the entire secrets map.
    // Wave 2 pipeline controller parses it back before passing to spawnBuiltinServer.
    const secret: CredentialSecret = {
      type: "static",
      value: JSON.stringify(secrets),
    };

    return {
      leaseId: leaseRow.id,
      credentialId: p.credentialId,
      projectId: p.projectId,
      runId: p.runId,
      stageId: p.stageId,
      issuedAt: now,
      expiresAt,
      secret,
    };
  }

  /**
   * Revoke a single lease by ID.
   * Idempotent — no-op (no error) when already revoked.
   */
  async revokeLease(leaseId: string): Promise<void> {
    const projectId = getProjectId(); // [R3-SEC-3] throws in system context

    const [lease] = await db
      .select()
      .from(credentialLeases)
      .where(eq(credentialLeases.id, leaseId));

    if (!lease) {
      throw new Error(`Lease ${leaseId} not found`);
    }

    // [R3-SEC-3] Verify lease belongs to current project.
    if (lease.projectId !== projectId) {
      throw new ForbiddenError(
        `Lease ${leaseId} belongs to project ${lease.projectId}, ` +
          `not ${projectId}. Cross-project revocation is forbidden.`,
      );
    }

    // Idempotent: already revoked → do nothing.
    if (lease.status !== "active") return;

    await db
      .update(credentialLeases)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(credentialLeases.id, leaseId));

    await writeAccessLog({
      leaseId,
      credentialId: lease.credentialId,
      projectId,
      runId: lease.runId,
      stageId: lease.stageId,
      action: "lease_revoked",
      requestedBy: projectId,
      success: true,
    });
  }

  /**
   * Revoke all active leases for a run, scoped to the current project.
   * Safe to call in a `finally` block — must not throw when no active leases exist
   * or when leases are already revoked.
   */
  async revokeRunLeases(runId: string): Promise<void> {
    const projectId = getProjectId(); // [R3-SEC-3] throws in system context

    // Find all active leases for this run in this project.
    const activeLeases = await db
      .select()
      .from(credentialLeases)
      .where(
        and(
          eq(credentialLeases.runId, runId),
          eq(credentialLeases.projectId, projectId),
          eq(credentialLeases.status, "active"),
        ),
      );

    if (activeLeases.length === 0) return;

    await db
      .update(credentialLeases)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(
        and(
          eq(credentialLeases.runId, runId),
          eq(credentialLeases.projectId, projectId),
          eq(credentialLeases.status, "active"),
        ),
      );

    for (const lease of activeLeases) {
      await writeAccessLog({
        leaseId: lease.id,
        credentialId: lease.credentialId,
        projectId,
        runId,
        stageId: lease.stageId,
        action: "lease_revoked",
        requestedBy: projectId,
        success: true,
      });
    }
  }

  // ── CREDENTIAL STORE ─────────────────────────────────────────────────────────

  /**
   * putCredential — not implemented in Wave 1.
   *
   * The `workspaceConnections` store requires a `workspaceId` that the broker
   * interface does not carry.  This method will be fully implemented in Wave 2
   * when the Vault backend (which has its own key-value store) is wired in.
   *
   * Callers who need to create workspace connections should use the workspace
   * connections API directly (POST /api/workspaces/:id/connections).
   */
  async putCredential(_p: {
    projectId: string;
    provider: string;
    scope: string;
    description: string;
    secret: string;
  }): Promise<CredentialMetadata> {
    throw new Error(
      "putCredential is not implemented in Wave 1. " +
        "Use the workspace connections API to create credentials. " +
        "This method will be implemented in Wave 2 (Vault backend).",
    );
  }

  /**
   * deleteCredential — not implemented in Wave 1.
   * Use the workspace connections DELETE endpoint instead.
   */
  async deleteCredential(_projectId: string, _credentialId: string): Promise<void> {
    throw new Error(
      "deleteCredential is not implemented in Wave 1. " +
        "Use the workspace connections API to delete credentials. " +
        "This method will be implemented in Wave 2 (Vault backend).",
    );
  }
}

// ─── Standalone exports for Wave-2 scheduling ─────────────────────────────────

/**
 * Mark a lease as used immediately before spawnBuiltinServer is called.
 * Called by the Wave-2 pipeline controller — NOT by the broker itself.
 *
 * Writes credential_access_log(action='lease_used').
 * Does NOT require an ALS context (the leaseId carries projectId).
 */
export async function markLeaseUsed(
  leaseId: string,
  requestedBy: string,
): Promise<void> {
  const [lease] = await db
    .select()
    .from(credentialLeases)
    .where(eq(credentialLeases.id, leaseId));

  if (!lease) {
    throw new Error(
      `markLeaseUsed: lease ${leaseId} not found`,
    );
  }

  await writeAccessLog({
    leaseId,
    credentialId: lease.credentialId,
    projectId: lease.projectId,
    runId: lease.runId,
    stageId: lease.stageId,
    action: "lease_used",
    requestedBy,
    success: true,
  });
}

/**
 * Expiry sweeper — marks all active leases where expiresAt < now() as 'expired'.
 * Backend-independent: pure DB timestamp comparison, no Vault calls.
 *
 * Designed to be scheduled by the Wave-2 pipeline controller (e.g. setInterval
 * or a BullMQ job).  Do NOT call setInterval here.
 *
 * Wraps the caller in runAsSystem if cross-project context is required;
 * this function uses db directly (no withProject) so it works in any context.
 *
 * Returns the number of leases that were expired.
 */
export async function expireStaleLeases(): Promise<number> {
  const now = new Date();

  const expired = await db
    .update(credentialLeases)
    .set({ status: "expired", revokedAt: now })
    .where(
      and(
        eq(credentialLeases.status, "active"),
        lt(credentialLeases.expiresAt, now),
      ),
    )
    .returning();

  // Write audit log for each expired lease.
  for (const lease of expired) {
    await writeAccessLog({
      leaseId: lease.id,
      credentialId: lease.credentialId,
      projectId: lease.projectId,
      runId: lease.runId,
      stageId: lease.stageId,
      action: "lease_expired",
      requestedBy: "system-sweeper",
      success: true,
    });
  }

  return expired.length;
}

// ─── Singleton export ─────────────────────────────────────────────────────────

/** Default singleton — import this in Wave-2 wiring. */
export const credentialProvider: CredentialProvider = new DbCryptoCredentialProvider();
