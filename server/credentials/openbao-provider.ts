/**
 * OpenBaoCredentialProvider — Phase 2 pluggable VALUE store (secrets-manager Phase 2).
 *
 * Secret METADATA (id, projectId, name, description, scope, provider, version,
 * createdBy, createdAt, rotatedAt) still lives in the Postgres `secrets` table —
 * this class WRAPS a DbCryptoCredentialProvider for ALL metadata / lease /
 * non-lease-decrypt / audit operations, and only overrides the vault-secret
 * VALUE read/write/delete path. `valueEncrypted` is always left NULL for
 * openbao-backed rows: the plaintext never touches Postgres.
 *
 * Secret VALUES live in OpenBao (Vault-compatible) KV v2, at:
 *   <mount>/data/<projectId>/<name>          (payload: { data: { value: <secret> } })
 *
 * Auth: `X-Vault-Token` is read from `process.env[tokenEnv]` at call time — the
 * token is NEVER stored in config and NEVER logged. Fail-closed: if `addr` or the
 * token env var is missing, the request is not attempted and a clear error is
 * thrown. SSRF containment: the request origin comes ONLY from operator config
 * (`config.credentials.openbao.addr`); path segments are the already-validated
 * `projectId`/`name` (URI-encoded), never raw pass-through user input.
 *
 * Mirrors the transport discipline of
 * server/services/consilium/trackers/gitlab-exec.ts (AbortController timeout,
 * scrubbed errors, no secret material logged).
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db.js";
import { secrets } from "../../shared/schema.js";
import {
  DbCryptoCredentialProvider,
  assertProject,
  writeAccessLog,
  getSecretForProject,
  toSecretMetadata,
} from "./db-crypto-provider.js";
import type {
  CredentialMetadata,
  CredentialProvider,
  AccessSecretParams,
} from "./types.js";
import type { AppConfig } from "../config/schema.js";

/** Per-call wall-clock budget for an OpenBao request. */
const OPENBAO_TIMEOUT_MS = 15_000;

/** Resolved OpenBao connection settings (addr may be absent → fail-closed). */
export interface OpenBaoConnectionConfig {
  addr?: string;
  mount: string;
  namespace?: string;
  tokenEnv: string;
}

/** Scrub any absolute path + collapse whitespace from an error string, then clamp. */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Read the OpenBao auth token from ENV (fail-closed). NEVER logged by this module. */
function readOpenBaoToken(
  tokenEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const token = (env[tokenEnv] ?? "").trim();
  return token.length > 0 ? token : null;
}

/** Build the KV v2 data path for a project-scoped secret (project/name are pre-validated). */
function kvDataPath(mount: string, projectId: string, name: string): string {
  const cleanMount = mount.replace(/^\/+|\/+$/g, "");
  return `${cleanMount}/data/${encodeURIComponent(projectId)}/${encodeURIComponent(name)}`;
}

/**
 * Minimal hand-rolled OpenBao HTTP client (no `node-vault` dependency).
 * NEVER logs the token or any response body (which may carry secret material).
 * Throws a scrubbed error on network failure / timeout / non-2xx status.
 */
async function openBaoRequest(
  cfg: OpenBaoConnectionConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  if (!cfg.addr) {
    throw new Error(
      "OpenBaoCredentialProvider: credentials.openbao.addr is not configured " +
        "(set MULTI_CREDENTIALS_OPENBAO_ADDR). Fail-closed — request not attempted.",
    );
  }
  const token = readOpenBaoToken(cfg.tokenEnv);
  if (!token) {
    throw new Error(
      `OpenBaoCredentialProvider: auth token missing — set the ${cfg.tokenEnv} ` +
        "environment variable. Fail-closed — request not attempted.",
    );
  }

  // SSRF containment: origin is operator-config-only; `path` is server-derived
  // (URI-encoded projectId/name), never a raw externally-supplied URL/path.
  const url = new URL(`/v1/${path}`, cfg.addr);

  const headers: Record<string, string> = {
    "X-Vault-Token": token,
    "Content-Type": "application/json",
  };
  if (cfg.namespace) {
    headers["X-Vault-Namespace"] = cfg.namespace;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENBAO_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      // NEVER include the token/url query or response text in the thrown error.
      throw new Error(
        `OpenBaoCredentialProvider: request failed: ${scrub((e as Error).message)}`,
      );
    }
    // NEVER log the parsed body — it may contain secret material.
    const json = await res.json().catch(() => null);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `OpenBaoCredentialProvider: OpenBao responded with status ${res.status}`,
      );
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function resolveConnectionConfig(config: AppConfig): OpenBaoConnectionConfig {
  const openbao = config.credentials.openbao;
  return {
    addr: openbao.addr,
    mount: openbao.mount,
    namespace: openbao.namespace,
    tokenEnv: openbao.tokenEnv,
  };
}

export class OpenBaoCredentialProvider implements CredentialProvider {
  private readonly metadataStore: DbCryptoCredentialProvider;
  private readonly connection: OpenBaoConnectionConfig;

  constructor(config: AppConfig) {
    this.metadataStore = new DbCryptoCredentialProvider();
    this.connection = resolveConnectionConfig(config);
  }

  // ── PLAN-TIME (delegate to DB metadata — unchanged) ─────────────────────────

  listCredentials(projectId: string): Promise<CredentialMetadata[]> {
    return this.metadataStore.listCredentials(projectId);
  }

  getCredentialMetadata(
    projectId: string,
    credentialId: string,
  ): Promise<CredentialMetadata | null> {
    return this.metadataStore.getCredentialMetadata(projectId, credentialId);
  }

  // ── NON-LEASE DIRECT ACCESS (delegate — ciphertext path is unaffected) ──────

  accessSecret(params: AccessSecretParams): Promise<string> {
    return this.metadataStore.accessSecret(params);
  }

  // ── EXEC-TIME lease ops (delegate — leases are Postgres-backed either way) ───

  issueLease(p: {
    projectId: string;
    credentialId: string;
    loopId: string;
    phase: string;
    requestedBy: string;
    ttlSeconds?: number;
    justification?: string;
  }): Promise<{ leaseId: string; expiresAt: Date }> {
    return this.metadataStore.issueLease(p);
  }

  revokeLease(leaseId: string): Promise<void> {
    return this.metadataStore.revokeLease(leaseId);
  }

  revokeRunLeases(runId: string): Promise<void> {
    return this.metadataStore.revokeRunLeases(runId);
  }

  // ── CREDENTIAL STORE (override VALUE path — OpenBao KV v2) ──────────────────

  /**
   * Create or rotate a vault secret. Writes the plaintext value to OpenBao KV v2
   * FIRST (fail before touching Postgres), then upserts a METADATA-only row in
   * `secrets` (valueEncrypted stays NULL). Writes the same credential_access_log
   * audit row as DbCryptoCredentialProvider.putCredential.
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

    await openBaoRequest(
      this.connection,
      "POST",
      kvDataPath(this.connection.mount, p.projectId, p.name),
      { data: { value: p.secret } },
    );

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
            valueEncrypted: null,
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
            valueEncrypted: null,
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
   * Delete a vault secret (project-scoped): deletes the OpenBao KV v2 value,
   * then the metadata row. Throws if the secret does not exist in this project.
   * Writes the same credential_access_log audit row as
   * DbCryptoCredentialProvider.deleteCredential.
   */
  async deleteCredential(projectId: string, credentialId: string): Promise<void> {
    assertProject(projectId);

    const existing = await getSecretForProject(credentialId, projectId);
    if (!existing) {
      throw new Error(
        `deleteCredential: secret ${credentialId} not found in project ${projectId}.`,
      );
    }

    await openBaoRequest(
      this.connection,
      "DELETE",
      kvDataPath(this.connection.mount, projectId, existing.name),
    );

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
   * Read the current value of a vault secret from OpenBao KV v2 (no
   * crypto.decrypt() call — the value arrives as plaintext over TLS). Writes
   * the same credential_access_log audit row as
   * DbCryptoCredentialProvider.getSecretValue, including on failure.
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
    if (!row) {
      await writeAccessLog({
        credentialId: p.credentialId,
        projectId: p.projectId,
        action: "secret_accessed",
        requestedBy,
        justification: p.purpose,
        success: false,
        errorMessage: "secret not found",
      }).catch((auditErr: unknown) => {
        console.warn("[credential-broker] audit write failed:", auditErr);
      });
      throw new Error(
        `getSecretValue: secret ${p.credentialId} not found in project ${p.projectId}.`,
      );
    }

    try {
      const { json } = await openBaoRequest(
        this.connection,
        "GET",
        kvDataPath(this.connection.mount, p.projectId, row.name),
      );
      const value = (json as { data?: { data?: { value?: unknown } } } | null)?.data?.data
        ?.value;
      if (typeof value !== "string") {
        throw new Error("OpenBao KV response missing data.data.value");
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

      return value;
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
          "[credential-broker] audit write failed on OpenBao read error:",
          auditErr,
        );
      });
      throw e;
    }
  }
}
