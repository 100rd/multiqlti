import { describe, it, expect } from "vitest";
import type { StageExecution } from "../../shared/schema.js";
import {
  deriveStageLesson,
  classifyFailure,
  normalizeErrorPattern,
  type LessonRunContext,
} from "../../server/memory/lessons/derive.js";

const ctx: LessonRunContext = { runId: "run-1", workspaceId: "ws-1" };

function stage(overrides: Partial<StageExecution>): StageExecution {
  return {
    id: "stage-1",
    runId: "run-1",
    stageIndex: 0,
    teamId: "backend",
    modelSlug: "mock",
    status: "pending",
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
    error: null,
    dagStageId: null,
    swarmCloneResults: null,
    swarmMeta: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("deriveStageLesson", () => {
  it("derives a failure lesson from a failed stage with an error (#342)", () => {
    const lesson = deriveStageLesson(
      stage({ status: "failed", error: "Sandbox failed (exit 1): boom" }),
      ctx,
    );
    expect(lesson).not.toBeNull();
    expect(lesson?.outcome).toBe("failure");
    expect(lesson?.category).toBe("sandbox");
    expect(lesson?.workspaceId).toBe("ws-1");
    expect(lesson?.runId).toBe("run-1");
    expect(lesson?.stageId).toBe("stage-1");
    expect(lesson?.teamId).toBe("backend");
    expect(lesson?.summary).toContain("boom");
    expect(lesson?.title).toContain("backend failed");
  });

  it("prefers rejectionReason and classifies it as rejection", () => {
    const lesson = deriveStageLesson(
      stage({ status: "failed", rejectionReason: "Reviewer rejected output" }),
      ctx,
    );
    expect(lesson?.category).toBe("rejection");
    expect(lesson?.summary).toBe("Reviewer rejected output");
  });

  it("derives a success lesson from a completed stage", () => {
    const lesson = deriveStageLesson(
      stage({ status: "completed", output: { summary: "All green" } }),
      ctx,
    );
    expect(lesson?.outcome).toBe("success");
    expect(lesson?.category).toBeNull();
    expect(lesson?.summary).toBe("All green");
  });

  it("returns null for a stage with no terminal outcome", () => {
    expect(deriveStageLesson(stage({ status: "running" }), ctx)).toBeNull();
  });
});

describe("classifyFailure", () => {
  it("maps timeout, guardrail, and bare exceptions", () => {
    expect(classifyFailure(stage({ status: "failed", error: "Request timed out" }))).toBe("timeout");
    expect(classifyFailure(stage({ status: "failed", error: "guardrail blocked" }))).toBe("guardrail");
    expect(classifyFailure(stage({ status: "failed", error: "kaput" }))).toBe("exception");
  });
});

describe("normalizeErrorPattern", () => {
  it("collapses digits and whitespace into a stable signature", () => {
    const a = normalizeErrorPattern("Sandbox failed (exit 1): line 42\nstack");
    const b = normalizeErrorPattern("Sandbox failed (exit 7): line 99\nother");
    expect(a).toBe(b);
  });
});
