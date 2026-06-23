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
  options?: { timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecFileFn = promisify(execFile);

// ─── B-3 / B-3+ gates ──────────────────────────────────────────────────────────

/**
 * Server-derived branch shape: `consilium/loop-<uuid>/round-<n>`. NOTHING from
 * model/action-point text ever reaches a branch name or PR title — this gate
 * rejects anything that is not the exact server-built form before git/gh runs.
 */
const BRANCH_RE = /^consilium\/loop-[0-9a-f-]{36}\/round-[0-9]+$/;
/** Well-formed `owner/repo` (GitHub slug chars only) — H-7 origin validation. */
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** True iff `branch` is a server-derived consilium branch (B-3). */
export function isValidLoopBranch(branch: string): boolean {
  return BRANCH_RE.test(branch);
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

  const env = sanitizedEnv(); // H-7b
  const ownerRepo = await resolveOwnerRepo(gitClient ?? makeGit(repoPath)); // H-7a
  if (typeof ownerRepo !== "string") return ownerRepo; // bad-origin fail

  const existing = await findExistingPr(ownerRepo, opts.head, execFileFn, env); // M-6.
  if (existing) return { ok: true, prUrl: existing };

  return createDraftPr(ownerRepo, opts, execFileFn, env);
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
    const { stdout } = await run(
      "gh",
      // server-fixed flags FIRST (H-6 --draft, --repo); body via --body-file
      // (never argv). B-3+: `gh` has NO positional args and REJECTS
      // `--end-of-options` (verified gh 2.94: "unknown flag"); `--base`/`--head`/
      // `--title` are value-flags, so the flag-injection defense here is the
      // leading-dash rejection of title+head above, NOT a terminator (which
      // would break the command). `git push` DOES get a `--` terminator.
      ["pr", "create", "--draft", "--repo", ownerRepo, "--body-file", bodyFile,
        "--base", opts.base, "--head", opts.head, "--title", opts.title],
      { timeout: 60_000, env },
    );
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
