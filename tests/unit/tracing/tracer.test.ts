import { describe, it, expect, vi } from "vitest";
import { Tracer } from "../../../server/tracing/tracer.js";
import type { IStorage } from "../../../server/storage.js";

function makeMockStorage(): IStorage {
  return {
    createTrace: vi.fn().mockResolvedValue({}),
    getTraceByRunId: vi.fn().mockResolvedValue(null),
    getTraceByTraceId: vi.fn().mockResolvedValue(null),
    getTraces: vi.fn().mockResolvedValue([]),
    updateTraceSpans: vi.fn().mockResolvedValue(undefined),
    // Stub the rest of IStorage to satisfy type
    getUser: vi.fn(),
    getUserByEmail: vi.fn(),
    createUser: vi.fn(),
    getModels: vi.fn(),
    getActiveModels: vi.fn(),
    getModelBySlug: vi.fn(),
    createModel: vi.fn(),
    updateModel: vi.fn(),
    deleteModel: vi.fn(),
    getPipelines: vi.fn(),
    getPipeline: vi.fn(),
    getTemplates: vi.fn(),
    createPipeline: vi.fn(),
    updatePipeline: vi.fn(),
    deletePipeline: vi.fn(),
    getPipelineRuns: vi.fn(),
    getPipelineRun: vi.fn(),
    createPipelineRun: vi.fn(),
    updatePipelineRun: vi.fn(),
    getStageExecutions: vi.fn(),
    getStageExecution: vi.fn(),
    createStageExecution: vi.fn(),
    updateStageExecution: vi.fn(),
    getQuestions: vi.fn(),
    getPendingQuestions: vi.fn(),
    getQuestion: vi.fn(),
    createQuestion: vi.fn(),
    answerQuestion: vi.fn(),
    dismissQuestion: vi.fn(),
    getChatMessages: vi.fn(),
    createChatMessage: vi.fn(),
    createLlmRequest: vi.fn(),
    getLlmRequests: vi.fn(),
    getLlmRequestById: vi.fn(),
    getLlmRequestStats: vi.fn(),
    getLlmStatsByModel: vi.fn(),
    getLlmStatsByProvider: vi.fn(),
    getLlmStatsByTeam: vi.fn(),
    getLlmTimeline: vi.fn(),
    getMemories: vi.fn(),
    searchMemories: vi.fn(),
    upsertMemory: vi.fn(),
    deleteMemory: vi.fn(),
    decayMemories: vi.fn(),
    deleteStaleMemories: vi.fn(),
    getMcpServers: vi.fn(),
    getMcpServer: vi.fn(),
    createMcpServer: vi.fn(),
    updateMcpServer: vi.fn(),
    deleteMcpServer: vi.fn(),
    createDelegationRequest: vi.fn(),
    getDelegationRequests: vi.fn(),
    updateDelegationRequest: vi.fn(),
    getSpecializationProfiles: vi.fn(),
    createSpecializationProfile: vi.fn(),
    deleteSpecializationProfile: vi.fn(),
    getSkills: vi.fn(),
    getSkill: vi.fn(),
    createSkill: vi.fn(),
    updateSkill: vi.fn(),
    deleteSkill: vi.fn(),
    getTriggers: vi.fn(),
    getTrigger: vi.fn(),
    getEnabledTriggersByType: vi.fn(),
    createTrigger: vi.fn(),
    updateTrigger: vi.fn(),
    deleteTrigger: vi.fn(),
  } as unknown as IStorage;
}

describe("Tracer", () => {
  it("1. startTrace returns a 32-char hex string", () => {
    const tracer = new Tracer();
    const traceId = tracer.startTrace("run-1");
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("2. startTrace is idempotent — second call returns same traceId", () => {
    const tracer = new Tracer();
    const id1 = tracer.startTrace("run-1");
    const id2 = tracer.startTrace("run-1");
    expect(id1).toBe(id2);
  });

  it("3. startSpan returns a 16-char hex string", () => {
    const tracer = new Tracer();
    const traceId = tracer.startTrace("run-1");
    const spanId = tracer.startSpan(traceId, "my.span");
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("4. startSpan with parentSpanId stores parentSpanId on span", () => {
    const tracer = new Tracer();
    const traceId = tracer.startTrace("run-1");
    const parentId = tracer.startSpan(traceId, "parent.span");
    const childId = tracer.startSpan(traceId, "child.span", parentId);
    const trace = tracer.getTrace(traceId)!;
    const child = trace.spans.find((s) => s.spanId === childId);
    expect(child?.parentSpanId).toBe(parentId);
  });

  it("5. endSpan sets endTime, status=ok, and attributes", () => {
    const tracer = new Tracer();
    const traceId = tracer.startTrace("run-1");
    const spanId = tracer.startSpan(traceId, "my.span");
    const before = Date.now();
    tracer.endSpan(spanId, "ok", { teamId: "planning", tokensUsed: 42 });
    const trace = tracer.getTrace(traceId)!;
    const span = trace.spans.find((s) => s.spanId === spanId)!;
    expect(span.status).toBe("ok");
    expect(span.endTime).toBeGreaterThanOrEqual(before);
    expect(span.attributes.teamId).toBe("planning");
    expect(span.attributes.tokensUsed).toBe(42);
  });

  it("6. endSpan with status=error sets status correctly", () => {
    const tracer = new Tracer();
    const traceId = tracer.startTrace("run-1");
    const spanId = tracer.startSpan(traceId, "failing.span");
    tracer.endSpan(spanId, "error", { errorMessage: "boom" });
    const trace = tracer.getTrace(traceId)!;
    const span = trace.spans.find((s) => s.spanId === spanId)!;
    expect(span.status).toBe("error");
    expect(span.attributes.errorMessage).toBe("boom");
  });

  it("7. addSpanEvent appends to span events", () => {
    const tracer = new Tracer();
    const traceId = tracer.startTrace("run-1");
    const spanId = tracer.startSpan(traceId, "my.span");
    tracer.addSpanEvent(spanId, "cache.hit", { key: "abc" });
    // Must look up before endSpan removes from index
    const trace = tracer.getTrace(traceId)!;
    const span = trace.spans.find((s) => s.spanId === spanId)!;
    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe("cache.hit");
    expect(span.events[0].attributes?.key).toBe("abc");
  });

  it("8. getTrace returns PipelineTrace with spans sorted by startTime", () => {
    const tracer = new Tracer();
    const traceId = tracer.startTrace("run-1");
    const s1 = tracer.startSpan(traceId, "first");
    const s2 = tracer.startSpan(traceId, "second");
    tracer.endSpan(s1, "ok");
    tracer.endSpan(s2, "ok");
    const trace = tracer.getTrace(traceId)!;
    expect(trace.traceId).toBe(traceId);
    expect(trace.runId).toBe("run-1");
    expect(trace.spans.length).toBeGreaterThanOrEqual(2);
    // spans sorted by startTime ascending
    for (let i = 1; i < trace.spans.length; i++) {
      expect(trace.spans[i].startTime).toBeGreaterThanOrEqual(trace.spans[i - 1].startTime);
    }
  });

  it("9. getTrace returns null for unknown traceId", () => {
    const tracer = new Tracer();
    expect(tracer.getTrace("deadbeefdeadbeefdeadbeefdeadbeef")).toBeNull();
  });

  it("10. parent-child relationship is preserved in getTrace output", () => {
    const tracer = new Tracer();
    const traceId = tracer.startTrace("run-1");
    const parentId = tracer.startSpan(traceId, "parent");
    const childId = tracer.startSpan(traceId, "child", parentId);
    const trace = tracer.getTrace(traceId)!;
    const parent = trace.spans.find((s) => s.spanId === parentId)!;
    const child = trace.spans.find((s) => s.spanId === childId)!;
    expect(parent.parentSpanId).toBeUndefined();
    expect(child.parentSpanId).toBe(parentId);
  });

  it("11. getActiveTraceId returns traceId before flush, undefined after flush", async () => {
    const tracer = new Tracer();
    const mockStorage = makeMockStorage();
    const traceId = tracer.startTrace("run-1");
    expect(tracer.getActiveTraceId("run-1")).toBe(traceId);
    await tracer.flushTrace(traceId, mockStorage);
    expect(tracer.getActiveTraceId("run-1")).toBeUndefined();
  });

  it("12. flushTrace calls storage.createTrace with correct data", async () => {
    const tracer = new Tracer();
    const mockStorage = makeMockStorage();
    const traceId = tracer.startTrace("run-2");
    const spanId = tracer.startSpan(traceId, "my.span");
    tracer.endSpan(spanId, "ok");
    await tracer.flushTrace(traceId, mockStorage);
    expect(mockStorage.createTrace).toHaveBeenCalledWith(
      expect.objectContaining({ traceId, runId: "run-2" }),
    );
  });

  it("13. flushTrace clears active trace (subsequent getActiveTraceId returns undefined)", async () => {
    const tracer = new Tracer();
    const mockStorage = makeMockStorage();
    const traceId = tracer.startTrace("run-3");
    await tracer.flushTrace(traceId, mockStorage);
    expect(tracer.getActiveTraceId("run-3")).toBeUndefined();
    expect(tracer.getTrace(traceId)).toBeNull();
  });

  it("14. flushTrace swallows storage errors — does not throw", async () => {
    const tracer = new Tracer();
    const mockStorage = makeMockStorage();
    (mockStorage.createTrace as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DB error"));
    const traceId = tracer.startTrace("run-4");
    await expect(tracer.flushTrace(traceId, mockStorage)).resolves.toBeUndefined();
  });
});
