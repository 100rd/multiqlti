/**
 * Unit tests for MemStorage.getLlmStatsByWorkspace() — the per-workspace LLM
 * aggregation (tokens / cost / requests attributed to a WORKSPACE).
 *
 * Attribution join under test:
 *   llm_requests.runId  ==  task_groups.id   (the gateway records runId = group.id
 *                                             in the consilium/task-group path)
 *   consilium_loops.groupId == that group.id
 *   consilium_loops.repoPath == workspaces.path   -> resolves the workspace.
 *
 * Correctness properties asserted:
 *   (a) attribution — a request whose runId maps through a loop lands on that
 *       loop's workspace;
 *   (b) unattributed bucket — a request with a null runId, or a runId that maps
 *       to no workspace, lands in { workspaceId: null, workspaceName: "Unattributed" };
 *   (c) NO double-counting — a group owning MULTIPLE consilium_loops rows AND
 *       MULTIPLE tasks has its single request counted exactly once (a naive
 *       fan-out join would multiply its tokens/cost by loops x tasks).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../server/storage.js";
import type { InsertLlmRequest } from "../../shared/schema.js";

/** Minimal, valid llm_request payload; caller overrides what matters. */
function llmReq(overrides: Partial<InsertLlmRequest>): InsertLlmRequest {
  return {
    runId: null,
    stageExecutionId: null,
    modelSlug: "claude-3-5-sonnet",
    provider: "anthropic",
    messages: [],
    systemPrompt: null,
    temperature: null,
    maxTokens: null,
    responseContent: "",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    latencyMs: 100,
    estimatedCostUsd: 0.001,
    status: "success",
    errorMessage: null,
    teamId: null,
    tags: [],
    ...overrides,
  } as InsertLlmRequest;
}

describe("MemStorage.getLlmStatsByWorkspace()", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  it("(a) attributes a request to the workspace resolved via its consilium loop", async () => {
    const ws = await storage.createWorkspace({
      name: "alpha", type: "local", path: "/repo/alpha", branch: "main",
    });
    const group = await storage.createTaskGroup({
      name: "review-alpha", description: "d", input: "i",
    });
    await storage.createLoop({
      groupId: group.id, repoPath: "/repo/alpha", state: "converged",
    });

    await storage.createLlmRequest(llmReq({ runId: group.id, inputTokens: 100, outputTokens: 40, estimatedCostUsd: 0.02 }));

    const stats = await storage.getLlmStatsByWorkspace();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      workspaceId: ws.id,
      workspaceName: "alpha",
      requests: 1,
      inputTokens: 100,
      outputTokens: 40,
      costUsd: 0.02,
    });
  });

  it("(b) buckets null-runId and unmatched-runId requests as Unattributed", async () => {
    // A request with no runId at all.
    await storage.createLlmRequest(llmReq({ runId: null, inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.005 }));
    // A request whose runId maps to no loop/workspace.
    await storage.createLlmRequest(llmReq({ runId: "ghost-group", inputTokens: 8, outputTokens: 2, estimatedCostUsd: 0.004 }));

    const stats = await storage.getLlmStatsByWorkspace();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      workspaceId: null,
      workspaceName: "Unattributed",
      requests: 2,
      inputTokens: 15,
      outputTokens: 5,
    });
    expect(stats[0].costUsd).toBeCloseTo(0.009, 10);
  });

  it("(c) counts a request ONCE for a group with 2 consilium loops and 2 tasks", async () => {
    const ws = await storage.createWorkspace({
      name: "beta", type: "local", path: "/repo/beta", branch: "main",
    });
    // Two OTHER workspaces the fan-out could wrongly attribute to via tasks.
    const wsX = await storage.createWorkspace({ name: "x", type: "local", path: "/repo/x", branch: "main" });
    const wsY = await storage.createWorkspace({ name: "y", type: "local", path: "/repo/y", branch: "main" });

    const group = await storage.createTaskGroup({ name: "review-beta", description: "d", input: "i" });

    // TWO terminal consilium loops on the SAME group (terminal loops accumulate
    // across re-runs; only NON-terminal loops are unique-per-group). Both point at
    // the same repo, so the resolved workspace is unambiguous regardless of which
    // loop wins the deterministic pick.
    await storage.createLoop({ groupId: group.id, repoPath: "/repo/beta", state: "converged" });
    await storage.createLoop({ groupId: group.id, repoPath: "/repo/beta", state: "failed" });

    // TWO tasks on the group, carrying DIFFERENT workspaceIds — a naive join on
    // tasks would fan out and double-count. Our chosen join ignores tasks, so these
    // must have zero effect.
    await storage.createTask({ groupId: group.id, name: "t1", description: "d", workspaceId: wsX.id });
    await storage.createTask({ groupId: group.id, name: "t2", description: "d", workspaceId: wsY.id });

    // ONE request for the group.
    await storage.createLlmRequest(llmReq({ runId: group.id, inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.01 }));

    const stats = await storage.getLlmStatsByWorkspace();

    // Only the beta workspace bucket exists — X and Y (task workspaces) must NOT appear.
    expect(stats).toHaveLength(1);
    const beta = stats.find((s) => s.workspaceId === ws.id);
    expect(beta).toBeDefined();
    expect(beta).toMatchObject({
      workspaceName: "beta",
      requests: 1,        // counted once, NOT 2 loops x 2 tasks = 4
      inputTokens: 100,   // summed once
      outputTokens: 50,
      costUsd: 0.01,
    });
    expect(stats.some((s) => s.workspaceId === wsX.id)).toBe(false);
    expect(stats.some((s) => s.workspaceId === wsY.id)).toBe(false);

    // Global invariant: total requests across all buckets == total requests recorded.
    const totalBucketed = stats.reduce((n, s) => n + s.requests, 0);
    expect(totalBucketed).toBe(1);
  });

  it("mixes attributed and unattributed requests without cross-contamination", async () => {
    const ws = await storage.createWorkspace({ name: "gamma", type: "local", path: "/repo/gamma", branch: "main" });
    const group = await storage.createTaskGroup({ name: "review-gamma", description: "d", input: "i" });
    await storage.createLoop({ groupId: group.id, repoPath: "/repo/gamma", state: "converged" });

    await storage.createLlmRequest(llmReq({ runId: group.id, inputTokens: 10, outputTokens: 10, estimatedCostUsd: 0.001 }));
    await storage.createLlmRequest(llmReq({ runId: group.id, inputTokens: 20, outputTokens: 20, estimatedCostUsd: 0.002 }));
    await storage.createLlmRequest(llmReq({ runId: null, inputTokens: 5, outputTokens: 5, estimatedCostUsd: 0.003 }));

    const stats = await storage.getLlmStatsByWorkspace();
    const gamma = stats.find((s) => s.workspaceId === ws.id);
    const unattr = stats.find((s) => s.workspaceId === null);

    expect(gamma).toMatchObject({ requests: 2, inputTokens: 30, outputTokens: 30, costUsd: 0.003 });
    expect(unattr).toMatchObject({ workspaceName: "Unattributed", requests: 1, inputTokens: 5, outputTokens: 5 });
    // Every recorded request is accounted for exactly once.
    expect(stats.reduce((n, s) => n + s.requests, 0)).toBe(3);
  });
});
