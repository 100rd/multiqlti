/**
 * pr-wrapper.ts — The one new external-VCS surface for the consilium loop
 * (design §14.2 step 5-6 / §14.6 B-3/B-4/H-6/M-6 + design-review B-3+/H-7/M-7).
 *
 * `WorkspaceManager` has every git verb the close-out needs EXCEPT push, and
 * there is no PR-opening capability anywhere (§14.1). This module adds exactly
 * two thin, never-throw functions, mirroring `git-wrapper.ts` discipline:
 *
 *   - `pushBranch(repoPath, branch)`  → `simpleGit(repoPath).push(["-u","origin",branch])`
 *   - `openDraftPr(repoPath, opts)`   → `gh pr create --draft --repo <o/r> …` via `execFile`
 *
 * Security (BINDING, Security has VETO):
 *   - B-3: `branch`/`head` MUST match `^consilium/loop-[0-9a-f-]{36}/round-[0-9]+$`
 *          (server-derived from loopId+round). Any non-matching value is REJECTED
 *          before it can reach git/gh. base/head/title/body are passed as arg-array
 *          elements (or `--body-file`), NEVER interpolated into a shell.
 *   - B-3+ (flag/option injection): leading-dash `title`/`branch` are rejected
 *          (a leading-dash argv element is parsed as a flag even under execFile).
 *          NO `--` terminator on `git push` — simple-git auto-appends
 *          `--verbose --porcelain`, which a `--` would turn into bogus refspecs;
 *          the branch is already option-safe via the regex gate + leading-dash
 *          rejection. `gh pr create` has NO positionals and rejects
 *          `--end-of-options` (verified gh 2.94), so its value-flags
 *          (`--base/--head/--title`) are likewise guarded by leading-dash
 *          rejection, not a terminator.
 *   - B-4: push targets only `origin` of the given allowlisted `repoPath`.
 *   - H-6: `gh` opens DRAFT PRs only (a human always merges). `gh` absent /
 *          unauthenticated / non-zero exit → typed failure; NEVER throws — the
 *          caller degrades to branch-only.
 *   - H-7: do not trust ambient git/env. `--repo <owner/repo>` is derived from
 *          the allowlisted repo's `origin` URL and validated (malformed → typed
 *          fail, no push/PR). `gh`/`git push` run with a SANITIZED env: only the
 *          intended token var is kept; inherited `GH_*` (incl. `GH_HOST`,
 *          `GH_ENTERPRISE_*`) the wrapper didn't set are stripped so a poisoned
 *          env/`.git/config` can't redirect to an attacker host + leak the token.
 *   - M-6: before creating, `gh pr list --head <branch>` — reuse an existing PR
 *          URL instead of opening a duplicate.
 *   - M-7: `gh pr create` failing with "already exists" is treated as REUSE —
 *          recover the URL via `pr list` instead of stranding the loop (TOCTOU).
 *   - M-8 (enrichment): the Draft PR is self-assigned (`--assignee @me`) and
 *          tagged with a server-FIXED label set (ensured to exist idempotently
 *          via `gh label create ... || true` first). Both assignee + label names
 *          are SERVER CONSTANTS (never model text). Applying them is BEST-EFFORT:
 *          a `gh` that rejects them degrades to a plain Draft PR — metadata never
 *          fails the PR.
 *
 * GitLab (Wglab): `openDraftPr` first runs `detectForge` (origin URL host
 * sniff, conservative default "github") and, for a "gitlab" origin, takes a
 * SEPARATE `glab`-based path (`openDraftMr`) instead of the `gh` path above —
 * the `gh` path below this point is UNCHANGED for github origins. `glab mr
 * create` resolves the (possibly nested-group) GitLab project from `origin`
 * via `cwd: repoPath`, so there is no owner/repo slug to parse/validate for
 * gitlab (H-7's `OWNER_REPO_RE`/`resolveOwnerRepo` stay github-only). Same
 * B-3/B-3+ gates apply (checked once, before the forge branch); env is
 * sanitized the same way (`sanitizedGitlabEnv` strips inherited `GITLAB_*`,
 * re-adds only `GITLAB_TOKEN`/`GITLAB_HOST`); `glab` absent/unauth/failing
 * never throws — same branch-only-fallback posture as `gh`. M-6/M-7 mirror:
 * `glab mr view <branch>` (accepts a branch name directly) reuses an existing
 * MR before create, and recovers the URL the same way on an already-exists
 * create race.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import simpleGit from "simple-git";
import type { GitErrorKind } from "../../config-sync/git-wrapper.js";

// ─── Result types (mirror git-wrapper's never-throw discriminated union) ──────

export interface PrOk {
  ok: true;
  /** Draft PR URL parsed from `gh` stdout (M-6/M-7: may be a reused PR). */
  prUrl: string;
}
export interface WrapFail {
  ok: false;
  kind: GitErrorKind | "bad-branch" | "bad-title" | "bad-origin" | "gh-failed";
  message: string;
}
export type PrResult = PrOk | WrapFail;
export type PushResult = { ok: true; branch: string } | WrapFail;

// ─── Injectable seams (unit tests inject fakes — no real repo / network) ──────

/** Minimal git surface this wrapper needs (lets tests inject a fake simple-git). */
export interface GitPushClient {
  push(args: string[]): Promise<unknown>;
  /** simple-git `getRemotes(true)` — name + refs.fetch/push URLs. */
  getRemotes(verbose: true): Promise<Array<{ name: string; refs: { fetch?: string; push?: string } }>>;
}
/** Minimal `gh`-runner surface (lets tests inject a fake execFile). */
export type ExecFileFn = (
  file: string,
  args: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecFileFn = promisify(execFile);

// ─── B-3 / B-3+ gates ──────────────────────────────────────────────────────────

/**
 * Server-derived branch shape: `consilium/loop-<uuid>/round-<n>`. NOTHING from
 * model/action-point text ever reaches a branch name or PR title — this gate
 * rejects anything that is not the exact server-built form before git/gh runs.
 */
const BRANCH_RE = /^consilium\/loop-[0-9a-f-]{36}\/round-[0-9]+$/;
/**
 * Parallel-develop: the PER-ACTION-POINT worktree branch shape,
 * `consilium/loop-<uuid>/round-<n>-ap-<k>`. Server-derived (loopId + round + 1-based AP
 * index) — NEVER model text. A DEDICATED shape (not the round branch) so a per-AP branch
 * can NEVER be mistaken for a PR head: `isValidLoopBranch` (the PR-head gate) stays strict,
 * while `isValidLoopWorktreeBranch` (worktree creation only) accepts EITHER shape.
 *
 * BUG-FIX (worktree fan-out produced 0 commits): the AP segment is a SIBLING of the round
 * branch (`round-<n>-ap-<k>`), NOT a child (`round-<n>/ap-<k>`). git stores each branch as a
 * loose ref FILE, so once the round branch `…/round-<n>` exists, a child ref `…/round-<n>/ap-<k>`
 * is a directory/file (D/F) conflict — `git worktree add` fails with "cannot lock ref … exists;
 * cannot create …". That made EVERY per-AP worktree creation throw ⇒ every AP failed ⇒ no
 * branches, no commits. The sibling shape shares only the `round-<n>` PREFIX (not the ref path),
 * so `…/round-<n>` and `…/round-<n>-ap-<k>` coexist as distinct loose refs.
 */
const AP_BRANCH_RE = /^consilium\/loop-[0-9a-f-]{36}\/round-[0-9]+-ap-[0-9]+$/;
/** Well-formed `owner/repo` (GitHub slug chars only) — H-7 origin validation. */
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// ─── Server-fixed PR metadata (assignee + labels) ─────────────────────────────
//
// SECURITY: assignee + label NAMES are SERVER CONSTANTS — they NEVER come from
// model/action-point text, so they can never carry a flag/shell payload. They
// are passed as arg-array elements to `gh`, and each is `^[a-z0-9@_-]+$`-shaped
// (no leading dash) so it is option-safe even as an argv value. Applying them is
// BEST-EFFORT: a `gh` that rejects `--assignee`/`--label` (old version, missing
// scope, label race) degrades to a plain Draft PR — metadata never fails the PR.

/** The PR is self-assigned to the invoking GH identity (server constant). */
export const SDLC_PR_ASSIGNEE = "@me";

/** A server-fixed label + its ensure-exists color/description (idempotent create). */
interface LabelSpec {
  name: string;
  color: string; // 6-hex, no leading '#'
  description: string;
}

/** Server-fixed labels applied to every SDLC Draft PR (ensured to exist first). */
export const SDLC_PR_LABEL_SPECS: readonly LabelSpec[] = [
  { name: "consilium-review", color: "5319e7", description: "Opened by the consilium reconciliation loop" },
  { name: "sdlc", color: "1d76db", description: "Produced by the SDLC executor close-out" },
  { name: "automated", color: "ededed", description: "Automated change — review before merge" },
];

/** Just the label NAMES, in apply order (server constants). */
export const SDLC_PR_LABELS: readonly string[] = SDLC_PR_LABEL_SPECS.map((l) => l.name);

/** True iff `branch` is a server-derived consilium ROUND branch (B-3). This is the PR-HEAD
 *  gate — it stays STRICT (a per-AP `ap-<k>` branch must NEVER be a PR head). */
export function isValidLoopBranch(branch: string): boolean {
  return BRANCH_RE.test(branch);
}

/** Parallel-develop: true iff `branch` is a server-derived per-ACTION-POINT branch
 *  (`consilium/loop-<uuid>/round-<n>-ap-<k>`). */
export function isValidLoopApBranch(branch: string): boolean {
  return AP_BRANCH_RE.test(branch);
}

/** Parallel-develop: the branch gate for WORKTREE CREATION — a round branch (the
 *  integration worktree / PR head) OR a per-AP branch (a wave worker's worktree). Used only
 *  by `createSdlcWorktree`; the PR-head path keeps calling the strict `isValidLoopBranch`. */
export function isValidLoopWorktreeBranch(branch: string): boolean {
  return isValidLoopBranch(branch) || isValidLoopApBranch(branch);
}

/**
 * Parallel-develop: build the per-ACTION-POINT worktree branch
 * (`consilium/loop-<uuid>/round-<n>-ap-<k>`) from SERVER-controlled inputs (loopId + round +
 * 1-based AP index) — NEVER model/action-point text. Gated through `isValidLoopApBranch`
 * before it reaches git, exactly like `buildBranchName`/`isValidLoopBranch` for the round.
 *
 * The `-ap-<k>` segment is a SIBLING of the round branch, not a child path (`/ap-<k>`): a child
 * ref collides with the round branch's loose ref FILE (git D/F conflict) and makes every
 * `git worktree add` throw. See `AP_BRANCH_RE` for the full incident note.
 */
export function buildApBranchName(loopId: string, round: number, apIndex: number): string {
  return `consilium/loop-${loopId}/round-${round}-ap-${apIndex}`;
}

/**
 * Build the ONE server-derived branch shape (`consilium/loop-<uuid>/round-<n>`)
 * from server-controlled `loopId` + `round` — NEVER from model/action-point text
 * (B-3). Co-located with `BRANCH_RE`/`isValidLoopBranch` so the close-out (D.5)
 * and the SDLC executor share a single source of truth for the shape; both gate
 * the result through `isValidLoopBranch` before it reaches git/gh. A malformed
 * `loopId` (non-uuid) yields a string the gate then REJECTS — it never silently
 * widens the allowed shape.
 */
export function buildBranchName(loopId: string, round: number): string {
  return `consilium/loop-${loopId}/round-${round}`;
}

function badBranch(branch: string): WrapFail {
  return { ok: false, kind: "bad-branch", message: `rejected branch name (B-3): ${branch}` };
}

/** Scrub fs layout from an error string before returning it (mirror A2). */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 200);
}

// ─── H-7: sanitized env + origin-derived owner/repo ─────────────────────────────

/** Token var the server intends to expose to `gh`/`git` (whichever is set). */
const KEEP_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

/**
 * Build a sanitized env: start from `process.env`, STRIP every inherited `GH_*`
 * (incl. `GH_HOST`, `GH_ENTERPRISE_TOKEN`, `GH_ENTERPRISE_*`) the wrapper didn't
 * set, then re-add only the intended token var(s). A poisoned ambient env can no
 * longer redirect `gh` to an attacker host and exfiltrate the token (H-7b).
 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GH_")) continue; // drop ALL inherited GH_* first.
    env[k] = v;
  }
  for (const tokenVar of KEEP_TOKEN_VARS) {
    if (process.env[tokenVar]) env[tokenVar] = process.env[tokenVar];
  }
  return env;
}

/** Parse `owner/repo` out of an origin URL (ssh or https), or undefined. */
function parseOwnerRepo(url: string): string | undefined {
  const m = url
    .trim()
    .replace(/\.git$/, "")
    .match(/[/:]([^/:]+\/[^/:]+)$/); // …github.com[:/ ]owner/repo
  const slug = m?.[1];
  return slug && OWNER_REPO_RE.test(slug) ? slug : undefined;
}

/**
 * H-7a: derive a validated `owner/repo` from the repo's `origin` remote URL.
 * Missing/malformed origin → typed `bad-origin` (no push/PR happens).
 */
async function resolveOwnerRepo(git: GitPushClient): Promise<string | WrapFail> {
  let remotes: Awaited<ReturnType<GitPushClient["getRemotes"]>>;
  try {
    remotes = await git.getRemotes(true);
  } catch (err) {
    return { ok: false, kind: "bad-origin", message: scrub(err instanceof Error ? err.message : String(err)) };
  }
  const origin = remotes.find((r) => r.name === "origin");
  const url = origin?.refs.push ?? origin?.refs.fetch;
  if (!url) return { ok: false, kind: "bad-origin", message: "no origin remote configured" };
  const slug = parseOwnerRepo(url);
  if (!slug) return { ok: false, kind: "bad-origin", message: "origin URL is not a well-formed owner/repo" };
  return slug;
}

// ─── GitLab (glab) outbound Draft-MR path — mirrors the gh path above ─────────
//
// `glab` resolves the (possibly nested-group) GitLab project from the CWD's
// `origin` remote itself, so unlike `gh` there is no owner/repo slug to parse
// or validate here (H-7's `OWNER_REPO_RE`/`resolveOwnerRepo` stay github-only,
// used only by the gh path below).

export type Forge = "github" | "gitlab";

/** glab's own token/host vars — kept, mirroring gh's `KEEP_TOKEN_VARS`. */
const KEEP_GITLAB_VARS = ["GITLAB_TOKEN", "GITLAB_HOST"] as const;

/**
 * H-7b mirror for glab: strip every inherited `GITLAB_*` the wrapper didn't
 * set (a poisoned `GITLAB_HOST` could redirect `glab` to an attacker host and
 * leak the token), then re-add only the intended token/host vars. PATH/HOME
 * etc. are left untouched so `glab` still finds its own config file.
 */
function sanitizedGitlabEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GITLAB_")) continue; // drop ALL inherited GITLAB_* first.
    env[k] = v;
  }
  for (const tokenVar of KEEP_GITLAB_VARS) {
    if (process.env[tokenVar]) env[tokenVar] = process.env[tokenVar];
  }
  return env;
}

/**
 * Sniff the forge from the repo's `origin` remote URL. Conservative: only a
 * URL host containing "gitlab" resolves to `"gitlab"`; missing origin, a read
 * error, or any other host (incl. github.com) resolves to `"github"` — the
 * pre-existing gh path's behavior is UNCHANGED for every caller that doesn't
 * have a gitlab origin.
 */
export async function detectForge(repoPath: string, gitClient?: GitPushClient): Promise<Forge> {
  const git = gitClient ?? makeGit(repoPath);
  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    const url = origin?.refs.push ?? origin?.refs.fetch ?? "";
    return /gitlab/i.test(url) ? "gitlab" : "github";
  } catch {
    return "github";
  }
}

/** Pull the first http(s) URL out of `glab` stdout (mirrors `parsePrUrl`). */
function parseMrUrl(stdout: string): string | undefined {
  return stdout.match(/https?:\/\/\S+/)?.[0];
}

/** True when a `glab mr create` error means an MR for the branch already exists (M-7 mirror). */
function isAlreadyExistsMr(message: string): boolean {
  return /already (exists|has an open|been created)|open merge request already exists/i.test(message);
}

/**
 * M-6 mirror: return the URL of an existing MR for `branch` via
 * `glab mr view <branch>` — `glab` accepts a branch name directly (no
 * owner/repo needed). Run with `cwd: repoPath` so `glab` resolves the project
 * from origin. Not-found / `glab` absent/unauth is NOT fatal — treated as "no
 * existing MR" (the caller decides what happens next).
 */
async function findExistingMr(
  repoPath: string,
  branch: string,
  run: ExecFileFn,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const { stdout } = await run("glab", ["mr", "view", branch], { timeout: 30_000, env, cwd: repoPath });
    return parseMrUrl(stdout);
  } catch {
    return undefined;
  }
}

/**
 * The `glab mr create` call + M-7-mirror already-exists recovery. `glab` has
 * no `--body-file`/`-F` equivalent for the description, so `--description`
 * takes the body string directly as an argv element — still `execFile` with
 * an args array (never a shell string), so this carries no injection risk;
 * it only differs from gh's `--body-file` in not hiding the content from
 * `ps`. Server-fixed flags first; `--draft` (H-6 mirror) so a human always
 * merges. Never throws.
 */
async function createDraftMr(
  repoPath: string,
  opts: OpenDraftPrOptions,
  run: ExecFileFn,
  env: NodeJS.ProcessEnv,
): Promise<PrResult> {
  const args = [
    "mr", "create", "--draft",
    "--source-branch", opts.head,
    "--target-branch", opts.base,
    "--title", opts.title,
    "--description", opts.body,
  ];
  try {
    const { stdout } = await run("glab", args, { timeout: 60_000, env, cwd: repoPath });
    const mrUrl = parseMrUrl(stdout);
    if (!mrUrl) return { ok: false, kind: "gh-failed", message: "glab returned no MR URL" };
    return { ok: true, prUrl: mrUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAlreadyExistsMr(message)) {
      const recovered = await findExistingMr(repoPath, opts.head, run, env); // M-7 mirror.
      if (recovered) return { ok: true, prUrl: recovered };
    }
    return { ok: false, kind: "gh-failed", message: scrub(message) };
  }
}

/**
 * GitLab counterpart of the gh path in `openDraftPr`: B-3/B-3+ gates already
 * ran in the caller before the forge branch, so `opts` is already safe here.
 * No origin/owner-repo derivation (H-7a is github-only) — `cwd: repoPath` lets
 * `glab` resolve the project itself. Never throws; `glab` absent/unauth/
 * failing degrades the same way `gh` does (caller falls back to branch-only).
 */
async function openDraftMr(
  repoPath: string,
  opts: OpenDraftPrOptions,
  execFileFn: ExecFileFn,
): Promise<PrResult> {
  const env = sanitizedGitlabEnv();
  const existing = await findExistingMr(repoPath, opts.head, execFileFn, env); // M-6 mirror.
  if (existing) return { ok: true, prUrl: existing };
  return createDraftMr(repoPath, opts, execFileFn, env);
}

// ─── pushBranch (B-4 / B-3+ / H-7b) ─────────────────────────────────────────────

/**
 * Push `branch` to `origin` of `repoPath` with upstream tracking, via the
 * arg-array `push` API (never a shell string). Rejects a non-server branch
 * (B-3) / leading-dash branch (B-3+ — option-injection via the branch is closed
 * by the regex gate + leading-dash rejection, no `--` needed), runs under a
 * sanitized env (H-7b), and never throws.
 */
export async function pushBranch(
  repoPath: string,
  branch: string,
  gitClient?: GitPushClient,
): Promise<PushResult> {
  if (branch.startsWith("-") || !isValidLoopBranch(branch)) return badBranch(branch);
  const git: GitPushClient = gitClient ?? makeGit(repoPath);
  try {
    // B-4: origin only. NO `--` terminator here: simple-git auto-APPENDS
    // `--verbose --porcelain` AFTER this array, and a `--` would turn those
    // trailing flags into refspecs ("src refspec --verbose does not match any").
    // Option-injection via `branch` is already closed by the regex gate +
    // leading-dash rejection above (B-3), so the branch is safe without it.
    await git.push(["-u", "origin", branch]);
    return { ok: true, branch };
  } catch (err) {
    return { ok: false, kind: "unknown", message: scrub(err instanceof Error ? err.message : String(err)) };
  }
}

/** Real simple-git client with a sanitized env (H-7b) for push. */
function makeGit(repoPath: string): GitPushClient {
  return simpleGit({ baseDir: repoPath, config: [] }) as unknown as GitPushClient;
}

// ─── openDraftPr (B-3 / B-3+ / H-6 / H-7 / M-6 / M-7) ────────────────────────────

export interface OpenDraftPrOptions {
  base: string;
  head: string; // == branch; B-3 gated
  title: string;
  body: string;
}

/** Pull the first http(s) URL out of `gh` stdout. */
function parsePrUrl(stdout: string): string | undefined {
  return stdout.match(/https?:\/\/\S+/)?.[0];
}

/**
 * M-6/M-7: return the URL of an existing PR for `branch` (no duplicate create).
 * `gh pr list` failing (gh absent/unauth) is NOT fatal — the caller decides.
 */
async function findExistingPr(
  ownerRepo: string,
  branch: string,
  run: ExecFileFn,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      "gh",
      ["pr", "list", "--repo", ownerRepo, "--json", "url", "--head", branch],
      { timeout: 30_000, env },
    );
    const parsed: unknown = JSON.parse(stdout || "[]");
    if (Array.isArray(parsed) && parsed.length > 0) {
      const url = (parsed[0] as { url?: unknown }).url;
      if (typeof url === "string" && url) return url;
    }
  } catch {
    // gh missing/unauth/parse error → treat as "no existing PR".
  }
  return undefined;
}

/** True when a `gh pr create` error means a PR for the branch already exists (M-7). */
function isAlreadyExists(message: string): boolean {
  return /already exists/i.test(message);
}

/**
 * Open a DRAFT PR on `repoPath` via `gh` (arg-array `execFile`, never a shell
 * string). `body` goes to a tmp file via `--body-file` (never in argv). Server-
 * fixed flags first, value-bearing args after `--end-of-options` (B-3+). `--repo`
 * is origin-derived + validated (H-7a) and `gh` runs under a sanitized env
 * (H-7b). Reuses an existing PR (M-6) and recovers from a create-time
 * already-exists race (M-7). Never throws.
 */
export async function openDraftPr(
  repoPath: string,
  opts: OpenDraftPrOptions,
  execFileFn: ExecFileFn = execFileAsync,
  gitClient?: GitPushClient,
): Promise<PrResult> {
  if (opts.head.startsWith("-") || !isValidLoopBranch(opts.head)) return badBranch(opts.head); // B-3 / B-3+.
  if (opts.title.startsWith("-")) {
    return { ok: false, kind: "bad-title", message: "rejected leading-dash title (B-3+ flag injection)" };
  }
  // L-1: `base` is a value-flag arg (`--base <base>`); reject a leading-dash base
  // so a malformed/poisoned base can't be parsed by `gh` as a flag (option injection).
  if (opts.base.startsWith("-")) {
    return { ok: false, kind: "bad-title", message: "rejected leading-dash base (B-3+ flag injection)" };
  }

  // GitLab origin → the glab Draft-MR path above; conservative default is
  // "github" (see `detectForge`), so this is a no-op branch for every github
  // caller — the rest of this function (the gh path) is UNCHANGED.
  if ((await detectForge(repoPath, gitClient)) === "gitlab") {
    return openDraftMr(repoPath, opts, execFileFn);
  }

  const env = sanitizedEnv(); // H-7b
  const ownerRepo = await resolveOwnerRepo(gitClient ?? makeGit(repoPath)); // H-7a
  if (typeof ownerRepo !== "string") return ownerRepo; // bad-origin fail

  const existing = await findExistingPr(ownerRepo, opts.head, execFileFn, env); // M-6.
  if (existing) return { ok: true, prUrl: existing };

  return createDraftPr(ownerRepo, opts, execFileFn, env);
}

/**
 * Idempotently ensure the server-fixed labels exist on the repo before `gh pr
 * create --label` references them (a label that does not exist makes `gh pr
 * create` fail). Mirrors `gh label create ... 2>/dev/null || true`: each create
 * is best-effort and its failure (label already exists / gh missing / no scope)
 * is SWALLOWED — never fatal. Label name/color/description are server constants.
 */
async function ensureLabels(
  ownerRepo: string,
  run: ExecFileFn,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const spec of SDLC_PR_LABEL_SPECS) {
    try {
      await run(
        "gh",
        ["label", "create", spec.name, "--repo", ownerRepo, "--color", spec.color, "--description", spec.description],
        { timeout: 30_000, env },
      );
    } catch {
      // already exists / gh missing / no scope → idempotent no-op (|| true).
    }
  }
}

/** The create call + M-7 already-exists recovery. */
async function createDraftPr(
  ownerRepo: string,
  opts: OpenDraftPrOptions,
  run: ExecFileFn,
  env: NodeJS.ProcessEnv,
): Promise<PrResult> {
  const bodyFile = join(tmpdir(), `consilium-pr-${randomUUID()}.md`);
  try {
    await writeFile(bodyFile, opts.body, "utf8");

    // server-fixed flags FIRST (H-6 --draft, --repo); body via --body-file
    // (never argv). B-3+: `gh` has NO positional args and REJECTS
    // `--end-of-options` (verified gh 2.94: "unknown flag"); `--base`/`--head`/
    // `--title` are value-flags, so the flag-injection defense here is the
    // leading-dash rejection of title+head above, NOT a terminator (which would
    // break the command). `git push` DOES get a `--` terminator.
    const baseArgs = [
      "pr", "create", "--draft", "--repo", ownerRepo, "--body-file", bodyFile,
      "--base", opts.base, "--head", opts.head, "--title", opts.title,
    ];

    // Best-effort: ensure the server-fixed labels exist before referencing them.
    await ensureLabels(ownerRepo, run, env);

    // Enrich with server-fixed labels + assignee (all server constants, never
    // model text). `--label`/`--assignee` are value-flags whose values are
    // option-safe constants.
    const enrichedArgs = [...baseArgs];
    for (const name of SDLC_PR_LABELS) enrichedArgs.push("--label", name);
    enrichedArgs.push("--assignee", SDLC_PR_ASSIGNEE);

    let stdout: string;
    try {
      ({ stdout } = await run("gh", enrichedArgs, { timeout: 60_000, env }));
    } catch (enrichErr) {
      const m = enrichErr instanceof Error ? enrichErr.message : String(enrichErr);
      // An already-exists race is REUSE, not a metadata problem — bubble it to the
      // M-7 recovery in the outer catch.
      if (isAlreadyExists(m)) throw enrichErr;
      // The metadata flags may have caused it (old gh / no scope / bad label).
      // Degrade gracefully: open a PLAIN Draft PR — metadata never fails the PR.
      // eslint-disable-next-line no-console
      console.warn(`[pr-wrapper] degraded: assignee/labels rejected, opening plain Draft PR: ${scrub(m)}`);
      ({ stdout } = await run("gh", baseArgs, { timeout: 60_000, env }));
    }
    const prUrl = parsePrUrl(stdout);
    if (!prUrl) return { ok: false, kind: "gh-failed", message: "gh returned no PR URL" };
    return { ok: true, prUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAlreadyExists(message)) {
      const recovered = await findExistingPr(ownerRepo, opts.head, run, env); // M-7 recovery.
      if (recovered) return { ok: true, prUrl: recovered };
    }
    return { ok: false, kind: "gh-failed", message: scrub(message) };
  } finally {
    await unlink(bodyFile).catch(() => undefined);
  }
}
