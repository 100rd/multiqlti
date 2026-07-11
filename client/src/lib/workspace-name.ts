/**
 * workspace-name.ts — resolve the human WORKSPACE NAME a consilium loop runs in.
 *
 * A loop only carries its `repoPath` (there is no `workspaceId` on the loop row).
 * The loop↔workspace link is BY PATH: the server binds a loop to the `local`
 * workspace whose `path` equals the loop's realpath'd repo (see
 * server/services/consilium/workspace-bind.ts). This mirrors that match on the
 * client — trailing-slash-insensitive, `local`-only — so the list page can group
 * / filter by workspace name and the detail page can label the loop with it.
 *
 * Falls back to the repo basename when no workspace row matches (a loop may run
 * on an allowlisted repo that was never saved as a workspace). Pure, no I/O.
 */
import type { WorkspaceRow } from "@shared/schema";

/** Trailing-slash-insensitive path key, so `/repo` and `/repo/` match. */
export function normalizePath(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Last path segment of a repo path, for a compact fallback label. */
export function repoBasename(repoPath: string): string {
  const trimmed = repoPath.replace(/\/+$/, "");
  const seg = trimmed.split("/").pop();
  return seg || repoPath;
}

/**
 * Resolve the workspace NAME for a loop's `repoPath`: match it (normalized,
 * `local`-only) against the project's workspaces by `path` and return that
 * workspace's `name`; fall back to the repo basename when nothing matches.
 */
export function resolveWorkspaceName(
  repoPath: string,
  workspaces: readonly WorkspaceRow[] | undefined,
): string {
  const target = normalizePath(repoPath);
  const match = workspaces?.find(
    (w) => w.type === "local" && normalizePath(w.path) === target,
  );
  return match?.name || repoBasename(repoPath);
}
