import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../server/storage.js";
import { LessonCaptureService } from "../../server/memory/lessons/capture.js";
import { LessonRecallService } from "../../server/memory/lessons/recall.js";
import type { StageExecution } from "../../shared/schema.js";

function stage(overrides: Partial<StageExecution>): StageExecution {
  return {
    id: "stage-x",
    runId: "run-x",
    stageIndex: 0,
    teamId: "backend",
    modelSlug: "mock",
    status: "failed",
    input: {},
    output: null,
    tokensUsed: 0,
    startedAt: null,
    completedAt: null,
    sandboxResult: null,
    thoughtTree: null,
    approvalStatus: null,
    approvedAt: null,
    approvedBy: null,
    rejectionReason: null,
    error: "boom",
    dagStageId: null,
    swarmCloneResults: null,
    swarmMeta: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("LessonCaptureService", () => {
  let storage: MemStorage;
  let capture: LessonCaptureService;

  beforeEach(() => {
    storage = new MemStorage();
    capture = new LessonCaptureService(storage);
  });

  it("captures a lesson from a failed stage and round-trips it through storage", async () => {
    const lesson = await capture.captureStage(
      stage({ error: "Sandbox failed (exit 1): boom" }),
      { runId: "run-x", workspaceId: "ws-1" },
    );
    expect(lesson).not.toBeNull();

    const stored = await storage.getLessons("ws-1");
    expect(stored).toHaveLength(1);
    expect(stored[0].outcome).toBe("failure");
    expect(stored[0].category).toBe("sandbox");
    expect(stored[0].id).toBe(lesson?.id);
  });

  it("never throws when storage rejects — capture is best-effort", async () => {
    const errors: unknown[] = [];
    const failing = new LessonCaptureService(
      {
        createLesson: () => Promise.reject(new Error("db down")),
      },
      (e) => errors.push(e),
    );
    const result = await failing.captureStage(stage({}), {
      runId: "run-x",
      workspaceId: "ws-1",
    });
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
  });
});

describe("LessonRecallService", () => {
  let storage: MemStorage;

  beforeEach(async () => {
    storage = new MemStorage();
    await storage.createLesson({
      workspaceId: "ws-1",
      runId: "r1",
      teamId: "backend",
      outcome: "failure",
      title: "old",
      summary: "old failure",
    });
    await storage.createLesson({
      workspaceId: "ws-1",
      runId: "r2",
      teamId: "frontend",
      outcome: "failure",
      title: "other team",
      summary: "frontend failure",
    });
    await storage.createLesson({
      workspaceId: "ws-2",
      runId: "r3",
      teamId: "backend",
      outcome: "failure",
      title: "other ws",
      summary: "other workspace",
    });
  });

  it("recalls only lessons matching workspace + team", async () => {
    const recall = new LessonRecallService(storage);
    const lessons = await recall.recallForPlanning({
      workspaceId: "ws-1",
      teamId: "backend",
    });
    expect(lessons).toHaveLength(1);
    expect(lessons[0].summary).toBe("old failure");
  });

  it("returns an empty list (not a throw) when recall storage fails", async () => {
    const recall = new LessonRecallService({
      recallLessons: () => Promise.reject(new Error("db down")),
    });
    const lessons = await recall.recallForPlanning({ workspaceId: "ws-1" });
    expect(lessons).toEqual([]);
  });
});
