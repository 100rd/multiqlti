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
import type { PipelineController } from "../../server/controller/pipeline-controller.js";
import type { Gateway } from "../../server/gateway/index.js";
import type { GatewayRequest, GatewayResponse } from "../../shared/types.js";

interface SpyGateway {
  gateway: Gateway;
  calls: GatewayRequest[];
}

/** A gateway double whose complete() records the request and returns valid JSON. */
function makeSpyGateway(): SpyGateway {
  const calls: GatewayRequest[] = [];
  const gateway = {
    async complete(request: GatewayRequest): Promise<GatewayResponse> {
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
    },
  } as unknown as Gateway;
  return { gateway, calls };
}

function makeOrchestrator(gateway: Gateway): { orchestrator: TaskOrchestrator; storage: MemStorage } {
  const storage = new MemStorage();
  const wsManager = { broadcastToRun: () => {} } as unknown as WsManager;
  const pipelineController = {} as unknown as PipelineController;
  const orchestrator = new TaskOrchestrator(storage, wsManager, pipelineController, gateway);
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

  it("persists the task summary from the real gateway response (not the canned stub)", async () => {
    const { orchestrator, storage } = makeOrchestrator(spy.gateway);

    const { group, tasks } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "do work",
      tasks: [{ name: "T1", description: "summarise", executionMode: "direct_llm" }],
    });

    await orchestrator.startGroup(group.id);

    const persisted = await storage.getTask(tasks[0].id);
    expect(persisted?.summary).toBe("real model summary");
    expect(persisted?.status).toBe("completed");
  });
});
