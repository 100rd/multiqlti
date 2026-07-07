/**
 * Write-side regression for BUG 2 (Per-Workspace Breakdown panel always empty).
 *
 * ROOT CAUSE: the consilium `direct_llm` path in TaskOrchestrator called
 * `gateway.completeStreaming(request, undefined, undefined, streamOptions)` — the
 * THIRD argument (loggingOptions) was `undefined`, so the gateway logged every
 * llm_requests row with run_id = NULL. The read side
 * (getLlmStatsByWorkspace) resolves run_id -> consilium_loops.groupId ->
 * repoPath -> workspace, so a NULL run_id can NEVER attribute: 100% of real
 * usage fell into the "Unattributed" bucket and the panel looked empty.
 *
 * The existing read-side suite (stats-by-workspace.test.ts) always inserts rows
 * with `runId: group.id` MANUALLY — it encodes the very assumption the write side
 * violated, so it could not catch this bug. These tests close that gap by driving
 * the REAL orchestrator direct_llm path and asserting the gateway is handed
 * `loggingOptions.runId === group.id`, then proving the full write->read loop
 * attributes the request to its workspace (NOT Unattributed), counted exactly once.
 *
 * Harness mirrors task-orchestrator-judge-retry.test.ts (real startGroup over
 * MemStorage + a programmable gateway double), extended to capture the
 * loggingOptions argument and to persist a row like the real gateway would.
 */
import { describe, it, expect } from "vitest";
import { MemStorage } from "../../server/storage.js";
import { TaskOrchestrator } from "../../server/services/task-orchestrator.js";
import type { WsManager } from "../../server/ws/manager.js";
import type { Gateway } from "../../server/gateway/index.js";
import type { GatewayRequest, GatewayResponse } from "../../shared/types.js";
import type { InsertLlmRequest } from "../../shared/schema.js";

const VALID_JSON = JSON.stringify({
  summary: "verdict",
  output: { verdict: "ship it" },
  decisions: ["converged"],
});

/** One recorded physical gateway call: the request + the loggingOptions handed in. */
interface RecordedCall {
  request: GatewayRequest;
  loggingOptions: { runId?: string; workspaceId?: string; teamId?: string } | undefined;
}

/**
 * A gateway double that (1) records the loggingOptions of every physical
 * completeStreaming call and (2) — when `storage` is provided — persists an
 * llm_requests row EXACTLY as the real gateway.logRequest does: `runId` taken
 * from the loggingOptions it was handed (`?? null`). This makes the double a
 * faithful stand-in for the write side so the read side can be exercised.
 */
function makeGateway(storage?: MemStorage): { gateway: Gateway; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const completeStreaming = async (
    request: GatewayRequest,
    _privacy?: unknown,
    loggingOptions?: { runId?: string; workspaceId?: string; teamId?: string },
    _stream?: unknown,
  ): Promise<GatewayResponse> => {
    calls.push({ request, loggingOptions });
    if (storage) {
      const row: InsertLlmRequest = {
        runId: loggingOptions?.runId ?? null, // <- the exact field this bug is about
        stageExecutionId: null,
        modelSlug: request.modelSlug,
        provider: "anthropic",
        messages: [],
        systemPrompt: null,
        temperature: null,
        maxTokens: null,
        responseContent: VALID_JSON,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        latencyMs: 10,
        estimatedCostUsd: 0.02,
        status: "success",
        errorMessage: null,
        teamId: loggingOptions?.teamId ?? null,
        tags: [],
      } as InsertLlmRequest;
      await storage.createLlmRequest(row);
    }
    return { content: VALID_JSON, tokensUsed: 140, modelSlug: request.modelSlug, finishReason: "stop" };
  };
  const gateway = { complete: completeStreaming, completeStreaming } as unknown as Gateway;
  return { gateway, calls };
}

function makeOrchestrator(gateway: Gateway, storage: MemStorage): TaskOrchestrator {
  const wsManager = { broadcastToRun: () => {} } as unknown as WsManager;
  return new TaskOrchestrator(storage, wsManager, gateway);
}

/** One direct_llm task standing in for a consilium review/judge call. */
async function runDirectLlmGroup(orchestrator: TaskOrchestrator, storage: MemStorage) {
  const { group, tasks } = await orchestrator.createTaskGroup({
    name: "review", description: "d", input: "review the change",
    tasks: [{ name: "Reviewer", description: "review", executionMode: "direct_llm", modelSlug: "claude-3-5-sonnet" }],
  });
  const { iteration } = await orchestrator.startGroup(group.id);
  const executions = await storage.getExecutionsByIteration(group.id, iteration.id);
  const exec = executions.find((e) => e.taskId === tasks[0].id)!;
  return { group, exec };
}

describe("TaskOrchestrator direct_llm — workspace attribution (BUG 2 write-side)", () => {
  it("stamps loggingOptions.runId = group.id on the direct_llm gateway call (once)", async () => {
    const storage = new MemStorage();
    const { gateway, calls } = makeGateway();
    const orchestrator = makeOrchestrator(gateway, storage);

    const { group, exec } = await runDirectLlmGroup(orchestrator, storage);

    expect(exec.status).toBe("completed");
    // Exactly one physical call (retry is default-OFF) — no double stamp.
    expect(calls).toHaveLength(1);
    // The regression: the gateway MUST be handed runId = the task-group id, so the
    // row it logs is attributable. Before the fix this was `undefined` -> run_id NULL.
    expect(calls[0].loggingOptions?.runId).toBe(group.id);
    expect(calls[0].loggingOptions?.runId).not.toBeUndefined();
  });

  it("end-to-end: the stamped request lands in its workspace bucket, not Unattributed", async () => {
    const storage = new MemStorage();
    const { gateway } = makeGateway(storage); // gateway persists the row like production does
    const orchestrator = makeOrchestrator(gateway, storage);

    // Workspace whose path the consilium loop points at.
    const ws = await storage.createWorkspace({
      name: "alpha", type: "local", path: "/repo/alpha", branch: "main",
    });

    const { group, exec } = await runDirectLlmGroup(orchestrator, storage);
    expect(exec.status).toBe("completed");

    // The consilium loop that ties this group's runId to the workspace path.
    await storage.createLoop({ groupId: group.id, repoPath: "/repo/alpha", state: "converged" });

    const stats = await storage.getLlmStatsByWorkspace();

    // Attributed to alpha — NOT Unattributed — and counted exactly once.
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      workspaceId: ws.id,
      workspaceName: "alpha",
      requests: 1,
      inputTokens: 100,
      outputTokens: 40,
    });
    expect(stats.some((s) => s.workspaceId === null)).toBe(false); // nothing unattributed
    // Global single-count invariant.
    expect(stats.reduce((n, s) => n + s.requests, 0)).toBe(1);
  });

  it("regression proof: WITHOUT the runId stamp the same row would be Unattributed", async () => {
    // Guards the read-side semantics the bug depended on: a NULL run_id can never
    // attribute. This is the state the panel was stuck in before the fix.
    const storage = new MemStorage();
    const ws = await storage.createWorkspace({ name: "alpha", type: "local", path: "/repo/alpha", branch: "main" });
    const group = await storage.createTaskGroup({ name: "review", description: "d", input: "i" });
    await storage.createLoop({ groupId: group.id, repoPath: "/repo/alpha", state: "converged" });

    await storage.createLlmRequest({
      runId: null, stageExecutionId: null, modelSlug: "claude-3-5-sonnet", provider: "anthropic",
      messages: [], systemPrompt: null, temperature: null, maxTokens: null, responseContent: "",
      inputTokens: 100, outputTokens: 40, totalTokens: 140, latencyMs: 10, estimatedCostUsd: 0.02,
      status: "success", errorMessage: null, teamId: null, tags: [],
    } as InsertLlmRequest);

    const stats = await storage.getLlmStatsByWorkspace();
    expect(stats).toHaveLength(1);
    expect(stats[0].workspaceId).toBeNull();
    expect(stats[0].workspaceName).toBe("Unattributed");
    expect(stats.some((s) => s.workspaceId === ws.id)).toBe(false);
  });
});
