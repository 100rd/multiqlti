/**
 * worktree.ts — SDLC executor, component 1: worktree lifecycle.
 *
 * The consilium loop's DEVELOPING side effect needs REAL multi-file code edits
 * made in ISOLATION from the user's own checkout. The legacy close-out
 * (dev-closeout.ts) called `WorkspaceManager.switchBranch()`, which mutates the
 * user's working tree — unacceptable while they are actively working there.
 *
 * Instead we cut a DEDICATED git worktree under the OS temp dir and let the
 * agentic coder edit there. `git worktree add <absolute-temp-dir> -b <branch>
 * <baseRef>` gives the new branch its own checked-out tree on disk that shares
 * the repo's object store but is physically separate from the user's checkout:
 * edits in the worktree CANNOT touch the user's files or `main`.
 *
 * Security (BINDING — adversarial-review surface):
 *   - The branch is the server-derived B-3 shape (`pr-wrapper.buildBranchName` +
 *     `isValidLoopBranch`). NOTHING from action-point text ever reaches a branch
 *     name. A non-B-3 / leading-dash branch is REJECTED before git runs.
 *   - `repoPath` is re-validated against the loop's fail-closed allowlist
 *     (`assertAllowedRepoPath`, realpath + traversal guard) every call.
 *   - The worktree dir is server-minted via `mkdtemp` under `os.tmpdir()` — an
 *     absolute path that NEVER overlaps the user's checkout. `baseRef` is gated
 *     to an option-safe ref token (no leading dash, safe charset) so it cannot
 *     inject a git flag even though every call uses an ARG ARRAY (never a shell
 *     string — no command injection regardless).
 *   - All git runs go through an injectable arg-array runner (default
 *     `simple-git(...).raw([...])`), so unit tests never touch a real repo.
 */
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import simpleGit from "simple-git";
import { isValidLoopBranch } from "../consilium/pr-wrapper.js";
import { assertAllowedRepoPath } from "../consilium/repo-allowlist.js";

/** Arg-array git runner seam: `(repoPath, args) => stdout`. Never a shell string. */
export type GitRunner = (repoPath: string, args: string[]) => Promise<string>;

/** Default runner — simple-git `raw`, which passes args verbatim (no shell). */
export const defaultGitRaw: GitRunner = (repoPath, args) =>
  simpleGit({ baseDir: repoPath, config: [] }).raw(args);

/** mkdtemp seam (tests inject a deterministic dir; default = real OS temp). */
export type MkdtempFn = (prefix: string) => Promise<string>;
const defaultMkdtemp: MkdtempFn = (prefix) => mkdtemp(prefix);

/**
 * Option-safe ref token: a branch name or a commit-ish that git will treat as a
 * positional, never a flag. No leading dash; conservative charset (sha / branch
 * / tag chars). `baseRef` is always server-derived (default branch or a server
 * sha), so this is a defense-in-depth gate, not the only guard.
 */
const SAFE_REF_RE = /^[0-9A-Za-z._\/-]+$/;

function isSafeRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("-") && SAFE_REF_RE.test(ref) && !ref.includes("..");
}

export interface CreateWorktreeOptions {
  /** Allowlisted repo to cut the worktree from (re-validated every call). */
  repoPath: string;
  /** Server-derived B-3 branch (`consilium/loop-<uuid>/round-<n>`). */
  branch: string;
  /** Commit-ish to base the new branch on. Defaults to the repo's default branch. */
  baseRef?: string;
  /** Fail-closed repo allowlist (H-5). */
  allowedRepoPaths: readonly string[];
  /** Injectable git runner (tests). */
  gitRaw?: GitRunner;
  /** Injectable mkdtemp (tests). */
  mkdtempFn?: MkdtempFn;
}

export interface CreateWorktreeResult {
  /** Absolute path of the isolated worktree (under os.tmpdir()). */
  worktreeDir: string;
  /** The temp PARENT dir mkdtemp created — removed wholesale on cleanup. */
  baseDir: string;
  /** The branch checked out in the worktree. */
  branch: string;
  /** The commit-ish the branch was based on. */
  baseRef: string;
}

/**
 * Resolve the repo's default branch NAME (e.g. "main"). Order: `origin/HEAD`
 * symbolic-ref → current branch → "main". Never throws (best-effort) and the
 * result is gated `isSafeRef` by callers before it reaches git as a positional.
 */
export async function resolveDefaultBranch(
  repoPath: string,
  gitRaw: GitRunner = defaultGitRaw,
): Promise<string> {
  try {
    const ref = (await gitRaw(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
    const name = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    if (name && isSafeRef(name)) return name;
  } catch {
    // fall through to the local-HEAD probe
  }
  try {
    const b = (await gitRaw(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (b && b !== "HEAD" && isSafeRef(b)) return b;
  } catch {
    // fall through to the static default
  }
  return "main";
}

/**
 * Create an isolated worktree + branch for an SDLC round. Throws (fail-closed)
 * on a disallowed repo, a non-B-3/unsafe branch, or an unsafe baseRef — the
 * caller (executor) catches and degrades. On a git failure mid-create it removes
 * the temp dir before rethrowing so no orphan tree is left behind.
 */
export async function createSdlcWorktree(opts: CreateWorktreeOptions): Promise<CreateWorktreeResult> {
  const gitRaw = opts.gitRaw ?? defaultGitRaw;
  const mkdtempFn = opts.mkdtempFn ?? defaultMkdtemp;

  // H-5: re-validate the repo against the fail-closed allowlist (realpath +
  // traversal + denylist). Throws when the path escapes confinement.
  const repo = assertAllowedRepoPath(opts.repoPath, opts.allowedRepoPaths);

  // B-3: the branch must be the EXACT server-derived shape. Reject anything else
  // (incl. a leading-dash branch) before git runs.
  if (opts.branch.startsWith("-") || !isValidLoopBranch(opts.branch)) {
    throw new Error(`createSdlcWorktree: rejected branch name (B-3): ${opts.branch}`);
  }

  const baseRef = opts.baseRef ?? (await resolveDefaultBranch(repo, gitRaw));
  if (!isSafeRef(baseRef)) {
    throw new Error(`createSdlcWorktree: rejected unsafe baseRef`);
  }

  // Server-minted isolated dir under the OS temp root — NEVER the user's checkout.
  const baseDir = await mkdtempFn(join(tmpdir(), "sdlc-wt-"));
  const worktreeDir = join(baseDir, "tree"); // non-existent subdir git will create.

  try {
    // Clear any stale worktree registrations first (best-effort — a prior crash
    // could leave a dangling entry that would otherwise block re-creation).
    await gitRaw(repo, ["worktree", "prune"]).catch(() => undefined);
    await addWorktree(gitRaw, repo, worktreeDir, opts.branch, baseRef);
    return { worktreeDir, baseDir, branch: opts.branch, baseRef };
  } catch (err) {
    // No orphan tree: drop the temp dir we minted before bubbling the failure up.
    await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * `git worktree add -b <branch> <path> <baseRef>`. Options precede the
 * positionals so an (already-gated) value can never be mis-parsed as a flag. If
 * the branch already exists (a re-driven round / a stale ref), recover by
 * force-recreating it from `baseRef` with `-B` so the round is coherent.
 */
async function addWorktree(
  gitRaw: GitRunner,
  repo: string,
  worktreeDir: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  try {
    await gitRaw(repo, ["worktree", "add", "-b", branch, worktreeDir, baseRef]);
  } catch (err) {
    if (!/already (exists|used by worktree|checked out)/i.test(errMsg(err))) throw err;
    await gitRaw(repo, ["worktree", "prune"]).catch(() => undefined);
    await gitRaw(repo, ["worktree", "add", "-B", branch, worktreeDir, baseRef]);
  }
}

/**
 * Remove the worktree (and the temp parent dir it lived in). NEVER throws — the
 * executor calls this from a `finally`, so a removal failure must not mask the
 * coder's result. Leaves the branch + any pushed PR intact (only the tree goes).
 */
export async function removeSdlcWorktree(
  repoPath: string,
  worktreeDir: string,
  opts: { baseDir?: string; gitRaw?: GitRunner } = {},
): Promise<void> {
  const gitRaw = opts.gitRaw ?? defaultGitRaw;
  // Primary: ask git to drop the worktree (also clears its admin entry).
  await gitRaw(repoPath, ["worktree", "remove", "--force", worktreeDir]).catch(() => undefined);
  // Belt-and-braces: nuke the on-disk dir + prune the admin entry in case the
  // `remove` above failed (e.g. the dir was already gone / locked).
  await rm(opts.baseDir ?? worktreeDir, { recursive: true, force: true }).catch(() => undefined);
  await gitRaw(repoPath, ["worktree", "prune"]).catch(() => undefined);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
