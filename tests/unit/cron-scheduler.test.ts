/**
 * Unit tests for CronScheduler (server/services/cron-scheduler.ts).
 *
 * Covers:
 * - bootstrap() loads all enabled schedule triggers and schedules them
 * - Disabled trigger does NOT fire when cron ticks (not loaded)
 * - Invalid cron expression is silently skipped (does not throw, just logs)
 * - re-enabling a trigger via scheduleTrigger replaces the existing task
 * - stopAll() cancels all running tasks
 * - removeTrigger() removes only the specified task
 * - size property tracks active task count
 *
 * Note: node-cron is mocked so tests run without real timers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TriggerRow } from "../../shared/schema.js";

// ─── Mock node-cron ───────────────────────────────────────────────────────────

const mockTaskStop = vi.fn();
const mockSchedule = vi.fn().mockReturnValue({ stop: mockTaskStop });
const mockValidate = vi.fn().mockReturnValue(true);

vi.mock("node-cron", () => ({
  default: {
    schedule: mockSchedule,
    validate: mockValidate,
  },
  schedule: mockSchedule,
  validate: mockValidate,
}));

// ─── Mock configLoader to prevent env requirements ───────────────────────────

vi.mock("../../server/config/loader.js", () => ({
  configLoader: {
    get: () => ({
      auth: { jwtSecret: "test-secret-minimum-32-chars-longxx", bcryptRounds: 4, sessionTtlDays: 1 },
      server: { nodeEnv: "test", port: 3000 },
      database: { url: undefined },
      providers: {},
      features: {
        sandbox: { enabled: false },
        privacy: { enabled: true },
        maintenance: { enabled: false, cronSchedule: "0 2 * * *" },
      },
      encryption: {},
    }),
  },
}));

// ─── Helper: make a minimal TriggerRow for schedule type ─────────────────────

function makeScheduleTrigger(
  id: string,
  opts: { cron?: string; timezone?: string; enabled?: boolean } = {},
): TriggerRow {
  return {
    id,
    pipelineId: "test-pipeline",
    type: "schedule",
    config: {
      cron: opts.cron ?? "0 9 * * 1",
      timezone: opts.timezone,
    },
    secretEncrypted: null,
    enabled: opts.enabled ?? true,
    lastTriggeredAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CronScheduler — basic scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockReturnValue(true);
    mockSchedule.mockReturnValue({ stop: mockTaskStop });
  });

  it("should schedule a trigger when scheduleTrigger is called with a valid cron", async () => {
    const { CronScheduler } = await import("../../server/services/cron-scheduler.js");

    const fireTrigger = vi.fn().mockResolvedValue(undefined);
    const scheduler = new CronScheduler({
      getEnabledTriggersByType: async () => [],
      fireTrigger,
    });

    const trigger = makeScheduleTrigger("t-1");
    scheduler.scheduleTrigger(trigger);

    expect(mockSchedule).toHaveBeenCalledOnce();
    expect(scheduler.size).toBe(1);
  });

  it("should not schedule when cron expression fails validation", async () => {
    const { CronScheduler } = await import("../../server/services/cron-scheduler.js");

    mockValidate.mockReturnValue(false);

    const fireTrigger = vi.fn().mockResolvedValue(undefined);
    const scheduler = new CronScheduler({
      getEnabledTriggersByType: async () => [],
      fireTrigger,
    });

    const trigger = makeScheduleTrigger("t-invalid", { cron: "not-a-cron" });
    scheduler.scheduleTrigger(trigger);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(scheduler.size).toBe(0);
  });

  it("should replace the existing task when scheduling the same trigger id again", async () => {
    const { CronScheduler } = await import("../../server/services/cron-scheduler.js");

    const fireTrigger = vi.fn().mockResolvedValue(undefined);
    const scheduler = new CronScheduler({
      getEnabledTriggersByType: async () => [],
      fireTrigger,
    });

    const trigger = makeScheduleTrigger("t-replace");
    scheduler.scheduleTrigger(trigger);
    scheduler.scheduleTrigger(trigger);

    // stop() should have been called once (for the replaced task)
    expect(mockTaskStop).toHaveBeenCalledOnce();
    // Only one task is active after replacement
    expect(scheduler.size).toBe(1);
  });
});

describe("CronScheduler — bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockReturnValue(true);
    mockSchedule.mockReturnValue({ stop: mockTaskStop });
  });

  it("should load and schedule all enabled triggers during bootstrap", async () => {
    const { CronScheduler } = await import("../../server/services/cron-scheduler.js");

    const triggers = [
      makeScheduleTrigger("bs-1"),
      makeScheduleTrigger("bs-2"),
    ];

    const scheduler = new CronScheduler({
      getEnabledTriggersByType: async () => triggers,
      fireTrigger: vi.fn().mockResolvedValue(undefined),
    });

    await scheduler.bootstrap();

    expect(scheduler.size).toBe(2);
    expect(mockSchedule).toHaveBeenCalledTimes(2);
  });

  it("should not schedule disabled triggers (only enabled ones are loaded by getEnabledTriggersByType)", async () => {
    const { CronScheduler } = await import("../../server/services/cron-scheduler.js");

    // Simulate storage that only returns enabled triggers (MemStorage already filters)
    const scheduler = new CronScheduler({
      getEnabledTriggersByType: async () => [], // disabled triggers not returned
      fireTrigger: vi.fn().mockResolvedValue(undefined),
    });

    await scheduler.bootstrap();

    expect(scheduler.size).toBe(0);
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe("CronScheduler — removeTrigger and stopAll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockReturnValue(true);
    mockSchedule.mockReturnValue({ stop: mockTaskStop });
  });

  it("should remove only the specified trigger task", async () => {
    const { CronScheduler } = await import("../../server/services/cron-scheduler.js");

    const scheduler = new CronScheduler({
      getEnabledTriggersByType: async () => [],
      fireTrigger: vi.fn().mockResolvedValue(undefined),
    });

    scheduler.scheduleTrigger(makeScheduleTrigger("rm-1"));
    scheduler.scheduleTrigger(makeScheduleTrigger("rm-2"));
    expect(scheduler.size).toBe(2);

    scheduler.removeTrigger("rm-1");
    expect(scheduler.size).toBe(1);
    expect(mockTaskStop).toHaveBeenCalledOnce();
  });

  it("should be a no-op when removing a non-existent trigger id", async () => {
    const { CronScheduler } = await import("../../server/services/cron-scheduler.js");

    const scheduler = new CronScheduler({
      getEnabledTriggersByType: async () => [],
      fireTrigger: vi.fn().mockResolvedValue(undefined),
    });

    // Should not throw
    expect(() => scheduler.removeTrigger("does-not-exist")).not.toThrow();
    expect(mockTaskStop).not.toHaveBeenCalled();
  });

  it("should cancel all tasks when stopAll is called", async () => {
    const { CronScheduler } = await import("../../server/services/cron-scheduler.js");

    // Each scheduled task gets a fresh mock stop
    const stop1 = vi.fn();
    const stop2 = vi.fn();
    mockSchedule
      .mockReturnValueOnce({ stop: stop1 })
      .mockReturnValueOnce({ stop: stop2 });

    const scheduler = new CronScheduler({
      getEnabledTriggersByType: async () => [],
      fireTrigger: vi.fn().mockResolvedValue(undefined),
    });

    scheduler.scheduleTrigger(makeScheduleTrigger("stop-1"));
    scheduler.scheduleTrigger(makeScheduleTrigger("stop-2"));
    expect(scheduler.size).toBe(2);

    scheduler.stopAll();

    expect(stop1).toHaveBeenCalledOnce();
    expect(stop2).toHaveBeenCalledOnce();
    expect(scheduler.size).toBe(0);
  });
});

describe("CronScheduler — restartTrigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockReturnValue(true);
    mockSchedule.mockReturnValue({ stop: mockTaskStop });
  });

  it("should reschedule the trigger when restartTrigger is called", async () => {
    const { CronScheduler } = await import("../../server/services/cron-scheduler.js");

    const scheduler = new CronScheduler({
      getEnabledTriggersByType: async () => [],
      fireTrigger: vi.fn().mockResolvedValue(undefined),
    });

    const trigger = makeScheduleTrigger("restart-1");
    scheduler.scheduleTrigger(trigger);

    scheduler.restartTrigger(trigger);

    // First stop called for old task, then a new task scheduled
    expect(mockTaskStop).toHaveBeenCalledOnce();
    expect(mockSchedule).toHaveBeenCalledTimes(2);
    expect(scheduler.size).toBe(1);
  });
});

describe("CronScheduler — fire callback on cron tick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockReturnValue(true);
  });

  it("should call fireTrigger with scheduled payload when the cron task fires", async () => {
    const { CronScheduler } = await import("../../server/services/cron-scheduler.js");

    let capturedCallback: (() => Promise<void>) | null = null;
    mockSchedule.mockImplementation((_expr: string, cb: () => Promise<void>) => {
      capturedCallback = cb;
      return { stop: vi.fn() };
    });

    const fireTrigger = vi.fn().mockResolvedValue(undefined);
    const scheduler = new CronScheduler({
      getEnabledTriggersByType: async () => [],
      fireTrigger,
    });

    const trigger = makeScheduleTrigger("fire-1", { cron: "0 9 * * *" });
    scheduler.scheduleTrigger(trigger);

    expect(capturedCallback).not.toBeNull();

    // Simulate the cron tick
    await capturedCallback!();

    expect(fireTrigger).toHaveBeenCalledOnce();
    const [firedTrigger, payload] = fireTrigger.mock.calls[0] as [TriggerRow, { scheduledAt: string }];
    expect(firedTrigger.id).toBe("fire-1");
    expect(payload.scheduledAt).toBeDefined();
  });
});
