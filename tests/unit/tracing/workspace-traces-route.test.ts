import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { IStorage } from "../../../server/storage.js";
import { registerWorkspaceTraceRoutes } from "../../../server/routes/workspace-traces.js";
import type { TraceSpan } from "../../../shared/types.js";
import { OI, OI_SPAN_KIND } from "../../../server/tracing/openinference.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const LLM_SPAN: TraceSpan = {
  spanId: "aaaa1111aaaa1111",
  name: "llm.claude-sonnet-4-6",
  startTime: 1000,
  endTime: 2500,
  status: "ok",
  attributes: {
    "openinference.span.kind": OI_SPAN_KIND.LLM,
    [OI.LLM_PROVIDER]: "anthropic",
    [OI.LLM_MODEL]: "claude-sonnet-4-6",
    [OI.LLM_TOTAL_TOKENS]: 150,
    [OI.LLM_COST_USD]: 0.0005,
  },
  events: [],
};

const TOOL_SPAN: TraceSpan = {
  spanId: "bbbb2222bbbb2222",
  parentSpanId: "aaaa1111aaaa1111",
  name: "tool.bash_run",
  startTime: 1100,
  endTime: 1300,
  status: "ok",
  attributes: {
    "openinference.span.kind": OI_SPAN_KIND.TOOL,
    [OI.TOOL_NAME]: "bash_run",
  },
  events: [],
};

const SAMPLE_TRACE = {
  traceId: "cafebabe00000000cafebabecafebabe",
  runId: "run-test-ws-1",
  spans: [LLM_SPAN, TOOL_SPAN],
};

// ─── Mock storage ─────────────────────────────────────────────────────────────

function makeMockStorage(overrides: Partial<IStorage> = {}): IStorage {
  return {
    getTraceByRunId: vi.fn().mockResolvedValue(SAMPLE_TRACE),
    getTraces: vi.fn().mockResolvedValue([SAMPLE_TRACE]),
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
    storage = makeMockStorage({ getTraces: vi.fn().mockResolvedValue([]) });
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
    storage = makeMockStorage({ getTraces: vi.fn().mockRejectedValue(new Error("DB error")) });
    app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/ws-1/traces");
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });

  it("11. respects limit query param", async () => {
    // Storage returns 1 item but we verify limit is parsed correctly
    const res = await request(app).get("/api/workspaces/ws-1/traces?limit=1");
    expect(res.status).toBe(200);
  });

  it("12. returns 400 for invalid limit", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces?limit=abc");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/workspaces/:id/traces/:run_id", () => {
  let app: ReturnType<typeof express>;
  let storage: IStorage;

  beforeEach(() => {
    storage = makeMockStorage();
    app = makeApp(storage);
  });

  it("13. returns 200 with full trace detail including spans", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces/run-test-ws-1");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.spans)).toBe(true);
    expect(res.body.spans).toHaveLength(2);
  });

  it("14. trace detail has all WorkspaceTraceSummary fields plus spans", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces/run-test-ws-1");
    expect(res.body).toHaveProperty("traceId");
    expect(res.body).toHaveProperty("runId");
    expect(res.body).toHaveProperty("spanCount");
    expect(res.body).toHaveProperty("spans");
    expect(res.body).toHaveProperty("totalTokens");
    expect(res.body).toHaveProperty("costUsd");
  });

  it("15. returns 404 when trace not found", async () => {
    storage = makeMockStorage({ getTraceByRunId: vi.fn().mockResolvedValue(null) });
    app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/ws-1/traces/no-such-run");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("16. returns 500 when storage throws", async () => {
    storage = makeMockStorage({ getTraceByRunId: vi.fn().mockRejectedValue(new Error("DB error")) });
    app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/ws-1/traces/run-test-ws-1");
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });

  it("17. span parent-child relationship is preserved in response", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces/run-test-ws-1");
    const toolSpan = res.body.spans.find((s: TraceSpan) => s.name === "tool.bash_run");
    expect(toolSpan).toBeDefined();
    expect(toolSpan.parentSpanId).toBe("aaaa1111aaaa1111");
  });

  it("18. span attributes include OpenInference conventions", async () => {
    const res = await request(app).get("/api/workspaces/ws-1/traces/run-test-ws-1");
    const llmSpan = res.body.spans.find((s: TraceSpan) => s.name.startsWith("llm."));
    expect(llmSpan).toBeDefined();
    expect(llmSpan.attributes["openinference.span.kind"]).toBe("LLM");
    expect(llmSpan.attributes[OI.LLM_PROVIDER]).toBe("anthropic");
    expect(llmSpan.attributes[OI.LLM_MODEL]).toBe("claude-sonnet-4-6");
  });
});
