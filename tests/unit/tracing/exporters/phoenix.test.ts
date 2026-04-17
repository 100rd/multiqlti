import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PipelineTrace, TraceSpan } from "../../../../shared/types.js";
import { OI, OI_SPAN_KIND } from "../../../../server/tracing/openinference.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const LLM_SPAN: TraceSpan = {
  spanId: "cccc3333cccc3333",
  name: "llm.gpt-4o",
  startTime: 1000,
  endTime: 2000,
  status: "ok",
  attributes: {
    "openinference.span.kind": OI_SPAN_KIND.LLM,
    [OI.LLM_PROVIDER]: "openai",
    [OI.LLM_MODEL]: "gpt-4o",
    [OI.LLM_TOTAL_TOKENS]: 200,
    [OI.LLM_COST_USD]: 0.001,
  },
  events: [],
};

const TOOL_SPAN: TraceSpan = {
  spanId: "dddd4444dddd4444",
  parentSpanId: "cccc3333cccc3333",
  name: "tool.search",
  startTime: 1100,
  endTime: 1300,
  status: "ok",
  attributes: {
    "openinference.span.kind": OI_SPAN_KIND.TOOL,
    [OI.TOOL_NAME]: "web_search",
    [OI.TOOL_ARGS]: "[REDACTED]",
  },
  events: [],
};

const SAMPLE_TRACE: PipelineTrace = {
  traceId: "deadbeefdeadbeef00000000deadbeef",
  runId: "run-phoenix-1",
  spans: [LLM_SPAN, TOOL_SPAN],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Phoenix exporter", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("1. exportToPhoenix — no-op if baseUrl is empty", async () => {
    const { exportToPhoenix } = await import("../../../../server/tracing/exporters/phoenix.js");
    await exportToPhoenix(SAMPLE_TRACE, { baseUrl: "" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("2. exportToPhoenix — posts to /v1/traces", async () => {
    const { exportToPhoenix } = await import("../../../../server/tracing/exporters/phoenix.js?v=2");
    await exportToPhoenix(SAMPLE_TRACE, { baseUrl: "http://phoenix:6006" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://phoenix:6006/v1/traces",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("3. exportToPhoenix — sends api_key header when configured", async () => {
    const { exportToPhoenix } = await import("../../../../server/tracing/exporters/phoenix.js?v=3");
    await exportToPhoenix(SAMPLE_TRACE, { baseUrl: "http://phoenix:6006", apiKey: "my-api-key" });
    const [, opts] = mockFetch.mock.calls[0];
    expect((opts.headers as Record<string, string>)["api_key"]).toBe("my-api-key");
  });

  it("4. buildOtlpPayload — has resourceSpans with correct service.name", async () => {
    const { buildOtlpPayload } = await import("../../../../server/tracing/exporters/phoenix.js?v=4");
    const payload = buildOtlpPayload(SAMPLE_TRACE) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: unknown }> };
        scopeSpans: Array<{ spans: unknown[] }>;
      }>;
    };
    const serviceAttr = payload.resourceSpans[0].resource.attributes.find(
      (a) => a.key === "service.name",
    );
    expect((serviceAttr?.value as { stringValue: string })?.stringValue).toBe("multiqlti");
  });

  it("5. buildOtlpPayload — has Phoenix project name resource attribute", async () => {
    const { buildOtlpPayload } = await import("../../../../server/tracing/exporters/phoenix.js?v=5");
    const payload = buildOtlpPayload(SAMPLE_TRACE) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: unknown }> };
        scopeSpans: never[];
      }>;
    };
    const projectAttr = payload.resourceSpans[0].resource.attributes.find(
      (a) => a.key === "openinference.project.name",
    );
    expect(projectAttr).toBeDefined();
  });

  it("6. buildOtlpPayload — scopeSpans contains all spans", async () => {
    const { buildOtlpPayload } = await import("../../../../server/tracing/exporters/phoenix.js?v=6");
    const payload = buildOtlpPayload(SAMPLE_TRACE) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>;
    };
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });

  it("7. buildOtlpSpan — LLM span has kind=3 (CLIENT)", async () => {
    const { buildOtlpSpan } = await import("../../../../server/tracing/exporters/phoenix.js?v=7");
    const span = buildOtlpSpan(LLM_SPAN, SAMPLE_TRACE.traceId) as { kind: number };
    expect(span.kind).toBe(3);
  });

  it("8. buildOtlpSpan — non-LLM span has kind=1 (INTERNAL)", async () => {
    const { buildOtlpSpan } = await import("../../../../server/tracing/exporters/phoenix.js?v=8");
    const span = buildOtlpSpan(TOOL_SPAN, SAMPLE_TRACE.traceId) as { kind: number };
    expect(span.kind).toBe(1);
  });

  it("9. buildOtlpSpan — startTimeUnixNano is ms * 1_000_000", async () => {
    const { buildOtlpSpan } = await import("../../../../server/tracing/exporters/phoenix.js?v=9");
    const span = buildOtlpSpan(LLM_SPAN, SAMPLE_TRACE.traceId) as { startTimeUnixNano: string };
    expect(span.startTimeUnixNano).toBe(String(1000 * 1_000_000));
  });

  it("10. buildOtlpSpan — attributes include openinference.span.kind", async () => {
    const { buildOtlpSpan } = await import("../../../../server/tracing/exporters/phoenix.js?v=10");
    const span = buildOtlpSpan(LLM_SPAN, SAMPLE_TRACE.traceId) as {
      attributes: Array<{ key: string; value: unknown }>;
    };
    const kindAttr = span.attributes.find((a) => a.key === "openinference.span.kind");
    expect((kindAttr?.value as { stringValue: string })?.stringValue).toBe("LLM");
  });

  it("11. buildOtlpSpan — parentSpanId set when span has parentSpanId", async () => {
    const { buildOtlpSpan } = await import("../../../../server/tracing/exporters/phoenix.js?v=11");
    const span = buildOtlpSpan(TOOL_SPAN, SAMPLE_TRACE.traceId) as { parentSpanId?: string };
    expect(span.parentSpanId).toBe("cccc3333cccc3333");
  });

  it("12. buildOtlpSpan — status code 1 for ok, 2 for error", async () => {
    const { buildOtlpSpan } = await import("../../../../server/tracing/exporters/phoenix.js?v=12");
    const okSpan = buildOtlpSpan(LLM_SPAN, SAMPLE_TRACE.traceId) as {
      status: { code: number };
    };
    expect(okSpan.status.code).toBe(1);

    const errSpan = buildOtlpSpan(
      { ...LLM_SPAN, status: "error" },
      SAMPLE_TRACE.traceId,
    ) as { status: { code: number } };
    expect(errSpan.status.code).toBe(2);
  });

  it("13. exportToPhoenix swallows errors — does not throw", async () => {
    const { exportToPhoenix } = await import("../../../../server/tracing/exporters/phoenix.js?v=13");
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));
    await expect(exportToPhoenix(SAMPLE_TRACE, { baseUrl: "http://phoenix:6006" })).resolves.toBeUndefined();
  });

  it("14. phoenixConfigFromEnv — returns null when PHOENIX_BASE_URL not set", async () => {
    vi.stubEnv("PHOENIX_BASE_URL", "");
    const { phoenixConfigFromEnv } = await import("../../../../server/tracing/exporters/phoenix.js?v=14");
    expect(phoenixConfigFromEnv()).toBeNull();
  });

  it("15. phoenixConfigFromEnv — returns config when PHOENIX_BASE_URL set", async () => {
    vi.stubEnv("PHOENIX_BASE_URL", "http://phoenix:6006");
    vi.stubEnv("PHOENIX_API_KEY", "my-key");
    const { phoenixConfigFromEnv } = await import("../../../../server/tracing/exporters/phoenix.js?v=15");
    const config = phoenixConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.baseUrl).toBe("http://phoenix:6006");
    expect(config!.apiKey).toBe("my-key");
  });

  it("16. buildAttr — integer value uses intValue", async () => {
    const { buildAttr } = await import("../../../../server/tracing/exporters/phoenix.js?v=16");
    const result = buildAttr("my.key", 42) as { key: string; value: { intValue: number } };
    expect(result.key).toBe("my.key");
    expect(result.value.intValue).toBe(42);
  });

  it("17. buildAttr — float value uses doubleValue", async () => {
    const { buildAttr } = await import("../../../../server/tracing/exporters/phoenix.js?v=17");
    const result = buildAttr("temp", 0.7) as { key: string; value: { doubleValue: number } };
    expect(result.value.doubleValue).toBeCloseTo(0.7, 6);
  });

  it("18. buildAttr — string value uses stringValue", async () => {
    const { buildAttr } = await import("../../../../server/tracing/exporters/phoenix.js?v=18");
    const result = buildAttr("model", "gpt-4o") as { key: string; value: { stringValue: string } };
    expect(result.value.stringValue).toBe("gpt-4o");
  });
});
