/**
 * azure-issues-poller.ts — TRACK-5: poll an Azure DevOps project (WIQL) and turn each
 * tagged, spec-ready work item into a committed spec PR + an Azure pickup comment. The
 * Azure analogue of `jira-issues-poller.ts`, reusing the EXACT same rails: watermark in
 * the trigger `config` jsonb, never-throw per cycle/trigger, project-scoped context, the
 * shared tracker kill-switch, the allowlist + consent gates, and the SHARED crystallise
 * pipeline. The ONLY Azure-specific surface lives in `AzureTrackerConnector` (WIQL watch /
 * REST read / comment+state+link write-back / `spec/azure-<id>` naming).
 *
 * DOES NOT FIRE LOOPS (identical to TRACK-1/3): a spec PRODUCER + ticket UPDATER opening a
 * PR that ADDS `docs/specs/azure-<id>-…` to the TARGET git repo (Azure has no git in this
 * flow). RAILS: per-trigger watermark + deterministic `spec/azure-<id>` branch + spec-writer
 * pr-list dedup ⇒ never a 2nd PR / double comment even on an edit; per-cycle budget; every
 * read degrades to `null` (azure-exec) so an outage SKIPS the cycle; `filter.label` (tag)
 * REQUIRED (consent); `targetRepoPath` MUST be in the allowlist. The PAT is never
 * read/logged here (azure-exec owns it); WIQL is built from sanitised, quoted literals.
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
import { AzureTrackerConnector, type AzureConnectorConfig } from "./azure-connector.js";
import { readAzureAuthFromEnv, type AzureAuth, type AzureHttpFn } from "./azure-exec.js";
import type { TicketSynthesizer } from "./jira-issues-poller.js";

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_PER_CYCLE = 20;
const MAX_TRACKED_INTAKE = 500;

export const AZURE_PICKUP_MARKER = "<!-- factory:track5:azure:pickup -->";
export const AZURE_NEED_CRITERIA_MARKER = "<!-- factory:track5:azure:need-criteria -->";

export interface AzureIssuesPollerDeps {
  getEnabledTriggersByType: (type: "tracker_event") => Promise<TriggerRow[]>;
  runInProject: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
  getTrigger: (id: string) => Promise<TriggerRow | undefined>;
  updateTrigger: (id: string, updates: Partial<TriggerRow>) => Promise<unknown>;
  config: () => AppConfig;
  allowedRepoPaths: () => string[];
  synthesizer?: TicketSynthesizer;
  runGh?: ExecFileFn;
  /** Injectable Azure HTTP transport (tests pass a fake — no real network). */
  azureHttp?: AzureHttpFn;
  /** Injectable Azure auth (tests pass a fake; prod reads env at call time). */
  azureAuth?: AzureAuth | null;
  gitRemoteUrl?: (repoPath: string) => Promise<string | null>;
  log: (message: string) => void;
  now?: () => number;
}

const execFileAsync: ExecFileFn = promisify(execFile);

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

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isAllowedRepoPath(targetRepoPath: string, allowed: readonly string[]): boolean {
  const target = canonicalPath(targetRepoPath);
  for (const a of allowed) {
    const root = canonicalPath(a);
    if (target === root || target.startsWith(root + "/")) return true;
  }
  return false;
}

function sanitizeTitleLine(value: string, max = 160): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

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

export class AzureIssuesPoller {
  private readonly deps: AzureIssuesPollerDeps;
  private readonly gitRemoteUrl: (repoPath: string) => Promise<string | null>;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(deps: AzureIssuesPollerDeps) {
    this.deps = deps;
    this.gitRemoteUrl = deps.gitRemoteUrl ?? ((p) => defaultGitRemoteUrl(p));
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    const cfg = this.deps.config().features.triggers.tracker;
    if (!cfg.enabled) {
      this.deps.log("azure tracker polling disabled — poller not started");
      return;
    }
    const intervalMs = cfg.pollIntervalSec * 1000;
    this.timer = setInterval(() => void this.pollAllSafe(), intervalMs);
    this.timer.unref?.();
    this.deps.log(`azure tracker poller started (every ${cfg.pollIntervalSec}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollAllSafe(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollAll();
    } catch (e) {
      this.deps.log(`azure tracker poll cycle error: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  async pollAll(): Promise<void> {
    if (!this.deps.config().features.triggers.enabled) {
      this.deps.log("azure tracker poll skipped — features.triggers.enabled (master switch) is off");
      return;
    }
    const triggers = await this.deps.getEnabledTriggersByType("tracker_event");
    for (const trigger of triggers) {
      try {
        await this.pollTrigger(trigger);
      } catch (e) {
        this.deps.log(`azure tracker poll error for trigger ${trigger.id}: ${(e as Error).message}`);
      }
    }
  }

  async pollTrigger(trigger: TriggerRow): Promise<void> {
    if (!trigger.projectId) return;
    const config = trigger.config as TrackerEventTriggerConfig;
    if (config.tracker !== "azure") return; // other pollers handle other kinds.

    const org = (config.azureOrg ?? "").trim();
    if (org.length === 0) {
      this.deps.log(`azure tracker poll skipped for trigger ${trigger.id} — no azureOrg`);
      return;
    }
    const project = (config.project ?? "").trim();
    if (project.length === 0) {
      this.deps.log(`azure tracker poll skipped for trigger ${trigger.id} — no project`);
      return;
    }
    const repo = (config.repo ?? "").trim();
    if (!OWNER_REPO_RE.test(repo)) {
      this.deps.log(`azure tracker poll skipped for trigger ${trigger.id} — repo not owner/repo`);
      return;
    }
    const targetRepoPath = config.targetRepoPath;
    if (!targetRepoPath || targetRepoPath.length === 0) {
      this.deps.log(`azure tracker poll skipped for trigger ${trigger.id} — no targetRepoPath`);
      return;
    }
    if (!isAllowedRepoPath(targetRepoPath, this.deps.allowedRepoPaths())) {
      this.deps.log(`azure tracker poll skipped for trigger ${trigger.id} — targetRepoPath not in allowlist`);
      return;
    }
    const tag = config.filter?.label;
    if (!tag || tag.length === 0) {
      this.deps.log(`azure tracker poll skipped for trigger ${trigger.id} — no filter.label (consent gate)`);
      return;
    }

    const connectorCfg: AzureConnectorConfig = {
      org,
      project,
      tag,
      areaPath: config.azureAreaPath,
      transitionTo: config.transitionTo,
    };
    const connector = new AzureTrackerConnector(connectorCfg, {
      http: this.deps.azureHttp,
      auth: this.deps.azureAuth ?? readAzureAuthFromEnv(),
      baseUrl: config.baseUrl,
      log: this.deps.log,
    });

    const projectId = trigger.projectId;
    await this.deps.runInProject(projectId, async () => {
      const state: TrackerPollState = { ...(config.pollState ?? {}) };
      if (!state.intake) state.intake = {};

      const tickets = await connector.pollTickets(state.lastPolledAt);
      if (tickets === null) {
        this.deps.log(`azure tracker poll: WIQL unavailable for ${project} (degraded) — skipping cycle`);
        return;
      }

      let intaken = 0;
      for (const ticket of tickets) {
        if (intaken >= MAX_PER_CYCLE) break;
        const key = ticket.id;
        if (!key || state.intake![key]) continue;

        if (!ticket.labels.includes(tag)) continue; // defence-in-depth consent re-check.

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
            this.deps.log(`azure tracker poll: synthesizer error for ${key}: ${(e as Error).message}`);
          }
        }

        const specStatus = config.specStatus ?? "ready";
        const title = ticket.title;
        const sanitizedTitle = sanitizeTitleLine(title);
        const commitMessage = `feat: add spec for azure-${key}`;
        const prTitle = `spec: ${sanitizedTitle || key} (azure ${key})`;
        const prBodyLines = [
          `Track-5 auto-produced spec for Azure DevOps work item ${key}.`,
          "",
          "This spec was generated from the linked Azure DevOps work item by the factory's Track-5 intake.",
          "Merging it fires the SPEC-1 spec-watch, which launches the review loop off the committed spec.",
        ];
        if (ticket.url) prBodyLines.push("", `Azure DevOps: ${ticket.url}`);
        const prBody = prBodyLines.join("\n");

        const result = await crystallizeTicket(
          {
            runGh: this.deps.runGh,
            gitRemoteUrl: this.gitRemoteUrl,
            log: this.deps.log,
            writeback: {
              pickup: (specPrUrl) =>
                connector.writeback
                  .comment(key, `🤖 picked up by the factory — spec at ${specPrUrl}`, AZURE_PICKUP_MARKER)
                  .then((r) => ({ posted: r.posted })),
              needCriteria: () =>
                connector.writeback
                  .comment(
                    key,
                    `🤖 I can pick this up but need testable acceptance criteria — please add an "Acceptance Criteria" section or checklist items.`,
                    AZURE_NEED_CRITERIA_MARKER,
                  )
                  .then((r) => ({ posted: r.posted })),
            },
          },
          {
            source: { kind: "azure", ref: key, url: ticket.url },
            targetRepoPath,
            branch: connector.specBranchName(key),
            filePath: connector.specFilePath(key, title),
            title: title.trim().length > 0 ? title : key,
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

        if (result.outcome === "need-criteria") continue;
        if (result.outcome === "failed") {
          this.deps.log(`azure tracker poll: spec PR failed for ${key}: ${result.reason}`);
          continue;
        }

        if (config.transitionTo && connector.writeback.transition) {
          await connector.writeback.transition(key, config.transitionTo);
        }

        state.intake![key] = { specPrUrl: result.prUrl, at: new Date(this.now()).toISOString() };
        intaken++;
      }

      state.intake = boundIntake(state.intake!);
      state.lastPolledAt = new Date(this.now()).toISOString();
      await this.persistWatermark(trigger.id, state);
    });
  }

  private async persistWatermark(triggerId: string, state: TrackerPollState): Promise<void> {
    const fresh = await this.deps.getTrigger(triggerId);
    if (!fresh) return;
    const freshConfig = (fresh.config ?? {}) as TrackerEventTriggerConfig;
    const nextConfig: TrackerEventTriggerConfig = { ...freshConfig, pollState: state };
    await this.deps.updateTrigger(triggerId, { config: nextConfig });
  }
}
