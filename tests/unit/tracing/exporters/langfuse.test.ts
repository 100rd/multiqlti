import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PipelineTrace, TraceSpan } from "../../../../shared/types.js";
import {
  OI,
  OI_SPAN_KIND,
} from "../../../../server/tracing/openinference.js";

// ─── Sample trace fixture ─────────────────────────────────────────────────────

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
    [OI.LLM_INPUT_VALUE]: "What is 2+2?",
    [OI.LLM_OUTPUT_VALUE]: "4",
    [OI.LLM_PROMPT_TOKENS]: 10,
    [OI.LLM_COMPLETION_TOKENS]: 5,
    [OI.LLM_TOTAL_TOKENS]: 15,
    [OI.LLM_COST_USD]: 0.000045,
    [OI.LLM_TEMPERATURE]: 0.7,
    [OI.LLM_MAX_TOKENS]: 2048,
    [OI.STAGE_ID]: "planning",
    [OI.PIPELINE_RUN_ID]: "run-test-1",
  },
  events: [],
};

const TOOL_SPAN: TraceSpan = {
  spanId: "bbbb2222bbbb2222",
  parentSpanId: "aaaa1111aaaa1111",
  name: "tool.bash_run",
  startTime: 1200,
  endTime: 1400,
  status: "ok",
  attributes: {
    "openinference.span.kind": OI_SPAN_KIND.TOOL,
    [OI.TOOL_NAME]: "bash_run",
    [OI.TOOL_ARGS]: "[REDACTED]",
    [OI.TOOL_RESULT]: "[REDACTED]",
    [OI.PIPELINE_RUN_ID]: "run-test-1",
  },
  events: [],
};

const SAMPLE_TRACE: PipelineTrace = {
  traceId: "cafebabecafebabe00000000cafebabe",
  runId: "run-test-1",
  spans: [LLM_SPAN, TOOL_SPAN],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Langfuse exporter", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("1. exportToLangfuse — no-op if baseUrl missing", async () => {
    const { exportToLangfuse } = await import("../../../../server/tracing/exporters/langfuse.js");
    await exportToLangfuse(SAMPLE_TRACE, { baseUrl: "", publicKey: "pk", secretKey: "sk" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("2. exportToLangfuse — no-op if publicKey missing", async () => {
    const { exportToLangfuse } = await import("../../../../server/tracing/exporters/langfuse.js?v=2");
    await exportToLangfuse(SAMPLE_TRACE, { baseUrl: "http://lf:3000", publicKey: "", secretKey: "sk" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("3. exportToLangfuse — calls /api/public/otel/v1/traces by default", async () => {
    const { exportToLangfuse } = await import("../../../../server/tracing/exporters/langfuse.js?v=3");
    await exportToLangfuse(SAMPLE_TRACE, {
      baseUrl: "http://lf:3000",
      publicKey: "pk-test",
      secretKey: "sk-test",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://lf:3000/api/public/otel/v1/traces",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("4. exportToLangfuse — uses Basic auth with base64(pk:sk)", async () => {
    const { exportToLangfuse } = await import("../../../../server/tracing/exporters/langfuse.js?v=4");
    await exportToLangfuse(SAMPLE_TRACE, {
      baseUrl: "http://lf:3000",
      publicKey: "my-pk",
      secretKey: "my-sk",
    });
    const [, opts] = mockFetch.mock.calls[0];
    const authHeader = (opts.headers as Record<string, string>)["Authorization"];
    const expected = "Basic " + Buffer.from("my-pk:my-sk").toString("base64");
    expect(authHeader).toBe(expected);
  });

  it("5. buildLangfuseSpan — LLM span has type=GENERATION", async () => {
    const { buildLangfuseSpan } = await import("../../../../server/tracing/exporters/langfuse.js?v=5");
    const result = buildLangfuseSpan(LLM_SPAN, SAMPLE_TRACE.traceId);
    expect(result.type).toBe("GENERATION");
  });

  it("6. buildLangfuseSpan — tool span has type=SPAN", async () => {
    const { buildLangfuseSpan } = await import("../../../../server/tracing/exporters/langfuse.js?v=6");
    const result = buildLangfuseSpan(TOOL_SPAN, SAMPLE_TRACE.traceId);
    expect(result.type).toBe("SPAN");
  });

  it("7. buildLangfuseSpan — GENERATION span has model field", async () => {
    const { buildLangfuseSpan } = await import("../../../../server/tracing/exporters/langfuse.js?v=7");
    const result = buildLangfuseSpan(LLM_SPAN, SAMPLE_TRACE.traceId);
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("8. buildLangfuseSpan — GENERATION span has usage with correct token counts", async () => {
    const { buildLangfuseSpan } = await import("../../../../server/tracing/exporters/langfuse.js?v=8");
    const result = buildLangfuseSpan(LLM_SPAN, SAMPLE_TRACE.traceId);
    expect(result.usage?.promptTokens).toBe(10);
    expect(result.usage?.completionTokens).toBe(5);
    expect(result.usage?.totalTokens).toBe(15);
  });

  it("9. buildLangfuseSpan — GENERATION span has costUsd", async () => {
    const { buildLangfuseSpan } = await import("../../../../server/tracing/exporters/langfuse.js?v=9");
    const result = buildLangfuseSpan(LLM_SPAN, SAMPLE_TRACE.traceId);
    expect(result.costUsd).toBeCloseTo(0.000045, 8);
  });

  it("10. buildLangfuseSpan — span has parentObservationId set from parentSpanId", async () => {
    const { buildLangfuseSpan } = await import("../../../../server/tracing/exporters/langfuse.js?v=10");
    const result = buildLangfuseSpan(TOOL_SPAN, SAMPLE_TRACE.traceId);
    expect(result.parentObservationId).toBe("aaaa1111aaaa1111");
  });

  it("11. buildLangfuseSpan — statusCode=SUCCESS when span.status=ok", async () => {
    const { buildLangfuseSpan } = await import("../../../../server/tracing/exporters/langfuse.js?v=11");
    const result = buildLangfuseSpan(LLM_SPAN, SAMPLE_TRACE.traceId);
    expect(result.statusCode).toBe("SUCCESS");
  });

  it("12. buildLangfuseSpan — statusCode=ERROR when span.status=error", async () => {
    const { buildLangfuseSpan } = await import("../../../../server/tracing/exporters/langfuse.js?v=12");
    const errSpan: TraceSpan = { ...LLM_SPAN, status: "error" };
    const result = buildLangfuseSpan(errSpan, SAMPLE_TRACE.traceId);
    expect(result.statusCode).toBe("ERROR");
  });

  it("13. buildIngestionPayload — batch has one entry per span", async () => {
    const { buildIngestionPayload } = await import("../../../../server/tracing/exporters/langfuse.js?v=13");
    const payload = buildIngestionPayload(SAMPLE_TRACE);
    expect(payload.batch).toHaveLength(2);
  });

  it("14. buildIngestionPayload — each entry has type=observation-create", async () => {
    const { buildIngestionPayload } = await import("../../../../server/tracing/exporters/langfuse.js?v=14");
    const payload = buildIngestionPayload(SAMPLE_TRACE);
    for (const entry of payload.batch) {
      expect(entry.type).toBe("observation-create");
    }
  });

  it("15. exportToLangfuse swallows fetch errors — does not throw", async () => {
    const { exportToLangfuse } = await import("../../../../server/tracing/exporters/langfuse.js?v=15");
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    await expect(exportToLangfuse(SAMPLE_TRACE, {
      baseUrl: "http://lf:3000",
      publicKey: "pk",
      secretKey: "sk",
    })).resolves.toBeUndefined();
  });

  it("16. langfuseConfigFromEnv — returns null when env vars not set", async () => {
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    const { langfuseConfigFromEnv } = await import("../../../../server/tracing/exporters/langfuse.js?v=16");
    expect(langfuseConfigFromEnv()).toBeNull();
  });

  it("17. langfuseConfigFromEnv — returns config when env vars are set", async () => {
    vi.stubEnv("LANGFUSE_BASE_URL", "http://lf:3000");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-env");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-env");
    const { langfuseConfigFromEnv } = await import("../../../../server/tracing/exporters/langfuse.js?v=17");
    const config = langfuseConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.baseUrl).toBe("http://lf:3000");
    expect(config!.publicKey).toBe("pk-env");
  });

  it("18. buildLangfuseSpan — input and output set for GENERATION spans", async () => {
    const { buildLangfuseSpan } = await import("../../../../server/tracing/exporters/langfuse.js?v=18");
    const result = buildLangfuseSpan(LLM_SPAN, SAMPLE_TRACE.traceId);
    expect(result.input).toBe("What is 2+2?");
    expect(result.output).toBe("4");
  });

  it("19. buildLangfuseSpan — modelParameters include temperature and max_tokens", async () => {
    const { buildLangfuseSpan } = await import("../../../../server/tracing/exporters/langfuse.js?v=19");
    const result = buildLangfuseSpan(LLM_SPAN, SAMPLE_TRACE.traceId);
    expect(result.modelParameters?.temperature).toBe(0.7);
    expect(result.modelParameters?.max_tokens).toBe(2048);
  });
});
