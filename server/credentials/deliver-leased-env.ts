/**
 * deliver-leased-env.ts — ADR-003 Phase 3a.C exec-time secret delivery helper.
 *
 * For a consilium loop's bound secrets, issue a short-TTL lease per secret,
 * decrypt its value through the broker, and shape an env map keyed by the secret
 * NAME (a STATIC raw string — typed AWS/Kubernetes shaping is Phase 3b). The
 * caller layers `env` OVER the sanitized allowlist env of a server-controlled
 * subprocess (the dev coder / built-in MCP server), marks each lease used before
 * spawn, and MUST revoke every lease in a `finally`. `values` feeds the dynamic
 * scrubber (secret-scrub.ts `extraValues`) so a leased value that never sat in
 * this server's process.env is still redacted from the run's output.
 *
 * Returns empty ({}, [], []) when the loop has no bound secrets ⇒ the caller's
 * spawn path is byte-identical to today. On a partial failure it revokes the
 * leases it already issued before rethrowing, so no active lease is orphaned.
 */
import type { CredentialProvider } from "./types.js";
import type { IStorage } from "../storage.js";

export interface LeasedEnvDelivery {
  /** Env entries keyed by secret name (raw static value). Layer OVER the allowlist. */
  env: Record<string, string>;
  /** Leased raw values for the per-run dynamic scrubber (ADR-003 §D). */
  values: string[];
  /** Lease ids the caller MUST revoke in a `finally` (and should markLeaseUsed). */
  leaseIds: string[];
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
  if (bound.length === 0) return { env: {}, values: [], leaseIds: [] };

  // Resolve credentialId → name (METADATA only) to key the env var. A credential
  // deleted since binding resolves to no name and is skipped (defense-in-depth).
  const metadata = await p.provider.listCredentials(p.projectId);
  const nameById = new Map<string, string>();
  for (const m of metadata) {
    if (m.name) nameById.set(m.id, m.name);
  }

  const env: Record<string, string> = {};
  const values: string[] = [];
  const leaseIds: string[] = [];

  try {
    for (const b of bound) {
      const name = nameById.get(b.credentialId);
      if (!name) continue; // credential removed since binding — nothing to deliver.

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

      const value = await p.provider.getSecretValue({
        projectId: p.projectId,
        credentialId: b.credentialId,
        purpose: `consilium-loop:${p.loopId}:${p.phase}`,
        requestedBy: p.requestedBy,
      });
      // The name was identifier-validated at bind time ⇒ a valid env var name.
      env[name] = value;
      values.push(value);
    }
  } catch (err) {
    // Partial failure: revoke everything issued so far so nothing is orphaned
    // (best-effort — the expiry sweeper is the backstop). Then rethrow.
    for (const id of leaseIds) {
      await p.provider.revokeLease(id).catch(() => undefined);
    }
    throw err;
  }

  return { env, values, leaseIds };
}
