/**
 * issue-writeback.ts — post the TRACK-1 write-back comments on a GitHub issue.
 * IDEMPOTENT, best-effort, NEVER throws.
 *
 * Two comment kinds, each keyed by a HIDDEN HTML marker so a re-poll never double-
 * posts (the marker is our own idempotency key — we scan existing comments for it
 * before posting):
 *   - PICKUP: after a spec PR is opened, tell the issue it was picked up + link the PR.
 *   - NEED-CRITERIA: when an issue has no testable acceptance criteria (and the
 *     synthesiser could not infer any), ask the human to add them. We do NOT open a
 *     spec PR and do NOT record intake, so the next poll re-checks after they edit.
 *
 * SECURITY
 *   - `repo` is shape-validated (`owner/repo`) up front — nothing attacker-shaped is
 *     read as a flag. `issueNumber` is a number. The comment body is composed of a
 *     server-fixed marker + a server-produced PR URL and is posted via `--body-file`
 *     (never argv), so no value is ever interpreted as a `gh` flag.
 *   - Best-effort: a `gh` failure (missing/unauth/rate-limited) logs + returns
 *     `{ posted: false }`. It NEVER throws — a write-back failure must never crash the
 *     poll cycle (the spec PR is already open; the comment is a nicety).
 */
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink } from "fs/promises";
import { runGhJson, type ExecFileFn } from "../../github-status.js";
import { runGhCapture } from "./gh-exec.js";

/** Hidden marker identifying our PICKUP comment (idempotency key). */
export const PICKUP_MARKER = "<!-- factory:track1:pickup -->";
/** Hidden marker identifying our NEED-CRITERIA comment (idempotency key). */
export const NEED_CRITERIA_MARKER = "<!-- factory:track1:need-criteria -->";

/**
 * TRACK-2 lifecycle markers. Each is keyed by ISSUE (implicit — the comment lives
 * ON the issue) + LOOP id + PHASE, so a re-poll (and a process restart) NEVER
 * double-posts a phase: the marker lives on the durable GitHub issue, and the
 * observer scans existing comments for it before posting. DISTINCT namespace from
 * TRACK-1's `factory:track1:*` — the pickup comment and the start comment never
 * collide (adversarial: "a race with TRACK-1's pickup comment").
 */
export const startMarker = (loopId: string): string => `<!-- factory:track2:start:${loopId} -->`;
export const prOpenedMarker = (loopId: string): string => `<!-- factory:track2:pr:${loopId} -->`;
export const verdictMarker = (loopId: string, round: number): string =>
  `<!-- factory:track2:verdict:${loopId}:${round} -->`;
export const terminalMarker = (loopId: string): string => `<!-- factory:track2:terminal:${loopId} -->`;

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Neutralise a dynamic (loop/user-authored) string before it enters a comment
 * body: strip control chars, collapse whitespace, and — CRUCIALLY — remove any
 * `<!--` / `-->` sequence so an inert `error` string can never forge one of our
 * idempotency markers (marker-forgery / double-post defence). Clamped to `max`.
 */
function sanitizeCommentText(value: string, max = 600): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    // Neutralise both HTML-comment delimiters (marker-forgery defence) using a
    // zero-width space so an inert error string can never carry `<!--`/`-->`.
    .replace(/<!--/g, "<\u200b!--")
    .replace(/-->/g, "--\u200b>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export interface WritebackDeps {
  runGh?: ExecFileFn;
  log: (message: string) => void;
}

export interface PostResult {
  posted: boolean;
  reason?: string;
}

/** True iff any existing comment body already carries `marker` (idempotency). */
async function alreadyMarked(
  repo: string,
  issueNumber: number,
  marker: string,
  runGh?: ExecFileFn,
): Promise<boolean> {
  const view = await runGhJson<{ comments?: Array<{ body?: string }> }>(
    ["issue", "view", String(issueNumber), "--repo", repo, "--json", "comments"],
    runGh,
  );
  const comments = view?.comments;
  if (!Array.isArray(comments)) return false;
  return comments.some((c) => typeof c.body === "string" && c.body.includes(marker));
}

/** Post `body` as an issue comment via a tmp `--body-file`. Never throws. */
async function postComment(
  deps: WritebackDeps,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<PostResult> {
  const bodyFile = join(tmpdir(), `track1-comment-${randomUUID()}.md`);
  try {
    await writeFile(bodyFile, body, "utf8");
    const res = await runGhCapture(
      ["issue", "comment", String(issueNumber), "--repo", repo, "--body-file", bodyFile],
      deps.runGh,
    );
    if (!res.ok) {
      deps.log(`issue-writeback: comment failed on ${repo}#${issueNumber}: ${res.stderr}`);
      return { posted: false, reason: "gh-failed" };
    }
    return { posted: true };
  } catch (err) {
    deps.log(`issue-writeback: comment error on ${repo}#${issueNumber}: ${(err as Error).message}`);
    return { posted: false, reason: "gh-failed" };
  } finally {
    await unlink(bodyFile).catch(() => undefined);
  }
}

/**
 * Post the PICKUP comment (idempotent): if a prior comment already carries
 * PICKUP_MARKER, do nothing (`{ posted: false, reason: "already-commented" }`).
 */
export async function postPickupComment(
  deps: WritebackDeps,
  params: { repo: string; issueNumber: number; specPrUrl: string },
): Promise<PostResult> {
  const { repo, issueNumber, specPrUrl } = params;
  if (!REPO_RE.test(repo)) {
    deps.log(`issue-writeback: rejected repo shape "${repo}"`);
    return { posted: false, reason: "bad-repo" };
  }
  if (await alreadyMarked(repo, issueNumber, PICKUP_MARKER, deps.runGh)) {
    return { posted: false, reason: "already-commented" };
  }
  const body = `${PICKUP_MARKER}\n🤖 picked up by the factory — spec at ${specPrUrl}`;
  return postComment(deps, repo, issueNumber, body);
}

/**
 * Post the NEED-CRITERIA comment (idempotent): if a prior comment already carries
 * NEED_CRITERIA_MARKER, do nothing. Used when an issue has no testable acceptance
 * criteria — we ask the human to add them instead of opening a spec PR.
 */
export async function postNeedCriteriaComment(
  deps: WritebackDeps,
  params: { repo: string; issueNumber: number },
): Promise<PostResult> {
  const { repo, issueNumber } = params;
  if (!REPO_RE.test(repo)) {
    deps.log(`issue-writeback: rejected repo shape "${repo}"`);
    return { posted: false, reason: "bad-repo" };
  }
  if (await alreadyMarked(repo, issueNumber, NEED_CRITERIA_MARKER, deps.runGh)) {
    return { posted: false, reason: "already-commented" };
  }
  const body =
    `${NEED_CRITERIA_MARKER}\n🤖 I can pick this up but need testable acceptance ` +
    `criteria — please add an "## Acceptance Criteria" section or checklist items.`;
  return postComment(deps, repo, issueNumber, body);
}

// ───────────────────────────────────────────────────────────────────────────
// TRACK-2 — the full write-back LIFECYCLE (start / verdict / PR / terminal).
//
// The TRACK-2 observer watches consilium loops READ-ONLY (loop-state poll) and
// comments each transition back on the origin issue. To BOUND `gh` traffic it
// reads a given issue's comments ONCE per cycle (`fetchIssueView`) and then
// checks every phase marker IN MEMORY — never one read per phase. Each poster is
// idempotent (skip if its marker is already present in the pre-fetched bodies),
// best-effort (a `gh` write failure logs + degrades, never throws), and only
// ever writes a server-fixed marker + sanitised text via `--body-file`.
// ───────────────────────────────────────────────────────────────────────────

/** A single read of an issue's open/closed state + all comment bodies. */
export interface IssueView {
  /** GitHub issue state, upper-cased ("OPEN" | "CLOSED"). */
  state: string;
  /** Every existing comment body (used for in-memory marker dedup). */
  commentBodies: string[];
}

/**
 * Read an issue's `state` + `comments` in ONE `gh` call. Returns `null` when `gh`
 * is degraded (missing/unauth/rate-limited) — the observer treats `null` as
 * "cannot read ⇒ do NOT post" so a blind write can never double-post (safety over
 * liveness). Never throws.
 */
export async function fetchIssueView(
  repo: string,
  issueNumber: number,
  runGh?: ExecFileFn,
): Promise<IssueView | null> {
  if (!REPO_RE.test(repo)) return null;
  const view = await runGhJson<{ state?: string; comments?: Array<{ body?: string }> }>(
    ["issue", "view", String(issueNumber), "--repo", repo, "--json", "state,comments"],
    runGh,
  );
  if (!view) return null;
  const comments = Array.isArray(view.comments) ? view.comments : [];
  const commentBodies = comments
    .map((c) => (typeof c.body === "string" ? c.body : ""))
    .filter((b) => b.length > 0);
  const state = typeof view.state === "string" ? view.state.toUpperCase() : "OPEN";
  return { state, commentBodies };
}

/**
 * Post `marker + \n + body` IFF no pre-fetched comment body already carries the
 * marker (in-memory idempotency — no extra `gh` read). Repo shape is re-validated
 * so nothing attacker-shaped is ever read as a flag. Never throws.
 */
async function postIfAbsent(
  deps: WritebackDeps,
  repo: string,
  issueNumber: number,
  existingBodies: readonly string[],
  marker: string,
  body: string,
): Promise<PostResult> {
  if (!REPO_RE.test(repo)) {
    deps.log(`issue-writeback: rejected repo shape "${repo}"`);
    return { posted: false, reason: "bad-repo" };
  }
  if (existingBodies.some((b) => b.includes(marker))) {
    return { posted: false, reason: "already-commented" };
  }
  return postComment(deps, repo, issueNumber, `${marker}\n${body}`);
}

/** Common params for every TRACK-2 lifecycle poster. `existingBodies` is pre-fetched. */
interface LifecycleParams {
  repo: string;
  issueNumber: number;
  loopId: string;
  existingBodies: readonly string[];
}

/** SPEC APPROVED / WORK STARTING: the loop launched from the committed spec. */
export async function postStartComment(
  deps: WritebackDeps,
  params: LifecycleParams,
): Promise<PostResult> {
  const { repo, issueNumber, loopId, existingBodies } = params;
  const body = `🤖 intent approved, work starting — consilium loop \`${sanitizeCommentText(loopId, 80)}\`.`;
  return postIfAbsent(deps, repo, issueNumber, existingBodies, startMarker(loopId), body);
}

/** CODE PR OPENED: the loop produced a Draft PR (link its ref). */
export async function postPrOpenedComment(
  deps: WritebackDeps,
  params: LifecycleParams & { prRef: string },
): Promise<PostResult> {
  const { repo, issueNumber, loopId, prRef, existingBodies } = params;
  const body = `🤖 draft PR opened for this ticket — ${sanitizeCommentText(prRef, 200)}`;
  return postIfAbsent(deps, repo, issueNumber, existingBodies, prOpenedMarker(loopId), body);
}

/** DEVELOP / VERDICT (opt-in): a per-round progress comment (action-point count). */
export async function postVerdictComment(
  deps: WritebackDeps,
  params: LifecycleParams & { round: number; summary: string },
): Promise<PostResult> {
  const { repo, issueNumber, loopId, round, summary, existingBodies } = params;
  const body = `🤖 review round ${round}: ${sanitizeCommentText(summary, 300)}`;
  return postIfAbsent(deps, repo, issueNumber, existingBodies, verdictMarker(loopId, round), body);
}

/** TERMINAL: converged / stopped_cap / failed / escalated — the #486 explanation. */
export async function postTerminalComment(
  deps: WritebackDeps,
  params: LifecycleParams & { title: string; detail: string; prRef?: string | null },
): Promise<PostResult> {
  const { repo, issueNumber, loopId, title, detail, prRef, existingBodies } = params;
  const prLine = prRef ? `\n\nPR: ${sanitizeCommentText(prRef, 200)}` : "";
  const body = `🤖 **${sanitizeCommentText(title, 80)}** — ${sanitizeCommentText(detail)}${prLine}`;
  return postIfAbsent(deps, repo, issueNumber, existingBodies, terminalMarker(loopId), body);
}

/**
 * Reopen a CLOSED issue (opt-in `writeback.reopenOnFailure` path only). Best-effort:
 * a `gh` failure logs + returns `{ posted: false }`, never throws. `gh issue reopen`
 * is a no-op on an already-open issue, so this stays idempotent under a re-poll.
 */
export async function reopenIssue(
  deps: WritebackDeps,
  params: { repo: string; issueNumber: number },
): Promise<PostResult> {
  const { repo, issueNumber } = params;
  if (!REPO_RE.test(repo)) {
    deps.log(`issue-writeback: rejected repo shape "${repo}"`);
    return { posted: false, reason: "bad-repo" };
  }
  const res = await runGhCapture(
    ["issue", "reopen", String(issueNumber), "--repo", repo],
    deps.runGh,
  );
  if (!res.ok) {
    deps.log(`issue-writeback: reopen failed on ${repo}#${issueNumber}: ${res.stderr}`);
    return { posted: false, reason: "gh-failed" };
  }
  return { posted: true };
}
