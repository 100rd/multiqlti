/**
 * executor.ts — SDLC executor, component 5: orchestration.
 *
 * `runSdlcHandoff` is the REAL DEVELOPING side effect for the consilium loop. It
 * replaces the legacy single-file `dev-closeout` (which wrote a `.md` checklist
 * and mutated the user's checkout via `switchBranch`). One worktree + one branch
 * + ONE agentic coder session per ROUND (not per action point) → a single,
 * coherent Draft PR. Rationale for one-session-per-round: the action points of a
 * round are usually interdependent remediations of the same review; a single
 * agent session with all of them in scope produces a cohesive change set and one
 * reviewable PR, instead of N conflicting branches/PRs that each see only part of
 * the picture.
 *
 * Lifecycle (cleanup GUARANTEED):
 *   1. createSdlcWorktree(repo, B-3 branch, baseRef=default-branch HEAD)
 *   2. coder.run(worktreeDir, actionPoints)            ← real edits, confined
 *   3. git add -A (worktree is DEDICATED → add-all is safe, unlike dev-closeout)
 *   4. commit (server-sanitized message), read HEAD
 *   5. pushBranch + openDraftPr   (reused from pr-wrapper: B-3/H-6/H-7/M-6/M-7)
 *   6. removeSdlcWorktree in a `finally` — even on coder throw / timeout.
 *
 * NEVER THROWS. Returns `{ prRef, headCommit, error? }` (structurally the loop's
 * `DevCloseoutResult`), so the controller's DEVELOPING→AWAITING_MERGE transition
 * consumes `prRef` + `headCommit` exactly as before. Any failure degrades to a
 * branch-only / no-PR result with a scrubbed note; the loop is never failed here.
 *
 * SECURITY (BINDING — adversarial-review surface):
 *   - branch + PR title are SERVER-DERIVED ONLY (buildBranchName / fixed prefix).
 *     Action-point text NEVER reaches a branch, a PR title, or any shell string.
 *   - Untrusted action-point text reaches: the coder prompt (stdin only) and the
 *     commit BODY (sanitized + clamped, passed as an arg-array `-m` element —
 *     never a shell string). That is the ONLY place model text is persisted.
 *   - The coder is confined to the worktree (cwd + --add-dir). The worktree is a
 *     server-minted temp dir, physically separate from the user's checkout.
 *   - Agents NEVER apply/merge: this opens a DRAFT PR only. No push to main.
 */
import type { ActionPoint } from "@shared/types";
import { buildBranchName, isValidLoopBranch, pushBranch, openDraftPr } from "../consilium/pr-wrapper.js";
import {
  createSdlcWorktree,
  removeSdlcWorktree,
  resolveDefaultBranch,
  defaultGitRaw,
  type GitRunner,
  type CreateWorktreeResult,
} from "./worktree.js";
import { SdlcCoder, type CoderResult, type CoderOptions } from "./coder.js";

const COMMIT_SUBJECT_PREFIX = "consilium: SDLC changes for round";
const COMMIT_BODY_TITLE_MAX = 120;
const COMMIT_BODY_MAX = 4_000;

export interface SdlcHandoffRequest {
  /** Allowlisted repo to operate on. */
  repoPath: string;
  /** Loop id (uuid) — feeds the server-derived branch. */
  loopId: string;
  /** Round number — feeds the branch + commit/PR title. */
  round: number;
  /** The round's open action points to implement. */
  actionPoints: readonly ActionPoint[];
  /** Fail-closed repo allowlist (H-5). */
  allowedRepoPaths: readonly string[];
  /** PR base branch. Defaults to the repo's default branch. */
  base?: string;
  /** Worktree base commit-ish. Defaults to the repo's default branch HEAD. */
  baseRef?: string;
  /** Loop owner (audit only). */
  ownerId?: string;
}

export interface SdlcHandoffResult {
  /** Draft PR URL, or null on any non-PR path (no changes / push or gh failure). */
  prRef: string | null;
  /** HEAD sha of the SDLC branch after the commit; "" when nothing was committed. */
  headCommit: string;
  /** Scrubbed note present on any non-happy path. */
  error?: string;
}

/** Injectable seams (unit tests inject fakes — no real repo / claude / gh). */
export interface SdlcExecutorDeps {
  createWorktree?: typeof createSdlcWorktree;
  removeWorktree?: typeof removeSdlcWorktree;
  resolveDefaultBranchFn?: typeof resolveDefaultBranch;
  /** The agentic coder (default: a shared `SdlcCoder`). */
  runCoder?: (worktreeDir: string, aps: readonly ActionPoint[], opts?: CoderOptions) => Promise<CoderResult>;
  push?: typeof pushBranch;
  openPr?: typeof openDraftPr;
  gitRaw?: GitRunner;
}

const sharedCoder = new SdlcCoder();

/** Scrub fs layout from an error string before returning it. */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Sanitize an action-point title for the commit BODY: strip control chars /
 * newlines, collapse whitespace, clamp. The title is UNTRUSTED model text — even
 * though it goes in via an arg-array `-m` element (no shell), we keep it tidy and
 * bounded so it cannot bloat or smuggle terminal control sequences into git log.
 */
function sanitizeTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  return title
    .replace(/[\u0000-\u001f\u007f]+/g, " ") // strip control chars / newlines
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, COMMIT_BODY_TITLE_MAX);
}

/** Build the commit message: server-fixed subject + sanitized title checklist body. */
export function buildCommitMessage(round: number, aps: readonly ActionPoint[]): { subject: string; body: string } {
  const subject = `${COMMIT_SUBJECT_PREFIX} ${round}`;
  const lines = aps.map((ap) => `- ${sanitizeTitle(ap.title ?? "")}`);
  const body = ["Implements the open consilium action points:", "", ...lines].join("\n").slice(0, COMMIT_BODY_MAX);
  return { subject, body };
}

/** Build the server-derived PR title (NO model text — B-3 class guard). */
export function buildPrTitle(round: number): string {
  return `Consilium round ${round}: SDLC changes`;
}

/** Draft-PR body: server-fixed header + the agent's (clamped) own summary. */
function prBody(round: number, coder: CoderResult): string {
  const head = `Automated SDLC changes for consilium round ${round}.`;
  const summary = coder.summary ? `\n\n## Coder summary\n\n${coder.summary}` : "";
  return `${head}${summary}\n\nThis is a Draft PR — a human must review and merge.`;
}

/**
 * Run the full SDLC handoff for one round. Never throws. The worktree is removed
 * in a `finally`, so it is cleaned up even when the coder throws or times out.
 */
export async function runSdlcHandoff(
  req: SdlcHandoffRequest,
  deps: SdlcExecutorDeps = {},
): Promise<SdlcHandoffResult> {
  const gitRaw = deps.gitRaw ?? defaultGitRaw;
  const createWorktree = deps.createWorktree ?? createSdlcWorktree;
  const removeWorktree = deps.removeWorktree ?? removeSdlcWorktree;
  const resolveDefault = deps.resolveDefaultBranchFn ?? resolveDefaultBranch;
  const runCoder = deps.runCoder ?? ((dir, aps, opts) => sharedCoder.run(dir, aps, opts));
  const push = deps.push ?? pushBranch;
  const openPr = deps.openPr ?? openDraftPr;

  // B-3: server-derived branch; defensively re-gate before anything runs.
  const branch = buildBranchName(req.loopId, req.round);
  if (!isValidLoopBranch(branch)) {
    return { prRef: null, headCommit: "", error: "rejected branch name (B-3)" };
  }

  try {
    const base = req.base ?? (await resolveDefault(req.repoPath, gitRaw));
    const wt = await createWorktree({
      repoPath: req.repoPath,
      branch,
      baseRef: req.baseRef ?? base,
      allowedRepoPaths: req.allowedRepoPaths,
      gitRaw,
    });
    try {
      // Real edits in isolation. May throw (binary missing / timeout); the finally
      // below still removes the worktree.
      const coder = await runCoder(wt.worktreeDir, req.actionPoints);
      return await commitAndOpenPr(req, branch, base, wt, coder, { gitRaw, push, openPr });
    } finally {
      // Cleanup GUARANTEE: remove the worktree even on coder throw / timeout.
      await removeWorktree(req.repoPath, wt.worktreeDir, { baseDir: wt.baseDir, gitRaw });
    }
  } catch (err) {
    // createWorktree failed (disallowed repo / bad branch / git error) OR the
    // coder threw — degrade, never fail the loop.
    return { prRef: null, headCommit: "", error: scrub(err instanceof Error ? err.message : String(err)) };
  }
}

/** Stage everything in the dedicated worktree, commit, push, open the Draft PR. */
async function commitAndOpenPr(
  req: SdlcHandoffRequest,
  branch: string,
  base: string,
  wt: CreateWorktreeResult,
  coder: CoderResult,
  io: { gitRaw: GitRunner; push: typeof pushBranch; openPr: typeof openDraftPr },
): Promise<SdlcHandoffResult> {
  // The worktree is DEDICATED (server-minted, single round) → `add -A` is safe
  // here: there are no unrelated user files to sweep in (unlike dev-closeout's
  // single-file constraint over the user's shared checkout).
  await io.gitRaw(wt.worktreeDir, ["add", "-A"]);

  // Nothing produced (coder made no edits / failed before editing) → no PR.
  const staged = (await io.gitRaw(wt.worktreeDir, ["status", "--porcelain"])).trim();
  if (staged.length === 0) {
    const note = coder.ok ? "no changes produced" : `coder failed: ${coder.error ?? "unknown"}`;
    return { prRef: null, headCommit: "", error: note };
  }

  const { subject, body } = buildCommitMessage(req.round, req.actionPoints);
  // Arg-array `-m` elements — never a shell string. Untrusted title lives only in
  // the (sanitized) body element.
  await io.gitRaw(wt.worktreeDir, ["commit", "-m", subject, "-m", body]);
  const headCommit = (await io.gitRaw(wt.worktreeDir, ["rev-parse", "HEAD"])).trim();

  // Push from the worktree (shares the repo's object store + remotes). pr-wrapper
  // re-gates the branch (B-3) and runs under a sanitized env (H-7).
  const pushed = await io.push(wt.worktreeDir, branch);
  if (!pushed.ok) {
    return { prRef: null, headCommit, error: scrub(`push failed: ${pushed.message}`) };
  }

  const pr = await io.openPr(wt.worktreeDir, {
    base,
    head: branch,
    title: buildPrTitle(req.round), // server-derived; NO model text.
    body: prBody(req.round, coder),
  });
  if (!pr.ok) {
    return { prRef: null, headCommit, error: `pushed branch ${branch}; open PR manually` };
  }
  return { prRef: pr.prUrl, headCommit };
}
