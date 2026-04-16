/**
 * Unit tests for capability-based routing in ParallelExecutor.
 *
 * Verifies that resolveSubtaskModel() calls selectModelForSubtask()
 * when capabilityRouting is enabled and no suggestedModel is set.
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
import { ModelCapabilityRegistry } from "../../../server/pipeline/model-capability-registry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  return { broadcastToRun: vi.fn() } as unknown as WsManager;
}

function makeTeamRegistry(): TeamRegistry {
  return {
    getTeam: vi.fn().mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        output: { raw: "team result" },
        tokensUsed: 20,
        raw: "team result",
      } satisfies TeamResult),
      parseOutput: vi.fn().mockReturnValue({}),
    }),
  } as unknown as TeamRegistry;
}

function makeSubtask(overrides: Partial<SubTask> = {}): SubTask {
  return {
    id: "s1",
    title: "Task s1",
    description: "Description for s1",
    context: [],
    estimatedComplexity: "medium",
    ...overrides,
  };
}

function makeSplitPlanJson(subtasks: SubTask[]): string {
  return JSON.stringify({
    shouldSplit: true,
    reason: "can be parallelized",
    subtasks,
  });
}

function makeContext(): StageContext {
  return {
    runId: "run-1",
    stageIndex: 0,
    previousOutputs: [],
    modelSlug: "mock",
  };
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
      splitStrategy: "auto",
      mergeStrategy: "concatenate",
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Capability-based routing in ParallelExecutor", () => {
  let registry: ModelCapabilityRegistry;

  beforeEach(() => {
    registry = new ModelCapabilityRegistry();
  });

  it("uses selectModelForSubtask when capabilityRouting is enabled", async () => {
    const codeSubtask = makeSubtask({
      id: "code-task",
      title: "Implement auth module",
      description: "Write the authentication function",
      estimatedComplexity: "high",
    });

    const subtasks = [codeSubtask];
    const gateway = makeGateway([makeSplitPlanJson(subtasks)]);
    const wsManager = makeWsManager();
    const teamRegistry = makeTeamRegistry();

    const selectSpy = vi.spyOn(registry, "selectModelForSubtask");

    const executor = new ParallelExecutor(gateway, teamRegistry, wsManager, registry);
    const stage = makeStage({
      modelSlug: "mock",
      parallel: {
        enabled: true,
        mode: "auto",
        maxAgents: 3,
        splitStrategy: "auto",
        mergeStrategy: "concatenate",
        capabilityRouting: {
          enabled: true,
          availableModels: ["claude-3.5-sonnet", "claude-3.5-haiku"],
        },
      },
    });

    await executor.executeParallel(
      stage,
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );

    expect(selectSpy).toHaveBeenCalled();
    const [models, complexity, strengths] = selectSpy.mock.calls[0];
    expect(models).toEqual(["claude-3.5-sonnet", "claude-3.5-haiku"]);
    expect(complexity).toBe("high");
    expect(strengths).toContain("code");
  });

  it("does NOT call selectModelForSubtask when capabilityRouting is disabled", async () => {
    const subtask = makeSubtask({ id: "s1" });
    const gateway = makeGateway([makeSplitPlanJson([subtask])]);
    const wsManager = makeWsManager();
    const teamRegistry = makeTeamRegistry();

    const selectSpy = vi.spyOn(registry, "selectModelForSubtask");

    const executor = new ParallelExecutor(gateway, teamRegistry, wsManager, registry);
    const stage = makeStage({
      parallel: {
        enabled: true,
        mode: "auto",
        maxAgents: 3,
        splitStrategy: "auto",
        mergeStrategy: "concatenate",
        capabilityRouting: {
          enabled: false,
          availableModels: ["claude-3.5-sonnet"],
        },
      },
    });

    await executor.executeParallel(
      stage,
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );

    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("does NOT call selectModelForSubtask when capabilityRouting is absent", async () => {
    const subtask = makeSubtask({ id: "s1" });
    const gateway = makeGateway([makeSplitPlanJson([subtask])]);
    const wsManager = makeWsManager();
    const teamRegistry = makeTeamRegistry();

    const selectSpy = vi.spyOn(registry, "selectModelForSubtask");

    const executor = new ParallelExecutor(gateway, teamRegistry, wsManager, registry);
    const stage = makeStage(); // no capabilityRouting

    await executor.executeParallel(
      stage,
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );

    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("prefers suggestedModel over capability routing", async () => {
    const subtask = makeSubtask({
      id: "s1",
      title: "Implement code",
      suggestedModel: "grok-3",
      estimatedComplexity: "high",
    });

    const gateway = makeGateway([makeSplitPlanJson([subtask])]);
    const wsManager = makeWsManager();
    const teamRegistry = makeTeamRegistry();

    const selectSpy = vi.spyOn(registry, "selectModelForSubtask");

    const executor = new ParallelExecutor(gateway, teamRegistry, wsManager, registry);
    const stage = makeStage({
      parallel: {
        enabled: true,
        mode: "auto",
        maxAgents: 3,
        splitStrategy: "auto",
        mergeStrategy: "concatenate",
        capabilityRouting: {
          enabled: true,
          availableModels: ["claude-3.5-sonnet", "claude-3.5-haiku"],
        },
      },
    });

    await executor.executeParallel(
      stage,
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );

    // suggestedModel takes priority, so selectModelForSubtask should NOT be called
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("routes reasoning tasks to reasoning-strong models", async () => {
    const reasoningSubtask = makeSubtask({
      id: "r1",
      title: "Analyze system architecture",
      description: "Complex analysis of the distributed system logic",
      estimatedComplexity: "high",
    });

    const gateway = makeGateway([makeSplitPlanJson([reasoningSubtask])]);
    const wsManager = makeWsManager();
    const teamRegistry = makeTeamRegistry();

    const selectSpy = vi.spyOn(registry, "selectModelForSubtask");

    const executor = new ParallelExecutor(gateway, teamRegistry, wsManager, registry);
    const stage = makeStage({
      parallel: {
        enabled: true,
        mode: "auto",
        maxAgents: 3,
        splitStrategy: "auto",
        mergeStrategy: "concatenate",
        capabilityRouting: {
          enabled: true,
          availableModels: ["claude-3.5-sonnet", "gemini-2.0-flash"],
        },
      },
    });

    await executor.executeParallel(
      stage,
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );

    expect(selectSpy).toHaveBeenCalled();
    const [, , strengths] = selectSpy.mock.calls[0];
    expect(strengths).toContain("reasoning");
  });

  it("falls back to stage model when availableModels is empty", async () => {
    const subtask = makeSubtask({ id: "s1", title: "Implement code" });
    const gateway = makeGateway([makeSplitPlanJson([subtask])]);
    const wsManager = makeWsManager();
    const teamRegistry = makeTeamRegistry();

    const selectSpy = vi.spyOn(registry, "selectModelForSubtask");

    const executor = new ParallelExecutor(gateway, teamRegistry, wsManager, registry);
    const stage = makeStage({
      modelSlug: "mock",
      parallel: {
        enabled: true,
        mode: "auto",
        maxAgents: 3,
        splitStrategy: "auto",
        mergeStrategy: "concatenate",
        capabilityRouting: {
          enabled: true,
          availableModels: [],
        },
      },
    });

    const result = await executor.executeParallel(
      stage,
      { taskDescription: "x".repeat(300) },
      makeContext(),
      "stage-1",
    );

    // Empty availableModels means we skip capability routing
    expect(selectSpy).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
  });
});
