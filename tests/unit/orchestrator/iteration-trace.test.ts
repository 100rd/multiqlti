/**
 * Unit tests for per-iteration tracing (BE4, task-groups-v2 §3.4).
 *
 *   - each iteration's trace is bound to that iteration (task_traces.iteration_id),
 *     readable via getTaskTraceByIteration(groupId, iterationId);
 *   - the legacy getTaskTrace(groupId) aliases the LATEST iteration's trace.
 *
 * Deterministic: MemStorage + a no-op WsManager + an ok gateway (no CLI/DB).
 */
import { describe, it, expect } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import { TaskOrchestrator } from "../../../server/services/task-orchestrator.js";
import { TaskTracer } from "../../../server/services/task-tracer.js";
import type { WsManager } from "../../../server/ws/manager.js";
import type { PipelineController } from "../../../server/controller/pipeline-controller.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { GatewayRequest, GatewayResponse } from "../../../shared/types.js";

function okGateway(): Gateway {
  const respond = async (request: GatewayRequest): Promise<GatewayResponse> => ({
    content: JSON.stringify({ summary: "ok", output: {} }),
    tokensUsed: 1,
    modelSlug: request.modelSlug,
    finishReason: "stop",
  });
  return {
    complete: respond,
    completeStreaming: respond,
  } as unknown as Gateway;
}

function makeTraced(): { orchestrator: TaskOrchestrator; storage: MemStorage } {
  const storage = new MemStorage();
  const wsManager = { broadcastToRun: () => {} } as unknown as WsManager;
  const orchestrator = new TaskOrchestrator(
    storage,
    wsManager,
    {} as unknown as PipelineController,
    okGateway(),
  );
  orchestrator.setTracer(new TaskTracer(storage, wsManager));
  return { orchestrator, storage };
}

describe("per-iteration tracing", () => {
  it("binds each iteration's trace to that iteration id", async () => {
    const { orchestrator, storage } = makeTraced();
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "T1", description: "x", executionMode: "direct_llm" }],
    });

    const first = await orchestrator.startGroup(group.id);
    const second = await orchestrator.startGroup(group.id);

    const trace1 = await storage.getTaskTraceByIteration(group.id, first.iteration.id);
    const trace2 = await storage.getTaskTraceByIteration(group.id, second.iteration.id);

    expect(trace1).not.toBeNull();
    expect(trace2).not.toBeNull();
    expect(trace1!.iterationId).toBe(first.iteration.id);
    expect(trace2!.iterationId).toBe(second.iteration.id);
    expect(trace1!.id).not.toBe(trace2!.id);
  });

  it("legacy getTaskTrace(groupId) aliases the latest iteration's trace", async () => {
    const { orchestrator, storage } = makeTraced();
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "T1", description: "x", executionMode: "direct_llm" }],
    });

    await orchestrator.startGroup(group.id);
    const second = await orchestrator.startGroup(group.id);

    const latestTrace = await storage.getTaskTraceByIteration(group.id, second.iteration.id);
    const legacy = await storage.getTaskTrace(group.id);
    expect(legacy?.traceId).toBe(latestTrace?.traceId);
  });
});
