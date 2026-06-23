/**
 * workspace-bind.ts — Resolve (or create) the `local` workspace bound to a
 * consilium loop's repo (design §14.3 / §14.6 H-5).
 *
 * The DEV close-out (§14.2) writes a bounded `.md` artifact into the loop's repo
 * via `WorkspaceManager`, which operates on a `WorkspaceRow`. There is no
 * `getWorkspaceByPath` in storage (§14.1), so we scan-or-create.
 *
 * Security (H-5, fail-closed):
 *   1. `assertAllowedRepoPath` + `realpathSync` run FIRST — we NEVER resolve or
 *      create a workspace for a non-allowlisted path. Empty allowlist throws.
 *   2. A pre-existing row matched by path is RE-VALIDATED against the allowlist:
 *      a row whose `path` was poisoned out-of-band must not be used.
 *   3. The created row stores the realpath'd path (not the raw caller input).
 *
 * Never reinvents path confinement — it reuses `assertAllowedRepoPath` (A2).
 */
import { realpathSync } from "fs";
import { assertAllowedRepoPath } from "./repo-allowlist.js";
import type { InsertWorkspace, WorkspaceRow } from "@shared/schema";

/**
 * Minimal storage surface this binder needs — lets unit tests inject a fake
 * without the full `IStorage`. Mirrors the real `getWorkspaces`/`createWorkspace`
 * signatures (`server/storage.ts:619`).
 */
export interface WorkspaceBindStorage {
  getWorkspaces(): Promise<WorkspaceRow[]>;
  createWorkspace(data: InsertWorkspace & { id?: string }): Promise<WorkspaceRow>;
}

/** Realpath a path that is known to exist; the caller already allowlist-checked it. */
function realResolve(rawPath: string): string {
  return realpathSync(rawPath);
}

/**
 * Find an existing `local` workspace whose realpath'd `path` equals the target,
 * re-validating that row's path against the allowlist (H-5: a poisoned row must
 * not be used). Returns the row, or `undefined` when none match.
 */
function findBoundWorkspace(
  rows: readonly WorkspaceRow[],
  resolvedTarget: string,
  allowedRoots: readonly string[],
): WorkspaceRow | undefined {
  for (const row of rows) {
    if (row.type !== "local") continue;
    let rowResolved: string;
    try {
      rowResolved = assertAllowedRepoPath(row.path, allowedRoots);
    } catch {
      continue; // poisoned / now-disallowed row — skip, never use.
    }
    if (rowResolved === resolvedTarget) return row;
  }
  return undefined;
}

/**
 * Resolve the `local` workspace bound to `repoPath`, creating one if absent.
 *
 * @throws if `repoPath` is not allowlisted (H-5) — never resolves/creates for a
 *         non-allowlisted path; fail-closed on an empty allowlist.
 */
export async function resolveLoopWorkspace(
  storage: WorkspaceBindStorage,
  repoPath: string,
  ownerId: string,
  allowedRoots: readonly string[],
  branch = "main",
): Promise<WorkspaceRow> {
  // H-5: allowlist + realpath FIRST — before any scan or create.
  assertAllowedRepoPath(repoPath, allowedRoots);
  const resolvedTarget = realResolve(repoPath);

  const existing = findBoundWorkspace(
    await storage.getWorkspaces(),
    resolvedTarget,
    allowedRoots,
  );
  if (existing) return existing;

  return storage.createWorkspace({
    name: resolvedTarget.split("/").pop() || resolvedTarget,
    type: "local",
    path: resolvedTarget,
    branch,
    ownerId,
  });
}
