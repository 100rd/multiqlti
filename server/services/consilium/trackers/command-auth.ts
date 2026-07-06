/**
 * command-auth.ts — TRACK-6 (task-tracker-triggers.md §8): verify a COMMENTER is
 * authorised to run a `/spec`,`/approve`,`/stop` command on a GitHub issue. The
 * connector verifies the commenter's ROLE via the tracker API BEFORE acting — the
 * comment body is NEVER trusted to self-assert authority (an attacker can write any
 * comment; only the tracker knows who may command).
 *
 * WHO MAY COMMAND (§8): the ticket ASSIGNEE or a repo MAINTAINER.
 *   - ASSIGNEE — the login appears in the issue's `assignees`.
 *   - MAINTAINER — the login has repo push access: the collaborator permission is
 *     `admin` | `maintain` | `write` (GitHub's `repos/{repo}/collaborators/{login}/
 *     permission` endpoint). `read`/`none`/404 (not a collaborator) ⇒ NOT authorised.
 *
 * FAIL-CLOSED (adversarial: an unauthorized commenter executing a command)
 *   - A `gh` outage / auth error / unparseable response on EITHER check ⇒ NOT
 *     authorised (a degraded API can never grant authority). We only ever return
 *     `true` on a POSITIVE signal from GitHub.
 *   - The commenter `login` is shape-validated to GitHub's charset (`[A-Za-z0-9-]`, no
 *     leading dash) BEFORE it is placed in an `gh api` path segment — nothing
 *     attacker-shaped is read as a flag or can traverse the path. An invalid login ⇒
 *     NOT authorised.
 *   - `repo` is shape-validated `owner/repo`. `issueNumber` is a positive integer.
 *
 * READ-ONLY: this module only READS (issue assignees, collaborator permission). It
 * never writes and never throws.
 */
import { runGhJson, type ExecFileFn } from "../../github-status.js";

/** `owner/repo` — the conservative GitHub charset (no leading dash / no flag). */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** A GitHub login: 1–39 chars of `[A-Za-z0-9-]`, no leading/trailing/double dash. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** Collaborator permission levels that count as MAINTAINER (push access). */
const MAINTAINER_PERMISSIONS: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

/** True iff `login` is an assignee of the issue. Fail-closed on any degrade. */
async function isAssignee(
  repo: string,
  issueNumber: number,
  login: string,
  runGh?: ExecFileFn,
): Promise<boolean> {
  const view = await runGhJson<{ assignees?: Array<{ login?: string }> }>(
    ["issue", "view", String(issueNumber), "--repo", repo, "--json", "assignees"],
    runGh,
  );
  const assignees = view?.assignees;
  if (!Array.isArray(assignees)) return false;
  return assignees.some((a) => typeof a?.login === "string" && a.login === login);
}

/** True iff `login` has repo push access (admin/maintain/write). Fail-closed. */
async function isMaintainer(
  repo: string,
  login: string,
  runGh?: ExecFileFn,
): Promise<boolean> {
  // `gh api repos/<owner>/<repo>/collaborators/<login>/permission` → { permission }.
  // A non-collaborator returns 404 → runGhJson degrades to null → not a maintainer.
  const res = await runGhJson<{ permission?: string }>(
    ["api", `repos/${repo}/collaborators/${login}/permission`],
    runGh,
  );
  const permission = res?.permission;
  return typeof permission === "string" && MAINTAINER_PERMISSIONS.has(permission);
}

/**
 * Authorise a commenter to run a command on an issue. Returns `true` ONLY on a
 * positive GitHub signal (assignee OR maintainer); everything else — invalid shapes,
 * `gh` degrade, `read`/`none` permission, not found — is `false` (fail-closed). Never
 * throws.
 */
export async function isAuthorizedCommenter(
  params: { repo: string; issueNumber: number; login: string },
  runGh?: ExecFileFn,
): Promise<boolean> {
  const { repo, issueNumber, login } = params;
  if (!REPO_RE.test(repo)) return false;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return false;
  if (typeof login !== "string" || !LOGIN_RE.test(login)) return false;

  // Assignee is the cheaper, ticket-scoped check — try it first.
  if (await isAssignee(repo, issueNumber, login, runGh)) return true;
  if (await isMaintainer(repo, login, runGh)) return true;
  return false;
}
