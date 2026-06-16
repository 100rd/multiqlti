/**
 * Unit tests for TaskOrchestrator iteration-awareness (BE3, task-groups-v2 §4).
 *
 * Each `start` creates a fresh iteration of the (unchanged) task DEFINITIONS:
 *   - re-run creates iteration 2 with isolated executions; iteration-1 untouched;
 *   - definition ids + dependsOn are reused verbatim;
 *   - a running iteration → RunActiveError; the configured cap → IterationCapError;
 *   - an all-fail iteration settles failed and is re-runnable;
 *   - terminal status + aggregate output project onto BOTH iteration + group;
 *   - orchestration computes ready/blocked from the DEFINITION graph + completed
 *     EXECUTIONS, even when the legacy `tasks.status` column is deliberately wrong.
 *
 * Deterministic: MemStorage + a scripted gateway double (no CLI/network/DB/WS).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import {
  TaskOrchestrator,
  RunActiveError,
  IterationCapError,
} from "../../../server/services/task-orchestrator.js";
import { configLoader } from "../../../server/config/loader.js";
import type { WsManager } from "../../../server/ws/manager.js";
import type { PipelineController } from "../../../server/controller/pipeline-controller.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { GatewayRequest, GatewayResponse } from "../../../shared/types.js";

type GatewayBehaviour = "ok" | "fail";

/** A gateway whose complete() returns valid JSON, or throws when scripted to. */
function makeGateway(behaviour: () => GatewayBehaviour): Gateway {
  const respond = async (request: GatewayRequest): Promise<GatewayResponse> => {
    if (behaviour() === "fail") throw new Error("scripted gateway failure");
    return {
      content: JSON.stringify({ summary: `did ${request.messages.length}`, output: { ok: true } }),
      tokensUsed: 1,
      modelSlug: request.modelSlug,
      finishReason: "stop",
    };
  };
  return {
    complete: respond,
    completeStreaming: respond,
  } as unknown as Gateway;
}

function makeOrchestrator(gateway: Gateway): { orchestrator: TaskOrchestrator; storage: MemStorage } {
  const storage = new MemStorage();
  const wsManager = { broadcastToRun: () => {} } as unknown as WsManager;
  const pipelineController = {} as unknown as PipelineController;
  return { orchestrator: new TaskOrchestrator(storage, wsManager, pipelineController, gateway), storage };
}

describe("TaskOrchestrator — iterations", () => {
  let behaviour: GatewayBehaviour;

  beforeEach(() => {
    behaviour = "ok";
  });

  it("re-run creates iteration 2 with fresh executions; iteration 1 unchanged", async () => {
    const { orchestrator, storage } = makeOrchestrator(makeGateway(() => behaviour));
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "T1", description: "x", executionMode: "direct_llm" }],
    });

    const first = await orchestrator.startGroup(group.id);
    const firstExecs = await storage.getExecutionsByIteration(group.id, first.iteration.id);
    const firstSummary = firstExecs[0].summary;

    const second = await orchestrator.startGroup(group.id);
    expect(second.iteration.iterationNumber).toBe(2);
    expect(second.iteration.id).not.toBe(first.iteration.id);

    const secondExecs = await storage.getExecutionsByIteration(group.id, second.iteration.id);
    expect(secondExecs).toHaveLength(1);
    expect(secondExecs[0].id).not.toBe(firstExecs[0].id);

    // Iteration 1 executions are immutable after the re-run.
    const firstAgain = await storage.getExecutionsByIteration(group.id, first.iteration.id);
    expect(firstAgain[0].id).toBe(firstExecs[0].id);
    expect(firstAgain[0].summary).toBe(firstSummary);
  });

  it("reuses the same definition ids + dependsOn across iterations", async () => {
    const { orchestrator, storage } = makeOrchestrator(makeGateway(() => behaviour));
    const { group, tasks } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [
        { name: "A", description: "x", executionMode: "direct_llm" },
        { name: "B", description: "y", executionMode: "direct_llm", dependsOn: ["A"] },
      ],
    });
    const a = tasks.find((t) => t.name === "A")!;
    const b = tasks.find((t) => t.name === "B")!;

    const first = await orchestrator.startGroup(group.id);
    const second = await orchestrator.startGroup(group.id);

    for (const it of [first.iteration, second.iteration]) {
      const execs = await storage.getExecutionsByIteration(group.id, it.id);
      expect(new Set(execs.map((e) => e.taskId))).toEqual(new Set([a.id, b.id]));
    }
    // dependsOn on the definition is unchanged.
    expect((await storage.getTask(b.id))!.dependsOn).toEqual([a.id]);
  });

  it("rejects start while an iteration is running (RunActiveError)", async () => {
    const { orchestrator, storage } = makeOrchestrator(makeGateway(() => behaviour));
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "T1", description: "x", executionMode: "direct_llm" }],
    });
    const first = await orchestrator.startGroup(group.id);
    // Force the latest iteration back to running (simulate an in-flight run).
    await storage.updateIteration(first.iteration.id, { status: "running" });

    await expect(orchestrator.startGroup(group.id)).rejects.toBeInstanceOf(RunActiveError);
  });

  it("rejects start past the configured iteration cap (IterationCapError)", async () => {
    const cfg = configLoader.get();
    const original = cfg.pipeline.taskGroups.maxIterationsPerGroup;
    cfg.pipeline.taskGroups.maxIterationsPerGroup = 1;
    try {
      const { orchestrator } = makeOrchestrator(makeGateway(() => behaviour));
      const { group } = await orchestrator.createTaskGroup({
        name: "G",
        description: "d",
        input: "obj",
        tasks: [{ name: "T1", description: "x", executionMode: "direct_llm" }],
      });
      await orchestrator.startGroup(group.id); // iteration 1 (allowed)
      await expect(orchestrator.startGroup(group.id)).rejects.toBeInstanceOf(IterationCapError);
    } finally {
      cfg.pipeline.taskGroups.maxIterationsPerGroup = original;
    }
  });

  it("an all-fail iteration settles failed and is re-runnable", async () => {
    const { orchestrator, storage } = makeOrchestrator(makeGateway(() => behaviour));
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "T1", description: "x", executionMode: "direct_llm" }],
    });

    behaviour = "fail";
    const failed = await orchestrator.startGroup(group.id);
    const failedIteration = await storage.getIteration(group.id, failed.iteration.iterationNumber);
    expect(failedIteration?.status).toBe("failed");
    expect((await storage.getTaskGroup(group.id))!.status).toBe("failed");

    behaviour = "ok";
    const retry = await orchestrator.startGroup(group.id);
    expect(retry.iteration.iterationNumber).toBe(2);
    const okIteration = await storage.getIteration(group.id, 2);
    expect(okIteration?.status).toBe("completed");
  });

  it("projects terminal status + aggregate output onto BOTH iteration and group", async () => {
    const { orchestrator, storage } = makeOrchestrator(makeGateway(() => behaviour));
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "T1", description: "x", executionMode: "direct_llm" }],
    });
    const { iteration } = await orchestrator.startGroup(group.id);

    const it = await storage.getIteration(group.id, iteration.iterationNumber);
    const g = await storage.getTaskGroup(group.id);
    expect(it?.status).toBe("completed");
    expect(g?.status).toBe("completed");
    const itOut = it?.output as { completedCount: number } | null;
    const gOut = g?.output as { completedCount: number } | null;
    expect(itOut?.completedCount).toBe(1);
    expect(gOut?.completedCount).toBe(1);
  });

  it("computes ready/blocked from the definition graph + executions despite stale tasks.status", async () => {
    const { orchestrator, storage } = makeOrchestrator(makeGateway(() => behaviour));
    const { group, tasks } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [
        { name: "A", description: "x", executionMode: "direct_llm" },
        { name: "B", description: "y", executionMode: "direct_llm", dependsOn: ["A"] },
      ],
    });
    const a = tasks.find((t) => t.name === "A")!;
    const b = tasks.find((t) => t.name === "B")!;

    // Deliberately corrupt the legacy column — orchestration must ignore it.
    await storage.updateTask(a.id, { status: "failed" });
    await storage.updateTask(b.id, { status: "completed" });

    const { iteration } = await orchestrator.startGroup(group.id);
    const execs = await storage.getExecutionsByIteration(group.id, iteration.id);
    // Both ran to completion via the execution graph, not the stale tasks.status.
    expect(execs.every((e) => e.status === "completed")).toBe(true);
    expect((await storage.getIteration(group.id, 1))!.status).toBe("completed");
  });

  it("cancelGroup cancels the active iteration's non-terminal executions + group", async () => {
    const { orchestrator, storage } = makeOrchestrator(makeGateway(() => behaviour));
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [
        { name: "A", description: "x", executionMode: "direct_llm" },
        { name: "B", description: "y", executionMode: "direct_llm", dependsOn: ["A"] },
      ],
    });
    const first = await orchestrator.startGroup(group.id);
    // Simulate an in-flight iteration with a non-terminal execution.
    await storage.updateIteration(first.iteration.id, { status: "running" });
    const execs = await storage.getExecutionsByIteration(group.id, first.iteration.id);
    await storage.updateExecution(execs[0].id, { status: "running" });

    await orchestrator.cancelGroup(group.id);
    expect((await storage.getIteration(group.id, 1))!.status).toBe("cancelled");
    expect((await storage.getTaskGroup(group.id))!.status).toBe("cancelled");
  });
});
