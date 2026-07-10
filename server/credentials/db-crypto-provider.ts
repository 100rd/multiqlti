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
import { encrypt, decrypt } from "../crypto.js";
import {
  workspaceConnections,
  workspaces,
  credentialLeases,
  credentialAccessLog,
  secrets,
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
export function assertProject(projectId: string): void {
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
export async function writeAccessLog(entry: {
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

/** Convert a `secrets` vault row to CredentialMetadata. NEVER includes valueEncrypted. */
export function toSecretMetadata(
  row: typeof secrets.$inferSelect,
  projectId: string,
): CredentialMetadata {
  return {
    id: row.id,
    projectId,
    provider: row.provider ?? "vault",
    scope: row.scope ?? "",
    description: row.description ?? "",
    hasSecret: row.valueEncrypted !== null,
    lastRotatedAt: row.rotatedAt ?? row.createdAt,
    name: row.name,
    version: row.version,
  };
}

/** Resolve a vault secret row that belongs to the given project, or null. */
export async function getSecretForProject(
  credentialId: string,
  projectId: string,
): Promise<typeof secrets.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(secrets)
    .where(and(eq(secrets.id, credentialId), eq(secrets.projectId, projectId)));
  return row ?? null;
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

    const connectionMetadata = rows.map((r) => toMetadata(r, projectId));

    const secretRows = await db
      .select()
      .from(secrets)
      .where(eq(secrets.projectId, projectId));
    const secretMetadata = secretRows.map((r) => toSecretMetadata(r, projectId));

    await writeAccessLog({
      credentialId: "*",
      projectId,
      action: "list_metadata",
      requestedBy: projectId,
      success: true,
    });

    return [...connectionMetadata, ...secretMetadata];
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
    const secretRow = row ? null : await getSecretForProject(credentialId, projectId);

    await writeAccessLog({
      credentialId,
      projectId,
      action: "get_metadata",
      requestedBy: projectId,
      success: row !== null || secretRow !== null,
    });

    if (row) return toMetadata(row, projectId);
    if (secretRow) return toSecretMetadata(secretRow, projectId);
    return null;
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

  // ── CREDENTIAL STORE (Secrets Vault, Phase 1) ────────────────────────────────

  /**
   * Create or rotate a vault secret, upserted by (projectId, name).
   *
   * `name` is required — vault secrets are named; connection-backed credentials
   * (workspaceConnections) are managed via the workspace connections API instead.
   * Every call encrypts `secret` and writes it to `valueEncrypted`, bumping
   * `version` and setting `rotatedAt` on update (version starts at 1 on create).
   * Writes a credential_access_log row (action='secret_created'|'secret_rotated').
   */
  async putCredential(p: {
    projectId: string;
    provider: string;
    scope: string;
    description: string;
    secret: string;
    name?: string;
  }): Promise<CredentialMetadata> {
    assertProject(p.projectId);

    if (!p.name) {
      throw new Error(
        "putCredential: `name` is required to create/rotate a vault secret. " +
          "Connection-backed credentials are managed via the workspace connections API.",
      );
    }

    const ciphertext = encrypt(p.secret);
    const existing = await db
      .select()
      .from(secrets)
      .where(and(eq(secrets.projectId, p.projectId), eq(secrets.name, p.name)))
      .then(([row]) => row ?? null);

    const now = new Date();
    const [row] = existing
      ? await db
          .update(secrets)
          .set({
            provider: p.provider,
            scope: p.scope,
            description: p.description,
            valueEncrypted: ciphertext,
            version: existing.version + 1,
            rotatedAt: now,
          })
          .where(eq(secrets.id, existing.id))
          .returning()
      : await db
          .insert(secrets)
          .values({
            projectId: p.projectId,
            name: p.name,
            provider: p.provider,
            scope: p.scope,
            description: p.description,
            valueEncrypted: ciphertext,
            version: 1,
            createdBy: p.projectId,
          })
          .returning();

    await writeAccessLog({
      credentialId: row.id,
      projectId: p.projectId,
      action: existing ? "secret_rotated" : "secret_created",
      requestedBy: p.projectId,
      success: true,
    });

    return toSecretMetadata(row, p.projectId);
  }

  /**
   * Delete a vault secret (project-scoped). Throws if the secret does not
   * exist in this project (no cross-project deletion, no silent no-op).
   * Writes a credential_access_log row (action='secret_deleted').
   */
  async deleteCredential(projectId: string, credentialId: string): Promise<void> {
    assertProject(projectId);

    const existing = await getSecretForProject(credentialId, projectId);
    if (!existing) {
      throw new Error(
        `deleteCredential: secret ${credentialId} not found in project ${projectId}.`,
      );
    }

    await db.delete(secrets).where(eq(secrets.id, credentialId));

    await writeAccessLog({
      credentialId,
      projectId,
      action: "secret_deleted",
      requestedBy: projectId,
      success: true,
    });
  }

  /**
   * Decrypt and return the current value of a vault secret.
   * Writes a credential_access_log row (action='secret_accessed'), including
   * on failure (not-found / decrypt error), mirroring accessSecret's audit
   * discipline. This is a sanctioned crypto.decrypt() call site.
   */
  async getSecretValue(p: {
    projectId: string;
    credentialId: string;
    purpose: string;
    requestedBy?: string;
  }): Promise<string> {
    assertProject(p.projectId);
    const requestedBy = p.requestedBy ?? p.projectId;

    const row = await getSecretForProject(p.credentialId, p.projectId);
    if (!row || row.valueEncrypted === null) {
      await writeAccessLog({
        credentialId: p.credentialId,
        projectId: p.projectId,
        action: "secret_accessed",
        requestedBy,
        justification: p.purpose,
        success: false,
        errorMessage: "secret not found or has no value",
      }).catch((auditErr: unknown) => {
        console.warn("[credential-broker] audit write failed:", auditErr);
      });
      throw new Error(
        `getSecretValue: secret ${p.credentialId} not found in project ${p.projectId}, or has no value.`,
      );
    }

    let plaintext: string;
    try {
      // ─── Sanctioned crypto.decrypt() call site (kept inside db-crypto-provider). ───
      plaintext = decrypt(row.valueEncrypted);
    } catch (e) {
      await writeAccessLog({
        credentialId: p.credentialId,
        projectId: p.projectId,
        action: "secret_accessed",
        requestedBy,
        justification: p.purpose,
        success: false,
        errorMessage: (e as Error).message,
      }).catch((auditErr: unknown) => {
        console.warn(
          "[credential-broker] audit write failed on decrypt error:",
          auditErr,
        );
      });
      throw e;
    }

    await writeAccessLog({
      credentialId: p.credentialId,
      projectId: p.projectId,
      action: "secret_accessed",
      requestedBy,
      justification: p.purpose,
      success: true,
    }).catch((auditErr: unknown) => {
      console.warn("[credential-broker] audit write failed:", auditErr);
    });

    return plaintext;
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

/**
 * Default singleton — import this in Wave-2 wiring.
 *
 * Phase 2 (secrets-manager pluggable backend): the concrete implementation
 * (DbCryptoCredentialProvider vs OpenBaoCredentialProvider) is now selected by
 * `createCredentialProvider` (see factory.ts) based on `config.credentials.backend`.
 * Re-exported here — rather than constructed here — so every existing importer
 * of `credentialProvider` from this module path keeps working unchanged.
 * (This creates an intentional import cycle between db-crypto-provider.ts and
 * factory.ts; safe because DbCryptoCredentialProvider is fully defined, above,
 * before this re-export is evaluated.)
 */
export { credentialProvider } from "./factory.js";
