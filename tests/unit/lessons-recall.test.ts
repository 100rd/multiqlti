import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../server/storage.js";
import { LessonRecallService } from "../../server/memory/lessons/recall.js";

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
