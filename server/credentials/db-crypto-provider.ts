/**
 * DbCryptoCredentialProvider — Phase 1 broker implementation (ADR-001 §3.2).
 *
 * Credential SOURCE: `workspaceConnections` table.
 * Each workspace connection that has `secretsEncrypted !== null` is a credential.
 * Project scoping is resolved by joining with `workspaces` (which carries projectId).
 *
 * Hardened contract [ADR-001 §3.2]:
 *   [R3-SEC-3] Every public method asserts projectId === getProjectId() at entry.
 *
 * Expiry sweeper: expireStaleLeases() is exported for scheduling.
 * markLeaseUsed(): exported for a caller to invoke immediately before spawnBuiltinServer.
 */

import { eq, and, lt } from "drizzle-orm";
import { db } from "../db.js";
import { getProjectId, requestContext } from "../context.js";
import { decrypt } from "../crypto.js";
import {
  workspaceConnections,
  workspaces,
  credentialLeases,
  credentialAccessLog,
} from "../../shared/schema.js";
import type {
  CredentialMetadata,
  CredentialProvider,
  AccessSecretParams,
} from "./types.js";
import { ForbiddenError } from "./types.js";

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

  // ── NON-LEASE DIRECT ACCESS (Wave 2, ADR-001 PR-1d) ────────────────────────────

  /**
   * Decrypt a pre-fetched ciphertext and write a credential_access_log row
   * (action='secret_accessed').
   *
   * Context behaviour:
   *   - Project context (getProjectId() returns a string): asserts
   *     params.projectId === getProjectId() before decrypting.
   *   - System context (requestContext.getStore()?.system === true): skips the
   *     project assertion; getProjectId() would throw in system context.
   *     The caller supplies the credential's projectId for the audit row.
   *   - No ALS context at all: throws — requires runAsProject or runAsSystem.
   *
   * If params.projectId is empty (legacy row without projectId), the audit row is
   * skipped with a console warning and the plaintext is still returned.
   *
   * After Wave 2 this is the ONLY permitted path to crypto.decrypt() outside of
   * rekey/migration scripts.  A CI grep enforces this:
   *   grep -rn "decrypt(" server/ | grep -v credentials/db-crypto-provider | grep -v scripts/
   * must return nothing.
   */
  async accessSecret(params: AccessSecretParams): Promise<string> {
    const ctx = requestContext.getStore();

    if (!ctx) {
      throw new Error(
        "accessSecret requires an ALS context. " +
          "Wrap the caller in runAsProject(projectId, fn) or runAsSystem(reason, fn).",
      );
    }

    if (!ctx.system) {
      // Project context: enforce that provided projectId matches the current context.
      // assertProject throws ForbiddenError on mismatch (and if context has no projectId).
      assertProject(params.projectId);
    }
    // System context: skip the project assertion — getProjectId() throws in system context.
    // The caller (always a runAsSystem-wrapped function) must pass the correct projectId.

    const requestedBy =
      params.requestedBy ??
      (ctx.system ? "system" : (ctx.projectId ?? params.projectId));

    let plaintext: string;
    try {
      // ─── The ONLY permitted crypto.decrypt() call outside rekey/migration scripts. ───
      plaintext = decrypt(params.ciphertext);
    } catch (e) {
      // Best-effort audit on decrypt failure.
      if (params.projectId) {
        await writeAccessLog({
          credentialId: params.credentialId,
          projectId: params.projectId,
          action: "secret_accessed",
          requestedBy,
          justification: params.purpose,
          success: false,
          errorMessage: (e as Error).message,
        }).catch((auditErr: unknown) => {
          console.warn(
            "[credential-broker] audit write failed on decrypt error:",
            auditErr,
          );
        });
      }
      throw e;
    }

    // Write the audit row.
    if (params.projectId) {
      await writeAccessLog({
        credentialId: params.credentialId,
        projectId: params.projectId,
        action: "secret_accessed",
        requestedBy,
        justification: params.purpose,
        success: true,
      }).catch((auditErr: unknown) => {
        console.warn("[credential-broker] audit write failed:", auditErr);
      });
    } else {
      console.warn(
        "[credential-broker] accessSecret: no projectId for credential " +
          params.credentialId +
          " — audit log skipped (legacy unscoped row). Purpose: " +
          params.purpose,
      );
    }

    return plaintext;
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
