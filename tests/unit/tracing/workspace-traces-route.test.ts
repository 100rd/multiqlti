import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { IStorage } from "../../../server/storage.js";
import { registerWorkspaceTraceRoutes } from "../../../server/routes/workspace-traces.js";
import type { TaskTraceSpan } from "../../../shared/types.js";
import type { TaskTraceRow, WorkspaceRow } from "../../../shared/schema.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// task_traces.spans are TaskTraceSpan (task-tracer native shape), NOT the
// legacy OpenInference TraceSpan — the route adapts them via
// taskSpanToTraceSpan(). See server/routes/workspace-traces.ts.

const LLM_SPAN: TaskTraceSpan = {
  spanId: "aaaa1111aaaa1111",
  parentSpanId: null,
  name: "llm.claude-sonnet-4-6",
  type: "llm_call",
  status: "completed",
  startTime: 1000,
  endTime: 2500,
  metadata: {
    provider: "anthropic",
    modelSlug: "claude-sonnet-4-6",
    tokensUsed: 150,
    estimatedCostUsd: 0.0005,
  },
};

const TASK_SPAN: TaskTraceSpan = {
  spanId: "bbbb2222bbbb2222",
  parentSpanId: "aaaa1111aaaa1111",
  name: "task.bash_run",
  type: "task",
  status: "completed",
  startTime: 1100,
  endTime: 1300,
  metadata: {
    taskId: "task-1",
  },
};

const WORKSPACE: WorkspaceRow = {
  id: "ws-1",
  projectId: "proj-1",
  name: "ws-1",
  type: "git",
  path: "/tmp/ws-1",
  branch: "main",
  status: "active",
  lastSyncAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ownerId: null,
  indexStatus: "idle",
} as unknown as WorkspaceRow;

const SAMPLE_TASK_TRACE: TaskTraceRow = {
  id: "tt-1",
  groupId: "run-test-ws-1",
  iterationId: null,
  traceId: "cafebabe00000000cafebabecafebabe",
  rootSpan: LLM_SPAN,
  spans: [LLM_SPAN, TASK_SPAN],
  totalDurationMs: 1500,
  totalTokens: 150,
  totalCostUsd: 0.0005,
  createdAt: new Date("2026-01-01T00:01:00Z"),
  updatedAt: new Date("2026-01-01T00:01:00Z"),
} as unknown as TaskTraceRow;

// ─── Mock storage ─────────────────────────────────────────────────────────────

function makeMockStorage(overrides: Partial<IStorage> = {}): IStorage {
  return {
    getWorkspace: vi.fn().mockResolvedValue(WORKSPACE),
    getWorkspaceTaskTraces: vi.fn().mockResolvedValue([SAMPLE_TASK_TRACE]),
    getWorkspaceTaskTraceByGroupId: vi.fn().mockResolvedValue(SAMPLE_TASK_TRACE),
    ...overrides,
  } as unknown as IStorage;
}

function makeApp(storage: IStorage) {
  const app = express();
  app.use(express.json());
  registerWorkspaceTraceRoutes(app, storage);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/workspaces/:id/traces", () => {
  let app: ReturnType<typeof express>;
  let storage: IStorage;

  beforeEach(() => {
    storage = makeMockStorage();
    app = makeApp(storage);
  });

  it("1. returns 200 with traces array", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.traces)).toBe(true);
  });

  it("2. each trace summary has required fields", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces");
    const summary = res.body.traces[0];
    expect(summary).toHaveProperty("traceId");
    expect(summary).toHaveProperty("runId");
    expect(summary).toHaveProperty("spanCount");
    expect(summary).toHaveProperty("startTime");
    expect(summary).toHaveProperty("endTime");
    expect(summary).toHaveProperty("totalTokens");
    expect(summary).toHaveProperty("costUsd");
    expect(summary).toHaveProperty("provider");
    expect(summary).toHaveProperty("model");
  });

  it("3. spanCount matches number of spans in the trace", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces");
    expect(res.body.traces[0].spanCount).toBe(2);
  });

  it("4. aggregates totalTokens from LLM spans", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces");
    expect(res.body.traces[0].totalTokens).toBe(150);
  });

  it("5. aggregates costUsd from LLM spans", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces");
    expect(res.body.traces[0].costUsd).toBeCloseTo(0.0005, 6);
  });

  it("6. provider is the most common llm.provider value", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces");
    expect(res.body.traces[0].provider).toBe("anthropic");
  });

  it("7. model is the most common llm.model value", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces");
    expect(res.body.traces[0].model).toBe("claude-sonnet-4-6");
  });

  it("8. returns 200 with empty traces when storage returns []", async () => {
    storage = makeMockStorage({ getWorkspaceTaskTraces: vi.fn().mockResolvedValue([]) });
    app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/ws-1/traces");
    expect(res.status).toBe(200);
    expect(res.body.traces).toHaveLength(0);
  });

  it("9. filters by runId query param", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces?runId=run-test-ws-1");
    expect(res.status).toBe(200);
    expect(res.body.traces[0].runId).toBe("run-test-ws-1");
  });

  it("10. returns 500 when storage throws", async () => {
    storage = makeMockStorage({ getWorkspaceTaskTraces: vi.fn().mockRejectedValue(new Error("DB error")) });
    app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/ws-1/traces");
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });

  it("11. respects limit query param", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces?limit=1");
    expect(res.status).toBe(200);
  });

  it("12. returns 400 for invalid limit", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces?limit=abc");
    expect(res.status).toBe(400);
  });

  it("13. returns 404 when the workspace does not exist / does not belong to caller's project", async () => {
    storage = makeMockStorage({ getWorkspace: vi.fn().mockResolvedValue(null) });
    app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/no-such-ws/traces");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("14. foreign-workspace request: getWorkspaceTaskTraces is called with the requested workspace id (no cross-workspace leakage)", async () => {
    const getWorkspaceTaskTraces = vi.fn().mockResolvedValue([]);
    storage = makeMockStorage({ getWorkspaceTaskTraces });
    app = makeApp(storage);
    await request(app).get("/api/workspaces/ws-other/traces");
    expect(getWorkspaceTaskTraces).toHaveBeenCalledWith("ws-other", expect.any(Number), expect.any(Number));
  });
});

describe("GET /api/workspaces/:id/traces/:run_id", () => {
  let app: ReturnType<typeof express>;
  let storage: IStorage;

  beforeEach(() => {
    storage = makeMockStorage();
    app = makeApp(storage);
  });

  it("15. returns 200 with full trace detail including spans", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces/run-test-ws-1");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.spans)).toBe(true);
    expect(res.body.spans).toHaveLength(2);
  });

  it("16. trace detail has all WorkspaceTraceSummary fields plus spans", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces/run-test-ws-1");
    expect(res.body).toHaveProperty("traceId");
    expect(res.body).toHaveProperty("runId");
    expect(res.body).toHaveProperty("spanCount");
    expect(res.body).toHaveProperty("spans");
    expect(res.body).toHaveProperty("totalTokens");
    expect(res.body).toHaveProperty("costUsd");
  });

  it("17. returns 404 when trace not found", async () => {
    storage = makeMockStorage({ getWorkspaceTaskTraceByGroupId: vi.fn().mockResolvedValue(null) });
    app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/ws-1/traces/no-such-run");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("18. returns 404 when the workspace itself does not exist / belong to caller's project", async () => {
    storage = makeMockStorage({ getWorkspace: vi.fn().mockResolvedValue(null) });
    app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/no-such-ws/traces/run-test-ws-1");
    expect(res.status).toBe(404);
  });

  it("19. foreign workspace requesting a real run_id from another workspace gets nothing (IDOR closure)", async () => {
    // Simulates storage correctly scoping: the group exists but has no task
    // recorded against THIS workspace, so getWorkspaceTaskTraceByGroupId
    // (which itself does the workspace-membership check) returns null.
    const getWorkspaceTaskTraceByGroupId = vi.fn().mockResolvedValue(null);
    storage = makeMockStorage({ getWorkspaceTaskTraceByGroupId });
    app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/ws-foreign/traces/run-test-ws-1");
    expect(res.status).toBe(404);
    expect(getWorkspaceTaskTraceByGroupId).toHaveBeenCalledWith("ws-foreign", "run-test-ws-1");
  });

  it("20. returns 500 when storage throws", async () => {
    storage = makeMockStorage({ getWorkspaceTaskTraceByGroupId: vi.fn().mockRejectedValue(new Error("DB error")) });
    app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/ws-1/traces/run-test-ws-1");
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });

  it("21. span parent-child relationship is preserved in response", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces/run-test-ws-1");
    const taskSpan = res.body.spans.find((s: { name: string }) => s.name === "task.bash_run");
    expect(taskSpan).toBeDefined();
    expect(taskSpan.parentSpanId).toBe("aaaa1111aaaa1111");
  });

  it("22. span attributes include OpenInference conventions adapted from task-tracer metadata", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces/run-test-ws-1");
    const llmSpan = res.body.spans.find((s: { name: string }) => s.name.startsWith("llm."));
    expect(llmSpan).toBeDefined();
    expect(llmSpan.attributes["openinference.span.kind"]).toBe("LLM");
    expect(llmSpan.attributes["llm.provider"]).toBe("anthropic");
    expect(llmSpan.attributes["llm.model"]).toBe("claude-sonnet-4-6");
  });
});
