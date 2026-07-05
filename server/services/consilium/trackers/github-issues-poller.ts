/**
 * github-issues-poller.ts — TRACK-1: poll GitHub ISSUES and turn each labelled,
 * spec-ready issue into a committed spec PR + a pickup comment. Mirrors
 * `github-poller.ts` (watermark in trigger `config` jsonb, never-throw per
 * cycle/trigger, project-scoped context, kill-switch gating).
 *
 * ARCHITECTURE — TRACK-1 does NOT fire loops
 *   This poller is a spec PRODUCER + ticket UPDATER. It RIDES SPEC-1's already-
 *   shipped spec-watch: it opens a PR that ADDS a `docs/specs/gh-issue-<n>-*.md`
 *   spec to the target repo; when a human MERGES that PR, the spec-watch fires the
 *   review loop off the committed spec. So this module NEVER touches
 *   `trigger-dispatch.ts` / `fireTrigger` and never launches a loop itself. Its
 *   pipeline is: poll issues → synthesise/normalise a spec → open the spec PR
 *   (remotely, via `gh` — never a local checkout) → post the pickup comment →
 *   advance the watermark.
 *
 * RAILS (adversarial)
 *   (a) RE-INTAKE THE SAME ISSUE — a per-trigger WATERMARK (`pollState.intake`,
 *       issue number → { specPrUrl, at }) is persisted in `config` jsonb; an issue
 *       already intaken is skipped. Combined with the DETERMINISTIC spec branch
 *       (`spec/gh-issue-<n>`) + spec-writer's pr-list dedup ⇒ NEVER a 2nd PR, NEVER
 *       a double comment.
 *   (b) INTAKE STORM — a per-cycle budget (MAX_PER_CYCLE) bounds how many NEW specs
 *       one poll opens; the rest wait for the next cycle. The interval (min 60s) +
 *       the label gate + the two kill-switches bound cadence.
 *   (c) gh OUTAGE — every read is `runGhJson` (→ null) and every write is
 *       `runGhCapture`/never-throw; a null issue-list SKIPS the cycle WITHOUT
 *       touching the watermark. Each trigger + each cycle is wrapped so one failure
 *       never stops the others.
 *   (d) CONSENT + BLAST RADIUS — the `filter.label` is REQUIRED (the label is the
 *       operator's consent-to-intake); `targetRepoPath` MUST be in the fail-closed
 *       allowlist (realpath-normalised both sides) or the trigger is skipped.
 *
 * SECURITY
 *   The `gh` token is never read/logged. Untrusted issue title/body is fenced before
 *   any prompt (issue-spec.ts), control-stripped + slugified before any filename/
 *   branch, leading-dash-rejected before any PR title, and only ever an argv VALUE /
 *   `--body-file` — never a shell string. `targetRepoPath` is the allowlisted local
 *   path that becomes the spec's `repo:` frontmatter (SPEC-1's resolveSpecRepo maps
 *   it); it is validated against the allowlist HERE and re-validated by SPEC-1 on
 *   merge.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { realpathSync } from "fs";
import { resolve } from "path";
import type { TriggerRow } from "@shared/schema";
import type { TrackerEventTriggerConfig, TrackerPollState } from "@shared/types";
import type { AppConfig } from "../../../config/schema.js";
import { runGhJson, type ExecFileFn } from "../../github-status.js";
import {
  extractSpecFromIssue,
  specBranchName,
  specFilePath,
  buildSpecMarkdown,
  type GhIssue,
} from "./issue-spec.js";
import { writeSpecPr } from "./spec-writer.js";
import { postPickupComment, postNeedCriteriaComment } from "./issue-writeback.js";

const execFileAsync: ExecFileFn = promisify(execFile);

/** `owner/repo` — conservative GitHub name charset (no leading dash / no flag). */
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Max NEW intakes opened per poll cycle (bounds blast radius). */
const MAX_PER_CYCLE = 20;
/** Cap on tracked intakes per trigger (bounds the watermark jsonb). */
const MAX_TRACKED_INTAKE = 500;

/**
 * INJECTABLE spec synthesiser for FREE-FORM issues (no spec-shaped body). The
 * production impl wraps the model gateway (see routes wiring); tests inject a fake.
 * Returns criteria (+ optional problem/scope/outOfScope). No criteria ⇒ the poller
 * falls through to the ask-for-criteria path.
 */
export interface SpecSynthesizer {
  synthesize(issue: GhIssue): Promise<{
    problem?: string;
    scope?: string;
    outOfScope?: string;
    criteria: string[];
  }>;
}

export interface GithubIssuesPollerDeps {
  /** Cross-project, SYSTEM-context load of enabled tracker_event triggers (runAsSystem). */
  getEnabledTriggersByType: (type: "tracker_event") => Promise<TriggerRow[]>;
  /** Establish a project-scoped ALS context for one trigger's poll (= runAsProject). */
  runInProject: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
  /** Re-read a trigger fresh so the watermark write does not clobber a concurrent edit. */
  getTrigger: (id: string) => Promise<TriggerRow | undefined>;
  /** Persist the advanced watermark (writes back `config` with `pollState`). */
  updateTrigger: (id: string, updates: Partial<TriggerRow>) => Promise<unknown>;
  /** Live config accessor (kill-switches + interval). */
  config: () => AppConfig;
  /** Fail-closed allowlist of local repo paths (consilium-loop allowlist). */
  allowedRepoPaths: () => string[];
  /** Optional model-backed synthesiser for free-form issues (absent ⇒ normalise-only). */
  synthesizer?: SpecSynthesizer;
  /** Injectable `gh` runner (tests pass a fake — no real `gh`/network). */
  runGh?: ExecFileFn;
  /** Injectable git-remote reader for the owner/repo derivation (default: real `git`). */
  gitRemoteUrl?: (repoPath: string) => Promise<string | null>;
  /** Structured logger. */
  log: (message: string) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Default git-remote reader: `git -C <repoPath> remote get-url origin`. NEVER throws.
 * `repoPath` is an allowlisted config value (validated before we get here).
 */
async function defaultGitRemoteUrl(
  repoPath: string,
  run: ExecFileFn = execFileAsync,
): Promise<string | null> {
  try {
    const { stdout } = await run(
      "git",
      ["-C", repoPath, "remote", "get-url", "origin"],
      { timeout: 10_000 },
    );
    const url = (stdout ?? "").trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/** Best-effort realpath (collapses symlinks/`..` for an EXISTING path), else lexical resolve. */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Fail-closed allowlist check (copy of trigger-dispatch's resolve/realpath idea):
 * `targetRepoPath` must realpath-equal an allowed root or sit strictly beneath one.
 * A non-existent path falls back to a LEXICAL resolve so `..` can never prefix-match.
 */
function isAllowedRepoPath(targetRepoPath: string, allowed: readonly string[]): boolean {
  const target = canonicalPath(targetRepoPath);
  for (const a of allowed) {
    const root = canonicalPath(a);
    if (target === root || target.startsWith(root + "/")) return true;
  }
  return false;
}

/** Single-line control-strip + collapse + clamp for the (untrusted) issue title. */
function sanitizeTitleLine(value: string, max = 160): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Keep at most MAX_TRACKED_INTAKE intakes (highest issue numbers win — most recent). */
function boundIntake(
  intake: Record<string, { specPrUrl?: string; at: string }>,
): Record<string, { specPrUrl?: string; at: string }> {
  const keys = Object.keys(intake);
  if (keys.length <= MAX_TRACKED_INTAKE) return intake;
  const kept = keys
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)
    .slice(0, MAX_TRACKED_INTAKE)
    .map((n) => String(n));
  const out: Record<string, { specPrUrl?: string; at: string }> = {};
  for (const k of kept) out[k] = intake[k];
  return out;
}

export class GithubIssuesPoller {
  private readonly deps: GithubIssuesPollerDeps;
  private readonly gitRemoteUrl: (repoPath: string) => Promise<string | null>;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(deps: GithubIssuesPollerDeps) {
    this.deps = deps;
    this.gitRemoteUrl = deps.gitRemoteUrl ?? ((p) => defaultGitRemoteUrl(p));
    this.now = deps.now ?? Date.now;
  }

  /**
   * Start the interval poller IFF `features.triggers.tracker.enabled`. The caller
   * only constructs + starts this when the kill-switch is on. Idempotent.
   */
  start(): void {
    if (this.timer) return;
    const cfg = this.deps.config().features.triggers.tracker;
    if (!cfg.enabled) {
      this.deps.log("tracker polling disabled — poller not started");
      return;
    }
    const intervalMs = cfg.pollIntervalSec * 1000;
    this.timer = setInterval(() => void this.pollAllSafe(), intervalMs);
    this.timer.unref?.();
    this.deps.log(`tracker poller started (every ${cfg.pollIntervalSec}s)`);
  }

  /** Stop the interval poller. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle, fully guarded — a throw here must never kill the interval. */
  async pollAllSafe(): Promise<void> {
    if (this.polling) return; // never overlap cycles.
    this.polling = true;
    try {
      await this.pollAll();
    } catch (e) {
      this.deps.log(`tracker poll cycle error: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Poll every enabled tracker_event trigger. Gated on the MASTER switch
   * (`features.triggers.enabled`): off ⇒ skip the cycle entirely (watermark
   * untouched), so intake resumes cleanly when the switch flips on.
   */
  async pollAll(): Promise<void> {
    if (!this.deps.config().features.triggers.enabled) {
      this.deps.log("tracker poll skipped — features.triggers.enabled (master switch) is off");
      return;
    }
    const triggers = await this.deps.getEnabledTriggersByType("tracker_event");
    for (const trigger of triggers) {
      try {
        await this.pollTrigger(trigger);
      } catch (e) {
        this.deps.log(`tracker poll error for trigger ${trigger.id}: ${(e as Error).message}`);
      }
    }
  }

  /** Poll one trigger: validate config + allowlist, intake labelled issues, persist. */
  async pollTrigger(trigger: TriggerRow): Promise<void> {
    if (!trigger.projectId) {
      this.deps.log(`tracker poll skipped for trigger ${trigger.id} — no projectId`);
      return;
    }
    const config = trigger.config as TrackerEventTriggerConfig;
    if (config.tracker !== "github") {
      this.deps.log(`tracker poll skipped for trigger ${trigger.id} — tracker is not "github"`);
      return;
    }
    const repo = (config.repo ?? "").trim();
    if (!OWNER_REPO_RE.test(repo)) {
      this.deps.log(`tracker poll skipped for trigger ${trigger.id} — repo not owner/repo`);
      return;
    }
    const targetRepoPath = config.targetRepoPath;
    if (!targetRepoPath || targetRepoPath.length === 0) {
      this.deps.log(`tracker poll skipped for trigger ${trigger.id} — no targetRepoPath`);
      return;
    }
    // Fail-closed allowlist gate (the spec's `repo:` + the local PR target).
    if (!isAllowedRepoPath(targetRepoPath, this.deps.allowedRepoPaths())) {
      this.deps.log(
        `tracker poll skipped for trigger ${trigger.id} — targetRepoPath not in allowlist`,
      );
      return;
    }
    // The label gate is the operator's consent-to-intake — REQUIRED at fire time.
    const label = config.filter?.label;
    if (!label || label.length === 0) {
      this.deps.log(`tracker poll skipped for trigger ${trigger.id} — no filter.label (consent gate)`);
      return;
    }

    const projectId = trigger.projectId;
    await this.deps.runInProject(projectId, async () => {
      const state: TrackerPollState = { ...(config.pollState ?? {}) };
      if (!state.intake) state.intake = {};

      const issues = await runGhJson<GhIssue[]>(
        [
          "issue", "list", "--repo", repo, "--label", label, "--state", "open",
          "--json", "number,title,body,labels,updatedAt,url", "--limit", "100",
        ],
        this.deps.runGh,
      );
      if (issues === null || !Array.isArray(issues)) {
        this.deps.log(`tracker poll: issue list unavailable for ${repo} (gh degraded) — skipping cycle`);
        return; // do NOT touch the watermark.
      }

      // Deterministic ascending order so intake is stable across cycles.
      const sorted = [...issues].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
      let intaken = 0;
      for (const issue of sorted) {
        if (intaken >= MAX_PER_CYCLE) break;
        const number = issue.number;
        if (!Number.isInteger(number) || number <= 0) continue;
        const key = String(number);
        if (state.intake![key]) continue; // watermark dedup — already intaken.

        // Defence-in-depth: confirm the label is actually present (gh already filtered).
        const labels = Array.isArray(issue.labels) ? issue.labels : [];
        if (!labels.some((l) => l?.name === label)) continue;

        // DETERMINISTIC extraction, then the injectable synthesiser for free-form issues.
        const extract = extractSpecFromIssue(issue);
        let problem = extract.problem;
        let scope = extract.scope;
        let outOfScope = extract.outOfScope;
        let criteria = extract.criteria;
        if (criteria.length === 0 && this.deps.synthesizer) {
          try {
            const syn = await this.deps.synthesizer.synthesize(issue);
            if (syn && Array.isArray(syn.criteria) && syn.criteria.length > 0) {
              criteria = syn.criteria;
              problem = problem ?? syn.problem;
              scope = scope ?? syn.scope;
              outOfScope = outOfScope ?? syn.outOfScope;
            }
          } catch (e) {
            this.deps.log(`tracker poll: synthesizer error for ${repo}#${number}: ${(e as Error).message}`);
          }
        }

        if (criteria.length === 0) {
          // No testable criteria — ask the human (idempotent), open NO spec PR, and
          // do NOT record intake so a re-poll re-checks after they edit the issue.
          await postNeedCriteriaComment(
            { runGh: this.deps.runGh, log: this.deps.log },
            { repo, issueNumber: number },
          );
          continue;
        }

        const specStatus = config.specStatus ?? "ready";
        const title = typeof issue.title === "string" ? issue.title : "";
        const filePath = specFilePath(number, title);
        const branch = specBranchName(number);
        const markdown = buildSpecMarkdown({
          title: title.trim().length > 0 ? title : `Issue #${number}`,
          issueNumber: number,
          issueUrl: issue.url,
          repo: targetRepoPath, // the allowlisted local path → SPEC-1's resolveSpecRepo maps it.
          status: specStatus,
          problem: problem ?? title,
          scope,
          outOfScope,
          criteria,
        });

        const sanitizedTitle = sanitizeTitleLine(title);
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

        const res = await writeSpecPr(
          { runGh: this.deps.runGh, gitRemoteUrl: this.gitRemoteUrl, log: this.deps.log },
          {
            targetRepoPath,
            issueNumber: number,
            branch,
            filePath,
            fileContent: markdown,
            commitMessage,
            prTitle,
            prBody,
          },
        );
        if (!res.ok) {
          // Do NOT record intake → retried next cycle.
          this.deps.log(`tracker poll: spec PR failed for ${repo}#${number}: ${res.reason}`);
          continue;
        }

        // WRITE-BACK (mandatory, idempotent, non-fatal): comment the pickup + PR link.
        await postPickupComment(
          { runGh: this.deps.runGh, log: this.deps.log },
          { repo, issueNumber: number, specPrUrl: res.prUrl },
        );

        // Record intake in the watermark (bound the map to the most-recent entries).
        state.intake![key] = { specPrUrl: res.prUrl, at: new Date(this.now()).toISOString() };
        intaken++;
      }

      state.intake = boundIntake(state.intake!);
      state.lastPolledAt = new Date(this.now()).toISOString();
      await this.persistWatermark(trigger.id, state);
    });
  }

  /** Re-read fresh + write the watermark into `config.pollState` (no migration). */
  private async persistWatermark(triggerId: string, state: TrackerPollState): Promise<void> {
    const fresh = await this.deps.getTrigger(triggerId);
    if (!fresh) return; // deleted/disabled mid-cycle — nothing to persist.
    const freshConfig = (fresh.config ?? {}) as TrackerEventTriggerConfig;
    const nextConfig: TrackerEventTriggerConfig = { ...freshConfig, pollState: state };
    await this.deps.updateTrigger(triggerId, { config: nextConfig });
  }
}
