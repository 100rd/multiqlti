/**
 * spec-intake.ts — the SHARED "crystallise a ticket into a committed spec PR" step,
 * used by EVERY tracker poller (GitHub TRACK-1, Jira TRACK-3, TRACK-4/5). This is the
 * single place the synth output becomes (a) a rendered spec markdown, (b) a remote
 * spec PR, and (c) a pickup write-back — so all connectors share ONE spec renderer
 * (`issue-spec.ts renderSpecMarkdown`), ONE spec-PR writer (`spec-writer.ts`), and ONE
 * provenance shape (`TicketSource`). A connector differs ONLY in the dialect it feeds
 * in (source, branch/file names, copy strings) and the write-back it supplies.
 *
 * WHAT STAYS IN THE POLLER (not here)
 *   The WATCH loop, the per-trigger WATERMARK (dedup — one spec per ticket), the
 *   MAX_PER_CYCLE budget, the allowlist + consent gates, and the extract/synth of
 *   criteria. This module is the crystallise TAIL only: it assumes the caller has
 *   already resolved the spec fields (criteria may be empty → ask-for-criteria).
 *
 * ORDER (identical to TRACK-1's original inline tail, so GitHub stays byte-identical)
 *   1. no testable criteria ⇒ post the ask-for-criteria write-back, open NO PR,
 *      return `need-criteria` (the caller does NOT record intake ⇒ re-checked next poll);
 *   2. else render the spec markdown (shared) and open the spec PR (shared, remote);
 *   3. PR failed ⇒ return `failed` (caller does NOT record intake ⇒ retried next cycle);
 *   4. PR ok ⇒ post the pickup write-back (mandatory, idempotent) and return `spec-pr`.
 */
import type { ExecFileFn } from "../../github-status.js";
import { renderSpecMarkdown, type TicketSource } from "./issue-spec.js";
import { writeSpecPr } from "./spec-writer.js";
import { writeSpecMr } from "./spec-writer-gitlab.js";
import type { GitlabHttpFn, GitlabAuth } from "./gitlab-exec.js";

/** The two write-back actions the crystallise step needs, supplied per connector. */
export interface CrystallizeWriteback {
  /** "picked up → spec at <PR>" (idempotent, best-effort). */
  pickup(specPrUrl: string): Promise<{ posted: boolean }>;
  /** "add testable acceptance criteria" (idempotent, best-effort). */
  needCriteria(): Promise<{ posted: boolean }>;
}

export interface CrystallizeDeps {
  /** Injectable `gh` runner for the remote spec PR (tests pass a fake). */
  runGh?: ExecFileFn;
  /** Read the TARGET git repo's `origin` URL (→ owner/repo for the PR). */
  gitRemoteUrl: (repoPath: string) => Promise<string | null>;
  /** The connector's pickup / need-criteria write-back. */
  writeback: CrystallizeWriteback;
  /** Structured logger. */
  log: (message: string) => void;
  /** Injectable GitLab transport/auth for a gitlab-origin target (tests pass fakes;
   *  prod reads GITLAB_TOKEN from env at call time). Unused for github origins. */
  gitlabHttp?: GitlabHttpFn;
  gitlabAuth?: GitlabAuth | null;
}

export interface CrystallizeTicketInput {
  /** Provenance the spec records (`{ kind, ref, url }`) — REQUIRED. */
  source: TicketSource;
  /** Allowlisted local git repo path → the spec's `repo:` frontmatter + PR target. */
  targetRepoPath: string;
  /** The deterministic dedup branch (`connector.specBranchName`). */
  branch: string;
  /** The committed spec path (`connector.specFilePath`). */
  filePath: string;
  /** The spec title (untrusted — rendered as a quoted YAML scalar). */
  title: string;
  status: "ready" | "draft";
  /** Resolved spec fields. `criteria` EMPTY ⇒ the ask-for-criteria path. */
  problem: string;
  scope?: string;
  outOfScope?: string;
  criteria: string[];
  role?: string;
  skills?: string[];
  /** Connector-specific PR/commit copy (GitHub carries `closes #n`; Jira does not). */
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

export type CrystallizeOutcome =
  | { outcome: "spec-pr"; prUrl: string; reused: boolean }
  | { outcome: "need-criteria" }
  | { outcome: "failed"; reason: string };

/**
 * Crystallise one ticket (see the ORDER contract above). NEVER throws — every failure
 * path is a typed outcome the poller logs and (for `failed`/`need-criteria`) leaves
 * OUT of the watermark so it is retried/re-checked.
 */
export async function crystallizeTicket(
  deps: CrystallizeDeps,
  input: CrystallizeTicketInput,
): Promise<CrystallizeOutcome> {
  // 1) No testable criteria — ask the human (idempotent), open NO spec PR.
  if (input.criteria.length === 0) {
    await deps.writeback.needCriteria();
    return { outcome: "need-criteria" };
  }

  // 2) Render the committed spec (SHARED renderer → identical bytes for every connector).
  const markdown = renderSpecMarkdown({
    title: input.title,
    source: input.source,
    repo: input.targetRepoPath,
    status: input.status,
    problem: input.problem,
    scope: input.scope,
    outOfScope: input.outOfScope,
    criteria: input.criteria,
    role: input.role,
    skills: input.skills,
  });

  // 3) Open the spec PR/MR remotely (SHARED writers; never touch the working tree).
  //    FORGE SNIFF (mirrors pr-wrapper's detectForge): a gitlab-hosted origin takes
  //    the GitLab MR dialect; everything else (incl. missing origin) stays on the
  //    pre-existing gh path — byte-identical for every github target.
  const writeParams = {
    targetRepoPath: input.targetRepoPath,
    branch: input.branch,
    filePath: input.filePath,
    fileContent: markdown,
    commitMessage: input.commitMessage,
    prTitle: input.prTitle,
    prBody: input.prBody,
  };
  const originUrl = await deps.gitRemoteUrl(input.targetRepoPath).catch(() => null);
  const res = /gitlab/i.test(originUrl ?? "")
    ? await writeSpecMr(
        {
          gitlabHttp: deps.gitlabHttp,
          gitlabAuth: deps.gitlabAuth,
          gitRemoteUrl: deps.gitRemoteUrl,
          log: deps.log,
        },
        writeParams,
      )
    : await writeSpecPr(
        { runGh: deps.runGh, gitRemoteUrl: deps.gitRemoteUrl, log: deps.log },
        writeParams,
      );
  if (!res.ok) {
    return { outcome: "failed", reason: res.reason };
  }

  // 4) WRITE-BACK (mandatory, idempotent, non-fatal): comment the pickup + PR link.
  await deps.writeback.pickup(res.prUrl);
  return { outcome: "spec-pr", prUrl: res.prUrl, reused: res.reused };
}
