/**
 * Unit tests for the judge/direct_llm bounded retry with model fallback
 * (fix/judge-timeout-resilience).
 *
 * Regression guard for the Phase-0 failure: in a consilium dispute the JUDGE
 * task's LLM call receives the FULL debate context — the largest-context call of
 * the round — and can hit the gateway wall-clock cap (observed: latency ≈
 * 600_000ms, output_tokens = 0). Today that throws, FAILS the judge
 * task_execution, cancels dependents, fails the iteration, and drives the loop
 * to FAILED. The two debater calls of the same round succeeded.
 *
 * The fix wraps the `direct_llm` gateway call (server/services/task-orchestrator
 * .ts `completeDirectLlm`) with an OPTIONAL single bounded retry, gated by
 * `pipeline.consiliumLoop.judgeRetry` (default OFF ⇒ byte-identical to today).
 *
 * Strategy: mirror task-orchestrator-default-model.test.ts — drive a real
 * startGroup() over MemStorage with a programmable gateway double whose
 * `completeStreaming` is scripted per call (throw a timeout / return empty /
 * return valid JSON). The retry config is toggled on the live cached config
 * object and restored after each test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemStorage } from "../../server/storage.js";
import { TaskOrchestrator } from "../../server/services/task-orchestrator.js";
import { configLoader } from "../../server/config/loader.js";
import type { WsManager } from "../../server/ws/manager.js";
import type { PipelineController } from "../../server/controller/pipeline-controller.js";
import type { Gateway } from "../../server/gateway/index.js";
import type { GatewayRequest, GatewayResponse } from "../../shared/types.js";

/** A scripted behaviour for one physical completeStreaming call. */
type CallBehaviour =
  | { kind: "ok"; content?: string }
  | { kind: "empty" }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

interface ScriptedGateway {
  gateway: Gateway;
  calls: GatewayRequest[];
}

const VALID_JSON = JSON.stringify({
  summary: "judge verdict",
  output: { verdict: "ship it" },
  decisions: ["converged"],
});

/**
 * A gateway double whose `completeStreaming` walks a fixed script of behaviours
 * (one per physical call), recording every request. A CLI-style overall-timeout
 * error is thrown for `timeout` so `isTimeoutError` matches it.
 */
function makeScriptedGateway(script: CallBehaviour[]): ScriptedGateway {
  const calls: GatewayRequest[] = [];
  let i = 0;
  const completeStreaming = async (request: GatewayRequest): Promise<GatewayResponse> => {
    calls.push(request);
    const behaviour = script[i] ?? { kind: "ok" as const };
    i += 1;
    switch (behaviour.kind) {
      case "timeout": {
        const err = new Error("CLI exceeded overall cap of 600000ms");
        err.name = "CliOverallTimeoutError";
        throw err;
      }
      case "error":
        throw new Error(behaviour.message);
      case "empty":
        return { content: "", tokensUsed: 1, modelSlug: request.modelSlug, finishReason: "stop" };
      case "ok":
      default:
        return {
          content: behaviour.content ?? VALID_JSON,
          tokensUsed: 42,
          modelSlug: request.modelSlug,
          finishReason: "stop",
        };
    }
  };
  const gateway = { complete: completeStreaming, completeStreaming } as unknown as Gateway;
  return { gateway, calls };
}

function makeOrchestrator(gateway: Gateway): { orchestrator: TaskOrchestrator; storage: MemStorage } {
  const storage = new MemStorage();
  const wsManager = { broadcastToRun: () => {} } as unknown as WsManager;
  const pipelineController = {} as unknown as PipelineController;
  const orchestrator = new TaskOrchestrator(storage, wsManager, pipelineController, gateway);
  return { orchestrator, storage };
}

/** A one-task group standing in for the dispute's judge (a direct_llm task). */
async function runJudge(
  orchestrator: TaskOrchestrator,
  storage: MemStorage,
  modelSlug = "gemini-3-1-pro-high",
) {
  const { group, tasks } = await orchestrator.createTaskGroup({
    name: "dispute",
    description: "d",
    input: "synthesise the verdict",
    tasks: [{ name: "Judge verdict", description: "judge", executionMode: "direct_llm", modelSlug }],
  });
  const { iteration } = await orchestrator.startGroup(group.id);
  const executions = await storage.getExecutionsByIteration(group.id, iteration.id);
  const judge = executions.find((e) => e.taskId === tasks[0].id)!;
  return { group, iteration, judge };
}

describe("TaskOrchestrator direct_llm bounded retry (judge timeout resilience)", () => {
  const retryCfg = () => configLoader.get().pipeline.consiliumLoop.judgeRetry;
  let saved: { enabled: boolean; fallbackModel?: string };

  beforeEach(() => {
    const c = retryCfg();
    saved = { enabled: c.enabled, fallbackModel: c.fallbackModel };
  });

  afterEach(() => {
    const c = retryCfg();
    c.enabled = saved.enabled;
    c.fallbackModel = saved.fallbackModel;
  });

  it("enabled: timeout → retry → success (judge task completes)", async () => {
    retryCfg().enabled = true;
    retryCfg().fallbackModel = undefined;
    const spy = makeScriptedGateway([{ kind: "timeout" }, { kind: "ok" }]);
    const { orchestrator, storage } = makeOrchestrator(spy.gateway);

    const { judge } = await runJudge(orchestrator, storage);

    expect(spy.calls).toHaveLength(2); // one retry
    expect(judge.status).toBe("completed");
    // Retry re-used the task's own model (no fallback configured).
    expect(spy.calls[0].modelSlug).toBe("gemini-3-1-pro-high");
    expect(spy.calls[1].modelSlug).toBe("gemini-3-1-pro-high");
    // Observability: the retry is visible in the execution output.
    const retry = (judge.output as Record<string, unknown>)?._retry as Record<string, unknown>;
    expect(retry).toMatchObject({ retried: true, cause: "timeout", fallbackModel: null });
    expect(judge.decisions).toContain("judge/LLM call retried (same model) after timeout");
  });

  it("enabled + fallbackModel: timeout → retry under fallback → success", async () => {
    retryCfg().enabled = true;
    retryCfg().fallbackModel = "claude-sonnet";
    const spy = makeScriptedGateway([{ kind: "timeout" }, { kind: "ok" }]);
    const { orchestrator, storage } = makeOrchestrator(spy.gateway);

    const { judge } = await runJudge(orchestrator, storage);

    expect(spy.calls).toHaveLength(2);
    expect(judge.status).toBe("completed");
    // First call under the task's model, retry under the fallback slug.
    expect(spy.calls[0].modelSlug).toBe("gemini-3-1-pro-high");
    expect(spy.calls[1].modelSlug).toBe("claude-sonnet");
    const retry = (judge.output as Record<string, unknown>)?._retry as Record<string, unknown>;
    expect(retry).toMatchObject({ retried: true, cause: "timeout", fallbackModel: "claude-sonnet" });
    expect(judge.decisions).toContain("judge/LLM call retried (fallback: claude-sonnet) after timeout");
  });

  it("enabled: empty (0-token) completion → retry → success", async () => {
    retryCfg().enabled = true;
    retryCfg().fallbackModel = "claude-sonnet";
    const spy = makeScriptedGateway([{ kind: "empty" }, { kind: "ok" }]);
    const { orchestrator, storage } = makeOrchestrator(spy.gateway);

    const { judge } = await runJudge(orchestrator, storage);

    expect(spy.calls).toHaveLength(2);
    expect(judge.status).toBe("completed");
    const retry = (judge.output as Record<string, unknown>)?._retry as Record<string, unknown>;
    expect(retry).toMatchObject({ retried: true, cause: "empty output", fallbackModel: "claude-sonnet" });
  });

  it("disabled (default): timeout → NO retry → today's failure path (loop fails cleanly)", async () => {
    retryCfg().enabled = false;
    const spy = makeScriptedGateway([{ kind: "timeout" }, { kind: "ok" }]);
    const { orchestrator, storage } = makeOrchestrator(spy.gateway);

    const { group, iteration, judge } = await runJudge(orchestrator, storage);

    expect(spy.calls).toHaveLength(1); // single attempt, no retry
    expect(judge.status).toBe("failed");
    // Iteration + group fail cleanly (FSM failure path untouched).
    const it = await storage.getIteration(group.id, iteration.iterationNumber);
    const g = await storage.getTaskGroup(group.id);
    expect(it?.status).toBe("failed");
    expect(g?.status).toBe("failed");
    expect((judge.output as Record<string, unknown> | null)?._retry).toBeUndefined();
  });

  it("enabled: retry EXHAUSTED (both calls time out) → today's failure path", async () => {
    retryCfg().enabled = true;
    retryCfg().fallbackModel = "claude-sonnet";
    const spy = makeScriptedGateway([{ kind: "timeout" }, { kind: "timeout" }]);
    const { orchestrator, storage } = makeOrchestrator(spy.gateway);

    const { group, judge } = await runJudge(orchestrator, storage);

    expect(spy.calls).toHaveLength(2); // exactly one retry, then give up
    expect(judge.status).toBe("failed");
    const g = await storage.getTaskGroup(group.id);
    expect(g?.status).toBe("failed");
  });

  it("enabled: a NON-timeout error is NOT retried (only timeout/empty are)", async () => {
    retryCfg().enabled = true;
    const spy = makeScriptedGateway([{ kind: "error", message: "budget exceeded" }, { kind: "ok" }]);
    const { orchestrator, storage } = makeOrchestrator(spy.gateway);

    const { judge } = await runJudge(orchestrator, storage);

    expect(spy.calls).toHaveLength(1); // no retry for a non-timeout failure
    expect(judge.status).toBe("failed");
  });
});
