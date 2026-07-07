/**
 * Unit tests for TaskOrchestrator direct_llm model resolution
 * (fix/task-group-real-model-execution).
 *
 * Regression guard for the bug where a `direct_llm` task created WITHOUT a
 * `modelSlug` defaulted to "mock" (server/services/task-orchestrator.ts:303
 * `task.modelSlug ?? "mock"`), so the group "completed" instantly with the
 * MockProvider canned stub at cost 0. The default is now the configured real
 * model (pipeline.taskGroups.defaultModel → DEFAULT_TASK_MODEL = "claude-sonnet").
 *
 * Strategy: seed a group via the orchestrator's own createTaskGroup, then drive
 * a real startGroup() over MemStorage with a SPY gateway. The slug the
 * orchestrator hands to gateway.complete() is the assertion target:
 *   - no modelSlug      → the configured default (NOT "mock"),
 *   - explicit slug     → that slug verbatim,
 *   - explicit "mock"   → "mock" (deterministic opt-in, no real CLI).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../server/storage.js";
import { TaskOrchestrator } from "../../server/services/task-orchestrator.js";
import { DEFAULT_TASK_MODEL } from "../../server/config/schema.js";
import type { WsManager } from "../../server/ws/manager.js";
import type { Gateway } from "../../server/gateway/index.js";
import type { GatewayRequest, GatewayResponse } from "../../shared/types.js";

interface SpyGateway {
  gateway: Gateway;
  calls: GatewayRequest[];
}

/**
 * A gateway double that records the request and returns valid JSON. Direct_llm
 * tasks run via completeStreaming (the streaming path), so both entry points
 * share one implementation and record into the same `calls` array.
 */
function makeSpyGateway(): SpyGateway {
  const calls: GatewayRequest[] = [];
  const respond = async (request: GatewayRequest): Promise<GatewayResponse> => {
    calls.push(request);
    return {
      content: JSON.stringify({
        summary: "real model summary",
        output: { ok: true },
        decisions: ["did the thing"],
      }),
      tokensUsed: 42,
      modelSlug: request.modelSlug,
      finishReason: "stop",
    };
  };
  const gateway = {
    complete: respond,
    completeStreaming: respond,
  } as unknown as Gateway;
  return { gateway, calls };
}

function makeOrchestrator(gateway: Gateway): { orchestrator: TaskOrchestrator; storage: MemStorage } {
  const storage = new MemStorage();
  const wsManager = { broadcastToRun: () => {} } as unknown as WsManager;
  const orchestrator = new TaskOrchestrator(storage, wsManager, gateway);
  return { orchestrator, storage };
}

describe("TaskOrchestrator direct_llm model resolution", () => {
  let spy: SpyGateway;

  beforeEach(() => {
    spy = makeSpyGateway();
  });

  it("resolves a model-less direct_llm task to the configured real default (NOT mock)", async () => {
    const { orchestrator } = makeOrchestrator(spy.gateway);

    // modelSlug intentionally omitted → must NOT fall back to "mock".
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "do work",
      tasks: [{ name: "T1", description: "summarise", executionMode: "direct_llm" }],
    });

    await orchestrator.startGroup(group.id);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].modelSlug).not.toBe("mock");
    expect(spy.calls[0].modelSlug).toBe(DEFAULT_TASK_MODEL);
  });

  it("uses an explicit modelSlug verbatim", async () => {
    const { orchestrator } = makeOrchestrator(spy.gateway);

    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "do work",
      tasks: [
        {
          name: "T1",
          description: "summarise",
          executionMode: "direct_llm",
          modelSlug: "claude-haiku",
        },
      ],
    });

    await orchestrator.startGroup(group.id);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].modelSlug).toBe("claude-haiku");
  });

  it("honours an explicit mock pin (deterministic opt-in, no real CLI)", async () => {
    const { orchestrator } = makeOrchestrator(spy.gateway);

    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "do work",
      tasks: [
        {
          name: "T1",
          description: "summarise",
          executionMode: "direct_llm",
          modelSlug: "mock",
        },
      ],
    });

    await orchestrator.startGroup(group.id);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].modelSlug).toBe("mock");
  });

  it("persists the execution summary from the real gateway response (latest iteration)", async () => {
    const { orchestrator, storage } = makeOrchestrator(spy.gateway);

    const { group, tasks } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "do work",
      tasks: [{ name: "T1", description: "summarise", executionMode: "direct_llm" }],
    });

    const { iteration } = await orchestrator.startGroup(group.id);

    // v2: status/summary live on the EXECUTION (latest iteration), not the
    // definition row (QA assertion inversion).
    const executions = await storage.getExecutionsByIteration(group.id, iteration.id);
    const ex = executions.find((e) => e.taskId === tasks[0].id);
    expect(ex?.summary).toBe("real model summary");
    expect(ex?.status).toBe("completed");
  });

  it("persists the RESOLVED default slug on the execution (#375) on first run", async () => {
    const { orchestrator, storage } = makeOrchestrator(spy.gateway);

    const { group, tasks } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "do work",
      tasks: [{ name: "T1", description: "summarise", executionMode: "direct_llm" }],
    });

    const { iteration } = await orchestrator.startGroup(group.id);
    const ex = (await storage.getExecutionsByIteration(group.id, iteration.id)).find(
      (e) => e.taskId === tasks[0].id,
    );
    expect(ex?.modelSlug).toBe(DEFAULT_TASK_MODEL);
    expect(ex?.modelSlug).not.toBe("mock");
  });

  it("re-run (iteration 2) of a model-less task still resolves the real default (never mock)", async () => {
    const { orchestrator, storage } = makeOrchestrator(spy.gateway);

    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "do work",
      tasks: [{ name: "T1", description: "summarise", executionMode: "direct_llm" }],
    });

    await orchestrator.startGroup(group.id); // iteration 1 (auto-completes)
    const second = await orchestrator.startGroup(group.id); // iteration 2

    expect(second.iteration.iterationNumber).toBe(2);
    // Two gateway calls total (one per iteration), both resolved, never mock.
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1].modelSlug).toBe(DEFAULT_TASK_MODEL);
    expect(spy.calls[1].modelSlug).not.toBe("mock");

    const ex2 = (await storage.getExecutionsByIteration(group.id, second.iteration.id))[0];
    expect(ex2.modelSlug).toBe(DEFAULT_TASK_MODEL);
  });

  it("explicit modelSlug still wins on re-run", async () => {
    const { orchestrator } = makeOrchestrator(spy.gateway);

    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "do work",
      tasks: [
        { name: "T1", description: "summarise", executionMode: "direct_llm", modelSlug: "claude-haiku" },
      ],
    });

    await orchestrator.startGroup(group.id);
    await orchestrator.startGroup(group.id);

    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1].modelSlug).toBe("claude-haiku");
  });

  it("explicit mock is still honoured on re-run", async () => {
    const { orchestrator } = makeOrchestrator(spy.gateway);

    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "do work",
      tasks: [
        { name: "T1", description: "summarise", executionMode: "direct_llm", modelSlug: "mock" },
      ],
    });

    await orchestrator.startGroup(group.id);
    await orchestrator.startGroup(group.id);

    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1].modelSlug).toBe("mock");
  });
});
