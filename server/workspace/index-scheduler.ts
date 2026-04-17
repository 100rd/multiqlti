/**
 * IndexScheduler — Issue #284
 *
 * Schedules nightly full rebuilds of incremental workspace indexes.
 * Uses node-cron for scheduling.
 *
 * Default: rebuilds all active workspace indexes at 02:00 UTC every day.
 * Override via INDEXER_REBUILD_CRON env var.
 */
import cron, { type ScheduledTask } from "node-cron";
import { getIncrementalIndexer } from "./incremental-indexer.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default nightly rebuild schedule (02:00 UTC). */
export const DEFAULT_REBUILD_CRON = "0 2 * * *";

// ─── IndexScheduler Class ─────────────────────────────────────────────────────

export class IndexScheduler {
  private task: ScheduledTask | null = null;
  private readonly cronExpression: string;
  private workspaceIds: Set<string> = new Set();

  constructor(cronExpression?: string) {
    this.cronExpression = cronExpression ?? process.env.INDEXER_REBUILD_CRON ?? DEFAULT_REBUILD_CRON;
  }

  /**
   * Register a workspace ID to be rebuilt on the nightly schedule.
   */
  registerWorkspace(workspaceId: string): void {
    this.workspaceIds.add(workspaceId);
  }

  /**
   * Deregister a workspace ID from the nightly schedule.
   */
  deregisterWorkspace(workspaceId: string): void {
    this.workspaceIds.delete(workspaceId);
  }

  /**
   * Start the scheduled task.
   * Idempotent — calling multiple times has no effect.
   */
  start(): void {
    if (this.task) return;

    if (!cron.validate(this.cronExpression)) {
      throw new Error(
        `[index-scheduler] Invalid cron expression: ${this.cronExpression}`,
      );
    }

    this.task = cron.schedule(this.cronExpression, () => {
      void this.runRebuild();
    });
  }

  /**
   * Stop the scheduled task and clear registered workspaces.
   */
  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    this.workspaceIds.clear();
  }

  /** True if the scheduler is currently running. */
  get isRunning(): boolean {
    return this.task !== null;
  }

  /** Number of registered workspace IDs. */
  get registeredCount(): number {
    return this.workspaceIds.size;
  }

  /**
   * Manually trigger the rebuild for all registered workspaces.
   * Also called by the cron task on schedule.
   */
  async runRebuild(): Promise<void> {
    for (const workspaceId of Array.from(this.workspaceIds)) {
      const inc = getIncrementalIndexer(workspaceId);
      if (!inc || !inc.isActive) continue;

      try {
        await inc.triggerFullRebuild();
      } catch (err) {
        process.stderr.write(
          `[index-scheduler] rebuild failed for workspace ${workspaceId}: ${(err as Error).message}\n`,
        );
      }
    }
  }
}

/** Module-level singleton scheduler. */
let _scheduler: IndexScheduler | null = null;

export function getIndexScheduler(): IndexScheduler {
  if (!_scheduler) {
    _scheduler = new IndexScheduler();
  }
  return _scheduler;
}
