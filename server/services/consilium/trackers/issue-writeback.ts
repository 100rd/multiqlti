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

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

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
