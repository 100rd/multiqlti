/**
 * github-command-poller.ts — TRACK-6 (task-tracker-triggers.md §8): scan a GitHub
 * repo's recent ISSUE COMMENTS for the three commands and act on the AUTHORISED ones.
 *
 *   /spec    — force intake of THIS ticket even if UNLABELLED → crystallise a spec PR
 *              (reuses the SHARED github crystallise dialect; role-stamped if the
 *              trigger carries a `roleConcern`).
 *   /approve — approve the spec: mark the ticket's spec PR (`spec/gh-issue-<n>`)
 *              ready-for-review (`gh pr ready`). A human still MERGES it (L4).
 *   /stop    — cancel the ticket's active consilium loop (controller.cancel).
 *
 * WHY A SEPARATE POLLER (not folded into the issues poller)
 *   The issues poller PRODUCES specs from LABELLED issues; commands are a DISTINCT
 *   surface — they read COMMENTS (not issues), need commenter-role AUTH, and reach the
 *   loop CONTROLLER (for /stop). Keeping it separate keeps the intake poller
 *   byte-identical and gives commands their own kill-switch (`tracker.commands.enabled`,
 *   default OFF) + their own watermark (`config.commandState`, a TOP-LEVEL key so the
 *   two pollers never clobber each other's watermark).
 *
 * RAILS / SECURITY (adversarial)
 *   (a) AUTH FIRST — every command is gated by `isAuthorizedCommenter` (assignee OR repo
 *       maintainer, verified via the `gh` API, fail-closed). An unauthorised command is
 *       IGNORED + logged + marked processed (never acted on, never re-evaluated). The
 *       comment body is NEVER trusted to self-assert authority.
 *   (b) IDEMPOTENT — a per-trigger `commandState` (newest-comment cursor +
 *       comment-id processed set) dedups so a re-poll never re-acts a command. Each
 *       action is ALSO idempotent on its own (crystallise dedups on the deterministic
 *       branch; `gh pr ready` is a no-op when already ready; cancel is a no-op on a
 *       terminal loop).
 *   (c) STRICT PARSE — `parseTrackerCommand` matches the EXACT leading token of a line
 *       (never a substring / prefix / casing bypass). A non-command comment is skipped.
 *   (d) UNTRUSTED TEXT FENCED — the comment body never reaches a shell or a prompt. The
 *       /spec path re-reads the ISSUE and runs the SAME fenced synth/crystallise as the
 *       label poll; nothing from the comment enters a prompt.
 *   (e) ALLOWLIST FAIL-CLOSED — `targetRepoPath` must be in the consilium-loop allowlist
 *       (realpath-normalised) or the trigger is skipped; the crystallise + SPEC-1 fire
 *       re-validate it too. A role stamp can only name the role's own allowlisted repo.
 *   (f) gh OUTAGE / BEST-EFFORT — every `gh` read degrades to null / skip; a throw in one
 *       comment / trigger / cycle never stops the others. Kill-switches (master +
 *       tracker + commands) gate the whole surface; all default OFF.
 */
import { realpathSync } from "fs";
import { resolve } from "path";
import type { TriggerRow, StandingRoleRow, ConsiliumLoopRow } from "@shared/schema";
import { CONSILIUM_LOOP_TERMINAL_STATES } from "@shared/schema";
import type { TrackerEventTriggerConfig, TrackerCommandState } from "@shared/types";
import type { AppConfig } from "../../../config/schema.js";
import { runGhJson, type ExecFileFn } from "../../github-status.js";
import { runGhCapture } from "./gh-exec.js";
import { extractSpecFromIssue, specBranchName, type GhIssue } from "./issue-spec.js";
import { crystallizeGithubIssue } from "./github-crystallize.js";
import { resolveRoleStamp } from "./role-stamp.js";
import { parseTrackerCommand, type TrackerCommand } from "./command-parser.js";
import { isAuthorizedCommenter } from "./command-auth.js";
import type { SpecSynthesizer } from "./github-issues-poller.js";

/** `owner/repo` — conservative GitHub name charset (no leading dash / no flag). */
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Max commands acted per trigger per cycle (bounds blast radius). */
const MAX_COMMANDS_PER_CYCLE = 20;
/** Cap on tracked processed-comment ids per trigger (bounds the watermark jsonb). */
const MAX_TRACKED_PROCESSED = 500;
/** Default look-back when a trigger has no command watermark yet. */
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const TERMINAL_LOOP_STATES: ReadonlySet<string> = new Set(CONSILIUM_LOOP_TERMINAL_STATES);

/** A repo issue-comment as returned by `GET /repos/{repo}/issues/comments`. */
interface RepoIssueComment {
  id?: number | string;
  body?: string;
  created_at?: string;
  user?: { login?: string };
  issue_url?: string;
}

export interface GithubCommandPollerDeps {
  /** Cross-project, SYSTEM-context load of enabled tracker_event triggers (runAsSystem). */
  getEnabledTriggersByType: (type: "tracker_event") => Promise<TriggerRow[]>;
  /** Establish a project-scoped ALS context for one trigger's poll (= runAsProject). */
  runInProject: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
  /** Re-read a trigger fresh so the watermark write does not clobber a concurrent edit. */
  getTrigger: (id: string) => Promise<TriggerRow | undefined>;
  /** Persist the advanced watermark (writes back `config.commandState`). */
  updateTrigger: (id: string, updates: Partial<TriggerRow>) => Promise<unknown>;
  /** Live config accessor (kill-switches + interval). */
  config: () => AppConfig;
  /** Fail-closed allowlist of local repo paths (consilium-loop allowlist). */
  allowedRepoPaths: () => string[];
  /** Project-scoped role load for the /spec role stamp (absent ⇒ unstamped forced spec). */
  getStandingRole?: (id: string) => Promise<StandingRoleRow | undefined>;
  /** Model-backed synthesiser for free-form issues on /spec (absent ⇒ normalise-only). */
  synthesizer?: SpecSynthesizer;
  /** Project-scoped read of consilium loops (for /stop — the SAME path the observer uses). */
  getLoops: () => Promise<ConsiliumLoopRow[]>;
  /** Cancel a loop (the loop controller's `cancel`) — for /stop. Best-effort, never throws here. */
  cancelLoop: (loopId: string, opts?: { reason?: string; actor?: string }) => Promise<ConsiliumLoopRow | null>;
  /** Injectable `gh` runner (tests pass a fake — no real `gh`/network). */
  runGh?: ExecFileFn;
  /** Injectable git-remote reader (default: real `git`) for the /spec crystallise. */
  gitRemoteUrl?: (repoPath: string) => Promise<string | null>;
  /** Structured logger. */
  log: (message: string) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Best-effort realpath (collapses symlinks/`..` for an EXISTING path), else lexical. */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Fail-closed allowlist check — target must equal or sit beneath an allowed root. */
function isAllowedRepoPath(targetRepoPath: string, allowed: readonly string[]): boolean {
  const target = canonicalPath(targetRepoPath);
  for (const a of allowed) {
    const root = canonicalPath(a);
    if (target === root || target.startsWith(root + "/")) return true;
  }
  return false;
}

/** The origin issue number embedded in an `issue_url` (`.../issues/<n>`), else null. */
function issueNumberFromUrl(issueUrl: string | undefined, repo: string): number | null {
  if (typeof issueUrl !== "string" || issueUrl.length === 0) return null;
  // Defence: the comment must belong to THIS repo (we listed from this repo's endpoint,
  // but re-check so a spoofed issue_url can never retarget another repo).
  if (!issueUrl.toLowerCase().includes(`/repos/${repo.toLowerCase()}/issues/`)) return null;
  const m = /\/issues\/(\d+)(?:$|[/?#])/.exec(issueUrl);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Keep at most MAX_TRACKED_PROCESSED processed ids (most recent by `at` win). */
function boundProcessed(processed: Record<string, { at: string }>): Record<string, { at: string }> {
  const keys = Object.keys(processed);
  if (keys.length <= MAX_TRACKED_PROCESSED) return processed;
  const kept = keys
    .sort((a, b) => Date.parse(processed[b]?.at ?? "") - Date.parse(processed[a]?.at ?? ""))
    .slice(0, MAX_TRACKED_PROCESSED);
  const out: Record<string, { at: string }> = {};
  for (const k of kept) out[k] = processed[k];
  return out;
}

export class GithubCommandPoller {
  private readonly deps: GithubCommandPollerDeps;
  private readonly gitRemoteUrl: (repoPath: string) => Promise<string | null>;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(deps: GithubCommandPollerDeps) {
    this.deps = deps;
    this.gitRemoteUrl =
      deps.gitRemoteUrl ??
      (async (repoPath: string) => {
        try {
          const { stdout } = await (deps.runGh
            ? deps.runGh("git", ["-C", repoPath, "remote", "get-url", "origin"], { timeout: 10_000 })
            : Promise.reject(new Error("no runner")));
          const url = (stdout ?? "").trim();
          return url.length > 0 ? url : null;
        } catch {
          return null;
        }
      });
    this.now = deps.now ?? Date.now;
  }

  /**
   * Start the interval poller IFF `tracker.enabled && tracker.commands.enabled`. The
   * caller only constructs + starts this when both are on. Idempotent.
   */
  start(): void {
    if (this.timer) return;
    const cfg = this.deps.config().features.triggers.tracker;
    if (!cfg.enabled || !cfg.commands.enabled) {
      this.deps.log("tracker commands disabled — command poller not started");
      return;
    }
    const intervalMs = cfg.pollIntervalSec * 1000;
    this.timer = setInterval(() => void this.pollAllSafe(), intervalMs);
    this.timer.unref?.();
    this.deps.log(`tracker command poller started (every ${cfg.pollIntervalSec}s)`);
  }

  /** Stop the interval poller. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One cycle, fully guarded — a throw here must never kill the interval. */
  async pollAllSafe(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollAll();
    } catch (e) {
      this.deps.log(`tracker command poll cycle error: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Poll every enabled tracker_event trigger for commands. Gated on the MASTER switch
   * AND the commands sub-switch: either off ⇒ skip the whole cycle (byte-identical to
   * TRACK-1..5 — no comment is ever acted on).
   */
  async pollAll(): Promise<void> {
    const triggers = this.deps.config().features.triggers;
    if (!triggers.enabled) {
      this.deps.log("tracker command poll skipped — features.triggers.enabled (master switch) off");
      return;
    }
    if (!triggers.tracker.commands.enabled) {
      this.deps.log("tracker command poll skipped — commands sub-switch off");
      return;
    }
    const rows = await this.deps.getEnabledTriggersByType("tracker_event");
    for (const trigger of rows) {
      try {
        await this.pollTrigger(trigger);
      } catch (e) {
        this.deps.log(`tracker command poll error for trigger ${trigger.id}: ${(e as Error).message}`);
      }
    }
  }

  /** Poll one trigger: validate config + allowlist, then process new command comments. */
  async pollTrigger(trigger: TriggerRow): Promise<void> {
    if (!trigger.projectId) return;
    const config = trigger.config as TrackerEventTriggerConfig;
    if (config.tracker !== "github") return;
    const repo = (config.repo ?? "").trim();
    if (!OWNER_REPO_RE.test(repo)) {
      this.deps.log(`tracker command poll skipped for trigger ${trigger.id} — repo not owner/repo`);
      return;
    }
    const targetRepoPath = config.targetRepoPath;
    if (!targetRepoPath || targetRepoPath.length === 0) {
      this.deps.log(`tracker command poll skipped for trigger ${trigger.id} — no targetRepoPath`);
      return;
    }
    if (!isAllowedRepoPath(targetRepoPath, this.deps.allowedRepoPaths())) {
      this.deps.log(`tracker command poll skipped for trigger ${trigger.id} — targetRepoPath not in allowlist`);
      return;
    }

    const projectId = trigger.projectId;
    await this.deps.runInProject(projectId, async () => {
      const state: TrackerCommandState = { ...(config.commandState ?? {}) };
      const processed = { ...(state.processed ?? {}) };
      const sinceMs = state.lastCommentAt
        ? Date.parse(state.lastCommentAt)
        : this.now() - DEFAULT_LOOKBACK_MS;
      const sinceIso = new Date(Number.isFinite(sinceMs) ? sinceMs : this.now() - DEFAULT_LOOKBACK_MS).toISOString();

      const comments = await runGhJson<RepoIssueComment[]>(
        [
          "api", "-X", "GET", `repos/${repo}/issues/comments`,
          "-f", `since=${sinceIso}`, "-f", "sort=created", "-f", "direction=asc", "-f", "per_page=100",
        ],
        this.deps.runGh,
      );
      if (comments === null || !Array.isArray(comments)) {
        this.deps.log(`tracker command poll: comments unavailable for ${repo} (gh degraded) — skipping cycle`);
        return; // do NOT advance the watermark.
      }

      let newestMs = Number.isFinite(sinceMs) ? sinceMs : this.now() - DEFAULT_LOOKBACK_MS;
      let acted = 0;
      for (const comment of comments) {
        const createdMs = comment.created_at ? Date.parse(comment.created_at) : NaN;
        if (Number.isFinite(createdMs) && createdMs > newestMs) newestMs = createdMs;

        const id = comment.id;
        const key = id !== undefined && id !== null ? String(id) : "";
        if (key.length === 0) continue;
        if (processed[key]) continue; // idempotency — already decided.

        const cmd = parseTrackerCommand(comment.body);
        if (!cmd) continue; // not a command — skip (watermark advances past it).

        if (acted >= MAX_COMMANDS_PER_CYCLE) break;

        const issueNumber = issueNumberFromUrl(comment.issue_url, repo);
        if (issueNumber === null) {
          this.deps.log(`tracker command poll: comment ${key} on ${repo} has no resolvable issue — skipping`);
          continue;
        }
        const login = comment.user?.login;
        if (typeof login !== "string" || login.length === 0) {
          processed[key] = { at: new Date(this.now()).toISOString() };
          continue;
        }

        // AUTH FIRST — verify the commenter's role via the tracker API (fail-closed).
        const authorized = await isAuthorizedCommenter(
          { repo, issueNumber, login },
          this.deps.runGh,
        );
        if (!authorized) {
          this.deps.log(
            `tracker command poll: IGNORED unauthorized /${cmd} by "${login}" on ${repo}#${issueNumber}`,
          );
          processed[key] = { at: new Date(this.now()).toISOString() }; // never re-evaluate.
          continue;
        }

        await this.runCommand(cmd, { repo, targetRepoPath, issueNumber, config });
        processed[key] = { at: new Date(this.now()).toISOString() };
        acted++;
      }

      // Advance the cursor to the newest comment seen; bound the processed set.
      state.lastCommentAt = new Date(newestMs).toISOString();
      state.processed = boundProcessed(processed);
      await this.persistWatermark(trigger.id, state);
    });
  }

  /** Dispatch one authorised command. Best-effort — a failure logs, never throws. */
  private async runCommand(
    cmd: TrackerCommand,
    ctx: { repo: string; targetRepoPath: string; issueNumber: number; config: TrackerEventTriggerConfig },
  ): Promise<void> {
    try {
      if (cmd === "spec") return await this.forceIntake(ctx);
      if (cmd === "approve") return await this.approveSpecPr(ctx);
      if (cmd === "stop") return await this.stopLoop(ctx);
    } catch (e) {
      this.deps.log(
        `tracker command poll: /${cmd} on ${ctx.repo}#${ctx.issueNumber} errored: ${(e as Error).message}`,
      );
    }
  }

  /** /spec — force intake of the issue (crystallise a spec PR), role-stamped if bound. */
  private async forceIntake(ctx: {
    repo: string;
    targetRepoPath: string;
    issueNumber: number;
    config: TrackerEventTriggerConfig;
  }): Promise<void> {
    const { repo, targetRepoPath, issueNumber, config } = ctx;
    const issue = await runGhJson<GhIssue>(
      ["issue", "view", String(issueNumber), "--repo", repo, "--json", "number,title,body,labels,url"],
      this.deps.runGh,
    );
    if (!issue || typeof issue.number !== "number") {
      this.deps.log(`tracker command poll: /spec could not read ${repo}#${issueNumber} — skipping`);
      return;
    }

    const extract = extractSpecFromIssue(issue);
    let { problem, scope, outOfScope, criteria } = extract;
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
        this.deps.log(`tracker command poll: /spec synth error for ${repo}#${issueNumber}: ${(e as Error).message}`);
      }
    }

    const roleStamp = await this.resolveRoleStamp(config);
    const title = typeof issue.title === "string" ? issue.title : "";
    const result = await crystallizeGithubIssue(
      { runGh: this.deps.runGh, gitRemoteUrl: this.gitRemoteUrl, log: this.deps.log },
      {
        repo,
        targetRepoPath,
        number: issueNumber,
        title,
        url: issue.url,
        status: config.specStatus ?? "ready",
        problem: problem ?? title,
        scope,
        outOfScope,
        criteria,
        roleStamp,
      },
    );
    this.deps.log(`tracker command poll: /spec on ${repo}#${issueNumber} → ${result.outcome}`);
  }

  /** /approve — mark the ticket's spec PR ready-for-review (a human still merges). */
  private async approveSpecPr(ctx: { repo: string; issueNumber: number }): Promise<void> {
    const { repo, issueNumber } = ctx;
    // The spec PR head is the deterministic `spec/gh-issue-<n>` branch (issue-spec.ts).
    const branch = specBranchName(issueNumber);
    const res = await runGhCapture(
      ["pr", "ready", branch, "--repo", repo],
      this.deps.runGh,
    );
    if (!res.ok) {
      this.deps.log(`tracker command poll: /approve on ${repo}#${issueNumber} (${branch}) failed: ${res.stderr}`);
      return;
    }
    this.deps.log(`tracker command poll: /approve on ${repo}#${issueNumber} → spec PR ${branch} marked ready`);
  }

  /** /stop — cancel the ticket's active (non-terminal) consilium loop. */
  private async stopLoop(ctx: { repo: string; issueNumber: number }): Promise<void> {
    const { repo, issueNumber } = ctx;
    const loops = await this.deps.getLoops();
    const target = loops.find((l) => this.loopMatchesIssue(l, repo, issueNumber));
    if (!target) {
      this.deps.log(`tracker command poll: /stop on ${repo}#${issueNumber} — no active loop to cancel`);
      return;
    }
    const cancelled = await this.deps.cancelLoop(target.id, {
      actor: "tracker:/stop",
      reason: `cancelled by /stop comment on ${repo}#${issueNumber}`,
    });
    this.deps.log(
      cancelled
        ? `tracker command poll: /stop on ${repo}#${issueNumber} → cancelled loop ${target.id}`
        : `tracker command poll: /stop on ${repo}#${issueNumber} → loop ${target.id} already terminal (no-op)`,
    );
  }

  /**
   * True iff a NON-TERMINAL loop traces to `repo#issueNumber` — the SAME provenance
   * join the write-back observer uses (`spec.source.kind==="github"` + ref===n + the
   * issue URL under this repo). A terminal loop is skipped (cancel would no-op).
   */
  private loopMatchesIssue(loop: ConsiliumLoopRow, repo: string, issueNumber: number): boolean {
    if (TERMINAL_LOOP_STATES.has(loop.state)) return false;
    const src = loop.triggerProvenance?.spec?.source;
    if (!src || src.kind !== "github") return false;
    if (src.ref !== String(issueNumber)) return false;
    const url = src.url;
    if (typeof url === "string" && url.length > 0) {
      return url.toLowerCase().includes(`/${repo.toLowerCase()}/issues/`);
    }
    return true; // no url (legacy edge) — attribute by ref alone within this repo trigger.
  }

  /** Resolve the /spec role stamp from the trigger's roleConcern (project-scoped). */
  private async resolveRoleStamp(config: TrackerEventTriggerConfig) {
    const binding = config.roleConcern;
    if (!binding || !this.deps.getStandingRole) return null;
    try {
      const role = await this.deps.getStandingRole(binding.roleId);
      const res = resolveRoleStamp(role, binding.concernId);
      if (!res.ok) {
        this.deps.log(`tracker command poll: /spec role stamp skipped — ${res.reason} (role ${binding.roleId})`);
        return null;
      }
      return res.stamp;
    } catch (e) {
      this.deps.log(`tracker command poll: /spec role stamp error: ${(e as Error).message}`);
      return null;
    }
  }

  /** Re-read fresh + write `config.commandState` (no migration; own top-level key). */
  private async persistWatermark(triggerId: string, state: TrackerCommandState): Promise<void> {
    const fresh = await this.deps.getTrigger(triggerId);
    if (!fresh) return;
    const freshConfig = (fresh.config ?? {}) as TrackerEventTriggerConfig;
    const nextConfig: TrackerEventTriggerConfig = { ...freshConfig, commandState: state };
    await this.deps.updateTrigger(triggerId, { config: nextConfig });
  }
}
