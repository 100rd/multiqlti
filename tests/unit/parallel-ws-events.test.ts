/**
 * Unit tests for parallel:* WebSocket event handling logic.
 * Tests the state reducer behavior extracted from usePipelineEvents.
 */
import { describe, it, expect } from "vitest";
import type { WsEvent, WsEventType } from "../../shared/types";

// ------------------------------------------------------------------
// We replicate the state shape and reducer logic from use-websocket.ts
// so we can test pure state transitions without React / DOM deps.
// ------------------------------------------------------------------

interface ParallelSubtaskState {
  subtaskId: string;
  title: string;
  modelSlug: string;
  status: "pending" | "running" | "completed" | "failed";
  tokensUsed?: number;
  durationMs?: number;
  output?: string;
  error?: string;
}

interface ParallelStageState {
  stageIndex: number;
  subtasks: ParallelSubtaskState[];
  mergeStrategy: string;
  isMerging: boolean;
  mergedOutput?: Record<string, unknown>;
  splitReason?: string;
}

type ParallelStagesMap = Map<number, ParallelStageState>;

function makeEvent(type: WsEventType, payload: Record<string, unknown>): WsEvent {
  return { type, runId: "run-1", payload, timestamp: new Date().toISOString() };
}

function applyParallelEvent(
  parallelStages: ParallelStagesMap,
  event: WsEvent,
): ParallelStagesMap {
  const next = new Map(parallelStages);

  switch (event.type) {
    case "parallel:split": {
      const stageIndex = event.payload.stageIndex as number;
      const subtasks = (event.payload.subtasks as Array<{
        id: string;
        title: string;
        suggestedModel?: string;
      }>) ?? [];
      next.set(stageIndex, {
        stageIndex,
        subtasks: subtasks.map((st) => ({
          subtaskId: st.id,
          title: st.title,
          modelSlug: st.suggestedModel ?? "",
          status: "pending",
        })),
        mergeStrategy: (event.payload.mergeStrategy as string) ?? "auto",
        isMerging: false,
        splitReason: event.payload.reason as string | undefined,
      });
      break;
    }
    case "parallel:subtask:started": {
      const stageIndex = event.payload.stageIndex as number;
      const subtaskId = event.payload.subtaskId as string;
      const modelSlug = event.payload.modelSlug as string;
      const ps = next.get(stageIndex);
      if (ps) {
        next.set(stageIndex, {
          ...ps,
          subtasks: ps.subtasks.map((st) =>
            st.subtaskId === subtaskId
              ? { ...st, status: "running", modelSlug: modelSlug || st.modelSlug }
              : st,
          ),
        });
      }
      break;
    }
    case "parallel:subtask:completed": {
      const stageIndex = event.payload.stageIndex as number;
      const subtaskId = event.payload.subtaskId as string;
      const failed = (event.payload.error as string | undefined) !== undefined;
      const ps = next.get(stageIndex);
      if (ps) {
        next.set(stageIndex, {
          ...ps,
          subtasks: ps.subtasks.map((st) =>
            st.subtaskId === subtaskId
              ? {
                  ...st,
                  status: failed ? "failed" : "completed",
                  tokensUsed: event.payload.tokensUsed as number | undefined,
                  durationMs: event.payload.durationMs as number | undefined,
                  output: event.payload.output as string | undefined,
                  error: event.payload.error as string | undefined,
                }
              : st,
          ),
        });
      }
      break;
    }
    case "parallel:merged": {
      const stageIndex = event.payload.stageIndex as number;
      const ps = next.get(stageIndex);
      if (ps) {
        next.set(stageIndex, {
          ...ps,
          isMerging: false,
          mergedOutput: event.payload.output as Record<string, unknown> | undefined,
        });
      }
      break;
    }
  }
  return next;
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe("parallel:split event", () => {
  it("initializes subtasks from payload", () => {
    const map: ParallelStagesMap = new Map();
    const result = applyParallelEvent(
      map,
      makeEvent("parallel:split", {
        stageIndex: 2,
        subtasks: [
          { id: "st-1", title: "Parse config", suggestedModel: "gpt-4" },
          { id: "st-2", title: "Generate schema" },
        ],
        mergeStrategy: "review",
        reason: "Input is large enough to parallelize",
      }),
    );

    expect(result.size).toBe(1);
    const ps = result.get(2)!;
    expect(ps.stageIndex).toBe(2);
    expect(ps.mergeStrategy).toBe("review");
    expect(ps.splitReason).toBe("Input is large enough to parallelize");
    expect(ps.isMerging).toBe(false);
    expect(ps.subtasks).toHaveLength(2);
    expect(ps.subtasks[0]).toEqual({
      subtaskId: "st-1",
      title: "Parse config",
      modelSlug: "gpt-4",
      status: "pending",
    });
    expect(ps.subtasks[1]).toEqual({
      subtaskId: "st-2",
      title: "Generate schema",
      modelSlug: "",
      status: "pending",
    });
  });

  it("defaults mergeStrategy to auto", () => {
    const result = applyParallelEvent(
      new Map(),
      makeEvent("parallel:split", {
        stageIndex: 0,
        subtasks: [{ id: "s1", title: "A" }],
      }),
    );
    expect(result.get(0)!.mergeStrategy).toBe("auto");
  });
});

describe("parallel:subtask:started event", () => {
  it("updates subtask status to running and sets modelSlug", () => {
    let map: ParallelStagesMap = new Map();
    map = applyParallelEvent(
      map,
      makeEvent("parallel:split", {
        stageIndex: 1,
        subtasks: [
          { id: "a", title: "A" },
          { id: "b", title: "B" },
        ],
      }),
    );

    map = applyParallelEvent(
      map,
      makeEvent("parallel:subtask:started", {
        stageIndex: 1,
        subtaskId: "a",
        modelSlug: "claude-sonnet",
      }),
    );

    const ps = map.get(1)!;
    expect(ps.subtasks[0].status).toBe("running");
    expect(ps.subtasks[0].modelSlug).toBe("claude-sonnet");
    expect(ps.subtasks[1].status).toBe("pending");
  });

  it("does nothing if stageIndex not found", () => {
    const map: ParallelStagesMap = new Map();
    const result = applyParallelEvent(
      map,
      makeEvent("parallel:subtask:started", {
        stageIndex: 99,
        subtaskId: "x",
        modelSlug: "foo",
      }),
    );
    expect(result.size).toBe(0);
  });
});

describe("parallel:subtask:completed event", () => {
  function setupTwoSubtasks(): ParallelStagesMap {
    let m: ParallelStagesMap = new Map();
    m = applyParallelEvent(
      m,
      makeEvent("parallel:split", {
        stageIndex: 0,
        subtasks: [
          { id: "s1", title: "One" },
          { id: "s2", title: "Two" },
        ],
        mergeStrategy: "concatenate",
      }),
    );
    m = applyParallelEvent(
      m,
      makeEvent("parallel:subtask:started", { stageIndex: 0, subtaskId: "s1", modelSlug: "m1" }),
    );
    m = applyParallelEvent(
      m,
      makeEvent("parallel:subtask:started", { stageIndex: 0, subtaskId: "s2", modelSlug: "m2" }),
    );
    return m;
  }

  it("marks subtask as completed with metadata", () => {
    let map = setupTwoSubtasks();
    map = applyParallelEvent(
      map,
      makeEvent("parallel:subtask:completed", {
        stageIndex: 0,
        subtaskId: "s1",
        tokensUsed: 500,
        durationMs: 1200,
        output: "result text",
      }),
    );

    const st = map.get(0)!.subtasks[0];
    expect(st.status).toBe("completed");
    expect(st.tokensUsed).toBe(500);
    expect(st.durationMs).toBe(1200);
    expect(st.output).toBe("result text");
    expect(st.error).toBeUndefined();
  });

  it("marks subtask as failed when error present", () => {
    let map = setupTwoSubtasks();
    map = applyParallelEvent(
      map,
      makeEvent("parallel:subtask:completed", {
        stageIndex: 0,
        subtaskId: "s2",
        error: "Model timeout",
        durationMs: 30000,
      }),
    );

    const st = map.get(0)!.subtasks[1];
    expect(st.status).toBe("failed");
    expect(st.error).toBe("Model timeout");
    expect(st.durationMs).toBe(30000);
    // s1 still running
    expect(map.get(0)!.subtasks[0].status).toBe("running");
  });
});

describe("parallel:merged event", () => {
  it("sets mergedOutput and isMerging to false", () => {
    let map: ParallelStagesMap = new Map();
    map = applyParallelEvent(
      map,
      makeEvent("parallel:split", {
        stageIndex: 3,
        subtasks: [{ id: "x", title: "X" }],
        mergeStrategy: "vote",
      }),
    );
    // Simulate isMerging = true (in real code this happens elsewhere)
    const ps = map.get(3)!;
    map.set(3, { ...ps, isMerging: true });

    map = applyParallelEvent(
      map,
      makeEvent("parallel:merged", {
        stageIndex: 3,
        output: { summary: "merged result", files: [] },
      }),
    );

    const final = map.get(3)!;
    expect(final.isMerging).toBe(false);
    expect(final.mergedOutput).toEqual({ summary: "merged result", files: [] });
  });
});

describe("full lifecycle", () => {
  it("split -> start -> complete -> merge", () => {
    let map: ParallelStagesMap = new Map();

    // Split
    map = applyParallelEvent(
      map,
      makeEvent("parallel:split", {
        stageIndex: 0,
        subtasks: [
          { id: "a", title: "Part A", suggestedModel: "claude" },
          { id: "b", title: "Part B", suggestedModel: "gemini" },
        ],
        mergeStrategy: "concatenate",
        reason: "Task decomposed into 2 parts",
      }),
    );
    expect(map.get(0)!.subtasks.every((s) => s.status === "pending")).toBe(true);

    // Start both
    map = applyParallelEvent(map, makeEvent("parallel:subtask:started", { stageIndex: 0, subtaskId: "a", modelSlug: "claude" }));
    map = applyParallelEvent(map, makeEvent("parallel:subtask:started", { stageIndex: 0, subtaskId: "b", modelSlug: "gemini" }));
    expect(map.get(0)!.subtasks.every((s) => s.status === "running")).toBe(true);

    // Complete both
    map = applyParallelEvent(map, makeEvent("parallel:subtask:completed", { stageIndex: 0, subtaskId: "a", output: "A output", tokensUsed: 100, durationMs: 500 }));
    map = applyParallelEvent(map, makeEvent("parallel:subtask:completed", { stageIndex: 0, subtaskId: "b", output: "B output", tokensUsed: 200, durationMs: 800 }));
    expect(map.get(0)!.subtasks.every((s) => s.status === "completed")).toBe(true);

    // Merge
    map = applyParallelEvent(map, makeEvent("parallel:merged", { stageIndex: 0, output: { merged: "A output\nB output" } }));
    const final = map.get(0)!;
    expect(final.mergedOutput).toEqual({ merged: "A output\nB output" });
    expect(final.subtasks[0].tokensUsed).toBe(100);
    expect(final.subtasks[1].tokensUsed).toBe(200);
  });
});
