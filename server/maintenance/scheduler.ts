/**
 * Maintenance Autopilot Scheduler — Phase 4.5 PR 3
 *
 * Manages cron-based execution of maintenance scans.
 * Each active policy gets its own cron job that triggers the Scout Agent
 * against the policy's associated workspace.
 *
 * Lifecycle:
 *   start()  — load all enabled policies, register cron jobs
 *   reload() — diff current jobs against DB, add/remove as needed
 *   stop()   — destroy all active cron jobs
 */

import cron, { type ScheduledTask } from "node-cron";
import { db } from "../db";
import { maintenancePolicies, maintenanceScans } from "@shared/schema";
import { eq } from "drizzle-orm";
import { runScout } from "./scout";
import type { MaintenanceCategoryConfig } from "@shared/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScheduledJob {
  policyId: string;
  schedule: string;
  task: ScheduledTask;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export class MaintenanceScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private workspacePathResolver: (workspaceId: string) => Promise<string | null>;

  constructor(
    workspacePathResolver: (workspaceId: string) => Promise<string | null>,
  ) {
    this.workspacePathResolver = workspacePathResolver;
  }

  /**
   * Load all enabled policies and start their cron jobs.
   */
  async start(): Promise<void> {
    const policies = await db
      .select()
      .from(maintenancePolicies)
      .where(eq(maintenancePolicies.enabled, true));

    for (const policy of policies) {
      this.registerJob(policy.id, policy.schedule);
    }
  }

  /**
   * Diff the current jobs against the DB and reconcile.
   * Call this after any policy CRUD operation.
   */
  async reload(): Promise<void> {
    const policies = await db
      .select()
      .from(maintenancePolicies)
      .where(eq(maintenancePolicies.enabled, true));

    const activePolicyIds = new Set(policies.map((p) => p.id));

    // Remove jobs for policies that no longer exist or are disabled
    for (const [policyId, job] of this.jobs.entries()) {
      if (!activePolicyIds.has(policyId)) {
        job.task.stop();
        this.jobs.delete(policyId);
      }
    }

    // Add or reschedule jobs for active policies
    for (const policy of policies) {
      const existing = this.jobs.get(policy.id);
      if (existing && existing.schedule === policy.schedule) {
        // Already running with the correct schedule
        continue;
      }
      if (existing) {
        // Schedule changed — replace
        existing.task.stop();
        this.jobs.delete(policy.id);
      }
      this.registerJob(policy.id, policy.schedule);
    }
  }

  /**
   * Stop all scheduled jobs. Call on server shutdown.
   */
  stop(): void {
    for (const job of this.jobs.values()) {
      job.task.stop();
    }
    this.jobs.clear();
  }

  /**
   * Immediately execute a scan for a policy (bypass cron schedule).
   * Returns the scan id.
   */
  async triggerNow(policyId: string): Promise<string | null> {
    return this.executeScan(policyId);
  }

  /**
   * Return a snapshot of currently scheduled jobs (for status/debug endpoints).
   */
  getJobStatus(): Array<{ policyId: string; schedule: string }> {
    return Array.from(this.jobs.values()).map((j) => ({
      policyId: j.policyId,
      schedule: j.schedule,
    }));
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private registerJob(policyId: string, schedule: string): void {
    if (!cron.validate(schedule)) {
      // Invalid schedule from DB — skip silently (schema validates on write)
      return;
    }

    const task = cron.schedule(schedule, () => {
      void this.executeScan(policyId);
    });

    this.jobs.set(policyId, { policyId, schedule, task });
  }

  private async executeScan(policyId: string): Promise<string | null> {
    // Fetch policy (it may have changed since registration)
    const [policy] = await db
      .select()
      .from(maintenancePolicies)
      .where(eq(maintenancePolicies.id, policyId));

    if (!policy || !policy.enabled || !policy.workspaceId) {
      return null;
    }

    const workspacePath = await this.workspacePathResolver(policy.workspaceId);
    if (!workspacePath) {
      return null;
    }

    // Create a scan record in "running" state
    const [scan] = await db
      .insert(maintenanceScans)
      .values({
        policyId: policy.id,
        workspaceId: policy.workspaceId,
        status: "running",
        findings: [],
        importantCount: 0,
      })
      .returning();

    try {
      const enabledCategories = (policy.categories as MaintenanceCategoryConfig[])
        .filter((c) => c.enabled)
        .map((c) => c.category);

      const result = await runScout({
        workspacePath,
        scanId: scan.id,
        enabledCategories,
      });

      await db
        .update(maintenanceScans)
        .set({
          status: "completed",
          findings: result.findings,
          importantCount: result.importantCount,
          completedAt: new Date(),
        })
        .where(eq(maintenanceScans.id, scan.id));

      return scan.id;
    } catch {
      await db
        .update(maintenanceScans)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(maintenanceScans.id, scan.id));

      return scan.id;
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _scheduler: MaintenanceScheduler | null = null;

export function getScheduler(): MaintenanceScheduler {
  if (!_scheduler) {
    throw new Error("Maintenance scheduler not initialized. Call initScheduler() first.");
  }
  return _scheduler;
}

export function initScheduler(
  workspacePathResolver: (workspaceId: string) => Promise<string | null>,
): MaintenanceScheduler {
  if (_scheduler) {
    _scheduler.stop();
  }
  _scheduler = new MaintenanceScheduler(workspacePathResolver);
  return _scheduler;
}

export function resetScheduler(): void {
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
}
