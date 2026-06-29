/**
 * executor.ts — SDLC executor, component 5: orchestration.
 *
 * `runSdlcHandoff` is the REAL DEVELOPING side effect for the consilium loop. It
 * replaces the legacy single-file `dev-closeout` (which wrote a `.md` checklist
 * and mutated the user's checkout via `switchBranch`).
 *
 * ONE worktree + ONE branch per ROUND, but the agentic coder runs ONCE PER
 * ACTION POINT, SEQUENTIALLY, in that single worktree. After each run the
 * worktree is staged (`git add -A`) and committed — so each action point becomes
 * its own commit on the round branch. At the end, if the branch has ANY commits,
 * we push + open ONE Draft PR aggregating them.
 *
 * Why per-action-point (a live run hit the old single-session 600s timeout on 3
 * large architectural P0s → no commit → all work discarded): a smaller unit of
 * work per coder run fits under the timeout, and — crucially — PARTIAL PRESERVE
 * means a run that times out or errors still has its work committed (with a
 * `[partial]` marker) before moving on, so the human gate sees real progress
 * instead of an empty timeout. Within a round the per-AP runs are SEQUENTIAL (one
 * shared worktree → avoid edit conflicts); the coder's ConcurrencyLimiter still
 * bounds concurrent coders ACROSS loops.
 *
 * Lifecycle (cleanup GUARANTEED):
 *   1. createSdlcWorktree(repo, B-3 branch, baseRef=default-branch HEAD)
 *   2. for each action point, sequentially:
 *        a. coder.run(worktreeDir, [ap], { timeoutMs })   ← real edits, confined
 *        b. git add -A; if dirty → commit (server-fixed subject; `[partial]` body
 *           marker when the run timed out / errored). Track per-AP outcome.
 *   3. if ANY commit → pushBranch + openDraftPr (body = per-AP status summary)
 *   4. removeSdlcWorktree in a `finally` — even on coder throw / timeout.
 *
 * NEVER THROWS. Returns `{ prRef, headCommit, error? }` (structurally the loop's
 * `DevCloseoutResult`), so the controller's DEVELOPING→AWAITING_MERGE transition
 * consumes `prRef` + `headCommit` exactly as before. Only when ZERO commits exist
 * does it degrade to `{ prRef: null, headCommit: "", error }`.
 *
 * SECURITY (BINDING — adversarial-review surface; UNCHANGED from before):
 *   - branch + PR title are SERVER-DERIVED ONLY (buildBranchName / fixed prefix).
 *     Action-point text NEVER reaches a branch, a PR title, or any shell string.
 *   - Untrusted action-point text reaches: the coder prompt (stdin only) and the
 *     commit SUBJECT + BODY + PR-body status lines — all sanitized (control chars
 *     stripped) + clamped and passed as arg-array elements (commit via `-m`, PR
 *     body via `--body-file` in pr-wrapper), NEVER a shell string.
 *   - The coder is confined to the worktree (cwd + --add-dir); NO Bash; spawned
 *     under a sanitized allowlisted env. The worktree is a server-minted temp dir.
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

const COMMIT_SUBJECT_TITLE_MAX = 100;
const COMMIT_BODY_TITLE_MAX = 120;
const COMMIT_BODY_RATIONALE_MAX = 1_000;
const COMMIT_BODY_MAX = 4_000;
const PRIORITY_MAX = 16;
const PR_BODY_TITLE_MAX = 120;
const PR_BODY_MAX = 16_000;

/** Per-action-point outcome status surfaced in the Draft PR body. */
export type ApStatus = "completed" | "partial" | "failed";

export interface ApOutcome {
  /** 1-based position in the round. */
  index: number;
  /** Sanitized priority (e.g. "P0"). */
  priority: string;
  /** Sanitized title (display only). */
  title: string;
  /** completed = ran clean + committed (or a clean no-op); partial = timed out /
   *  errored but committed work-in-progress; failed = errored with nothing to commit. */
  status: ApStatus;
  /** Whether this action point produced a commit on the branch. */
  committed: boolean;
  /** Short server-generated note (e.g. "coder timed out", "no file changes"). */
  note?: string;
}

export interface SdlcHandoffRequest {
  /** Allowlisted repo to operate on. */
  repoPath: string;
  /** Loop id (uuid) — feeds the server-derived branch. */
  loopId: string;
  /** Round number — feeds the branch + commit/PR title. */
  round: number;
  /** The round's open action points to implement (one coder run EACH). */
  actionPoints: readonly ActionPoint[];
  /** Fail-closed repo allowlist (H-5). */
  allowedRepoPaths: readonly string[];
  /** PR base branch. Defaults to the repo's default branch. */
  base?: string;
  /** Worktree base commit-ish. Defaults to the repo's default branch HEAD. */
  baseRef?: string;
  /** Loop owner (audit only). */
  ownerId?: string;
  /** Hard timeout PER action-point coder run (ms). Defaults to the coder default. */
  coderTimeoutMs?: number;
}

export interface SdlcHandoffResult {
  /** Draft PR URL, or null when ZERO commits were produced / push or gh failed. */
  prRef: string | null;
  /** HEAD sha of the SDLC branch after the last commit; "" when nothing committed. */
  headCommit: string;
  /** Scrubbed note present on any non-happy path. */
  error?: string;
}

/** Injectable seams (unit tests inject fakes — no real repo / claude / gh). */
export interface SdlcExecutorDeps {
  createWorktree?: typeof createSdlcWorktree;
  removeWorktree?: typeof removeSdlcWorktree;
  resolveDefaultBranchFn?: typeof resolveDefaultBranch;
  /** The agentic coder (default: a shared `SdlcCoder`). Called ONCE PER action point. */
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
 * Sanitize UNTRUSTED model text for a SINGLE-LINE field (commit subject / PR
 * status line): strip control chars / newlines, collapse whitespace, clamp.
 * Passed only as arg-array / body-file content — never a shell string.
 */
function sanitizeLine(value: string, max: number): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ") // strip control chars / newlines
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Build the server-derived PR title (NO model text — B-3 class guard). */
export function buildPrTitle(round: number): string {
  return `Consilium round ${round}: SDLC changes`;
}

/**
 * Build ONE action point's commit message. Subject is server-fixed shape carrying
 * the sanitized priority + clamped title; the body carries the (sanitized) title,
 * rationale, the AP position, and a `[partial]` marker + note when the run timed
 * out / errored. All values are arg-array `-m` elements (never a shell string).
 */
export function buildApCommitMessage(
  round: number,
  ap: ActionPoint,
  index: number,
  total: number,
  isPartial: boolean,
  note?: string,
): { subject: string; body: string } {
  const priority = sanitizeLine(ap.priority ?? "-", PRIORITY_MAX) || "-";
  const subject = `Consilium round ${round}: ${priority} ${sanitizeLine(ap.title ?? "", COMMIT_SUBJECT_TITLE_MAX)}`.trim();
  const lines: string[] = [
    sanitizeLine(ap.title ?? "", COMMIT_BODY_TITLE_MAX),
    "",
    `Action point ${index}/${total} (priority ${priority}) of consilium round ${round}.`,
  ];
  if (isPartial) {
    lines.push("[partial] coder run timed out or errored — committing work-in-progress.");
  }
  if (note) lines.push(`Note: ${sanitizeLine(note, 200)}`);
  const rationale = sanitizeLine(ap.rationale ?? "", COMMIT_BODY_RATIONALE_MAX);
  if (rationale) lines.push(`Rationale: ${rationale}`);
  return { subject: subject.slice(0, 200), body: lines.join("\n").slice(0, COMMIT_BODY_MAX) };
}

/** Draft-PR body: server-fixed header + per-action-point status summary. */
export function buildPrStatusBody(round: number, outcomes: readonly ApOutcome[]): string {
  const lines = outcomes.map((o) => {
    const tail = o.note ? ` — ${sanitizeLine(o.note, 120)}` : "";
    return `- [${o.status}] (${o.priority}) ${sanitizeLine(o.title, PR_BODY_TITLE_MAX)}${tail}`;
  });
  const committed = outcomes.filter((o) => o.committed).length;
  return [
    `Automated SDLC changes for consilium round ${round}.`,
    "",
    `Per action-point status (${committed}/${outcomes.length} produced commits):`,
    "",
    ...lines,
    "",
    "This is a Draft PR — a human must review and merge.",
  ].join("\n").slice(0, PR_BODY_MAX);
}

/**
 * Run the full SDLC handoff for one round. Never throws. The worktree is removed
 * in a `finally`, so it is cleaned up even when a coder run throws / times out.
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
  if (req.actionPoints.length === 0) {
    return { prRef: null, headCommit: "", error: "no action points to implement" };
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
      // SEQUENTIAL per-action-point runs in the ONE shared worktree (avoid edit
      // conflicts). Each `runActionPoint` NEVER throws — a coder timeout/error is
      // caught, its work committed `[partial]`, and the loop continues.
      const outcomes: ApOutcome[] = [];
      let committedCount = 0;
      for (let i = 0; i < req.actionPoints.length; i++) {
        const outcome = await runActionPoint(
          { gitRaw, runCoder },
          wt,
          req,
          req.actionPoints[i],
          i + 1,
          req.actionPoints.length,
        );
        outcomes.push(outcome);
        if (outcome.committed) committedCount += 1;
      }
      return await pushAndOpenPr(req, branch, base, wt, outcomes, committedCount, { gitRaw, push, openPr });
    } finally {
      // Cleanup GUARANTEE: remove the worktree even on any failure above.
      await removeWorktree(req.repoPath, wt.worktreeDir, { baseDir: wt.baseDir, gitRaw });
    }
  } catch (err) {
    // createWorktree failed (disallowed repo / bad branch / git error) — degrade.
    return { prRef: null, headCommit: "", error: scrub(err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * Run ONE action point: coder → `git add -A` → commit (partial-preserve on
 * timeout/error). NEVER throws — every failure is captured into the returned
 * outcome so the round continues and partial work is preserved.
 */
async function runActionPoint(
  io: { gitRaw: GitRunner; runCoder: NonNullable<SdlcExecutorDeps["runCoder"]> },
  wt: CreateWorktreeResult,
  req: SdlcHandoffRequest,
  ap: ActionPoint,
  index: number,
  total: number,
): Promise<ApOutcome> {
  const priority = sanitizeLine(ap.priority ?? "-", PRIORITY_MAX) || "-";
  const title = sanitizeLine(ap.title ?? "", PR_BODY_TITLE_MAX);
  const base: Omit<ApOutcome, "status" | "committed" | "note"> = { index, priority, title };

  // 1. Run the coder for THIS action point only. A throw (timeout / binary
  //    missing) is caught — its partial edits are still committed below.
  let threw = false;
  let coder: CoderResult | null = null;
  let runNote: string | undefined;
  try {
    coder = await io.runCoder(wt.worktreeDir, [ap], { timeoutMs: req.coderTimeoutMs });
  } catch (err) {
    threw = true;
    runNote = scrub(err instanceof Error ? err.message : String(err));
  }

  // 2. Stage whatever the run produced (partial or complete) and check for change.
  let dirty = false;
  try {
    await io.gitRaw(wt.worktreeDir, ["add", "-A"]);
    dirty = (await io.gitRaw(wt.worktreeDir, ["status", "--porcelain"])).trim().length > 0;
  } catch (err) {
    // A git failure here means we cannot commit this AP — mark failed, continue.
    return { ...base, status: "failed", committed: false, note: scrub(err instanceof Error ? err.message : String(err)) };
  }

  const ranClean = !threw && coder !== null && coder.ok;

  // 3a. Nothing to commit.
  if (!dirty) {
    if (ranClean) {
      return { ...base, status: "completed", committed: false, note: "no file changes" };
    }
    return { ...base, status: "failed", committed: false, note: runNote ?? coder?.error ?? "no changes produced" };
  }

  // 3b. There are changes → commit them. A clean run → "completed"; a
  //     timed-out/errored run that still produced edits → "partial".
  const isPartial = threw || (coder !== null && !coder.ok);
  const note = isPartial ? (runNote ?? coder?.error ?? "coder did not finish") : undefined;
  const { subject, body } = buildApCommitMessage(req.round, ap, index, total, isPartial, note);
  try {
    // Arg-array `-m` elements — never a shell string. Untrusted text only here.
    await io.gitRaw(wt.worktreeDir, ["commit", "-m", subject, "-m", body]);
  } catch (err) {
    return { ...base, status: "failed", committed: false, note: scrub(err instanceof Error ? err.message : String(err)) };
  }
  return {
    ...base,
    status: isPartial ? "partial" : "completed",
    committed: true,
    note,
  };
}

/**
 * After all action points: if ANY commit exists, push the branch + open ONE Draft
 * PR whose body summarizes per-AP status. ZERO commits → `{ prRef: null }` + error.
 */
async function pushAndOpenPr(
  req: SdlcHandoffRequest,
  branch: string,
  base: string,
  wt: CreateWorktreeResult,
  outcomes: readonly ApOutcome[],
  committedCount: number,
  io: { gitRaw: GitRunner; push: typeof pushBranch; openPr: typeof openDraftPr },
): Promise<SdlcHandoffResult> {
  if (committedCount === 0) {
    // Every action point failed / produced nothing — no branch to PR (as today).
    const failed = outcomes.find((o) => o.note)?.note;
    return { prRef: null, headCommit: "", error: failed ? `no commits produced: ${failed}` : "no changes produced" };
  }

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
    body: buildPrStatusBody(req.round, outcomes),
  });
  if (!pr.ok) {
    return { prRef: null, headCommit, error: `pushed branch ${branch}; open PR manually` };
  }
  return { prRef: pr.prUrl, headCommit };
}
