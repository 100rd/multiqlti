/**
 * Active Knowledge Base refresh scheduler (Wave 2).
 *
 * Clones the MaintenanceScheduler pattern (server/maintenance/scheduler.ts): a
 * weekly cron that scans, writes findings, and queues work for humans — but
 * NEVER mutates source. Here "source" is a practice card's `status`: stale and
 * superseded cards stay `status='active'` until a human accepts a replacement
 * via POST /review. The refresh only writes a report row and sets a
 * `pending_review` review-state HINT for flagged cards.
 *
 * The server does NOT spawn research agents. On a cadence/manual run the
 * candidate set is empty, so the diff detects staleness/supersession AMONG
 * EXISTING cards. Off-server agents feed fresh candidates back via POST /ingest.
 *
 * SIGNAL trigger (Terraform release / changelog) — NOT wired in this MVP. It would
 * attach to the existing `github_event` triggers model (TRIGGER_TYPES includes
 * "github_event" with "release"), which depends on TRIGGER_SECRET_KEY being set
 * (server/routes.ts disables the trigger subsystem otherwise). A release webhook
 * would call refreshScheduler.triggerNow(workspaceId, "signal"). Cadence is what
 * ships now.
 */
import cron, { type ScheduledTask } from "node-cron";
import type { IStorage } from "../storage";
import type { PracticeCardRefreshRunRow } from "@shared/schema";
import { diffPracticeCards, type DiffReport } from "./diff-engine";

const DEFAULT_CRON = "0 6 * * 1"; // Mondays 06:00 UTC
const ACTIVE_CARD_SCAN_LIMIT = 200;

/** Resolve the cron expression: env override or weekly default. */
export function resolveRefreshCron(): string {
  const fromEnv = process.env.KB_REFRESH_CRON;
  return fromEnv && cron.validate(fromEnv) ? fromEnv : DEFAULT_CRON;
}

/** Serializable report persisted on the refresh-run row. */
export interface RefreshRunReport {
  new: number;
  changed: number;
  stale: string[];
  superseded: string[];
  unchangedCount: number;
}

function toReport(diff: DiffReport): RefreshRunReport {
  return {
    new: diff.new.length,
    changed: diff.changed.length,
    stale: diff.stale.map((c) => c.id),
    superseded: diff.superseded.map((c) => c.id),
    unchangedCount: diff.unchangedCount,
  };
}

export class KnowledgeRefreshScheduler {
  private readonly storage: IStorage;
  private readonly schedule: string;
  /** Cron jobs keyed by a registration id (MVP uses a single global job). */
  private readonly jobs = new Map<string, ScheduledTask>();

  constructor(storage: IStorage, schedule: string = resolveRefreshCron()) {
    this.storage = storage;
    this.schedule = schedule;
  }

  /**
   * Register the weekly cron. MVP: one schedule; the job iterates per workspace.
   */
  async start(): Promise<void> {
    if (!cron.validate(this.schedule)) return;
    if (this.jobs.has("__global__")) return;
    const task = cron.schedule(this.schedule, () => {
      void this.runAllWorkspaces(new Date());
    });
    this.jobs.set("__global__", task);
  }

  /** Stop all cron jobs (server shutdown). */
  stop(): void {
    for (const task of this.jobs.values()) task.stop();
    this.jobs.clear();
  }

  /** Re-evaluate the schedule (no-op restart of the single global job). */
  async reload(): Promise<void> {
    this.stop();
    await this.start();
  }

  /** Manually run a refresh for one workspace, returning the refresh-run id. */
  async triggerNow(workspaceId: string, trigger = "manual", now: Date = new Date()): Promise<string> {
    const run = await this.executeRefresh(workspaceId, now, trigger);
    return run.id;
  }

  /**
   * Execute one refresh: load active cards, diff against an empty candidate set
   * (server-triggered), write a report row, and set a pending_review HINT for
   * flagged cards. Mutates NO card's `status`.
   */
  async executeRefresh(
    workspaceId: string,
    now: Date,
    trigger = "cadence",
  ): Promise<PracticeCardRefreshRunRow> {
    const run = await this.storage.createRefreshRun(workspaceId, "terraform-module-best-practices", trigger);
    try {
      const { cards } = await this.storage.listPracticeCards(workspaceId, {
        status: "active",
        limit: ACTIVE_CARD_SCAN_LIMIT,
      });
      const diff = diffPracticeCards(cards, [], now);
      const report = toReport(diff);

      // Queue HINT only — review-state, never status. Idempotent: skip if already pending.
      const flagged = [...diff.stale, ...diff.superseded];
      for (const card of flagged) {
        if (card.reviewState !== "pending_review") {
          await this.storage.updatePracticeCardState(card.id, { reviewState: "pending_review" });
        }
      }

      return this.storage.updateRefreshRun(run.id, {
        status: "completed",
        report: report as unknown as Record<string, unknown>,
        completedAt: now,
      });
    } catch {
      return this.storage.updateRefreshRun(run.id, { status: "failed", completedAt: now });
    }
  }

  private async runAllWorkspaces(now: Date): Promise<void> {
    const workspaces = await this.storage.getWorkspaces();
    for (const ws of workspaces) {
      await this.executeRefresh(ws.id, now);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _scheduler: KnowledgeRefreshScheduler | null = null;

export function initRefreshScheduler(storage: IStorage): KnowledgeRefreshScheduler {
  if (_scheduler) _scheduler.stop();
  _scheduler = new KnowledgeRefreshScheduler(storage);
  return _scheduler;
}

export function getRefreshScheduler(): KnowledgeRefreshScheduler | null {
  return _scheduler;
}

export function resetRefreshScheduler(): void {
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
}
