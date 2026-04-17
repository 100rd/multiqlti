/**
 * Unit tests for IndexScheduler (Issue #284)
 *
 * Tests scheduler start/stop lifecycle, workspace registration,
 * manual rebuild trigger, and cron validation.
 *
 * node-cron is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock incremental-indexer registry ────────────────────────────────────────

const mockIndexerMap = new Map<string, {
  isActive: boolean;
  triggerFullRebuild: ReturnType<typeof vi.fn>;
}>();

vi.mock("../../../server/workspace/incremental-indexer.js", () => ({
  getIncrementalIndexer: vi.fn((id: string) => mockIndexerMap.get(id)),
  getOrCreateIncrementalIndexer: vi.fn(),
  removeIncrementalIndexer: vi.fn(),
}));

// ─── Mock node-cron ───────────────────────────────────────────────────────────

let capturedCallback: (() => void) | null = null;
let mockTaskStopped = false;

vi.mock("node-cron", () => ({
  default: {
    validate: vi.fn((expr: string) => {
      // Very basic validation — accept standard 5-field cron
      return expr.split(" ").length === 5;
    }),
    schedule: vi.fn((_expr: string, cb: () => void) => {
      capturedCallback = cb;
      mockTaskStopped = false;
      return {
        stop: vi.fn(() => { mockTaskStopped = true; }),
      };
    }),
  },
}));

import { IndexScheduler, DEFAULT_REBUILD_CRON } from "../../../server/workspace/index-scheduler.js";

describe("IndexScheduler", () => {
  beforeEach(() => {
    mockIndexerMap.clear();
    capturedCallback = null;
    mockTaskStopped = false;
  });

  it("1. DEFAULT_REBUILD_CRON is a valid cron expression", () => {
    expect(DEFAULT_REBUILD_CRON.split(" ").length).toBe(5);
  });

  it("2. start() sets isRunning=true", () => {
    const s = new IndexScheduler("0 2 * * *");
    s.start();
    expect(s.isRunning).toBe(true);
    s.stop();
  });

  it("3. stop() sets isRunning=false", () => {
    const s = new IndexScheduler("0 2 * * *");
    s.start();
    s.stop();
    expect(s.isRunning).toBe(false);
  });

  it("4. calling start() twice is idempotent", () => {
    const s = new IndexScheduler("0 2 * * *");
    s.start();
    s.start();
    expect(s.isRunning).toBe(true);
    s.stop();
  });

  it("5. invalid cron expression throws on start()", () => {
    const s = new IndexScheduler("not a cron");
    expect(() => s.start()).toThrow();
  });

  it("6. registerWorkspace adds to the registered set", () => {
    const s = new IndexScheduler("0 2 * * *");
    s.registerWorkspace("ws-001");
    expect(s.registeredCount).toBe(1);
    s.stop();
  });

  it("7. deregisterWorkspace removes from the registered set", () => {
    const s = new IndexScheduler("0 2 * * *");
    s.registerWorkspace("ws-001");
    s.deregisterWorkspace("ws-001");
    expect(s.registeredCount).toBe(0);
    s.stop();
  });

  it("8. runRebuild() calls triggerFullRebuild on each active registered workspace", async () => {
    const triggerMock = vi.fn().mockResolvedValue(undefined);
    mockIndexerMap.set("ws-001", { isActive: true, triggerFullRebuild: triggerMock });

    const s = new IndexScheduler("0 2 * * *");
    s.registerWorkspace("ws-001");

    await s.runRebuild();

    expect(triggerMock).toHaveBeenCalledOnce();
    s.stop();
  });

  it("9. runRebuild() skips inactive indexers", async () => {
    const triggerMock = vi.fn().mockResolvedValue(undefined);
    mockIndexerMap.set("ws-inactive", { isActive: false, triggerFullRebuild: triggerMock });

    const s = new IndexScheduler("0 2 * * *");
    s.registerWorkspace("ws-inactive");

    await s.runRebuild();

    expect(triggerMock).not.toHaveBeenCalled();
    s.stop();
  });

  it("10. runRebuild() skips workspaces without an active indexer", async () => {
    const s = new IndexScheduler("0 2 * * *");
    s.registerWorkspace("ws-no-indexer"); // not in mockIndexerMap

    // Should not throw
    await expect(s.runRebuild()).resolves.toBeUndefined();
    s.stop();
  });

  it("11. cron callback triggers runRebuild (integration via capturedCallback)", async () => {
    const triggerMock = vi.fn().mockResolvedValue(undefined);
    mockIndexerMap.set("ws-cron", { isActive: true, triggerFullRebuild: triggerMock });

    const s = new IndexScheduler("0 2 * * *");
    s.registerWorkspace("ws-cron");
    s.start();

    expect(capturedCallback).not.toBeNull();
    capturedCallback!();
    // Wait for async rebuild
    await Promise.resolve();
    await Promise.resolve();

    expect(triggerMock).toHaveBeenCalled();
    s.stop();
  });

  it("12. runRebuild does not crash when triggerFullRebuild rejects", async () => {
    const triggerMock = vi.fn().mockRejectedValue(new Error("rebuild failed"));
    mockIndexerMap.set("ws-fail", { isActive: true, triggerFullRebuild: triggerMock });

    const s = new IndexScheduler("0 2 * * *");
    s.registerWorkspace("ws-fail");

    await expect(s.runRebuild()).resolves.toBeUndefined();
    s.stop();
  });

  it("13. stop() clears all registered workspaces", () => {
    const s = new IndexScheduler("0 2 * * *");
    s.registerWorkspace("ws-001");
    s.registerWorkspace("ws-002");
    s.start();
    s.stop();
    expect(s.registeredCount).toBe(0);
  });

  it("14. registeredCount is 0 initially", () => {
    const s = new IndexScheduler("0 2 * * *");
    expect(s.registeredCount).toBe(0);
  });

  it("15. runRebuild handles multiple workspaces in parallel", async () => {
    for (let i = 0; i < 3; i++) {
      const id = `ws-${i}`;
      const triggerMock = vi.fn().mockResolvedValue(undefined);
      mockIndexerMap.set(id, { isActive: true, triggerFullRebuild: triggerMock });
    }

    const s = new IndexScheduler("0 2 * * *");
    s.registerWorkspace("ws-0");
    s.registerWorkspace("ws-1");
    s.registerWorkspace("ws-2");

    await s.runRebuild();

    for (let i = 0; i < 3; i++) {
      expect(mockIndexerMap.get(`ws-${i}`)!.triggerFullRebuild).toHaveBeenCalled();
    }
    s.stop();
  });
});
