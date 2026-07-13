/**
 * deliver-leased-env.ts — ADR-003 Phase 3a.C / 3b exec-time secret delivery.
 *
 * For a consilium loop's bound secrets, issue a short-TTL lease per secret, decrypt
 * its value through the broker, and shape it into its typed delivery form (§D3/§D4):
 *   - static     → an env var keyed by the secret name (today's behavior).
 *   - aws        → the standard AWS_* env vars.
 *   - kubernetes → a per-run 0600 kubeconfig temp file + `KUBECONFIG=<path>`.
 * The caller layers `env` OVER the sanitized allowlist env of a server-controlled
 * subprocess, marks each lease used before spawn, MUST revoke every lease AND call
 * `cleanup()` in a `finally`. `values` feeds the dynamic scrubber (secret-scrub.ts
 * `extraValues`) so leased material (and any kubeconfig temp path) that never sat in
 * process.env is still redacted from run output.
 *
 * Returns an empty delivery when the loop has no bound secrets ⇒ byte-identical. A
 * malformed typed payload drops THAT secret (fail-soft), not the run. On a partial
 * failure it cleans up + revokes what it already issued before rethrowing.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialProvider } from "./types.js";
import type { IStorage } from "../storage.js";
import { shapeTypedSecret, type SecretType } from "./typed-secret.js";

export interface LeasedEnvDelivery {
  /** Env entries to layer OVER the sanitized allowlist. */
  env: Record<string, string>;
  /** Leased raw values (+ any kubeconfig temp path) for the dynamic scrubber. */
  values: string[];
  /** Lease ids the caller MUST revoke in a `finally` (and should markLeaseUsed). */
  leaseIds: string[];
  /**
   * Remove any per-run temp files (e.g. a kubeconfig). The caller MUST call this in
   * its `finally` alongside revoking leases. No-op when nothing was materialized.
   */
  cleanup: () => Promise<void>;
}

function emptyDelivery(): LeasedEnvDelivery {
  return { env: {}, values: [], leaseIds: [], cleanup: async () => undefined };
}

export async function deliverLeasedEnv(p: {
  provider: CredentialProvider;
  storage: Pick<IStorage, "getLoopSecrets">;
  projectId: string;
  loopId: string;
  phase: string;
  requestedBy: string;
  ttlSeconds?: number;
}): Promise<LeasedEnvDelivery> {
  const bound = await p.storage.getLoopSecrets(p.loopId);
  if (bound.length === 0) return emptyDelivery();

  // Resolve credentialId → name + type (METADATA only). A credential deleted since
  // binding resolves to no name and is skipped (defense-in-depth).
  const metadata = await p.provider.listCredentials(p.projectId);
  const nameById = new Map<string, string>();
  const typeById = new Map<string, SecretType>();
  for (const m of metadata) {
    if (m.name) {
      nameById.set(m.id, m.name);
      typeById.set(m.id, m.type ?? "static");
    }
  }

  const env: Record<string, string> = {};
  const values: string[] = [];
  const leaseIds: string[] = [];
  const tempDirs: string[] = [];

  const cleanup = async (): Promise<void> => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  try {
    for (const b of bound) {
      const name = nameById.get(b.credentialId);
      if (!name) continue; // credential removed since binding — nothing to deliver.
      const type = typeById.get(b.credentialId) ?? "static";

      // issueLease enforces D1 (loop state) + D2 (bound set) + rate limit + audit.
      const { leaseId } = await p.provider.issueLease({
        projectId: p.projectId,
        credentialId: b.credentialId,
        loopId: p.loopId,
        phase: p.phase,
        requestedBy: p.requestedBy,
        ttlSeconds: p.ttlSeconds,
      });
      leaseIds.push(leaseId);

      const raw = await p.provider.getSecretValue({
        projectId: p.projectId,
        credentialId: b.credentialId,
        purpose: `consilium-loop:${p.loopId}:${p.phase}`,
        requestedBy: p.requestedBy,
      });

      let shaped;
      try {
        shaped = shapeTypedSecret({ name, type, value: raw });
      } catch (shapeErr: unknown) {
        // Fail-soft: a malformed typed payload drops THIS secret, not the run. Its
        // lease is already issued and is revoked with the rest by the caller/partial-
        // failure path. Message carries the name/type only, never the value.
        console.warn(
          `[credential-broker] typed secret "${name}" (${type}) malformed; skipping:`,
          shapeErr instanceof Error ? shapeErr.message : shapeErr,
        );
        continue;
      }

      Object.assign(env, shaped.env);
      values.push(...shaped.scrubExtra);

      if (shaped.kubeconfig !== undefined) {
        // Per-run kubeconfig in a private 0600 temp dir; KUBECONFIG points at it.
        // The path is scrubbed from output too; cleanup() removes the dir.
        const dir = await mkdtemp(join(tmpdir(), "mq-kubeconfig-"));
        tempDirs.push(dir);
        const path = join(dir, "config");
        await writeFile(path, shaped.kubeconfig, { mode: 0o600 });
        env.KUBECONFIG = path;
        values.push(path);
      }
    }
  } catch (err) {
    await cleanup();
    for (const id of leaseIds) {
      await p.provider.revokeLease(id).catch(() => undefined);
    }
    throw err;
  }

  return { env, values, leaseIds, cleanup };
}
