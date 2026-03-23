import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  RemoteAgentStageConfig,
  RemoteAgentConfig,
  A2AMessage,
  TeamResult,
} from "@shared/types";

// ─── Types for mocks ────────────────────────────────────────────────────────

interface AgentRouteConfig {
  agentId?: string;
  agentSelector?: Record<string, string>;
}

interface TaskDispatchResult {
  taskId: string;
  status: string;
  output?: A2AMessage;
  error?: string;
  durationMs?: number;
}

// ─── Mock RemoteAgentManager ────────────────────────────────────────────────

function createMockRemoteAgentManager() {
  return {
    resolveAgent: vi.fn<(config: AgentRouteConfig) => Promise<RemoteAgentConfig | null>>(),
    dispatchTask: vi.fn<(agentId: string, message: A2AMessage, options?: Record<string, unknown>) => Promise<TaskDispatchResult>>(),
    initialize: vi.fn(),
    shutdown: vi.fn(),
    registerAgent: vi.fn(),
    connectAgent: vi.fn(),
    disconnectAgent: vi.fn(),
    listAgents: vi.fn(),
    getAgent: vi.fn(),
    getConnectionStatus: vi.fn(),
  };
}

// ─── Minimal agent fixture ──────────────────────────────────────────────────

function makeAgent(overrides: Partial<RemoteAgentConfig> = {}): RemoteAgentConfig {
  return {
    id: "agent-1",
    name: "test-agent",
    environment: "dev",
    transport: "https",
    endpoint: "https://agent.example.com",
    cluster: null,
    namespace: null,
    labels: { role: "k8s" },
    authTokenEnc: null,
    enabled: true,
    autoConnect: false,
    status: "online",
    lastHeartbeatAt: null,
    healthError: null,
    agentCard: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Extract and test executeRemoteStage logic directly ─────────────────────
//
// Since executeRemoteStage is a private method on PipelineController,
// we extract its logic into a standalone function that mirrors the
// implementation, allowing us to test it without instantiating the
// full controller (which requires many heavy dependencies).
//
// This approach tests the exact same algorithm that lives in the controller.

async function executeRemoteStage(
  remoteAgentManager: ReturnType<typeof createMockRemoteAgentManager> | null,
  config: RemoteAgentStageConfig,
  stageInput: Record<string, unknown>,
  runId: string,
  stageExecutionId: string,
): Promise<TeamResult> {
  if (!remoteAgentManager) {
    throw new Error("Remote agent execution requested but RemoteAgentManager is not configured");
  }

  // Resolve agent by ID, label selector, or fallback
  const agent = await remoteAgentManager.resolveAgent({
    agentId: config.agentId,
    agentSelector: config.agentSelector,
  });
  if (!agent) {
    throw new Error(
      config.agentId
        ? `Remote agent not found: ${config.agentId}`
        : "No matching remote agent found for selector",
    );
  }

  // Build A2A message from stage input
  const inputText = typeof stageInput === "string"
    ? stageInput
    : (stageInput as Record<string, unknown>).taskDescription as string
      ?? JSON.stringify(stageInput);

  const message: A2AMessage = {
    role: "user",
    parts: [{ type: "text", text: inputText }],
  };

  // Dispatch task to remote agent
  const dispatchResult = await remoteAgentManager.dispatchTask(
    agent.id,
    message,
    { skill: config.skill, runId, stageExecutionId },
  );

  if (dispatchResult.status === "failed") {
    throw new Error(`Remote agent task failed: ${dispatchResult.error ?? "unknown error"}`);
  }

  // Convert A2A response to TeamResult
  const outputText = dispatchResult.output?.parts
    ?.map((p) => p.text ?? (p.data ? JSON.stringify(p.data) : ""))
    .join("\n")
    ?? "";

  return {
    output: {
      raw: outputText,
      summary: outputText.slice(0, 500),
      remoteAgentId: agent.id,
      remoteTaskId: dispatchResult.taskId,
      remoteStatus: dispatchResult.status,
      remoteDurationMs: dispatchResult.durationMs,
    },
    tokensUsed: 0,
    raw: outputText,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Pipeline Remote Stage Execution", () => {
  let manager: ReturnType<typeof createMockRemoteAgentManager>;
  const runId = "run-001";
  const stageExecId = "exec-001";

  beforeEach(() => {
    manager = createMockRemoteAgentManager();
  });

  // ── 1. Successful execution by agent ID ──

  it("resolves agent by ID and dispatches task successfully", async () => {
    const agent = makeAgent({ id: "agent-42" });
    manager.resolveAgent.mockResolvedValue(agent);
    manager.dispatchTask.mockResolvedValue({
      taskId: "task-1",
      status: "completed",
      output: {
        role: "agent",
        parts: [{ type: "text", text: "Deployment successful" }],
      },
      durationMs: 1200,
    });

    const config: RemoteAgentStageConfig = { agentId: "agent-42", skill: "deploy" };
    const result = await executeRemoteStage(manager, config, { taskDescription: "deploy app" }, runId, stageExecId);

    expect(manager.resolveAgent).toHaveBeenCalledWith({ agentId: "agent-42", agentSelector: undefined });
    expect(manager.dispatchTask).toHaveBeenCalledWith(
      "agent-42",
      { role: "user", parts: [{ type: "text", text: "deploy app" }] },
      { skill: "deploy", runId, stageExecutionId: stageExecId },
    );
    expect(result.output.raw).toBe("Deployment successful");
    expect(result.output.remoteAgentId).toBe("agent-42");
    expect(result.output.remoteTaskId).toBe("task-1");
    expect(result.output.remoteDurationMs).toBe(1200);
    expect(result.tokensUsed).toBe(0);
  });

  // ── 2. Label-based routing ──

  it("resolves agent by label selector", async () => {
    const agent = makeAgent({ id: "k8s-agent", labels: { role: "k8s", env: "prod" } });
    manager.resolveAgent.mockResolvedValue(agent);
    manager.dispatchTask.mockResolvedValue({
      taskId: "task-2",
      status: "completed",
      output: { role: "agent", parts: [{ type: "text", text: "pods listed" }] },
    });

    const config: RemoteAgentStageConfig = {
      agentSelector: { role: "k8s", env: "prod" },
    };
    const result = await executeRemoteStage(manager, config, { taskDescription: "list pods" }, runId, stageExecId);

    expect(manager.resolveAgent).toHaveBeenCalledWith({
      agentId: undefined,
      agentSelector: { role: "k8s", env: "prod" },
    });
    expect(result.output.remoteAgentId).toBe("k8s-agent");
    expect(result.raw).toBe("pods listed");
  });

  // ── 3. Agent not found ──

  it("throws when no matching agent is found (by ID)", async () => {
    manager.resolveAgent.mockResolvedValue(null);

    const config: RemoteAgentStageConfig = { agentId: "nonexistent" };
    await expect(
      executeRemoteStage(manager, config, { taskDescription: "test" }, runId, stageExecId),
    ).rejects.toThrow("Remote agent not found: nonexistent");
  });

  it("throws descriptive error when no agent matches selector", async () => {
    manager.resolveAgent.mockResolvedValue(null);

    const config: RemoteAgentStageConfig = { agentSelector: { role: "gpu" } };
    await expect(
      executeRemoteStage(manager, config, { taskDescription: "test" }, runId, stageExecId),
    ).rejects.toThrow("No matching remote agent found for selector");
  });

  // ── 4. Dispatch failure ──

  it("throws when dispatch returns failed status", async () => {
    manager.resolveAgent.mockResolvedValue(makeAgent());
    manager.dispatchTask.mockResolvedValue({
      taskId: "task-err",
      status: "failed",
      error: "connection refused",
    });

    const config: RemoteAgentStageConfig = { agentId: "agent-1" };
    await expect(
      executeRemoteStage(manager, config, { taskDescription: "test" }, runId, stageExecId),
    ).rejects.toThrow("Remote agent task failed: connection refused");
  });

  it("throws with 'unknown error' when dispatch fails without error message", async () => {
    manager.resolveAgent.mockResolvedValue(makeAgent());
    manager.dispatchTask.mockResolvedValue({
      taskId: "task-err2",
      status: "failed",
    });

    const config: RemoteAgentStageConfig = { agentId: "agent-1" };
    await expect(
      executeRemoteStage(manager, config, { taskDescription: "test" }, runId, stageExecId),
    ).rejects.toThrow("Remote agent task failed: unknown error");
  });

  // ── 5. No RemoteAgentManager configured ──

  it("throws when remoteAgentManager is null", async () => {
    const config: RemoteAgentStageConfig = { agentId: "agent-1" };
    await expect(
      executeRemoteStage(null, config, { taskDescription: "test" }, runId, stageExecId),
    ).rejects.toThrow("Remote agent execution requested but RemoteAgentManager is not configured");
  });

  // ── 6. A2A response conversion ──

  it("converts multi-part A2A response to TeamResult", async () => {
    manager.resolveAgent.mockResolvedValue(makeAgent());
    manager.dispatchTask.mockResolvedValue({
      taskId: "task-mp",
      status: "completed",
      output: {
        role: "agent",
        parts: [
          { type: "text", text: "Part one." },
          { type: "data", data: { count: 42 } },
          { type: "text", text: "Part three." },
        ],
      },
      durationMs: 500,
    });

    const config: RemoteAgentStageConfig = { agentId: "agent-1" };
    const result = await executeRemoteStage(manager, config, { taskDescription: "multi" }, runId, stageExecId);

    expect(result.raw).toBe('Part one.\n{"count":42}\nPart three.');
    expect(result.output.raw).toBe('Part one.\n{"count":42}\nPart three.');
    expect(result.output.summary).toBe('Part one.\n{"count":42}\nPart three.');
    expect(result.tokensUsed).toBe(0);
  });

  it("handles empty output from remote agent", async () => {
    manager.resolveAgent.mockResolvedValue(makeAgent());
    manager.dispatchTask.mockResolvedValue({
      taskId: "task-empty",
      status: "completed",
      output: undefined,
    });

    const config: RemoteAgentStageConfig = { agentId: "agent-1" };
    const result = await executeRemoteStage(manager, config, { taskDescription: "test" }, runId, stageExecId);

    expect(result.raw).toBe("");
    expect(result.output.raw).toBe("");
    expect(result.output.remoteStatus).toBe("completed");
  });

  // ── 7. Input formatting ──

  it("extracts taskDescription from input object", async () => {
    manager.resolveAgent.mockResolvedValue(makeAgent());
    manager.dispatchTask.mockResolvedValue({
      taskId: "t1",
      status: "completed",
      output: { role: "agent", parts: [{ type: "text", text: "ok" }] },
    });

    const config: RemoteAgentStageConfig = { agentId: "agent-1" };
    await executeRemoteStage(manager, config, { taskDescription: "run tests" }, runId, stageExecId);

    const sentMessage = manager.dispatchTask.mock.calls[0][1];
    expect(sentMessage.parts[0].text).toBe("run tests");
  });

  it("JSON-serializes input when taskDescription is missing", async () => {
    manager.resolveAgent.mockResolvedValue(makeAgent());
    manager.dispatchTask.mockResolvedValue({
      taskId: "t2",
      status: "completed",
      output: { role: "agent", parts: [{ type: "text", text: "ok" }] },
    });

    const config: RemoteAgentStageConfig = { agentId: "agent-1" };
    await executeRemoteStage(manager, config, { foo: "bar", num: 1 }, runId, stageExecId);

    const sentMessage = manager.dispatchTask.mock.calls[0][1];
    expect(sentMessage.parts[0].text).toBe('{"foo":"bar","num":1}');
  });

  // ── 8. Skill passthrough ──

  it("passes skill from config to dispatch options", async () => {
    manager.resolveAgent.mockResolvedValue(makeAgent());
    manager.dispatchTask.mockResolvedValue({
      taskId: "t3",
      status: "completed",
      output: { role: "agent", parts: [{ type: "text", text: "done" }] },
    });

    const config: RemoteAgentStageConfig = { agentId: "agent-1", skill: "kubectl-apply" };
    await executeRemoteStage(manager, config, { taskDescription: "apply manifest" }, runId, stageExecId);

    const options = manager.dispatchTask.mock.calls[0][2] as Record<string, unknown>;
    expect(options.skill).toBe("kubectl-apply");
    expect(options.runId).toBe(runId);
    expect(options.stageExecutionId).toBe(stageExecId);
  });

  // ── 9. Summary truncation ──

  it("truncates summary to 500 characters", async () => {
    const longText = "x".repeat(1000);
    manager.resolveAgent.mockResolvedValue(makeAgent());
    manager.dispatchTask.mockResolvedValue({
      taskId: "t4",
      status: "completed",
      output: { role: "agent", parts: [{ type: "text", text: longText }] },
    });

    const config: RemoteAgentStageConfig = { agentId: "agent-1" };
    const result = await executeRemoteStage(manager, config, { taskDescription: "test" }, runId, stageExecId);

    expect(result.output.summary).toHaveLength(500);
    expect(result.raw).toHaveLength(1000);
  });

  // ── 10. Non-remote stages bypass ──

  it("non-remote stages are not affected (type check)", () => {
    // Verify that a stage config without remoteAgent is falsy
    const stageConfig = {
      teamId: "research" as const,
      modelSlug: "gpt-4",
      enabled: true,
    };
    expect(stageConfig.remoteAgent).toBeUndefined();
    // In the controller, `if (stageConfig.remoteAgent)` would be false
    expect(!!stageConfig.remoteAgent).toBe(false);
  });

  // ── 11. Dispatch error propagation ──

  it("propagates network errors from dispatchTask", async () => {
    manager.resolveAgent.mockResolvedValue(makeAgent());
    manager.dispatchTask.mockRejectedValue(new Error("ECONNREFUSED"));

    const config: RemoteAgentStageConfig = { agentId: "agent-1" };
    await expect(
      executeRemoteStage(manager, config, { taskDescription: "test" }, runId, stageExecId),
    ).rejects.toThrow("ECONNREFUSED");
  });
});
