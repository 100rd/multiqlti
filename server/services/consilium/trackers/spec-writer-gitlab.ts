/**
 * spec-writer-gitlab.ts — the GitLab dialect of `spec-writer.ts`: open the tracker
 * spec MR REMOTELY, via the GitLab REST API (never a local git checkout/commit).
 * NEVER throws.
 *
 * WHY REMOTE (no local git) — same contract as the gh writer: the poller runs in the
 * operator's server process; `targetRepoPath` is a live working tree they may be
 * editing. Every write goes through the sanitized `gitlab-exec` HTTP seam:
 *   1. GET  /projects/:path              → project id + default branch,
 *   2. GET  /merge_requests?source_branch → dedup (never a 2nd MR for the branch),
 *   3. GET  /repository/branches/:branch  → branch-exists probe (idempotent re-run),
 *   4. POST /repository/branches          → create the spec branch server-side,
 *   5. POST /repository/files/:path       → commit the spec file (base64) on it,
 *   6. POST /merge_requests               → open the MR.
 * The operator's working tree is never touched.
 *
 * WHY REST (not `glab`, which the loop's pr-wrapper shells out to): `glab mr create`
 * needs an already-pushed branch — i.e. LOCAL git mutations — while the REST calls
 * above create the branch and file entirely server-side, mirroring the gh writer's
 * `gh api` flow. The seam also keeps the PAT out of argv/logs.
 *
 * SECURITY — same discipline as the gh writer:
 *   - `branch` is SERVER-DERIVED and re-validated with SPEC_BRANCH_RE.
 *   - The MR title is control-stripped/clamped and leading-dash-rejected (it only
 *     travels as a JSON body value here, but the shared gate stays).
 *   - The GitLab project path is ORIGIN-DERIVED (`parseGitlabRemote`) and
 *     shape-validated; nested groups (`group/subgroup/project`) are supported.
 *   - Every call is never-throw via gitlab-exec (degrades to typed failures the
 *     poller logs + retries next cycle).
 */
import {
  gitlabGetJson,
  gitlabSendJson,
  type GitlabHttpFn,
  type GitlabAuth,
} from "./gitlab-exec.js";
import {
  isValidSpecBranch,
  sanitizeSpecTitle,
  type WriteSpecPrParams,
  type WriteSpecPrResult,
} from "./spec-writer.js";

/** Nested-group GitLab project path (2+ segments, conservative charset, no flags —
 *  a segment may not START with a dash, so a path can never be argv-flag-shaped). */
const GITLAB_PROJECT_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*(\/[A-Za-z0-9._][A-Za-z0-9._-]*)+$/;

/**
 * Parse a GitLab `origin` remote URL into the API base + project path.
 * Accepts `git@host:group/sub/project.git` and `https://host/group/sub/project(.git)`.
 * Returns `null` (fail-closed) for anything else — the caller degrades.
 */
export function parseGitlabRemote(
  remoteUrl: string,
): { baseUrl: string; projectPath: string } | null {
  let host: string | undefined;
  let path: string | undefined;

  const ssh = remoteUrl.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  if (ssh) {
    host = ssh[1];
    path = ssh[2];
  } else {
    try {
      const u = new URL(remoteUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      host = u.hostname;
      path = u.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }
  if (!host || !path) return null;

  const projectPath = path.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!GITLAB_PROJECT_PATH_RE.test(projectPath)) return null;
  // The API base is always https regardless of the remote transport.
  return { baseUrl: `https://${host}`, projectPath };
}

export interface GitlabSpecWriterDeps {
  /** Injectable GitLab HTTP transport (tests pass a fake — no real network). */
  gitlabHttp?: GitlabHttpFn;
  /** Injectable GitLab auth (tests pass a fake; prod reads env at call time). */
  gitlabAuth?: GitlabAuth | null;
  /** Read the TARGET git repo's `origin` URL (→ base + project path). */
  gitRemoteUrl: (repoPath: string) => Promise<string | null>;
  /** Structured logger. */
  log: (message: string) => void;
}

interface GitlabMr {
  web_url?: string;
  state?: string;
}

/**
 * Create the spec MR remotely (see module header for the flow). Never throws; every
 * failure is a typed `{ ok: false, reason }` sharing the gh writer's reason strings
 * so the pollers stay dialect-blind. `reused: true` ⇒ an MR for the branch already
 * existed (dedup) and was returned instead of creating a new one.
 */
export async function writeSpecMr(
  deps: GitlabSpecWriterDeps,
  params: WriteSpecPrParams,
): Promise<WriteSpecPrResult> {
  const { gitRemoteUrl, log } = deps;
  const exec = { http: deps.gitlabHttp, auth: deps.gitlabAuth, log };
  const { targetRepoPath, branch, filePath, fileContent, commitMessage, prTitle, prBody } = params;

  try {
    // 1) Validate the server-derived branch + reject a flag-shaped title.
    if (!isValidSpecBranch(branch)) {
      log(`spec-writer-gitlab: rejected branch (SPEC_BRANCH_RE): ${branch}`);
      return { ok: false, reason: "bad-branch" };
    }
    if (prTitle.startsWith("-")) {
      log("spec-writer-gitlab: rejected leading-dash MR title (flag injection)");
      return { ok: false, reason: "bad-title" };
    }
    const title = sanitizeSpecTitle(prTitle);
    if (title.length === 0 || title.startsWith("-")) {
      return { ok: false, reason: "bad-title" };
    }

    // 2) Origin-derived, validated base + project path (nested groups OK).
    const remoteUrl = await gitRemoteUrl(targetRepoPath);
    const parsed = remoteUrl ? parseGitlabRemote(remoteUrl) : null;
    if (!parsed) {
      log(`spec-writer-gitlab: no gitlab project path for ${targetRepoPath} — skip`);
      return { ok: false, reason: "bad-origin" };
    }
    const { baseUrl, projectPath } = parsed;
    const proj = `api/v4/projects/${encodeURIComponent(projectPath)}`;

    // 3) DEDUP: an existing MR for this source branch ⇒ reuse it, create nothing.
    const existing = await gitlabGetJson<GitlabMr[]>(exec, baseUrl, `${proj}/merge_requests`, {
      source_branch: branch,
      state: "all",
    });
    const found = existing?.find((m) => typeof m.web_url === "string" && m.web_url.length > 0);
    if (found?.web_url) {
      log(`spec-writer-gitlab: reusing existing spec MR for ${branch} on ${projectPath}`);
      return { ok: true, prUrl: found.web_url, reused: true };
    }

    // 4) Default branch (also proves the project is reachable with this PAT).
    const project = await gitlabGetJson<{ default_branch?: string }>(exec, baseUrl, proj);
    const base = project?.default_branch;
    if (!base || typeof base !== "string" || base.length === 0) {
      log(`spec-writer-gitlab: no default branch for ${projectPath} (degraded) — skip`);
      return { ok: false, reason: "no-default-branch" };
    }

    // 5) Create the branch (probe first so an idempotent re-run continues).
    const branchExists = await gitlabGetJson<{ name?: string }>(
      exec,
      baseUrl,
      `${proj}/repository/branches/${encodeURIComponent(branch)}`,
    );
    if (branchExists?.name === branch) {
      log(`spec-writer-gitlab: branch ${branch} already exists on ${projectPath} — continuing`);
    } else {
      const refRes = await gitlabSendJson(exec, "POST", baseUrl, `${proj}/repository/branches`, {
        branch,
        ref: base,
      });
      if (!refRes.ok) {
        log(`spec-writer-gitlab: branch create failed on ${projectPath}: ${refRes.reason}`);
        return { ok: false, reason: "branch-create-failed" };
      }
    }

    // 6) Commit the spec file on the branch (base64 content = inert bytes).
    const encPath = encodeURIComponent(filePath);
    const fileExists = await gitlabGetJson<{ file_path?: string }>(
      exec,
      baseUrl,
      `${proj}/repository/files/${encPath}`,
      { ref: branch },
    );
    if (fileExists?.file_path) {
      log(`spec-writer-gitlab: file ${filePath} already present on ${branch} — continuing to MR`);
    } else {
      const fileRes = await gitlabSendJson(exec, "POST", baseUrl, `${proj}/repository/files/${encPath}`, {
        branch,
        content: Buffer.from(fileContent, "utf8").toString("base64"),
        encoding: "base64",
        commit_message: commitMessage,
      });
      if (!fileRes.ok) {
        log(`spec-writer-gitlab: file create failed on ${projectPath}: ${fileRes.reason}`);
        return { ok: false, reason: "file-create-failed" };
      }
    }

    // 7) Open the MR. A race-created duplicate is recovered via re-dedup.
    const mrRes = await gitlabSendJson(exec, "POST", baseUrl, `${proj}/merge_requests`, {
      source_branch: branch,
      target_branch: base,
      title,
      description: prBody,
    });
    if (!mrRes.ok) {
      const recovered = await gitlabGetJson<GitlabMr[]>(exec, baseUrl, `${proj}/merge_requests`, {
        source_branch: branch,
        state: "all",
      });
      const mr = recovered?.find((m) => typeof m.web_url === "string" && m.web_url.length > 0);
      if (mr?.web_url) return { ok: true, prUrl: mr.web_url, reused: true };
      log(`spec-writer-gitlab: mr create failed on ${projectPath}: ${mrRes.reason}`);
      return { ok: false, reason: "pr-create-failed" };
    }
    let mrUrl: string | undefined;
    try {
      mrUrl = (JSON.parse(mrRes.body) as GitlabMr).web_url;
    } catch {
      /* fall through to the failure below */
    }
    if (!mrUrl) {
      log(`spec-writer-gitlab: mr created on ${projectPath} but no web_url in response`);
      return { ok: false, reason: "pr-create-failed" };
    }
    log(`spec-writer-gitlab: opened spec MR ${mrUrl}`);
    return { ok: true, prUrl: mrUrl, reused: false };
  } catch (err) {
    // Belt-and-braces: the seam never throws, but keep the writer never-throw too.
    log(`spec-writer-gitlab: unexpected error: ${(err as Error)?.message ?? String(err)}`);
    return { ok: false, reason: "exception" };
  }
}
