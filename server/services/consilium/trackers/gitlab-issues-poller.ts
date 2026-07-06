/**
 * gitlab-issues-poller.ts — TRACK-4: poll a GitLab project's labelled issues and turn
 * each spec-ready issue into a committed spec PR + a GitLab pickup note. The GitLab
 * analogue of `jira-issues-poller.ts`, reusing the EXACT same rails (#492 shape):
 * watermark in the trigger `config` jsonb, never-throw per cycle/trigger, project-scoped
 * context, the tracker kill-switch, the allowlist + consent gates, and the SHARED
 * crystallise pipeline (`spec-intake.ts` → `issue-spec.ts` synth + `spec-writer.ts` PR).
 * The ONLY GitLab-specific surface lives in `GitlabTrackerConnector`.
 *
 * ARCHITECTURE — TRACK-4 does NOT fire loops (identical to TRACK-1/3)
 *   A spec PRODUCER + ticket UPDATER. It opens a PR that ADDS a `docs/specs/gitlab-<iid>-…`
 *   spec to the TARGET git repo; when a human MERGES that PR, SPEC-1's spec-watch fires
 *   the review loop off the committed spec. It never touches the loop controller.
 *
 * RAILS (adversarial) — same as TRACK-3: a per-trigger WATERMARK (`pollState.intake`,
 * iid → { specPrUrl, at }) + the DETERMINISTIC `spec/gitlab-<iid>` branch + spec-writer's
 * pr-list dedup ⇒ never a 2nd PR / double note even on a ticket EDIT; a per-cycle budget;
 * every read degrades to `null` (gitlab-exec) and `pollTickets` → null SKIPS the cycle
 * WITHOUT touching the watermark; the `filter.label` is REQUIRED (consent-to-intake) and
 * `targetRepoPath` MUST be in the fail-closed allowlist.
 *
 * SECURITY: the GitLab PAT is never read/logged here (gitlab-exec owns it, fail-closed).
 * Untrusted title/description is fenced before any prompt (issue-spec.ts) and
 * slug/clamped before any filename/branch (gitlab-connector); the label is an encoded
 * query param (no injection).
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { realpathSync } from "fs";
import { resolve } from "path";
import type { TriggerRow } from "@shared/schema";
import type { TrackerEventTriggerConfig, TrackerPollState } from "@shared/types";
import type { AppConfig } from "../../../config/schema.js";
import type { ExecFileFn } from "../../github-status.js";
import { extractSpecFromIssue } from "./issue-spec.js";
import { crystallizeTicket } from "./spec-intake.js";
import { GitlabTrackerConnector, type GitlabConnectorConfig } from "./gitlab-connector.js";
import { readGitlabAuthFromEnv, type GitlabAuth, type GitlabHttpFn } from "./gitlab-exec.js";

/** `owner/repo` — conservative charset (no leading dash / no flag). */
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Max NEW intakes opened per poll cycle (bounds blast radius). */
const MAX_PER_CYCLE = 20;
/** Cap on tracked intakes per trigger (bounds the watermark jsonb). */
const MAX_TRACKED_INTAKE = 500;

/** Idempotency markers for the GitLab write-back notes (distinct from TRACK-1/2/3). */
export const GITLAB_PICKUP_MARKER = "<!-- factory:track4:gitlab:pickup -->";
export const GITLAB_NEED_CRITERIA_MARKER = "<!-- factory:track4:gitlab:need-criteria -->";

/**
 * INJECTABLE spec synthesiser for FREE-FORM tickets (no spec-shaped description). The
 * production impl wraps the model gateway; tests inject a fake. Connector-agnostic
 * (title+body only) so it is structurally shared across trackers.
 */
export interface TicketSynthesizer {
  synthesize(ticket: { title: string; body: string }): Promise<{
    problem?: string;
    scope?: string;
    outOfScope?: string;
    criteria: string[];
  }>;
}

export interface GitlabIssuesPollerDeps {
  getEnabledTriggersByType: (type: "tracker_event") => Promise<TriggerRow[]>;
  runInProject: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
  getTrigger: (id: string) => Promise<TriggerRow | undefined>;
  updateTrigger: (id: string, updates: Partial<TriggerRow>) => Promise<unknown>;
  config: () => AppConfig;
  allowedRepoPaths: () => string[];
  synthesizer?: TicketSynthesizer;
  /** Injectable `gh` runner for the remote spec PR (tests pass a fake — no real gh). */
  runGh?: ExecFileFn;
  /** Injectable GitLab HTTP transport (tests pass a fake — no real network). */
  gitlabHttp?: GitlabHttpFn;
  /** Injectable GitLab auth (tests pass a fake; prod reads env at call time). */
  gitlabAuth?: GitlabAuth | null;
  /** Injectable git-remote reader for the owner/repo derivation (default: real `git`). */
  gitRemoteUrl?: (repoPath: string) => Promise<string | null>;
  log: (message: string) => void;
  now?: () => number;
}

const execFileAsync: ExecFileFn = promisify(execFile);

/** Default git-remote reader: `git -C <repoPath> remote get-url origin`. NEVER throws. */
async function defaultGitRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      timeout: 10_000,
    });
    const url = (stdout ?? "").trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/** Best-effort realpath (collapses symlinks/`..`), else lexical resolve. */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Fail-closed allowlist check: `targetRepoPath` realpath-equals or sits beneath an allowed root. */
function isAllowedRepoPath(targetRepoPath: string, allowed: readonly string[]): boolean {
  const target = canonicalPath(targetRepoPath);
  for (const a of allowed) {
    const root = canonicalPath(a);
    if (target === root || target.startsWith(root + "/")) return true;
  }
  return false;
}

/** Single-line control-strip + collapse + clamp for the (untrusted) ticket title. */
function sanitizeTitleLine(value: string, max = 160): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Keep at most MAX_TRACKED_INTAKE intakes (most-recent by `at` timestamp win). */
function boundIntake(
  intake: Record<string, { specPrUrl?: string; at: string }>,
): Record<string, { specPrUrl?: string; at: string }> {
  const keys = Object.keys(intake);
  if (keys.length <= MAX_TRACKED_INTAKE) return intake;
  const kept = keys
    .sort((a, b) => (intake[b].at ?? "").localeCompare(intake[a].at ?? ""))
    .slice(0, MAX_TRACKED_INTAKE);
  const out: Record<string, { specPrUrl?: string; at: string }> = {};
  for (const k of kept) out[k] = intake[k];
  return out;
}

export class GitlabIssuesPoller {
  private readonly deps: GitlabIssuesPollerDeps;
  private readonly gitRemoteUrl: (repoPath: string) => Promise<string | null>;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(deps: GitlabIssuesPollerDeps) {
    this.deps = deps;
    this.gitRemoteUrl = deps.gitRemoteUrl ?? ((p) => defaultGitRemoteUrl(p));
    this.now = deps.now ?? Date.now;
  }

  /** Start the interval poller IFF `features.triggers.tracker.enabled`. Idempotent. */
  start(): void {
    if (this.timer) return;
    const cfg = this.deps.config().features.triggers.tracker;
    if (!cfg.enabled) {
      this.deps.log("gitlab tracker polling disabled — poller not started");
      return;
    }
    const intervalMs = cfg.pollIntervalSec * 1000;
    this.timer = setInterval(() => void this.pollAllSafe(), intervalMs);
    this.timer.unref?.();
    this.deps.log(`gitlab tracker poller started (every ${cfg.pollIntervalSec}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle, fully guarded — a throw here must never kill the interval. */
  async pollAllSafe(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollAll();
    } catch (e) {
      this.deps.log(`gitlab tracker poll cycle error: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  /** Poll every enabled tracker_event trigger. Gated on the MASTER switch. */
  async pollAll(): Promise<void> {
    if (!this.deps.config().features.triggers.enabled) {
      this.deps.log("gitlab tracker poll skipped — features.triggers.enabled (master switch) is off");
      return;
    }
    const triggers = await this.deps.getEnabledTriggersByType("tracker_event");
    for (const trigger of triggers) {
      try {
        await this.pollTrigger(trigger);
      } catch (e) {
        this.deps.log(`gitlab tracker poll error for trigger ${trigger.id}: ${(e as Error).message}`);
      }
    }
  }

  /** Poll one GitLab trigger: validate config + allowlist, intake labelled issues, persist. */
  async pollTrigger(trigger: TriggerRow): Promise<void> {
    if (!trigger.projectId) return;
    const config = trigger.config as TrackerEventTriggerConfig;
    if (config.tracker !== "gitlab") return; // the github/jira/bitbucket pollers handle theirs.

    const baseUrl = (config.baseUrl ?? "").trim();
    if (baseUrl.length === 0) {
      this.deps.log(`gitlab tracker poll skipped for trigger ${trigger.id} — no baseUrl`);
      return;
    }
    const project = (config.gitlabProject ?? "").trim();
    if (project.length === 0) {
      this.deps.log(`gitlab tracker poll skipped for trigger ${trigger.id} — no gitlabProject`);
      return;
    }
    // `repo` (owner/repo) is the git repo the spec PR lands in — shape-validated.
    const repo = (config.repo ?? "").trim();
    if (!OWNER_REPO_RE.test(repo)) {
      this.deps.log(`gitlab tracker poll skipped for trigger ${trigger.id} — repo not owner/repo`);
      return;
    }
    const targetRepoPath = config.targetRepoPath;
    if (!targetRepoPath || targetRepoPath.length === 0) {
      this.deps.log(`gitlab tracker poll skipped for trigger ${trigger.id} — no targetRepoPath`);
      return;
    }
    if (!isAllowedRepoPath(targetRepoPath, this.deps.allowedRepoPaths())) {
      this.deps.log(`gitlab tracker poll skipped for trigger ${trigger.id} — targetRepoPath not in allowlist`);
      return;
    }
    // The label gate is the operator's consent-to-intake — REQUIRED at fire time.
    const label = config.filter?.label;
    if (!label || label.length === 0) {
      this.deps.log(`gitlab tracker poll skipped for trigger ${trigger.id} — no filter.label (consent gate)`);
      return;
    }

    const connectorCfg: GitlabConnectorConfig = {
      baseUrl,
      project,
      label,
      labelOnPickup: config.transitionTo,
    };
    const connector = new GitlabTrackerConnector(connectorCfg, {
      http: this.deps.gitlabHttp,
      auth: this.deps.gitlabAuth ?? readGitlabAuthFromEnv(),
      log: this.deps.log,
    });

    const projectId = trigger.projectId;
    await this.deps.runInProject(projectId, async () => {
      const state: TrackerPollState = { ...(config.pollState ?? {}) };
      if (!state.intake) state.intake = {};

      const tickets = await connector.pollTickets(state.lastPolledAt);
      if (tickets === null) {
        this.deps.log(`gitlab tracker poll: search unavailable for ${project} (degraded) — skipping cycle`);
        return; // do NOT touch the watermark.
      }

      let intaken = 0;
      for (const ticket of tickets) {
        if (intaken >= MAX_PER_CYCLE) break;
        const iid = ticket.id;
        if (!iid || state.intake![iid]) continue; // watermark dedup — already intaken.

        // Defence-in-depth: confirm the consent label is actually present.
        if (!ticket.labels.includes(label)) continue;

        // DETERMINISTIC extraction, then the injectable synthesiser for free-form tickets.
        const extract = extractSpecFromIssue({ number: 0, title: ticket.title, body: ticket.body });
        let problem = extract.problem;
        let scope = extract.scope;
        let outOfScope = extract.outOfScope;
        let criteria = extract.criteria;
        if (criteria.length === 0 && this.deps.synthesizer) {
          try {
            const syn = await this.deps.synthesizer.synthesize({ title: ticket.title, body: ticket.body });
            if (syn && Array.isArray(syn.criteria) && syn.criteria.length > 0) {
              criteria = syn.criteria;
              problem = problem ?? syn.problem;
              scope = scope ?? syn.scope;
              outOfScope = outOfScope ?? syn.outOfScope;
            }
          } catch (e) {
            this.deps.log(`gitlab tracker poll: synthesizer error for ${iid}: ${(e as Error).message}`);
          }
        }

        const specStatus = config.specStatus ?? "ready";
        const title = ticket.title;
        const sanitizedTitle = sanitizeTitleLine(title);
        const commitMessage = `feat: add spec for gitlab issue !${iid}`;
        const prTitle = `spec: ${sanitizedTitle || `gitlab-${iid}`} (gitlab #${iid})`;
        const prBodyLines = [
          `Track-4 auto-produced spec for GitLab issue #${iid}.`,
          "",
          "This spec was generated from the linked GitLab issue by the factory's Track-4 intake.",
          "Merging it fires the SPEC-1 spec-watch, which launches the review loop off the committed spec.",
        ];
        if (ticket.url) prBodyLines.push("", `GitLab: ${ticket.url}`);
        const prBody = prBodyLines.join("\n");

        const result = await crystallizeTicket(
          {
            runGh: this.deps.runGh, // spec PR uses the shared gh writer (injectable).
            gitRemoteUrl: this.gitRemoteUrl,
            log: this.deps.log,
            writeback: {
              pickup: (specPrUrl) =>
                connector.writeback
                  .comment(iid, `🤖 picked up by the factory — spec at ${specPrUrl}`, GITLAB_PICKUP_MARKER)
                  .then((r) => ({ posted: r.posted })),
              needCriteria: () =>
                connector.writeback
                  .comment(
                    iid,
                    `🤖 I can pick this up but need testable acceptance criteria — please add an "Acceptance Criteria" section or checklist items.`,
                    GITLAB_NEED_CRITERIA_MARKER,
                  )
                  .then((r) => ({ posted: r.posted })),
            },
          },
          {
            source: { kind: "gitlab", ref: iid, url: ticket.url },
            targetRepoPath,
            branch: connector.specBranchName(iid),
            filePath: connector.specFilePath(iid, title),
            title: title.trim().length > 0 ? title : `gitlab-${iid}`,
            status: specStatus,
            problem: problem ?? title,
            scope,
            outOfScope,
            criteria,
            commitMessage,
            prTitle,
            prBody,
          },
        );

        if (result.outcome === "need-criteria") continue; // asked human, no intake.
        if (result.outcome === "failed") {
          this.deps.log(`gitlab tracker poll: spec PR failed for ${iid}: ${result.reason}`);
          continue;
        }

        // Optional pickup label (best-effort; a blank/failed add is a no-op).
        if (config.transitionTo && connector.writeback.transition) {
          await connector.writeback.transition(iid, config.transitionTo);
        }

        state.intake![iid] = { specPrUrl: result.prUrl, at: new Date(this.now()).toISOString() };
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
    if (!fresh) return;
    const freshConfig = (fresh.config ?? {}) as TrackerEventTriggerConfig;
    const nextConfig: TrackerEventTriggerConfig = { ...freshConfig, pollState: state };
    await this.deps.updateTrigger(triggerId, { config: nextConfig });
  }
}
