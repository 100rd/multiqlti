/**
 * git-wrapper.ts — Thin wrapper around simple-git for config-sync operations.
 *
 * Issue #318: Config sync git operations (push/pull/status with graceful errors)
 *
 * All functions return typed result objects — they never throw. Callers check
 * the `ok` discriminator and handle the `error` or `errorKind` fields.
 *
 * Error kinds:
 *   not-a-repo     — directory is not a git repository
 *   no-remote      — repository has no remote configured
 *   no-upstream    — branch has no upstream tracking ref
 *   merge-conflict — pull resulted in conflicts
 *   offline        — network operation timed out or DNS failed
 *   unknown        — any other git error
 */

import os from "os";
import simpleGit, { GitError } from "simple-git";

// ─── Error kinds ──────────────────────────────────────────────────────────────

export type GitErrorKind =
  | "not-a-repo"
  | "no-remote"
  | "no-upstream"
  | "merge-conflict"
  | "offline"
  | "unknown";

// ─── Result types ─────────────────────────────────────────────────────────────

export interface GitOk<T> {
  ok: true;
  data: T;
}

export interface GitFail {
  ok: false;
  errorKind: GitErrorKind;
  message: string;
}

export type GitResult<T> = GitOk<T> | GitFail;

// ─── Data shapes ──────────────────────────────────────────────────────────────

export interface GitStatusData {
  /** Current branch name, or "(detached)" / "(no commits yet)". */
  branch: string;
  /** Whether the working tree has any uncommitted changes. */
  dirty: boolean;
  /** Commits ahead of the remote tracking branch. */
  ahead: number;
  /** Commits behind the remote tracking branch. */
  behind: number;
  /** Number of staged files. */
  staged: number;
  /** Number of modified + deleted + renamed (unstaged) files. */
  unstaged: number;
  /** Number of untracked files. */
  untracked: number;
  /** Whether a remote is configured at all. */
  hasRemote: boolean;
}

export interface GitPushData {
  /** Branch that was pushed. */
  branch: string;
  /** Remote that was pushed to. */
  remote: string;
  /** Commit hash of the HEAD that was pushed. */
  commitHash: string;
  /** Human-readable auto-generated commit message. */
  commitMessage: string;
  /** Number of files changed in this commit (0 if nothing to commit). */
  filesChanged: number;
}

export interface GitPullData {
  /** Branch that was updated. */
  branch: string;
  /** Remote that was pulled from. */
  remote: string;
  /** Summary from the merge/rebase (may be "up to date" if already current). */
  summary: string;
  /** Whether the repo was already up to date (no new commits). */
  alreadyUpToDate: boolean;
  /** Commits that were brought in (may be 0). */
  commitsAdded: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Classify a raw git error message into a typed error kind so callers can
 * present actionable guidance instead of raw git text.
 */
function classifyError(raw: string): GitErrorKind {
  const msg = raw.toLowerCase();

  if (
    msg.includes("not a git repository") ||
    msg.includes("not a git repo") ||
    (msg.includes("no such file or directory") && msg.includes(".git"))
  ) {
    return "not-a-repo";
  }

  if (
    msg.includes("no remote") ||
    msg.includes("remote: not found") ||
    msg.includes("does not appear to be a git repository") ||
    msg.includes("no configured push destination") ||
    msg.includes("remote-less")
  ) {
    return "no-remote";
  }

  if (
    msg.includes("no upstream") ||
    msg.includes("no tracking information") ||
    msg.includes("has no upstream branch") ||
    msg.includes("branch has no remote")
  ) {
    return "no-upstream";
  }

  if (
    msg.includes("conflict") ||
    msg.includes("automatic merge failed") ||
    msg.includes("merge conflict") ||
    msg.includes("unmerged paths")
  ) {
    return "merge-conflict";
  }

  if (
    msg.includes("could not resolve host") ||
    msg.includes("connection timed out") ||
    msg.includes("network is unreachable") ||
    msg.includes("unable to connect") ||
    msg.includes("connection refused") ||
    (msg.includes("timeout") && (msg.includes("connect") || msg.includes("network")))
  ) {
    return "offline";
  }

  return "unknown";
}

function fail(err: unknown, fallbackKind: GitErrorKind = "unknown"): GitFail {
  if (err instanceof GitError) {
    const kind = classifyError(err.message);
    return { ok: false, errorKind: kind, message: err.message.trim() };
  }
  const message = err instanceof Error ? err.message : String(err);
  const detected = classifyError(message);
  return {
    ok: false,
    errorKind: detected === "unknown" ? fallbackKind : detected,
    message: message.trim(),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the git status of the config repo.
 *
 * Works even on fresh repos with no commits.  Returns `hasRemote: false` when
 * no remote is configured instead of erroring.
 */
export async function gitStatus(repoPath: string): Promise<GitResult<GitStatusData>> {
  const git = simpleGit(repoPath);

  // Verify it is actually a git repository first.
  try {
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return {
        ok: false,
        errorKind: "not-a-repo",
        message: `${repoPath} is not a git repository. Run \`mqlti config init\` first.`,
      };
    }
  } catch (err) {
    return fail(err, "not-a-repo");
  }

  // Check whether a remote exists (best-effort; don't fail if it doesn't).
  let hasRemote = false;
  try {
    const remotes = await git.getRemotes(false);
    hasRemote = remotes.length > 0;
  } catch {
    // Ignore — hasRemote stays false.
  }

  try {
    const [statusResult, branchResult] = await Promise.all([
      git.status(),
      git.branchLocal(),
    ]);

    return {
      ok: true,
      data: {
        branch: branchResult.current ?? "(detached)",
        dirty: !statusResult.isClean(),
        ahead: statusResult.ahead,
        behind: statusResult.behind,
        staged: statusResult.staged.length,
        unstaged:
          statusResult.modified.length +
          statusResult.deleted.length +
          statusResult.renamed.length,
        untracked: statusResult.not_added.length,
        hasRemote,
      },
    };
  } catch {
    // Fresh repo with no commits: status() may fail.
    return {
      ok: true,
      data: {
        branch: "(no commits yet)",
        dirty: false,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        hasRemote,
      },
    };
  }
}

/**
 * Commit all mqlti-managed files and push to the remote.
 *
 * Steps:
 *  1. `git add .`
 *  2. Build commit message from timestamp + hostname + changed entity count.
 *  3. `git commit` (skipped if nothing to commit).
 *  4. `git push --set-upstream` with default remote / branch.
 *
 * Returns an error with kind "no-remote" if no remote is configured, or
 * "offline" if the network is unreachable, rather than hanging.
 */
export async function gitPush(
  repoPath: string,
  options: { entityCount?: number } = {},
): Promise<GitResult<GitPushData>> {
  const git = simpleGit(repoPath);

  // Pre-flight: must be a repo.
  try {
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return {
        ok: false,
        errorKind: "not-a-repo",
        message: `${repoPath} is not a git repository.`,
      };
    }
  } catch (err) {
    return fail(err, "not-a-repo");
  }

  // Pre-flight: must have a remote.
  let remote = "origin";
  try {
    const remotes = await git.getRemotes(false);
    if (remotes.length === 0) {
      return {
        ok: false,
        errorKind: "no-remote",
        message:
          "No remote configured. Add a remote with:\n" +
          "  git -C " + repoPath + " remote add origin <url>",
      };
    }
    remote = remotes[0]?.name ?? "origin";
  } catch (err) {
    return fail(err, "no-remote");
  }

  // Stage all changes.
  try {
    await git.add(".");
  } catch (err) {
    return fail(err);
  }

  // Check what is staged (after git add).
  let statusResult: Awaited<ReturnType<typeof git.status>>;
  try {
    statusResult = await git.status();
  } catch (err) {
    return fail(err);
  }

  // Count total staged files (staged array covers all added/modified/deleted staged entries).
  const filesChanged = statusResult.staged.length;

  // Build commit message.
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const hostname = os.hostname().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32);
  const entityNote =
    options.entityCount !== undefined
      ? ` (${options.entityCount} ${options.entityCount === 1 ? "entity" : "entities"})`
      : "";
  const commitMessage = `chore: sync config from ${hostname} at ${timestamp}${entityNote}`;

  // Commit only if there are staged changes.
  if (filesChanged > 0) {
    try {
      await git.commit(commitMessage);
    } catch (err) {
      return fail(err);
    }
  }

  // Get the current HEAD hash.
  let commitHash = "(unknown)";
  try {
    commitHash = (await git.revparse(["HEAD"])).trim();
  } catch {
    // Keep default.
  }

  // Get current branch.
  let branch = "main";
  try {
    const br = await git.branchLocal();
    branch = br.current ?? "main";
  } catch {
    // Keep default.
  }

  // Push (--set-upstream ensures the local branch tracks the remote).
  try {
    await git.push(remote, branch, ["--set-upstream"]);
  } catch (err) {
    return fail(err);
  }

  return {
    ok: true,
    data: { branch, remote, commitHash, commitMessage, filesChanged },
  };
}

/**
 * Fetch + pull (with rebase by default) from the remote.
 *
 * Steps:
 *  1. `git fetch` to check ahead/behind without modifying HEAD.
 *  2. `git pull --rebase` (or `--no-rebase`) to integrate remote changes.
 *
 * If a merge conflict is detected the rebase is aborted and the error kind is
 * "merge-conflict" so the caller can print clear guidance.
 */
export async function gitPull(
  repoPath: string,
  options: { rebase?: boolean } = {},
): Promise<GitResult<GitPullData>> {
  const rebase = options.rebase ?? true;
  const git = simpleGit(repoPath);

  // Pre-flight: must be a repo.
  try {
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return {
        ok: false,
        errorKind: "not-a-repo",
        message: `${repoPath} is not a git repository.`,
      };
    }
  } catch (err) {
    return fail(err, "not-a-repo");
  }

  // Pre-flight: must have a remote.
  let remote = "origin";
  try {
    const remotes = await git.getRemotes(false);
    if (remotes.length === 0) {
      return {
        ok: false,
        errorKind: "no-remote",
        message:
          "No remote configured. Add a remote with:\n" +
          "  git -C " + repoPath + " remote add origin <url>",
      };
    }
    remote = remotes[0]?.name ?? "origin";
  } catch (err) {
    return fail(err, "no-remote");
  }

  // Fetch (shows ahead/behind without touching HEAD).
  try {
    await git.fetch(remote);
  } catch (err) {
    const f = fail(err);
    // Re-classify fetch failures more precisely (network vs auth vs other).
    const kind = f.ok === false ? f.errorKind : "unknown";
    return {
      ok: false,
      errorKind: kind,
      message: f.ok === false ? f.message : String(err),
    };
  }

  // Get current branch.
  let branch = "main";
  try {
    const br = await git.branchLocal();
    branch = br.current ?? "main";
  } catch {
    // Keep default.
  }

  let pullSummary: string;
  let alreadyUpToDate = false;
  let commitsAdded = 0;

  try {
    // Use string array form of options (avoids TS union type issues with TaskOptions).
    const pullOptions: string[] = rebase ? ["--rebase"] : ["--no-rebase"];
    const result = await git.pull(remote, branch, pullOptions);

    // simple-git's PullResult exposes a summary field.
    if (result.summary?.changes !== undefined) {
      pullSummary = `${result.summary.changes} change(s), ${result.summary.insertions ?? 0} insertion(s), ${result.summary.deletions ?? 0} deletion(s)`;
      alreadyUpToDate =
        result.summary.changes === 0 &&
        result.summary.insertions === 0 &&
        result.summary.deletions === 0;
      commitsAdded = result.summary.changes;
    } else {
      pullSummary = "up to date";
      alreadyUpToDate = true;
    }
  } catch (err) {
    // Check if we ended up in a conflict state and abort.
    const kind = classifyError(err instanceof Error ? err.message : String(err));
    if (kind === "merge-conflict") {
      // Attempt to abort so the repo is left in a clean state.
      try {
        if (rebase) {
          await git.rebase(["--abort"]);
        } else {
          await git.merge(["--abort"]);
        }
      } catch {
        // Ignore abort errors — we still report merge-conflict to the caller.
      }
      return {
        ok: false,
        errorKind: "merge-conflict",
        message:
          "Merge conflict detected. The rebase has been aborted.\n" +
          "Resolve locally with:\n" +
          "  git -C " + repoPath + " pull --no-rebase\n" +
          "  # resolve conflicts, then:\n" +
          "  git -C " + repoPath + " add .\n" +
          "  git -C " + repoPath + " commit",
      };
    }
    return fail(err);
  }

  return {
    ok: true,
    data: { branch, remote, summary: pullSummary, alreadyUpToDate, commitsAdded },
  };
}
