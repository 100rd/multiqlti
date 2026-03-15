/**
 * Unit tests for server/pipeline/parallel-executor.ts
 *
 * The Splitter and Merger are dependencies imported inside the executor.
 * We test via the public executeParallel() method, controlling behaviour through
 * gateway mock responses (the Splitter/Merger call gateway.complete internally).
 *
 * Test focuses on:
 *  - Split plan respected (shouldSplit=false → returns null)
 *  - All subtasks succeed → correct metadata
 *  - One subtask fails → partial merge, failedCount > 0
 *  - All subtasks fail → throws
 *  - Empty subtasks returned by splitter → null returned
 *  - WS events emitted (parallel:subtask:started, parallel:subtask:completed)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ParallelExecutor } from "../../../server/pipeline/parallel-executor.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { TeamRegistry } from "../../../server/teams/registry.js";
import type { WsManager } from "../../../server/ws/manager.js";
import type {
  PipelineStageConfig,
  StageContext,
  SubTask,
  TeamResult,
} from "../../../shared/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a gateway that returns JSON responses in sequence.
 * Each call returns the next item from `responses`.
 */
function makeGateway(responses: string[]): Gateway {
  let callIndex = 0;
  const complete = vi.fn().mockImplementation(() => {
    const content = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return Promise.resolve({
      content,
      tokensUsed: 10,
      modelSlug: "mock",
      finishReason: "stop",
    });
  });
  return {
    complete,
    stream: vi.fn(),
    completeWithTools: vi.fn().mockResolvedValue({
      content: "{}",
      tokensUsed: 10,
      modelSlug: "mock",
      finishReason: "stop",
      toolCallLog: [],
    }),
  } as unknown as Gateway;
}

function makeWsManager(): WsManager {
  return {
    broadcastToRun: vi.fn(),
  } as unknown as WsManager;
}

function makeTeamRegistry(parseOutputResult: Record<string, unknown> = {}): TeamRegistry {
  return {
    getTeam: vi.fn().mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        output: { raw: "team result" },
        tokensUsed: 20,
        raw: "team result",
      } satisfies TeamResult),
      parseOutput: vi.fn().mockReturnValue(parseOutputResult),
    }),
  } as unknown as TeamRegistry;
}

function makeTeamRegistryWithFailingSubtask(failOnCallIndex: number): TeamRegistry {
  let callIndex = 0;
  return {
    getTeam: vi.fn().mockReturnValue({
      execute: vi.fn().mockImplementation(() => {
        const idx = callIndex++;
        if (idx === failOnCallIndex) {
          return Promise.reject(new Error("subtask execution failed"));
        }
        return Promise.resolve({
          output: { raw: "success" },
          tokensUsed: 10,
          raw: "success",
        } satisfies TeamResult);
      }),
      parseOutput: vi.fn().mockReturnValue({ summary: "parsed" }),
    }),
  } as unknown as TeamRegistry;
}

function makeStage(overrides: Partial<PipelineStageConfig> = {}): PipelineStageConfig {
  return {
    teamId: "development",
    modelSlug: "mock",
    enabled: true,
    parallel: {
      enabled: true,
      mode: "auto",
      maxAgents: 3,
      mergeStrategy: "concatenate",
    },
    ...overrides,
  };
}

function makeContext(): StageContext {
  return {
    runId: "run-1",
    stageIndex: 0,
    previousOutputs: [],
    modelSlug: "mock",
  };
}

/** Builds a valid SplitPlan JSON string with n subtasks. */
function makeSplitPlanJson(subtasks: SubTask[], shouldSplit = true): string {
  return JSON.stringify({
    shouldSplit,
    reason: "can be parallelized",
    subtasks,
  });
}

function makeSubtask(id: string): SubTask {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    context: [],
    estimatedComplexity: "medium",
  };
}

// ─── parallel disabled / shouldSplit=false ────────────────────────────────────

describe("ParallelExecutor.executeParallel — parallel not enabled", () => {
  it("returns null when stage.parallel.enabled is false", async () => {
    const gateway = makeGateway(["{}"]);
    const executor = new ParallelExecutor(gateway, makeTeamRegistry(), makeWsManager());
    const stage = makeStage({ parallel: { enabled: false, mode: "auto", maxAgents: 2, mergeStrategy: "concatenate" } });
    const result = await executor.executeParallel(stage, { taskDescription: "build it" }, makeContext(), "stage-1");
    expect(result).toBeNull();
  });

  it("returns null when parallel config is missing", async () => {
    const gateway = makeGateway(["{}"]);
    const executor = new ParallelExecutor(gateway, makeTeamRegistry(), makeWsManager());
    const stage = makeStage({ parallel: undefined });
    const result = await executor.executeParallel(stage, {}, makeContext(), "stage-1");
    expect(result).toBeNull();
  });
});

// ─── shouldSplit=false from splitter ─────────────────────────────────────────

describe("ParallelExecutor.executeParallel — splitter returns shouldSplit=false", () => {
  it("returns null when splitter decides not to split", async () => {
    const noSplitPlan = makeSplitPlanJson([], false);
    // The gateway is called once by the Splitter, returns no-split plan
    const gateway = makeGateway([noSplitPlan]);
    const executor = new ParallelExecutor(gateway, makeTeamRegistry(), makeWsManager());
    const result = await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) }, // long enough to pass MIN_INPUT_LENGTH check
      makeContext(),
      "stage-1",
    );
    expect(result).toBeNull();
  });

  it("returns null when splitter returns empty subtasks", async () => {
    const emptyPlan = makeSplitPlanJson([], true); // shouldSplit=true but no subtasks
    const gateway = makeGateway([emptyPlan]);
    const executor = new ParallelExecutor(gateway, makeTeamRegistry(), makeWsManager());
    const result = await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    expect(result).toBeNull();
  });
});

// ─── All subtasks succeed ─────────────────────────────────────────────────────

describe("ParallelExecutor.executeParallel — all subtasks succeed", () => {
  it("returns a ParallelStageResult (not null)", async () => {
    const subtasks = [makeSubtask("s1"), makeSubtask("s2")];
    const splitPlan = makeSplitPlanJson(subtasks);
    // Gateway: 1st call = splitter, 2nd call (optional) = merger if strategy is 'review'
    // We use 'concatenate' so merger doesn't call gateway
    const gateway = makeGateway([splitPlan]);
    const teamRegistry = makeTeamRegistry({ summary: "done" });
    const executor = new ParallelExecutor(gateway, teamRegistry, makeWsManager());
    const result = await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    expect(result).not.toBeNull();
  });

  it("meta.succeededCount equals number of subtasks on full success", async () => {
    const subtasks = [makeSubtask("s1"), makeSubtask("s2")];
    const splitPlan = makeSplitPlanJson(subtasks);
    const gateway = makeGateway([splitPlan]);
    const teamRegistry = makeTeamRegistry({ summary: "done" });
    const executor = new ParallelExecutor(gateway, teamRegistry, makeWsManager());
    const result = await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    expect(result!.meta.succeededCount).toBe(2);
  });

  it("meta.failedCount is 0 when all subtasks succeed", async () => {
    const subtasks = [makeSubtask("s1"), makeSubtask("s2")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const teamRegistry = makeTeamRegistry({});
    const executor = new ParallelExecutor(gateway, teamRegistry, makeWsManager());
    const result = await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    expect(result!.meta.failedCount).toBe(0);
  });

  it("meta.subtaskCount equals total number of planned subtasks", async () => {
    const subtasks = [makeSubtask("s1"), makeSubtask("s2"), makeSubtask("s3")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const teamRegistry = makeTeamRegistry({});
    const executor = new ParallelExecutor(gateway, teamRegistry, makeWsManager());
    const result = await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    expect(result!.meta.subtaskCount).toBe(3);
  });

  it("meta.parallelExecution is true", async () => {
    const subtasks = [makeSubtask("s1")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const teamRegistry = makeTeamRegistry({});
    const executor = new ParallelExecutor(gateway, teamRegistry, makeWsManager());
    const result = await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    expect(result!.meta.parallelExecution).toBe(true);
  });

  it("result.tokensUsed is sum of all subtask tokens", async () => {
    const subtasks = [makeSubtask("s1"), makeSubtask("s2")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    // Each subtask execution returns tokensUsed: 20 (via makeTeamRegistry default)
    const teamRegistry = makeTeamRegistry({});
    const executor = new ParallelExecutor(gateway, teamRegistry, makeWsManager());
    const result = await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    expect(result!.tokensUsed).toBe(40); // 2 subtasks × 20 tokens
  });
});

// ─── One subtask fails ────────────────────────────────────────────────────────

describe("ParallelExecutor.executeParallel — partial failure", () => {
  it("does not throw when one subtask fails (partial merge)", async () => {
    const subtasks = [makeSubtask("s1"), makeSubtask("s2")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const teamRegistry = makeTeamRegistryWithFailingSubtask(0); // first subtask fails
    const executor = new ParallelExecutor(gateway, teamRegistry, makeWsManager());
    await expect(
      executor.executeParallel(
        makeStage(),
        { taskDescription: "x".repeat(300) },
        makeContext(),
        "stage-1",
      ),
    ).resolves.not.toThrow();
  });

  it("records failedCount > 0 when one subtask fails", async () => {
    const subtasks = [makeSubtask("s1"), makeSubtask("s2")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const teamRegistry = makeTeamRegistryWithFailingSubtask(0);
    const executor = new ParallelExecutor(gateway, teamRegistry, makeWsManager());
    const result = await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    expect(result!.meta.failedCount).toBe(1);
  });

  it("records correct succeededCount after partial failure", async () => {
    const subtasks = [makeSubtask("s1"), makeSubtask("s2"), makeSubtask("s3")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const teamRegistry = makeTeamRegistryWithFailingSubtask(1); // second fails
    const executor = new ParallelExecutor(gateway, teamRegistry, makeWsManager());
    const result = await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    expect(result!.meta.succeededCount).toBe(2);
  });
});

// ─── All subtasks fail ────────────────────────────────────────────────────────

describe("ParallelExecutor.executeParallel — all subtasks fail", () => {
  it("throws when all subtasks fail", async () => {
    const subtasks = [makeSubtask("s1"), makeSubtask("s2")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const allFailRegistry: TeamRegistry = {
      getTeam: vi.fn().mockReturnValue({
        execute: vi.fn().mockRejectedValue(new Error("failed")),
        parseOutput: vi.fn().mockReturnValue({}),
      }),
    } as unknown as TeamRegistry;
    const executor = new ParallelExecutor(gateway, allFailRegistry, makeWsManager());
    await expect(
      executor.executeParallel(
        makeStage(),
        { taskDescription: "x".repeat(300) },
        makeContext(),
        "stage-1",
      ),
    ).rejects.toThrow();
  });

  it("error message mentions subtask failure when all fail", async () => {
    const subtasks = [makeSubtask("s1")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const allFailRegistry: TeamRegistry = {
      getTeam: vi.fn().mockReturnValue({
        execute: vi.fn().mockRejectedValue(new Error("execution error")),
        parseOutput: vi.fn().mockReturnValue({}),
      }),
    } as unknown as TeamRegistry;
    const executor = new ParallelExecutor(gateway, allFailRegistry, makeWsManager());
    try {
      await executor.executeParallel(
        makeStage(),
        { taskDescription: "x".repeat(300) },
        makeContext(),
        "stage-1",
      );
      expect.fail("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/fail/i);
    }
  });
});

// ─── WS events ────────────────────────────────────────────────────────────────

describe("ParallelExecutor.executeParallel — WS event broadcasting", () => {
  it("emits parallel:subtask:started for each subtask", async () => {
    const wsManager = makeWsManager();
    const subtasks = [makeSubtask("s1"), makeSubtask("s2")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const teamRegistry = makeTeamRegistry({});
    const executor = new ParallelExecutor(gateway, teamRegistry, wsManager);
    await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const startedEvents = calls.filter(
      (c) => (c[1] as { type: string }).type === "parallel:subtask:started",
    );
    expect(startedEvents).toHaveLength(2);
  });

  it("emits parallel:subtask:completed for each succeeded subtask", async () => {
    const wsManager = makeWsManager();
    const subtasks = [makeSubtask("s1"), makeSubtask("s2")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const teamRegistry = makeTeamRegistry({});
    const executor = new ParallelExecutor(gateway, teamRegistry, wsManager);
    await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvents = calls.filter(
      (c) => (c[1] as { type: string }).type === "parallel:subtask:completed",
    );
    expect(completedEvents).toHaveLength(2);
  });

  it("emits parallel:split event when split occurs", async () => {
    const wsManager = makeWsManager();
    const subtasks = [makeSubtask("s1")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const teamRegistry = makeTeamRegistry({});
    const executor = new ParallelExecutor(gateway, teamRegistry, wsManager);
    await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const splitEvent = calls.find(
      (c) => (c[1] as { type: string }).type === "parallel:split",
    );
    expect(splitEvent).toBeDefined();
  });

  it("emits parallel:merged event after merging", async () => {
    const wsManager = makeWsManager();
    const subtasks = [makeSubtask("s1"), makeSubtask("s2")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const teamRegistry = makeTeamRegistry({});
    const executor = new ParallelExecutor(gateway, teamRegistry, wsManager);
    await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );
    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const mergedEvent = calls.find(
      (c) => (c[1] as { type: string }).type === "parallel:merged",
    );
    expect(mergedEvent).toBeDefined();
  });

  it("broadcast payloads include the stageId", async () => {
    const wsManager = makeWsManager();
    const subtasks = [makeSubtask("s1")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const teamRegistry = makeTeamRegistry({});
    const executor = new ParallelExecutor(gateway, teamRegistry, wsManager);
    await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "my-stage-id",
    );
    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const allHaveStageId = calls.every(
      (c) => (c[1] as { payload: { stageId: string } }).payload.stageId === "my-stage-id",
    );
    expect(allHaveStageId).toBe(true);
  });
});

// ─── Promise.allSettled behaviour (partial failure tolerance) ─────────────────

describe("ParallelExecutor — uses Promise.allSettled semantics", () => {
  it("does not short-circuit on first failure when others can succeed", async () => {
    // With Promise.all, first failure would cancel others.
    // With Promise.allSettled, all run to completion.
    const subtasks = [makeSubtask("s1"), makeSubtask("s2"), makeSubtask("s3")];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);

    let executeCallCount = 0;
    const registry: TeamRegistry = {
      getTeam: vi.fn().mockReturnValue({
        execute: vi.fn().mockImplementation(() => {
          executeCallCount++;
          if (executeCallCount === 1) return Promise.reject(new Error("first fails"));
          return Promise.resolve({ output: { raw: "ok" }, tokensUsed: 5, raw: "ok" } satisfies TeamResult);
        }),
        parseOutput: vi.fn().mockReturnValue({ summary: "ok" }),
      }),
    } as unknown as TeamRegistry;

    const executor = new ParallelExecutor(gateway, registry, makeWsManager());
    const result = await executor.executeParallel(
      makeStage(),
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );

    // All 3 subtasks ran (Promise.allSettled), 2 succeeded
    expect(executeCallCount).toBe(3);
    expect(result!.meta.succeededCount).toBe(2);
    expect(result!.meta.failedCount).toBe(1);
  });
});
