/**
 * Unit tests for the Maintenance Scheduler (Phase 4.5 PR 3).
 *
 * Mocks the DB and node-cron to verify job lifecycle without real I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock node-cron ────────────────────────────────────────────────────────────

const scheduledTasks: Map<string, { stopped: boolean; callback: () => void }> = new Map();
let taskCounter = 0;

vi.mock("node-cron", () => ({
  default: {
    validate: (expr: string) => {
      // Accept standard cron expressions and named shortcuts
      const valid = /^(@(annually|yearly|monthly|weekly|daily|hourly|reboot)|(\S+ \S+ \S+ \S+ \S+))$/.test(expr.trim());
      return valid;
    },
    schedule: (_expr: string, callback: () => void) => {
      const id = `task-${++taskCounter}`;
      const task = {
        id,
        stopped: false,
        stop: () => { task.stopped = true; },
        callback,
      };
      scheduledTasks.set(id, task);
      return task;
    },
  },
}));

// ── Mock DB ───────────────────────────────────────────────────────────────────

const dbPolicies: Record<string, unknown>[] = [];
const dbScans: Record<string, unknown>[] = [];

vi.mock("../../../server/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([...dbPolicies]),
      }),
    }),
    insert: () => ({
      values: (data: Record<string, unknown>) => ({
        returning: () => {
          const scan = { id: `scan-${Date.now()}`, ...data, completedAt: null };
          dbScans.push(scan);
          return Promise.resolve([scan]);
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  },
}));

// ── Mock scout ────────────────────────────────────────────────────────────────

vi.mock("../../../server/maintenance/scout", () => ({
  runScout: vi.fn().mockResolvedValue({ findings: [], importantCount: 0, errors: [] }),
}));

import {
  MaintenanceScheduler,
  initScheduler,
  getScheduler,
  resetScheduler,
} from "../../../server/maintenance/scheduler";

// ─── Tests ───────────────────────────────────────────────────────────────────

const noop = async (_id: string) => "/tmp/workspace";

describe("MaintenanceScheduler", () => {
  beforeEach(() => {
    dbPolicies.length = 0;
    dbScans.length = 0;
    scheduledTasks.clear();
    taskCounter = 0;
    resetScheduler();
  });

  afterEach(() => {
    resetScheduler();
  });

  // ── start() ───────────────────────────────────────────────────────────────

  describe("start()", () => {
    it("registers cron jobs for all enabled policies", async () => {
      dbPolicies.push(
        { id: "p1", enabled: true, schedule: "0 9 * * 1", workspaceId: "ws1", categories: [] },
        { id: "p2", enabled: true, schedule: "0 10 * * 2", workspaceId: "ws2", categories: [] },
      );

      const scheduler = new MaintenanceScheduler(noop);
      await scheduler.start();

      expect(scheduler.getJobStatus().length).toBe(2);
    });

    it("starts with zero jobs when no enabled policies exist", async () => {
      const scheduler = new MaintenanceScheduler(noop);
      await scheduler.start();
      expect(scheduler.getJobStatus().length).toBe(0);
    });

    it("skips invalid cron expressions silently", async () => {
      dbPolicies.push({
        id: "p-bad",
        enabled: true,
        schedule: "not-a-cron",
        workspaceId: "ws1",
        categories: [],
      });

      const scheduler = new MaintenanceScheduler(noop);
      await scheduler.start();
      expect(scheduler.getJobStatus().length).toBe(0);
    });
  });

  // ── reload() ──────────────────────────────────────────────────────────────

  describe("reload()", () => {
    it("adds new jobs when policies are added", async () => {
      const scheduler = new MaintenanceScheduler(noop);
      await scheduler.start();
      expect(scheduler.getJobStatus().length).toBe(0);

      dbPolicies.push({ id: "p1", enabled: true, schedule: "0 9 * * 1", workspaceId: "ws1", categories: [] });
      await scheduler.reload();
      expect(scheduler.getJobStatus().length).toBe(1);
    });

    it("removes jobs for deleted/disabled policies", async () => {
      dbPolicies.push({ id: "p1", enabled: true, schedule: "0 9 * * 1", workspaceId: "ws1", categories: [] });

      const scheduler = new MaintenanceScheduler(noop);
      await scheduler.start();
      expect(scheduler.getJobStatus().length).toBe(1);

      // Policy gets removed
      dbPolicies.length = 0;
      await scheduler.reload();
      expect(scheduler.getJobStatus().length).toBe(0);
    });

    it("reschedules jobs when schedule changes", async () => {
      dbPolicies.push({ id: "p1", enabled: true, schedule: "0 9 * * 1", workspaceId: "ws1", categories: [] });

      const scheduler = new MaintenanceScheduler(noop);
      await scheduler.start();
      expect(scheduler.getJobStatus()[0]?.schedule).toBe("0 9 * * 1");

      // Update schedule
      dbPolicies[0] = { id: "p1", enabled: true, schedule: "0 10 * * 2", workspaceId: "ws1", categories: [] };
      await scheduler.reload();
      expect(scheduler.getJobStatus().length).toBe(1);
      expect(scheduler.getJobStatus()[0]?.schedule).toBe("0 10 * * 2");
    });

    it("does not replace jobs when schedule is unchanged", async () => {
      dbPolicies.push({ id: "p1", enabled: true, schedule: "0 9 * * 1", workspaceId: "ws1", categories: [] });

      const scheduler = new MaintenanceScheduler(noop);
      await scheduler.start();
      const beforeCount = scheduledTasks.size;

      await scheduler.reload();
      // Should not have created new tasks
      expect(scheduledTasks.size).toBe(beforeCount);
    });
  });

  // ── stop() ────────────────────────────────────────────────────────────────

  describe("stop()", () => {
    it("stops all scheduled tasks", async () => {
      dbPolicies.push(
        { id: "p1", enabled: true, schedule: "0 9 * * 1", workspaceId: "ws1", categories: [] },
        { id: "p2", enabled: true, schedule: "0 10 * * 2", workspaceId: "ws2", categories: [] },
      );

      const scheduler = new MaintenanceScheduler(noop);
      await scheduler.start();
      expect(scheduler.getJobStatus().length).toBe(2);

      scheduler.stop();
      expect(scheduler.getJobStatus().length).toBe(0);
    });
  });

  // ── getJobStatus() ────────────────────────────────────────────────────────

  describe("getJobStatus()", () => {
    it("returns correct job metadata", async () => {
      dbPolicies.push({ id: "p1", enabled: true, schedule: "@weekly", workspaceId: "ws1", categories: [] });

      const scheduler = new MaintenanceScheduler(noop);
      await scheduler.start();

      const status = scheduler.getJobStatus();
      expect(status.length).toBe(1);
      expect(status[0].policyId).toBe("p1");
      expect(status[0].schedule).toBe("@weekly");
    });
  });

  // ── triggerNow() ──────────────────────────────────────────────────────────

  describe("triggerNow()", () => {
    it("returns null when policy has no workspaceId", async () => {
      dbPolicies.push({ id: "p1", enabled: true, schedule: "0 9 * * 1", workspaceId: null, categories: [] });

      const scheduler = new MaintenanceScheduler(async () => null);
      const result = await scheduler.triggerNow("p1");
      expect(result).toBeNull();
    });

    it("returns null when policy not found in DB", async () => {
      const scheduler = new MaintenanceScheduler(noop);
      const result = await scheduler.triggerNow("nonexistent-policy");
      expect(result).toBeNull();
    });

    it("returns scan id when scan executes", async () => {
      dbPolicies.push({ id: "p1", enabled: true, schedule: "0 9 * * 1", workspaceId: "ws1", categories: [] });

      const scheduler = new MaintenanceScheduler(async (_id) => "/tmp/workspace");
      const result = await scheduler.triggerNow("p1");
      expect(typeof result).toBe("string");
      expect(result).not.toBeNull();
    });
  });

  // ── Singleton helpers ─────────────────────────────────────────────────────

  describe("initScheduler / getScheduler / resetScheduler", () => {
    it("initScheduler returns a scheduler instance", () => {
      const scheduler = initScheduler(noop);
      expect(scheduler).toBeInstanceOf(MaintenanceScheduler);
    });

    it("getScheduler returns the initialized instance", () => {
      const scheduler = initScheduler(noop);
      expect(getScheduler()).toBe(scheduler);
    });

    it("getScheduler throws before init", () => {
      expect(() => getScheduler()).toThrow("not initialized");
    });

    it("resetScheduler clears the singleton", () => {
      initScheduler(noop);
      resetScheduler();
      expect(() => getScheduler()).toThrow("not initialized");
    });

    it("initScheduler stops existing scheduler before replacing", () => {
      const s1 = initScheduler(noop);
      const stopSpy = vi.spyOn(s1, "stop");
      initScheduler(noop);
      expect(stopSpy).toHaveBeenCalled();
    });
  });
});
