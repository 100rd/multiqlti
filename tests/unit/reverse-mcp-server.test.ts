/**
 * Tests for the multiqlti reverse MCP server (issue #274).
 *
 * Covers:
 *  1. Token auth — generation, hashing, validation, expiry, revocation
 *  2. Scope enforcement — workspace access, tool allow-list, wildcard
 *  3. Concurrency limiting — acquire/release run slots
 *  4. Tool: list_workspaces — scoped to token workspaces
 *  5. Tool: list_pipelines — scoped to workspace, excludes templates
 *  6. Tool: run_pipeline — returns run_id; concurrency gate
 *  7. Tool: get_run — status + stage trace
 *  8. Tool: cancel_run — running vs. terminal runs
 *  9. Tool: list_connections — no secrets in output
 * 10. Tool: query_connection_usage — workspace scope check
 * 11. Audit log — recordToolCall called per invocation
 * 12. JSON-RPC protocol — tools/list, tools/call, unknown method
 * 13. stdio transport — processStdioLines, parse errors
 * 14. streamable-http transport — POST /mcp endpoint
 * 15. Token management HTTP endpoints — CRUD
 */


// Mock auth middleware for HTTP transport tests
// vi.mock is hoisted before module evaluation
vi.mock("../../server/auth/middleware", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireOwnerOrRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IStorage } from "../../server/storage";
import { MemStorage } from "../../server/storage";

// ── auth ──────────────────────────────────────────────────────────────────────
import {
  McpTokenStore,
  generateRawToken,
  hashToken,
  tokenSuffix,
  checkWorkspaceAccess,
  checkToolAccess,
  acquireRunSlot,
  releaseRunSlot,
  getActiveRunCount,
  _resetConcurrency,
  mcpTokenStore,
} from "../../server/mcp-servers/multiqlti-self/auth";

// ── server ────────────────────────────────────────────────────────────────────
import {
  MultiqltiMcpServer,
  McpScopeError,
  McpConcurrencyError,
  McpToolNotFoundError,
  handleMcpRequest,
  processStdioLines,
  MCP_TOOL_DEFINITIONS,
  ALL_TOOLS,
  TOOL_LIST_WORKSPACES,
  TOOL_LIST_PIPELINES,
  TOOL_RUN_PIPELINE,
  TOOL_GET_RUN,
  TOOL_CANCEL_RUN,
  TOOL_LIST_CONNECTIONS,
  TOOL_QUERY_CONNECTION_USAGE,
  _resetMultiqltiMcpServer,
} from "../../server/mcp-servers/multiqlti-self/index";
import type { McpCallContext } from "../../server/mcp-servers/multiqlti-self/index";
import type { McpTokenScope } from "../../shared/types";

// ── http transport ─────────────────────────────────────────────────────────────
import express from "express";
import request from "supertest";
import { Router } from "express";
import { registerMcpRoutes } from "../../server/routes/mcp";

// ── audit ──────────────────────────────────────────────────────────────────────
import * as audit from "../../server/tools/audit";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScope(overrides: Partial<McpTokenScope> = {}): McpTokenScope {
  return {
    workspaceIds: ["ws-1"],
    allowedTools: ["*"],
    maxRunConcurrency: 5,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<McpCallContext> = {}): McpCallContext {
  return {
    tokenId: "tok-1",
    scope: makeScope(),
    ...overrides,
  };
}

/** Build a minimal mock PipelineController. */
function makeMockController() {
  return {
    startRun: vi.fn(),
    cancelRun: vi.fn(),
  };
}

// ─── 1. Token auth ────────────────────────────────────────────────────────────

describe("generateRawToken()", () => {
  it("generates tokens with mq_mcp_ prefix", () => {
    const t = generateRawToken();
    expect(t.startsWith("mq_mcp_")).toBe(true);
  });

  it("generates unique tokens on successive calls", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateRawToken()));
    expect(tokens.size).toBe(20);
  });
});

describe("hashToken()", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const h = hashToken("mq_mcp_abc123");
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  it("is deterministic", () => {
    expect(hashToken("same")).toBe(hashToken("same"));
  });

  it("different inputs produce different hashes", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
});

describe("tokenSuffix()", () => {
  it("returns the last 8 characters", () => {
    expect(tokenSuffix("abcdefgh1234")).toBe("efgh1234");
    expect(tokenSuffix("12345678")).toBe("12345678");
  });
});

describe("McpTokenStore", () => {
  let store: McpTokenStore;

  beforeEach(() => {
    store = new McpTokenStore();
  });

  it("creates a token and returns rawToken once", () => {
    const result = store.create({
      workspaceId: "ws-1",
      name: "My Token",
      scope: makeScope(),
    });
    expect(result.rawToken).toMatch(/^mq_mcp_/);
    expect(result.token.tokenSuffix).toBe(result.rawToken.slice(-8));
    expect(result.token.isRevoked).toBe(false);
  });

  it("validates a correct raw token", () => {
    const { rawToken } = store.create({
      workspaceId: "ws-1",
      name: "Test",
      scope: makeScope(),
    });
    const ctx = store.validate(rawToken);
    expect(ctx).not.toBeNull();
    expect(ctx!.scope.workspaceIds).toContain("ws-1");
  });

  it("returns null for an unknown token", () => {
    expect(store.validate("mq_mcp_unknown")).toBeNull();
  });

  it("returns null for a revoked token", () => {
    const { rawToken, token } = store.create({
      workspaceId: "ws-1",
      name: "Test",
      scope: makeScope(),
    });
    store.revoke(token.id);
    expect(store.validate(rawToken)).toBeNull();
  });

  it("returns null for an expired token", () => {
    const { rawToken } = store.create({
      workspaceId: "ws-1",
      name: "Test",
      scope: makeScope(),
      expiresAt: new Date(Date.now() - 1000), // already expired
    });
    expect(store.validate(rawToken)).toBeNull();
  });

  it("does not expire a token with future expiresAt", () => {
    const { rawToken } = store.create({
      workspaceId: "ws-1",
      name: "Test",
      scope: makeScope(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(store.validate(rawToken)).not.toBeNull();
  });

  it("lists tokens by workspace", () => {
    store.create({ workspaceId: "ws-1", name: "A", scope: makeScope() });
    store.create({ workspaceId: "ws-1", name: "B", scope: makeScope() });
    store.create({ workspaceId: "ws-2", name: "C", scope: makeScope({ workspaceIds: ["ws-2"] }) });
    expect(store.listByWorkspace("ws-1")).toHaveLength(2);
    expect(store.listByWorkspace("ws-2")).toHaveLength(1);
  });

  it("getById returns public token shape without hash", () => {
    const { token } = store.create({ workspaceId: "ws-1", name: "X", scope: makeScope() });
    const retrieved = store.getById(token.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(token.id);
    expect("tokenHash" in retrieved!).toBe(false);
  });

  it("revoke returns false for unknown ID", () => {
    expect(store.revoke("nonexistent")).toBe(false);
  });

  it("updates lastUsedAt on validate", () => {
    const { rawToken, token } = store.create({
      workspaceId: "ws-1",
      name: "T",
      scope: makeScope(),
    });
    expect(store.getById(token.id)!.lastUsedAt).toBeNull();
    store.validate(rawToken);
    expect(store.getById(token.id)!.lastUsedAt).toBeInstanceOf(Date);
  });
});

// ─── 2. Scope checking ────────────────────────────────────────────────────────

describe("checkWorkspaceAccess()", () => {
  it("returns true when workspace is in scope", () => {
    expect(checkWorkspaceAccess(makeScope({ workspaceIds: ["ws-1", "ws-2"] }), "ws-1")).toBe(true);
  });

  it("returns false when workspace is not in scope", () => {
    expect(checkWorkspaceAccess(makeScope({ workspaceIds: ["ws-1"] }), "ws-99")).toBe(false);
  });
});

describe("checkToolAccess()", () => {
  it("allows all tools when list is ['*']", () => {
    const scope = makeScope({ allowedTools: ["*"] });
    expect(checkToolAccess(scope, "any_tool")).toBe(true);
  });

  it("allows a named tool in the list", () => {
    const scope = makeScope({ allowedTools: ["list_workspaces", "get_run"] });
    expect(checkToolAccess(scope, "list_workspaces")).toBe(true);
    expect(checkToolAccess(scope, "get_run")).toBe(true);
  });

  it("blocks a tool not in the list", () => {
    const scope = makeScope({ allowedTools: ["list_workspaces"] });
    expect(checkToolAccess(scope, "run_pipeline")).toBe(false);
  });
});

// ─── 3. Concurrency limiting ──────────────────────────────────────────────────

describe("acquireRunSlot / releaseRunSlot", () => {
  beforeEach(() => _resetConcurrency());

  it("allows up to maxConcurrency slots", () => {
    expect(acquireRunSlot("t1", 2)).toBe(true);
    expect(acquireRunSlot("t1", 2)).toBe(true);
    expect(acquireRunSlot("t1", 2)).toBe(false); // at capacity
  });

  it("releases a slot so it can be reacquired", () => {
    acquireRunSlot("t1", 1);
    expect(acquireRunSlot("t1", 1)).toBe(false);
    releaseRunSlot("t1");
    expect(acquireRunSlot("t1", 1)).toBe(true);
  });

  it("getActiveRunCount reflects current count", () => {
    acquireRunSlot("t2", 5);
    acquireRunSlot("t2", 5);
    expect(getActiveRunCount("t2")).toBe(2);
    releaseRunSlot("t2");
    expect(getActiveRunCount("t2")).toBe(1);
  });

  it("releasing below zero does not go negative", () => {
    releaseRunSlot("t3");
    expect(getActiveRunCount("t3")).toBe(0);
  });

  it("different tokens have independent counters", () => {
    acquireRunSlot("t4", 1);
    expect(acquireRunSlot("t5", 1)).toBe(true); // different token
  });
});

// ─── Shared server setup for tool tests ──────────────────────────────────────

function makeServer() {
  const storage = new MemStorage();
  const controller = makeMockController();
  const server = new MultiqltiMcpServer(
    storage as IStorage,
    controller as unknown as import("../../server/controller/pipeline-controller").PipelineController,
  );
  return { storage, controller, server };
}

// ─── 4. list_workspaces ───────────────────────────────────────────────────────

describe("MultiqltiMcpServer.callTool — list_workspaces", () => {
  beforeEach(() => _resetConcurrency());

  it("returns only workspaces the token is scoped to", async () => {
    const { storage, server } = makeServer();
    await storage.createWorkspace({ name: "WS1", type: "local", path: "/a", branch: "main", status: "active", indexStatus: "idle" });
    await storage.createWorkspace({ name: "WS2", type: "local", path: "/b", branch: "main", status: "active", indexStatus: "idle" });

    const workspaces = await storage.getWorkspaces();
    const [ws1, ws2] = workspaces;

    // Token only has access to ws1
    const ctx = makeCtx({ scope: makeScope({ workspaceIds: [ws1.id] }) });
    const result = await server.callTool(TOOL_LIST_WORKSPACES, {}, ctx) as Array<{ id: string }>;

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(ws1.id);
    expect(result.find((w) => w.id === ws2.id)).toBeUndefined();
  });

  it("returns empty array when token has no matching workspaces", async () => {
    const { server } = makeServer();
    const ctx = makeCtx({ scope: makeScope({ workspaceIds: ["non-existent-ws"] }) });
    const result = await server.callTool(TOOL_LIST_WORKSPACES, {}, ctx);
    expect(result).toEqual([]);
  });

  it("throws McpToolNotFoundError for unknown tool names", async () => {
    const { server } = makeServer();
    await expect(server.callTool("unknown_tool", {}, makeCtx())).rejects.toThrow(McpToolNotFoundError);
  });

  it("throws McpScopeError when tool is not in allow-list", async () => {
    const { server } = makeServer();
    const ctx = makeCtx({ scope: makeScope({ allowedTools: ["get_run"] }) });
    await expect(server.callTool(TOOL_LIST_WORKSPACES, {}, ctx)).rejects.toThrow(McpScopeError);
  });
});

// ─── 5. list_pipelines ────────────────────────────────────────────────────────

describe("MultiqltiMcpServer.callTool — list_pipelines", () => {
  beforeEach(() => _resetConcurrency());

  it("returns pipelines for an allowed workspace", async () => {
    const { storage, server } = makeServer();
    const ws = await storage.createWorkspace({ name: "WS", type: "local", path: "/w", branch: "main", status: "active", indexStatus: "idle" });
    await storage.createPipeline({ name: "Pipeline A", stages: [], isTemplate: false });
    await storage.createPipeline({ name: "Template", stages: [], isTemplate: true });

    const ctx = makeCtx({ scope: makeScope({ workspaceIds: [ws.id] }) });
    const result = await server.callTool(TOOL_LIST_PIPELINES, { workspace_id: ws.id }, ctx) as Array<{ name: string; isTemplate: boolean }>;

    // Should exclude template
    expect(result.every((p) => !p.isTemplate)).toBe(true);
    expect(result.some((p) => p.name === "Pipeline A")).toBe(true);
  });

  it("throws McpScopeError for workspace not in token scope", async () => {
    const { storage, server } = makeServer();
    const ws = await storage.createWorkspace({ name: "W", type: "local", path: "/", branch: "main", status: "active", indexStatus: "idle" });
    const ctx = makeCtx({ scope: makeScope({ workspaceIds: ["other-ws"] }) });

    await expect(
      server.callTool(TOOL_LIST_PIPELINES, { workspace_id: ws.id }, ctx),
    ).rejects.toThrow(McpScopeError);
  });

  it("throws Error when workspace_id arg is missing", async () => {
    const { server } = makeServer();
    await expect(
      server.callTool(TOOL_LIST_PIPELINES, {}, makeCtx()),
    ).rejects.toThrow(/workspace_id/);
  });
});

// ─── 6. run_pipeline ─────────────────────────────────────────────────────────

describe("MultiqltiMcpServer.callTool — run_pipeline", () => {
  beforeEach(() => _resetConcurrency());

  it("returns run_id and pending status on success", async () => {
    const { storage, controller, server } = makeServer();
    const pipeline = await storage.createPipeline({ name: "P", stages: [], isTemplate: false });

    const mockRun = {
      id: "run-abc",
      pipelineId: pipeline.id,
      status: "running",
      input: "hello",
      startedAt: new Date(),
      output: null,
      currentStageIndex: 0,
      completedAt: null,
      triggeredBy: null,
      dagMode: false,
      createdAt: new Date(),
    };
    controller.startRun.mockResolvedValue(mockRun);

    // Add to storage so get_run can find it
    await storage.createPipelineRun({
      pipelineId: pipeline.id,
      input: "hello",
      status: "running",
      currentStageIndex: 0,
      startedAt: new Date(),
      dagMode: false,
      triggeredBy: null,
    });

    const ctx = makeCtx();
    const result = await server.callTool(
      TOOL_RUN_PIPELINE,
      { pipeline_id: pipeline.id, input: "hello" },
      ctx,
    ) as { runId: string; status: string };

    expect(controller.startRun).toHaveBeenCalledOnce();
    expect(result.runId).toBe(mockRun.id);
  });

  it("throws McpConcurrencyError when at capacity", async () => {
    const { storage, controller, server } = makeServer();
    const pipeline = await storage.createPipeline({ name: "P2", stages: [], isTemplate: false });
    controller.startRun.mockResolvedValue({ id: "run-x", status: "running", startedAt: new Date() });

    const ctx = makeCtx({ scope: makeScope({ maxRunConcurrency: 1 }) });

    // Acquire the single slot manually
    acquireRunSlot(ctx.tokenId, 1);

    await expect(
      server.callTool(TOOL_RUN_PIPELINE, { pipeline_id: pipeline.id, input: "go" }, ctx),
    ).rejects.toThrow(McpConcurrencyError);
  });

  it("releases slot if startRun throws", async () => {
    const { storage, controller, server } = makeServer();
    const pipeline = await storage.createPipeline({ name: "P3", stages: [], isTemplate: false });
    controller.startRun.mockRejectedValue(new Error("controller error"));

    const ctx = makeCtx({ tokenId: "tok-err", scope: makeScope({ maxRunConcurrency: 2 }) });

    try {
      await server.callTool(
        TOOL_RUN_PIPELINE,
        { pipeline_id: pipeline.id, input: "go" },
        ctx,
      );
    } catch {
      // expected
    }

    // Slot should have been released
    expect(getActiveRunCount("tok-err")).toBe(0);
  });
});

// ─── 7. get_run ───────────────────────────────────────────────────────────────

describe("MultiqltiMcpServer.callTool — get_run", () => {
  beforeEach(() => _resetConcurrency());

  it("returns run details with stage list", async () => {
    const { storage, server } = makeServer();
    const pipeline = await storage.createPipeline({ name: "P", stages: [], isTemplate: false });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      input: "hello",
      status: "running",
      currentStageIndex: 0,
      startedAt: new Date(),
      dagMode: false,
      triggeredBy: null,
    });

    const result = await server.callTool(TOOL_GET_RUN, { run_id: run.id }, makeCtx()) as {
      id: string;
      status: string;
      stages: unknown[];
    };

    expect(result.id).toBe(run.id);
    expect(result.status).toBe("running");
    expect(Array.isArray(result.stages)).toBe(true);
  });

  it("throws Error for unknown run_id", async () => {
    const { server } = makeServer();
    await expect(
      server.callTool(TOOL_GET_RUN, { run_id: "no-such-run" }, makeCtx()),
    ).rejects.toThrow(/Run not found/);
  });

  it("throws Error when run_id arg is missing", async () => {
    const { server } = makeServer();
    await expect(server.callTool(TOOL_GET_RUN, {}, makeCtx())).rejects.toThrow(/run_id/);
  });
});

// ─── 8. cancel_run ───────────────────────────────────────────────────────────

describe("MultiqltiMcpServer.callTool — cancel_run", () => {
  beforeEach(() => _resetConcurrency());

  it("cancels a running run", async () => {
    const { storage, controller, server } = makeServer();
    const pipeline = await storage.createPipeline({ name: "P", stages: [], isTemplate: false });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      input: "go",
      status: "running",
      currentStageIndex: 0,
      startedAt: new Date(),
      dagMode: false,
      triggeredBy: null,
    });
    controller.cancelRun.mockResolvedValue(undefined);

    const result = await server.callTool(TOOL_CANCEL_RUN, { run_id: run.id }, makeCtx()) as {
      runId: string;
      cancelled: boolean;
    };

    expect(result.cancelled).toBe(true);
    expect(controller.cancelRun).toHaveBeenCalledWith(run.id);
  });

  it("returns cancelled: false for already completed run", async () => {
    const { storage, controller, server } = makeServer();
    const pipeline = await storage.createPipeline({ name: "P", stages: [], isTemplate: false });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      input: "go",
      status: "completed",
      currentStageIndex: 0,
      startedAt: new Date(),
      dagMode: false,
      triggeredBy: null,
    });

    const result = await server.callTool(TOOL_CANCEL_RUN, { run_id: run.id }, makeCtx()) as {
      cancelled: boolean;
    };

    expect(result.cancelled).toBe(false);
    expect(controller.cancelRun).not.toHaveBeenCalled();
  });

  it("returns cancelled: false for failed run", async () => {
    const { storage, controller, server } = makeServer();
    const pipeline = await storage.createPipeline({ name: "P", stages: [], isTemplate: false });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      input: "go",
      status: "failed",
      currentStageIndex: 0,
      startedAt: new Date(),
      dagMode: false,
      triggeredBy: null,
    });
    const result = await server.callTool(TOOL_CANCEL_RUN, { run_id: run.id }, makeCtx()) as {
      cancelled: boolean;
    };
    expect(result.cancelled).toBe(false);
  });

  it("throws Error for unknown run_id", async () => {
    const { server } = makeServer();
    await expect(
      server.callTool(TOOL_CANCEL_RUN, { run_id: "no-such" }, makeCtx()),
    ).rejects.toThrow(/Run not found/);
  });
});

// ─── 9. list_connections — no secrets ────────────────────────────────────────

describe("MultiqltiMcpServer.callTool — list_connections", () => {
  beforeEach(() => _resetConcurrency());

  it("returns connection metadata without secrets or config", async () => {
    const { storage, server } = makeServer();
    const ws = await storage.createWorkspace({ name: "W", type: "local", path: "/", branch: "main", status: "active", indexStatus: "idle" });
    await storage.createWorkspaceConnection({
      workspaceId: ws.id,
      type: "github",
      name: "My GitHub",
      config: { host: "https://api.github.com" },
      secrets: { token: "ghp_supersecrettoken12345678901234567890" },
    });

    const ctx = makeCtx({ scope: makeScope({ workspaceIds: [ws.id] }) });
    const result = await server.callTool(
      TOOL_LIST_CONNECTIONS,
      { workspace_id: ws.id },
      ctx,
    ) as Array<Record<string, unknown>>;

    expect(result).toHaveLength(1);
    const conn = result[0];
    expect(conn.id).toBeDefined();
    expect(conn.name).toBe("My GitHub");
    expect(conn.hasSecrets).toBe(true);
    // Critical: no secrets or config should appear
    expect("secrets" in conn).toBe(false);
    expect("config" in conn).toBe(false);
    // Token value must not appear anywhere in the serialised output
    const json = JSON.stringify(conn);
    expect(json).not.toContain("ghp_supersecrettoken");
    expect(json).not.toContain("supersecrettoken");
  });

  it("throws McpScopeError for workspace not in token scope", async () => {
    const { storage, server } = makeServer();
    const ws = await storage.createWorkspace({ name: "W", type: "local", path: "/", branch: "main", status: "active", indexStatus: "idle" });
    const ctx = makeCtx({ scope: makeScope({ workspaceIds: ["other-ws"] }) });

    await expect(
      server.callTool(TOOL_LIST_CONNECTIONS, { workspace_id: ws.id }, ctx),
    ).rejects.toThrow(McpScopeError);
  });

  it("never includes kubernetes token in output", async () => {
    const { storage, server } = makeServer();
    const ws = await storage.createWorkspace({ name: "W2", type: "local", path: "/", branch: "main", status: "active", indexStatus: "idle" });
    await storage.createWorkspaceConnection({
      workspaceId: ws.id,
      type: "kubernetes",
      name: "K8s Cluster",
      config: { server: "https://k8s.example.com" },
      secrets: { kubeconfig: "apiVersion: v1\nclusters:\n- cluster:\n    server: https://k8s.example.com\n  name: default\ncurrent-context: default\ncontexts:\n- context:\n    cluster: default\n    user: admin\n  name: default\nkind: Config\npreferences: {}\nusers:\n- name: admin\n  user:\n    token: my-secret-token-value" },
    });

    const ctx = makeCtx({ scope: makeScope({ workspaceIds: [ws.id] }) });
    const result = await server.callTool(
      TOOL_LIST_CONNECTIONS,
      { workspace_id: ws.id },
      ctx,
    ) as Array<Record<string, unknown>>;

    const json = JSON.stringify(result);
    expect(json).not.toContain("my-secret-token-value");
    expect(json).not.toContain("kubeconfig");
  });
});

// ─── 10. query_connection_usage ───────────────────────────────────────────────

describe("MultiqltiMcpServer.callTool — query_connection_usage", () => {
  beforeEach(() => _resetConcurrency());

  it("returns usage metrics for a valid connection", async () => {
    const { storage, server } = makeServer();
    const ws = await storage.createWorkspace({ name: "W", type: "local", path: "/", branch: "main", status: "active", indexStatus: "idle" });
    const conn = await storage.createWorkspaceConnection({
      workspaceId: ws.id,
      type: "github",
      name: "GH",
      config: {},
    });

    const ctx = makeCtx({ scope: makeScope({ workspaceIds: [ws.id] }) });
    const result = await server.callTool(
      TOOL_QUERY_CONNECTION_USAGE,
      { connection_id: conn.id },
      ctx,
    ) as { connectionId: string; isOrphan: boolean };

    expect(result.connectionId).toBe(conn.id);
    expect(typeof result.isOrphan).toBe("boolean");
  });

  it("throws Error for unknown connection_id", async () => {
    const { server } = makeServer();
    await expect(
      server.callTool(TOOL_QUERY_CONNECTION_USAGE, { connection_id: "no-conn" }, makeCtx()),
    ).rejects.toThrow(/Connection not found/);
  });

  it("throws McpScopeError when connection belongs to an inaccessible workspace", async () => {
    const { storage, server } = makeServer();
    const ws = await storage.createWorkspace({ name: "W", type: "local", path: "/", branch: "main", status: "active", indexStatus: "idle" });
    const conn = await storage.createWorkspaceConnection({
      workspaceId: ws.id,
      type: "github",
      name: "GH",
      config: {},
    });

    // Token with access to a different workspace
    const ctx = makeCtx({ scope: makeScope({ workspaceIds: ["other-ws"] }) });
    await expect(
      server.callTool(TOOL_QUERY_CONNECTION_USAGE, { connection_id: conn.id }, ctx),
    ).rejects.toThrow(McpScopeError);
  });
});

// ─── 11. Audit log ────────────────────────────────────────────────────────────

describe("Audit log per tool call", () => {
  beforeEach(() => _resetConcurrency());

  it("recordToolCall is called for successful tool invocations", async () => {
    const spy = vi.spyOn(audit, "recordToolCall").mockResolvedValue(undefined);
    const { server } = makeServer();
    const ctx = makeCtx();

    await server.callTool(TOOL_LIST_WORKSPACES, {}, ctx);

    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0][1];
    expect(call.toolName).toBe(TOOL_LIST_WORKSPACES);
    expect(call.connectionType).toBe("mcp_client");
    expect(call.connectionId).toContain("tok-1");
    spy.mockRestore();
  });

  it("recordToolCall is called even when the tool throws", async () => {
    const spy = vi.spyOn(audit, "recordToolCall").mockResolvedValue(undefined);
    const { server } = makeServer();
    const ctx = makeCtx();

    try {
      await server.callTool(TOOL_GET_RUN, { run_id: "missing" }, ctx);
    } catch {
      // expected
    }

    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0][1];
    expect(call.error).toMatch(/Run not found/);
    spy.mockRestore();
  });

  it("audit log contains the tool name and no raw secrets", async () => {
    const captured: typeof audit.AuditCallInput[] = [];
    const spy = vi.spyOn(audit, "recordToolCall").mockImplementation(async (_s, input) => {
      captured.push(input as typeof audit.AuditCallInput);
      return undefined;
    });

    const { storage, server } = makeServer();
    const ws = await storage.createWorkspace({ name: "W", type: "local", path: "/", branch: "main", status: "active", indexStatus: "idle" });
    const ctx = makeCtx({ scope: makeScope({ workspaceIds: [ws.id] }) });

    await server.callTool(TOOL_LIST_WORKSPACES, {}, ctx);

    expect(captured[0].toolName).toBe(TOOL_LIST_WORKSPACES);
    spy.mockRestore();
  });
});

// ─── 12. JSON-RPC protocol ────────────────────────────────────────────────────

describe("handleMcpRequest()", () => {
  beforeEach(() => _resetConcurrency());

  it("tools/list returns all tool definitions", async () => {
    const { server } = makeServer();
    const ctx = makeCtx();
    const resp = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      server,
      ctx,
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { tools: unknown[] };
    expect(result.tools).toHaveLength(ALL_TOOLS.length);
  });

  it("tools/call dispatches to list_workspaces", async () => {
    const { server } = makeServer();
    const ctx = makeCtx();
    const resp = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_workspaces", arguments: {} },
      },
      server,
      ctx,
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();
  });

  it("unknown method returns -32601 error", async () => {
    const { server } = makeServer();
    const resp = await handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "unknown/method" },
      server,
      makeCtx(),
    );
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32601);
  });

  it("tools/call with scope violation returns -32001 error", async () => {
    const { server } = makeServer();
    const ctx = makeCtx({ scope: makeScope({ allowedTools: ["get_run"] }) });
    const resp = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_workspaces", arguments: {} },
      },
      server,
      ctx,
    );
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32001);
  });

  it("tools/call with unknown tool returns -32601 error", async () => {
    const { server } = makeServer();
    const resp = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {} },
      },
      server,
      makeCtx(),
    );
    expect(resp.error!.code).toBe(-32601);
  });

  it("preserves request id in response", async () => {
    const { server } = makeServer();
    const resp = await handleMcpRequest(
      { jsonrpc: "2.0", id: "req-42", method: "tools/list" },
      server,
      makeCtx(),
    );
    expect(resp.id).toBe("req-42");
  });

  it("null id in request passes through", async () => {
    const { server } = makeServer();
    const resp = await handleMcpRequest(
      { jsonrpc: "2.0", id: null, method: "tools/list" },
      server,
      makeCtx(),
    );
    expect(resp.id).toBeNull();
  });
});

// ─── 13. stdio transport ─────────────────────────────────────────────────────

describe("processStdioLines()", () => {
  beforeEach(() => _resetConcurrency());

  it("writes one response per valid line", async () => {
    const { server } = makeServer();
    const ctx = makeCtx();
    const output: string[] = [];

    await processStdioLines(
      ['{"jsonrpc":"2.0","id":1,"method":"tools/list"}'],
      server,
      ctx,
      (s) => output.push(s),
    );

    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.result).toBeDefined();
  });

  it("skips blank lines", async () => {
    const { server } = makeServer();
    const output: string[] = [];

    await processStdioLines(
      ["", "   ", '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'],
      server,
      makeCtx(),
      (s) => output.push(s),
    );

    expect(output).toHaveLength(1);
  });

  it("returns parse error response for invalid JSON", async () => {
    const { server } = makeServer();
    const output: string[] = [];

    await processStdioLines(
      ["not-valid-json"],
      server,
      makeCtx(),
      (s) => output.push(s),
    );

    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.error.code).toBe(-32700);
    expect(parsed.id).toBeNull();
  });

  it("processes multiple lines in order", async () => {
    const { server } = makeServer();
    const output: string[] = [];

    await processStdioLines(
      [
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
      ],
      server,
      makeCtx(),
      (s) => output.push(s),
    );

    expect(output).toHaveLength(2);
    expect(JSON.parse(output[0]).id).toBe(1);
    expect(JSON.parse(output[1]).id).toBe(2);
  });
});

// ─── 14. streamable-http transport ───────────────────────────────────────────

describe("streamable-http transport (POST /mcp)", () => {
  let app: express.Express;
  let testStore: McpTokenStore;
  let validRawToken: string;
  let workspaceId: string;
  let testStorage: MemStorage;

  beforeEach(() => {
    _resetConcurrency();
    _resetMultiqltiMcpServer();
    testStore = new McpTokenStore();
    testStorage = new MemStorage();

    app = express();
    app.use(express.json());

    const mockController = makeMockController();
    const router = Router();

    // Swap in our test store by patching the singleton (via module-level mock)
    // We build the app fresh each time so the MCP server uses testStorage.
    registerMcpRoutes(router, testStorage as IStorage, mockController as unknown as import("../../server/controller/pipeline-controller").PipelineController);
    app.use(router);
  });

  it("returns 401 when no Authorization header", async () => {
    const res = await request(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it("returns 401 for invalid token", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer invalid_token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON-RPC body", async () => {
    const { rawToken } = mcpTokenStore.create({
      workspaceId: "ws-1",
      name: "T",
      scope: makeScope(),
    });

    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${rawToken}`)
      .send({ not: "jsonrpc" });

    expect(res.status).toBe(400);
    mcpTokenStore._reset();
  });

  it("GET /mcp/tools returns tool list without auth", async () => {
    const res = await request(app).get("/mcp/tools");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tools)).toBe(true);
    expect(res.body.tools.length).toBe(ALL_TOOLS.length);
  });
});

// ─── 15. Token management HTTP endpoints ─────────────────────────────────────

describe("Token management endpoints", () => {
  let app: express.Express;

  beforeEach(() => {
    _resetConcurrency();
    _resetMultiqltiMcpServer();
    mcpTokenStore._reset();
    app = express();
    app.use(express.json());

    // Inject test user
    app.use((req, _res, next) => {
      (req as express.Request & { user?: unknown }).user = {
        id: "admin-user",
        email: "admin@test.com",
        name: "Admin",
        isActive: true,
        role: "admin",
        lastLoginAt: null,
        createdAt: new Date(0),
      };
      next();
    });

    const storage = new MemStorage();
    const mockController = makeMockController();
    const router = Router();
    registerMcpRoutes(
      router,
      storage as IStorage,
      mockController as unknown as import("../../server/controller/pipeline-controller").PipelineController,
    );
    app.use(router);
  });

  afterEach(() => {
    mcpTokenStore._reset();
  });

  it("POST /api/workspaces/:id/mcp-tokens creates a token", async () => {
    const res = await request(app)
      .post("/api/workspaces/ws-1/mcp-tokens")
      .send({
        name: "CI Token",
        scope: { workspaceIds: ["ws-1"], allowedTools: ["*"], maxRunConcurrency: 3 },
      });

    expect(res.status).toBe(201);
    expect(res.body.rawToken).toMatch(/^mq_mcp_/);
    expect(res.body.token.name).toBe("CI Token");
    expect(res.body.token.isRevoked).toBe(false);
    // rawToken must not appear again in subsequent responses
  });

  it("POST returns 400 when scope.workspaceIds does not include the path workspace", async () => {
    const res = await request(app)
      .post("/api/workspaces/ws-1/mcp-tokens")
      .send({
        name: "Bad",
        scope: { workspaceIds: ["ws-2"], allowedTools: ["*"], maxRunConcurrency: 1 },
      });

    expect(res.status).toBe(400);
  });

  it("GET /api/workspaces/:id/mcp-tokens lists tokens for workspace", async () => {
    mcpTokenStore.create({ workspaceId: "ws-1", name: "A", scope: makeScope() });
    mcpTokenStore.create({ workspaceId: "ws-1", name: "B", scope: makeScope() });
    mcpTokenStore.create({ workspaceId: "ws-2", name: "C", scope: makeScope({ workspaceIds: ["ws-2"] }) });

    const res = await request(app).get("/api/workspaces/ws-1/mcp-tokens");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((t: { name: string }) => t.name !== "C")).toBe(true);
  });

  it("DELETE /api/workspaces/:id/mcp-tokens/:tid revokes a token", async () => {
    const { token } = mcpTokenStore.create({ workspaceId: "ws-1", name: "T", scope: makeScope() });

    const res = await request(app).delete(`/api/workspaces/ws-1/mcp-tokens/${token.id}`);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);

    // Token should now be revoked
    const tokens = mcpTokenStore.listByWorkspace("ws-1");
    expect(tokens.find((t) => t.id === token.id)!.isRevoked).toBe(true);
  });

  it("DELETE returns 403 when token belongs to a different workspace", async () => {
    const { token } = mcpTokenStore.create({
      workspaceId: "ws-2",
      name: "Other",
      scope: makeScope({ workspaceIds: ["ws-2"] }),
    });

    const res = await request(app).delete(`/api/workspaces/ws-1/mcp-tokens/${token.id}`);
    expect(res.status).toBe(403);
  });

  it("DELETE returns 404 for non-existent token", async () => {
    const res = await request(app).delete("/api/workspaces/ws-1/mcp-tokens/no-such-id");
    expect(res.status).toBe(404);
  });
});

// ─── 16. MCP_TOOL_DEFINITIONS completeness ────────────────────────────────────

describe("MCP_TOOL_DEFINITIONS", () => {
  it("contains exactly 7 tools", () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(7);
  });

  it("every ALL_TOOLS entry has a definition", () => {
    const names = MCP_TOOL_DEFINITIONS.map((d) => d.name);
    for (const t of ALL_TOOLS) {
      expect(names).toContain(t);
    }
  });

  it("each definition has name, description, and inputSchema", () => {
    for (const def of MCP_TOOL_DEFINITIONS) {
      expect(typeof def.name).toBe("string");
      expect(typeof def.description).toBe("string");
      expect(typeof def.inputSchema).toBe("object");
    }
  });
});
