/**
 * github-crystallize.ts — TRACK-6: the ONE GitHub "issue → committed spec PR" dialect,
 * shared by the label-poll intake (`github-issues-poller.ts`) and the `/spec`
 * force-intake command (`github-command-poller.ts`) so the two CANNOT drift. It fixes
 * the GitHub copy (commit message, PR title/body, `closes #n`), the deterministic
 * branch/file names, the `{ kind:"github", ref }` provenance, and the pickup /
 * need-criteria write-backs, then delegates to the connector-agnostic
 * `crystallizeTicket` (spec-intake.ts) — the SAME shared renderer + spec-writer + order
 * every tracker uses.
 *
 * BYTE-IDENTICAL: extracted verbatim from TRACK-1's inline tail — the same argv, the
 * same order, the same copy — so `github-issues-poller.test.ts`'s round-trip assertions
 * are unchanged. The `/spec` command path reuses it so a forced spec is identical to a
 * labelled-intake spec (only the trigger differs).
 */
import type { ExecFileFn } from "../../github-status.js";
import { specBranchName, specFilePath } from "./issue-spec.js";
import { crystallizeTicket, type CrystallizeOutcome } from "./spec-intake.js";
import { postPickupComment, postNeedCriteriaComment } from "./issue-writeback.js";
import type { RoleStamp } from "./role-stamp.js";

/** Single-line control-strip + collapse + clamp for the (untrusted) issue title. */
export function sanitizeTitleLine(value: string, max = 160): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export interface GithubCrystallizeDeps {
  runGh?: ExecFileFn;
  gitRemoteUrl: (repoPath: string) => Promise<string | null>;
  log: (message: string) => void;
}

export interface GithubCrystallizeInput {
  /** `owner/repo` (already shape-validated by the caller). */
  repo: string;
  /** Allowlisted local repo path (already allowlist-validated by the caller). */
  targetRepoPath: string;
  /** The issue number (positive integer, validated by the caller). */
  number: number;
  /** The raw (untrusted) issue title — rendered as a quoted YAML scalar downstream. */
  title: string;
  url?: string;
  status: "ready" | "draft";
  /** Resolved spec fields (criteria EMPTY ⇒ the ask-for-criteria path). */
  problem: string;
  scope?: string;
  outOfScope?: string;
  criteria: string[];
  /** TRACK-6: the role STAMP (name + skills) → spec frontmatter; undefined ⇒ unstamped. */
  roleStamp?: RoleStamp | null;
}

/**
 * Crystallise one GitHub issue into a committed spec PR + pickup comment (or an
 * ask-for-criteria comment when there are no testable criteria). Byte-identical to
 * TRACK-1's inline tail. Never throws (every failure is a typed `CrystallizeOutcome`).
 */
export async function crystallizeGithubIssue(
  deps: GithubCrystallizeDeps,
  input: GithubCrystallizeInput,
): Promise<CrystallizeOutcome> {
  const { repo, number } = input;
  const sanitizedTitle = sanitizeTitleLine(input.title);
  const commitMessage = `feat: add spec for issue #${number} (closes #${number})`;
  const prTitle = `spec: ${sanitizedTitle || `issue #${number}`} (closes #${number})`;
  const prBody = [
    `Track-1 auto-produced spec for issue #${number}.`,
    "",
    "This spec was generated from the linked GitHub issue by the factory's Track-1 intake.",
    "Merging it fires the SPEC-1 spec-watch, which launches the review loop off the committed spec.",
    "",
    `Closes #${number}`,
  ].join("\n");

  return crystallizeTicket(
    {
      runGh: deps.runGh,
      gitRemoteUrl: deps.gitRemoteUrl,
      log: deps.log,
      writeback: {
        pickup: (specPrUrl) =>
          postPickupComment(
            { runGh: deps.runGh, log: deps.log },
            { repo, issueNumber: number, specPrUrl },
          ),
        needCriteria: () =>
          postNeedCriteriaComment(
            { runGh: deps.runGh, log: deps.log },
            { repo, issueNumber: number },
          ),
      },
    },
    {
      source: { kind: "github", ref: String(number), url: input.url },
      targetRepoPath: input.targetRepoPath,
      branch: specBranchName(number),
      filePath: specFilePath(number, input.title),
      title: input.title.trim().length > 0 ? input.title : `Issue #${number}`,
      status: input.status,
      problem: input.problem,
      scope: input.scope,
      outOfScope: input.outOfScope,
      criteria: input.criteria,
      // TRACK-6: stamp the role's name + skills so the merged spec fires the ROLE's loop.
      role: input.roleStamp?.role,
      skills: input.roleStamp?.skills,
      commitMessage,
      prTitle,
      prBody,
    },
  );
}
