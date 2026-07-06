/**
 * spec-writer.ts — open the TRACK-1 spec PR REMOTELY, via `gh api` (never a local
 * git checkout/commit). NEVER throws.
 *
 * WHY REMOTE (no local git)
 *   The poller runs in the operator's server process; the `targetRepoPath` is a live
 *   working tree they may be editing. Creating the spec branch/commit LOCALLY would
 *   mutate that tree (checkout, add, commit, push) — a side effect an unattended
 *   poll must never inflict. Instead every write goes through the `gh` HTTP seam:
 *     1. `gh pr list` (dedup — never a 2nd PR for the same issue branch),
 *     2. `gh repo view` → default branch, `gh api .../git/ref/heads/<base>` → base sha,
 *     3. `gh api POST .../git/refs` → create the spec branch server-side,
 *     4. `gh api PUT .../contents/<path>` → commit the spec file (base64) on that branch,
 *     5. `gh pr create` → open the PR.
 *   The operator's working tree is never touched. JSON reads use `runGhJson`
 *   (github-status.ts); writes use `runGhCapture` (gh-exec.ts) so we can tell
 *   "already exists" (idempotent re-run) from a hard failure.
 *
 * SECURITY
 *   - `branch` is SERVER-DERIVED (`spec/gh-issue-<n>`) and re-validated with
 *     SPEC_BRANCH_RE before it reaches `gh`. `filePath`/`commitMessage` are
 *     server-built from the issue number + sanitised slug. The ONLY untrusted embed
 *     is the issue title inside `prTitle` (leading-dash REJECTED + control-stripped +
 *     passed as an argv VALUE, never a flag) and inside `prBody` (via `--body-file`,
 *     never argv). `fileContent` is base64-encoded — inert bytes over the API.
 *   - `ownerRepo` is origin-derived (`parseOwnerRepo`, reused from github-poller) and
 *     shape-validated; nothing attacker-shaped can be read as a flag.
 *   - Every `gh` call is never-throw (runGhJson → null, runGhCapture → {ok:false});
 *     a gh outage/timeout degrades to a typed failure the poller logs + retries.
 *   - DEDUP is belt-and-braces: the deterministic branch + the pr-list check + the
 *     poller's watermark ⇒ never a duplicate PR, even across restarts.
 */
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink } from "fs/promises";
import { runGhJson, type ExecFileFn } from "../../github-status.js";
import { parseOwnerRepo } from "../../github-poller.js";
import { runGhCapture } from "./gh-exec.js";

/**
 * The server-derived spec branch shapes, one alternative per connector dialect:
 *   - GitHub    (TRACK-1): `spec/gh-issue-<n>`   (n = issue number)
 *   - Jira      (TRACK-3): `spec/jira-<KEY>`     (KEY = `PROJ-123`, uppercased)
 *   - GitLab    (TRACK-4): `spec/gitlab-<iid>`   (iid = project-internal issue id)
 *   - Bitbucket (TRACK-4): `spec/bitbucket-<id>` (id = issue id)
 * Every alternative is SERVER-DERIVED from a validated ticket id, so nothing
 * attacker-shaped (a leading dash, a path separator, a `..`) can reach `gh`. New
 * connectors (TRACK-5) add their own alternative here — the writer stays generic.
 */
export const SPEC_BRANCH_RE = /^spec\/(gh-issue-[0-9]+|jira-[A-Za-z0-9._-]+|gitlab-[0-9]+|bitbucket-[0-9]+)$/;

/** True iff `branch` is a server-derived tracker spec branch (any connector). */
export function isValidSpecBranch(branch: string): boolean {
  return SPEC_BRANCH_RE.test(branch);
}

export interface SpecWriterDeps {
  /** Injectable `gh` runner (tests pass a fake — no real `gh`/network). */
  runGh?: ExecFileFn;
  /** Read the target repo's `origin` URL (→ owner/repo). Injected for tests. */
  gitRemoteUrl: (repoPath: string) => Promise<string | null>;
  /** Structured logger. */
  log: (message: string) => void;
}

export interface WriteSpecPrParams {
  targetRepoPath: string;
  /**
   * The origin ticket id, for logging/traceability only (NOT used to build any
   * `gh` arg — the branch/path/title are pre-derived by the caller). Optional
   * because a Jira key is not a number; the GitHub caller still passes its number.
   */
  issueNumber?: number;
  branch: string;
  filePath: string;
  fileContent: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

export type WriteSpecPrResult =
  | { ok: true; prUrl: string; reused: boolean }
  | { ok: false; reason: string };

/** Single-line control-strip + clamp for the PR title (sanitizeEventLabel discipline). */
function sanitizeTitle(value: string, max = 200): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Pull the first http(s) URL out of `gh` stdout. */
function parsePrUrl(stdout: string): string | undefined {
  return stdout.match(/https?:\/\/\S+/)?.[0];
}

/** Find an existing PR URL for `branch` (dedup / already-exists recovery). */
async function findExistingPr(
  ownerRepo: string,
  branch: string,
  runGh?: ExecFileFn,
): Promise<string | undefined> {
  const list = await runGhJson<Array<{ url?: string; state?: string }>>(
    ["pr", "list", "--repo", ownerRepo, "--head", branch, "--state", "all", "--json", "url,state"],
    runGh,
  );
  if (Array.isArray(list)) {
    const found = list.find((p) => typeof p.url === "string" && p.url.length > 0);
    if (found?.url) return found.url;
  }
  return undefined;
}

/**
 * Create the spec PR remotely (see module header for the 5-step flow). Never throws;
 * every failure is a typed `{ ok: false, reason }`. Returns `reused: true` when an
 * existing PR for the branch was found (dedup) instead of creating a new one.
 */
export async function writeSpecPr(
  deps: SpecWriterDeps,
  params: WriteSpecPrParams,
): Promise<WriteSpecPrResult> {
  const { runGh, gitRemoteUrl, log } = deps;
  const { targetRepoPath, branch, filePath, fileContent, commitMessage, prTitle, prBody } = params;

  try {
    // 1) Validate the server-derived branch + reject a flag-injection title.
    if (!isValidSpecBranch(branch)) {
      log(`spec-writer: rejected branch (SPEC_BRANCH_RE): ${branch}`);
      return { ok: false, reason: "bad-branch" };
    }
    if (prTitle.startsWith("-")) {
      log("spec-writer: rejected leading-dash PR title (flag injection)");
      return { ok: false, reason: "bad-title" };
    }
    const title = sanitizeTitle(prTitle);
    if (title.length === 0 || title.startsWith("-")) {
      return { ok: false, reason: "bad-title" };
    }

    // 2) Origin-derived, validated owner/repo (reuse github-poller's parser).
    const remoteUrl = await gitRemoteUrl(targetRepoPath);
    const ownerRepo = remoteUrl ? parseOwnerRepo(remoteUrl) : null;
    if (!ownerRepo) {
      log(`spec-writer: no github owner/repo for ${targetRepoPath} — skip`);
      return { ok: false, reason: "bad-origin" };
    }

    // 3) DEDUP: an existing PR for this branch ⇒ reuse it, create nothing.
    const existing = await findExistingPr(ownerRepo, branch, runGh);
    if (existing) {
      log(`spec-writer: reusing existing spec PR for ${branch} on ${ownerRepo}`);
      return { ok: true, prUrl: existing, reused: true };
    }

    // 4) Default branch → base sha.
    const repoMeta = await runGhJson<{ defaultBranchRef?: { name?: string } }>(
      ["repo", "view", ownerRepo, "--json", "defaultBranchRef"],
      runGh,
    );
    const base = repoMeta?.defaultBranchRef?.name;
    if (!base || typeof base !== "string" || base.length === 0) {
      log(`spec-writer: no default branch for ${ownerRepo} (gh degraded) — skip`);
      return { ok: false, reason: "no-default-branch" };
    }
    const refInfo = await runGhJson<{ object?: { sha?: string } }>(
      ["api", `repos/${ownerRepo}/git/ref/heads/${base}`],
      runGh,
    );
    const baseSha = refInfo?.object?.sha;
    if (!baseSha || typeof baseSha !== "string" || baseSha.length === 0) {
      log(`spec-writer: no base sha for ${ownerRepo}@${base} (gh degraded) — skip`);
      return { ok: false, reason: "no-base-sha" };
    }

    // 5) Create the branch ref (already-exists ⇒ continue; other error ⇒ fail).
    const refRes = await runGhCapture(
      [
        "api", "--method", "POST", `repos/${ownerRepo}/git/refs`,
        "-f", `ref=refs/heads/${branch}`, "-f", `sha=${baseSha}`,
      ],
      runGh,
    );
    if (!refRes.ok) {
      if (/already exists|reference already exists|422/i.test(refRes.stderr)) {
        log(`spec-writer: branch ${branch} already exists on ${ownerRepo} — continuing`);
      } else {
        log(`spec-writer: branch create failed on ${ownerRepo}: ${refRes.stderr}`);
        return { ok: false, reason: "branch-create-failed" };
      }
    }

    // 6) Commit the spec file on the branch (base64 content = inert bytes).
    const base64 = Buffer.from(fileContent, "utf8").toString("base64");
    const fileRes = await runGhCapture(
      [
        "api", "--method", "PUT", `repos/${ownerRepo}/contents/${filePath}`,
        "-f", `message=${commitMessage}`, "-f", `content=${base64}`, "-f", `branch=${branch}`,
      ],
      runGh,
    );
    if (!fileRes.ok) {
      if (/already exists|sha.*wasn|422/i.test(fileRes.stderr)) {
        log(`spec-writer: file ${filePath} already present on ${branch} — continuing to PR`);
      } else {
        log(`spec-writer: file create failed on ${ownerRepo}: ${fileRes.stderr}`);
        return { ok: false, reason: "file-create-failed" };
      }
    }

    // 7) Open the PR — body via --body-file (never argv), title as an argv value.
    const bodyFile = join(tmpdir(), `track1-specpr-${randomUUID()}.md`);
    try {
      await writeFile(bodyFile, prBody, "utf8");
      const prRes = await runGhCapture(
        [
          "pr", "create", "--repo", ownerRepo,
          "--base", base, "--head", branch, "--title", title, "--body-file", bodyFile,
        ],
        runGh,
      );
      if (!prRes.ok) {
        if (/already exists/i.test(prRes.stderr)) {
          // TOCTOU: a PR appeared between the dedup check and create — recover it.
          const recovered = await findExistingPr(ownerRepo, branch, runGh);
          if (recovered) return { ok: true, prUrl: recovered, reused: true };
          return { ok: false, reason: "pr-create-failed" };
        }
        log(`spec-writer: pr create failed on ${ownerRepo}: ${prRes.stderr}`);
        return { ok: false, reason: "pr-create-failed" };
      }
      const prUrl = parsePrUrl(prRes.stdout);
      if (!prUrl) return { ok: false, reason: "no-pr-url" };
      return { ok: true, prUrl, reused: false };
    } finally {
      await unlink(bodyFile).catch(() => undefined);
    }
  } catch (err) {
    // Belt-and-braces: even a tmp-file write failure degrades to a typed failure.
    log(`spec-writer: unexpected error: ${(err as Error).message}`);
    return { ok: false, reason: "exception" };
  }
}
