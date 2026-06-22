/**
 * repo-allowlist.ts — Defense-in-depth path confinement for consilium-loop
 * repo access (design §10.2 / §13 H-1).
 *
 * Byte-mirrors `server/services/file-watcher.ts validateWatchPath` (~L60):
 *   1. Resolve symlinks via realpathSync (fall back to resolve() when the path
 *      does not exist yet — same belt-and-suspenders posture).
 *   2. Reject a post-resolution "..".
 *   3. Enforce `resolved === root || resolved.startsWith(root + "/")` against
 *      EACH realpath'd allowed root (not a single base — the loop has a list).
 *   4. Apply the same system-critical denylist as file-watcher.
 *
 * Fail-closed: an empty allowlist throws — no implicit "allow everything".
 * `buildDiffContext` calls this itself on the persisted `repoPath` every round,
 * so a poisoned row can never widen access (never trust the caller).
 */
import { realpathSync } from "fs";
import { resolve } from "path";

/**
 * Absolute-path denylist, mirrored from `file-watcher.ts DENIED_PATHS`. Any
 * resolved path that equals or is nested under one of these is rejected.
 */
const DENIED_PATHS = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/run",
  "/root",
  "/var/run/docker.sock",
  "/run/secrets",
];

/** Resolve symlinks; fall back to lexical resolve() when the path is absent. */
function realResolve(rawPath: string): string {
  try {
    return realpathSync(rawPath);
  } catch {
    return resolve(rawPath);
  }
}

/** Reject a resolved path matching the system-critical denylist. */
function assertNotDenied(resolved: string): void {
  for (const denied of DENIED_PATHS) {
    if (resolved === denied || resolved.startsWith(denied + "/")) {
      throw new Error(
        `[repo-allowlist] Path "${resolved}" matches a denied system path "${denied}"`,
      );
    }
  }
}

/** True when `resolved` is the root itself or strictly nested under it. */
function isWithinRoot(resolved: string, root: string): boolean {
  const normalized = root.endsWith("/") ? root : root + "/";
  return resolved === root || resolved.startsWith(normalized);
}

/**
 * Assert `repoPath` resolves inside one of `allowedRoots`. Returns the resolved
 * absolute path on success; throws (fail-closed) otherwise. Both `repoPath` and
 * each allowed root are realpath'd so a symlink cannot escape confinement.
 */
export function assertAllowedRepoPath(
  repoPath: string,
  allowedRoots: readonly string[],
): string {
  if (allowedRoots.length === 0) {
    throw new Error("[repo-allowlist] allowlist is empty — fail-closed, no repo path is permitted");
  }

  const resolved = realResolve(repoPath);
  if (resolved.includes("..")) {
    throw new Error(`[repo-allowlist] Path traversal detected in resolved path: ${resolved}`);
  }
  assertNotDenied(resolved);

  for (const root of allowedRoots) {
    if (isWithinRoot(resolved, realResolve(root))) return resolved;
  }
  throw new Error(`[repo-allowlist] Path "${resolved}" is outside every allowed repo root`);
}

export { DENIED_PATHS };
