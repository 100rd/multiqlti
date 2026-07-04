/**
 * github-poller.ts — POLLING mode for github_event triggers (github-trigger-polling).
 *
 * WHY THIS EXISTS
 *   A github_event webhook only fires when GitHub POSTs to us. GitHub's servers
 *   live on the public internet and CANNOT deliver a webhook to a LOCAL daemon
 *   behind NAT (localhost / a private-LAN IP). So an enabled github trigger on a
 *   local box has `lastFired: null` forever, despite real PRs. GitHub can't push
 *   to us — but WE can pull from GitHub (works behind NAT, no public endpoint).
 *
 * WHAT IT DOES
 *   For each ENABLED github_event trigger, on an interval, it PULLS the events the
 *   trigger watches via the existing `gh` CLI seam (github-status.ts `runGhJson`):
 *     - pull_request → `gh pr list --repo <o/r> --state open --json
 *       number,title,headRefOid,baseRefOid,updatedAt` — a NEW open PR, or an open
 *       PR whose head advanced, fires.
 *     - push (default branch) → the default branch's current head sha; when it
 *       ADVANCES past the watermark, a post-merge review of before..after fires.
 *   Each detected event is SYNTHESIZED into the SAME `{ event, delivery, payload }`
 *   envelope the webhook receiver (github-event-handler.ts, #471) hands to
 *   `fireTrigger`, so the SAME `mapGitHubEventToReview` produces IDENTICAL loops —
 *   webhook and polling are byte-for-byte consistent.
 *
 * RAILS (adversarial concerns, addressed)
 *   (a) RE-FIRE THE SAME PR EVERY POLL — a per-trigger WATERMARK (last-seen PR head
 *       / default-branch head) is persisted in the trigger's `config` jsonb and only
 *       ADVANCED when a fire was NOT dedup-suppressed. A PR/push already seen at the
 *       same sha is skipped; the watermark persists across restarts.
 *   (b) POLL STORM → UNBOUNDED LOOPS — every fire flows through the SAME
 *       `launchReviewWithDedup` (one active loop per repo+trigger), the master
 *       kill-switch (`features.triggers.enabled`) gates firing, and the interval
 *       (min 60s) bounds cadence. Within one cycle the first PR launches and every
 *       later PR of the same repo is dedup-suppressed (watermark held → retried).
 *   (c) gh OUTAGE CRASHING THE POLLER — every `gh` call goes through `runGhJson`
 *       (never throws, degrades to null); a null result SKIPS that poll and does
 *       NOT touch the watermark; each trigger + each cycle is wrapped so one failure
 *       never stops the others or the loop.
 *   (d) OWNER/REPO PARSE — the owner/repo is taken from `config.repository`
 *       (already `owner/repo`), else DERIVED from the local repo's git remote via
 *       `parseOwnerRepo`, which handles BOTH scp-style SSH (`git@host:o/r.git`) and
 *       URL (`https|ssh|git://host/o/r(.git)`) remotes. No github remote → skip+log.
 *
 * SECURITY
 *   The `gh` token is never read/logged here — `runGhJson` hands it to `gh` via a
 *   sanitized env only. Every value pulled off GitHub is UNTRUSTED and reaches the
 *   review objective ONLY through the factory's sanitized seam (same as the webhook
 *   path). `repoPath` (the LOCAL review target) is `action.repoPath`, re-validated
 *   against the fail-closed allowlist INSIDE the factory — the poller never widens
 *   it. Only fixed, non-free-form args are passed to `gh` (owner/repo is shape-
 *   validated first, so nothing leading-dash / attacker-shaped is read as a flag).
 */
import { execFile } from "child_process";
import { promisify } from "util";
import type { TriggerRow } from "@shared/schema";
import type { GitHubEventTriggerConfig, GitHubPollState } from "@shared/types";
import type { AppConfig } from "../config/schema.js";
import type { TriggerFireResult } from "./consilium/trigger-dispatch.js";
import { runGhJson, type ExecFileFn } from "./github-status.js";

const execFileAsync: ExecFileFn = promisify(execFile);

/** A git object id: 7–64 lowercase hex (parity with the event map's SHA_RE). */
const SHA_RE = /^[0-9a-f]{7,64}$/;
/** `owner/repo` — conservative GitHub name charset (no leading dash / no flag). */
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Cap on tracked open-PR heads per trigger (bounds the watermark jsonb). */
const MAX_TRACKED_PRS = 200;

function isRealSha(v: string | undefined): v is string {
  return typeof v === "string" && SHA_RE.test(v) && !/^0+$/.test(v);
}

/** The `gh pr list --json number,title,headRefOid,baseRefOid,updatedAt` item shape. */
interface GhPrListItem {
  number: number;
  title?: string;
  headRefOid?: string;
  baseRefOid?: string;
  updatedAt?: string;
}

/**
 * Parse a git remote URL to `owner/repo`, or null if it is not a recognizable
 * github-shaped remote. Handles BOTH forms (adversarial concern (d)):
 *   - scp-style SSH:  git@github.com:owner/repo.git
 *   - URL:            https://github.com/owner/repo(.git)
 *                     ssh://git@github.com/owner/repo.git
 *                     git://github.com/owner/repo.git
 * A trailing `.git` and trailing slash are stripped. A non-github host is still
 * parsed to owner/repo (the poller pulls by owner/repo; `gh` targets github.com) —
 * a non-github remote simply yields no PRs and degrades to a skip.
 */
export function parseOwnerRepo(remoteUrl: string): string | null {
  const s = remoteUrl.trim();
  if (s.length === 0) return null;
  // scp-style: [user@]host:owner/repo(.git)
  let m = /^[\w.-]+@[\w.-]+:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s);
  if (m) return normalizeOwnerRepo(m[1], m[2]);
  // URL form: scheme://[user@]host/owner/repo(.git)
  m = /^[a-z][a-z0-9+.-]*:\/\/(?:[\w.-]+@)?[\w.-]+\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s);
  if (m) return normalizeOwnerRepo(m[1], m[2]);
  return null;
}

function normalizeOwnerRepo(owner: string, repo: string): string | null {
  const candidate = `${owner}/${repo}`;
  return OWNER_REPO_RE.test(candidate) ? candidate : null;
}

export interface GitHubPollerDeps {
  /** Cross-project, system-context load of enabled github_event triggers. */
  getEnabledTriggersByType: (type: "github_event") => Promise<TriggerRow[]>;
  /** Re-read a trigger fresh so the watermark write does not clobber a concurrent edit. */
  getTrigger: (id: string) => Promise<TriggerRow | undefined>;
  /** Persist the advanced watermark (writes back `config` with `pollState`). */
  updateTrigger: (id: string, updates: Partial<TriggerRow>) => Promise<unknown>;
  /**
   * The SAME `fireTrigger` seam the webhook receiver uses. Returns the dispatch
   * result so the poller can hold the watermark on `"skipped-dedup"`.
   */
  fireTrigger: (trigger: TriggerRow, payload: unknown) => Promise<TriggerFireResult>;
  /** Live config accessor (kill-switches + interval). */
  config: () => AppConfig;
  /** Injectable `gh` runner (tests pass a fake — no real `gh`/network). */
  runGh?: ExecFileFn;
  /** Injectable git-remote reader for the owner/repo fallback (default: real `git`). */
  gitRemoteUrl?: (repoPath: string) => Promise<string | null>;
  /** Structured logger. */
  log: (message: string) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Default git-remote reader: `git -C <repoPath> remote get-url origin`. NEVER
 * throws (no remote / not a repo → null). `repoPath` is a trusted local config
 * value; `--end-of-options` guards a `repoPath` that starts with a dash.
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

export class GitHubPoller {
  private readonly deps: GitHubPollerDeps;
  private readonly runGh: ExecFileFn;
  private readonly gitRemoteUrl: (repoPath: string) => Promise<string | null>;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(deps: GitHubPollerDeps) {
    this.deps = deps;
    this.runGh = deps.runGh ?? execFileAsync;
    this.gitRemoteUrl = deps.gitRemoteUrl ?? ((p) => defaultGitRemoteUrl(p));
    this.now = deps.now ?? Date.now;
  }

  /**
   * Start the interval poller IFF `features.triggers.githubPolling.enabled`. A
   * running server never silently starts polling — the caller only constructs +
   * starts this when the kill-switch is on. Idempotent (a second start is a no-op).
   */
  start(): void {
    if (this.timer) return;
    const cfg = this.deps.config().features.triggers.githubPolling;
    if (!cfg.enabled) {
      this.deps.log("github polling disabled — poller not started");
      return;
    }
    const intervalMs = cfg.intervalSec * 1000;
    this.timer = setInterval(() => void this.pollAllSafe(), intervalMs);
    // Node timers keep the event loop alive; a poller should not block shutdown.
    this.timer.unref?.();
    this.deps.log(`github poller started (every ${cfg.intervalSec}s)`);
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
    if (this.polling) return; // never overlap cycles (a slow gh must not stack up)
    this.polling = true;
    try {
      await this.pollAll();
    } catch (e) {
      this.deps.log(`github poll cycle error: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Poll every enabled github_event trigger. Gated on the MASTER switch: with
   * `features.triggers.enabled` off there is no point polling (a fire would be a
   * no-op that consumes the watermark), so we skip the cycle entirely — the
   * watermark is untouched and firing resumes cleanly when the switch flips on.
   */
  async pollAll(): Promise<void> {
    if (!this.deps.config().features.triggers.enabled) {
      this.deps.log("github poll skipped — features.triggers.enabled (master switch) is off");
      return;
    }
    const triggers = await this.deps.getEnabledTriggersByType("github_event");
    for (const trigger of triggers) {
      try {
        await this.pollTrigger(trigger);
      } catch (e) {
        this.deps.log(`github poll error for trigger ${trigger.id}: ${(e as Error).message}`);
      }
    }
  }

  /** Poll one trigger: resolve owner/repo, pull watched events, advance + persist. */
  async pollTrigger(trigger: TriggerRow): Promise<void> {
    const config = trigger.config as GitHubEventTriggerConfig;
    const events = Array.isArray(config.events) ? config.events : [];
    if (events.length === 0) return;

    const ownerRepo = await this.resolveOwnerRepo(config);
    if (!ownerRepo) {
      this.deps.log(
        `github poll skipped for trigger ${trigger.id} — no github owner/repo (config.repository empty and no parseable git remote)`,
      );
      return;
    }

    // Read-modify: work on a COPY of the current watermark.
    const state: GitHubPollState = { ...(config.pollState ?? {}) };
    let changed = false;

    if (events.includes("pull_request")) {
      changed = (await this.pollPullRequests(trigger, ownerRepo, state)) || changed;
    }
    if (events.includes("push")) {
      changed = (await this.pollPush(trigger, ownerRepo, state)) || changed;
    }

    state.lastPolledAt = new Date(this.now()).toISOString();
    changed = true; // always persist lastPolledAt for diagnosability

    if (changed) {
      await this.persistWatermark(trigger.id, state);
    }
  }

  /**
   * Poll open PRs. Returns whether the watermark changed. A PR fires when its head
   * sha is not what we last saw; the head is recorded ONLY when the fire was not
   * dedup-suppressed (so a suppressed PR is retried next cycle, never lost).
   */
  private async pollPullRequests(
    trigger: TriggerRow,
    ownerRepo: string,
    state: GitHubPollState,
  ): Promise<boolean> {
    const prs = await runGhJson<GhPrListItem[]>(
      [
        "pr", "list",
        "--repo", ownerRepo,
        "--state", "open",
        "--json", "number,title,headRefOid,baseRefOid,updatedAt",
        "--limit", "100",
      ],
      this.runGh,
    );
    if (prs === null || !Array.isArray(prs)) {
      this.deps.log(`github poll: pr list unavailable for ${ownerRepo} (gh degraded) — skipping PR poll`);
      return false;
    }

    const prevHeads = state.prHeads ?? {};
    const nextHeads: Record<string, string> = {};
    let changed = false;

    // Deterministic order (ascending PR number) so the FIRST fire in a cycle is
    // stable; later same-repo PRs dedup-suppress against it and are retried.
    const sorted = [...prs].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    for (const pr of sorted) {
      const key = String(pr.number);
      const head = pr.headRefOid;
      const base = pr.baseRefOid;
      // A PR with an unusable head/base can never map to a review — carry the last
      // watermark forward (if any) and skip without firing.
      if (!isRealSha(head) || !isRealSha(base)) {
        if (prevHeads[key]) nextHeads[key] = prevHeads[key];
        continue;
      }
      const lastHead = prevHeads[key];
      if (lastHead === head) {
        nextHeads[key] = head; // unchanged → already reviewed at this commit
        continue;
      }
      // New (no lastHead) OR head advanced → fire, mapping to a reviewable action.
      const action = lastHead ? "synchronize" : "opened";
      const result = await this.deps.fireTrigger(
        trigger,
        this.prEnvelope(ownerRepo, pr, head, base, action),
      );
      if (result === "skipped-dedup") {
        // Hold the watermark at the PRIOR value → retried next cycle (never lost).
        if (lastHead) nextHeads[key] = lastHead;
        this.deps.log(`github poll: PR #${key} on ${ownerRepo} dedup-suppressed — watermark held`);
      } else {
        nextHeads[key] = head; // advance
        changed = true;
        this.deps.log(`github poll: fired ${action} for PR #${key} on ${ownerRepo} (${result})`);
      }
    }

    // Prune to open PRs only (bounds the jsonb). If prev != next, mark changed.
    const bounded = boundHeads(nextHeads);
    if (!shallowEqual(prevHeads, bounded)) changed = true;
    state.prHeads = bounded;
    return changed;
  }

  /**
   * Poll the default branch head. Returns whether the watermark changed. The FIRST
   * observation records a BASELINE (no fire — a first-seen head is the current
   * state, not a push event); a later ADVANCE fires a post-merge review of
   * before..after, recorded only when not dedup-suppressed.
   */
  private async pollPush(
    trigger: TriggerRow,
    ownerRepo: string,
    state: GitHubPollState,
  ): Promise<boolean> {
    const branch = await this.getDefaultBranch(ownerRepo);
    if (!branch) {
      this.deps.log(`github poll: default branch unavailable for ${ownerRepo} (gh degraded) — skipping push poll`);
      return false;
    }
    const head = await this.getBranchHead(ownerRepo, branch);
    if (!isRealSha(head)) {
      this.deps.log(`github poll: ${branch} head unavailable for ${ownerRepo} (gh degraded) — skipping push poll`);
      return false;
    }

    const last = state.lastPushSha;
    if (!last) {
      // Baseline: record the current head WITHOUT firing (not a "push" event).
      state.lastPushSha = head;
      this.deps.log(`github poll: push baseline set for ${ownerRepo}@${branch} (${head.slice(0, 7)})`);
      return true;
    }
    if (last === head) return false; // unchanged

    const result = await this.deps.fireTrigger(
      trigger,
      this.pushEnvelope(ownerRepo, branch, last, head),
    );
    if (result === "skipped-dedup") {
      this.deps.log(`github poll: push to ${ownerRepo}@${branch} dedup-suppressed — watermark held`);
      return false; // hold last → retried next cycle
    }
    state.lastPushSha = head; // advance
    this.deps.log(`github poll: fired push to ${ownerRepo}@${branch} (${head.slice(0, 7)}, ${result})`);
    return true;
  }

  /** Owner/repo from `config.repository` (already owner/repo), else the git remote. */
  private async resolveOwnerRepo(config: GitHubEventTriggerConfig): Promise<string | null> {
    const declared = (config.repository ?? "").trim();
    if (declared.length > 0) {
      return OWNER_REPO_RE.test(declared) ? declared : null;
    }
    const repoPath = config.action?.repoPath;
    if (!repoPath) return null;
    const url = await this.gitRemoteUrl(repoPath);
    return url ? parseOwnerRepo(url) : null;
  }

  /** Default branch name via `gh repo view <o/r> --json defaultBranchRef`. */
  private async getDefaultBranch(ownerRepo: string): Promise<string | null> {
    const meta = await runGhJson<{ defaultBranchRef?: { name?: string } }>(
      ["repo", "view", ownerRepo, "--json", "defaultBranchRef"],
      this.runGh,
    );
    const name = meta?.defaultBranchRef?.name;
    return typeof name === "string" && name.length > 0 ? name : null;
  }

  /** Default-branch head sha via `gh api repos/<o/r>/branches/<branch>`. */
  private async getBranchHead(ownerRepo: string, branch: string): Promise<string | undefined> {
    const info = await runGhJson<{ commit?: { sha?: string } }>(
      ["api", `repos/${ownerRepo}/branches/${encodeURIComponent(branch)}`],
      this.runGh,
    );
    return info?.commit?.sha;
  }

  /**
   * Synthesize the SAME `{ event, delivery, payload }` envelope the webhook receiver
   * hands `fireTrigger` for a pull_request (github-event-handler.ts), so
   * `mapGitHubEventToReview` produces an IDENTICAL diff-pr-review loop.
   */
  private prEnvelope(
    ownerRepo: string,
    pr: GhPrListItem,
    head: string,
    base: string,
    action: "opened" | "synchronize",
  ): unknown {
    return {
      event: "pull_request",
      delivery: `poll-pr-${pr.number}-${head.slice(0, 7)}`,
      payload: {
        action,
        number: pr.number,
        pull_request: {
          number: pr.number,
          title: pr.title ?? "",
          head: { sha: head },
          base: { sha: base },
        },
        repository: { full_name: ownerRepo },
      },
    };
  }

  /** The webhook-identical envelope for a push to the default branch. */
  private pushEnvelope(ownerRepo: string, branch: string, before: string, after: string): unknown {
    return {
      event: "push",
      delivery: `poll-push-${after.slice(0, 7)}`,
      payload: {
        ref: `refs/heads/${branch}`,
        before,
        after,
        repository: { full_name: ownerRepo, default_branch: branch },
      },
    };
  }

  /** Re-read fresh + write the watermark into `config.pollState` (no migration). */
  private async persistWatermark(triggerId: string, state: GitHubPollState): Promise<void> {
    const fresh = await this.deps.getTrigger(triggerId);
    // The trigger may have been deleted/disabled mid-cycle — nothing to persist.
    if (!fresh) return;
    const freshConfig = (fresh.config ?? {}) as GitHubEventTriggerConfig;
    const nextConfig: GitHubEventTriggerConfig = { ...freshConfig, pollState: state };
    await this.deps.updateTrigger(triggerId, { config: nextConfig });
  }
}

/** Keep at most MAX_TRACKED_PRS heads (highest PR numbers win — most recent). */
function boundHeads(heads: Record<string, string>): Record<string, string> {
  const keys = Object.keys(heads);
  if (keys.length <= MAX_TRACKED_PRS) return heads;
  const kept = keys
    .map((k) => Number(k))
    .sort((a, b) => b - a)
    .slice(0, MAX_TRACKED_PRS)
    .map((n) => String(n));
  const out: Record<string, string> = {};
  for (const k of kept) out[k] = heads[k];
  return out;
}

function shallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}
