import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PipelineTrace } from "../../../shared/types.js";

const SAMPLE_TRACE: PipelineTrace = {
  traceId: "abcdef1234567890abcdef1234567890",
  runId: "run-test-1",
  spans: [
    {
      spanId: "abcd1234abcd1234",
      name: "stage.execute",
      startTime: 1000,
      endTime: 2000,
      attributes: { teamId: "planning", tokensUsed: 42 },
      events: [{ name: "cache.hit", timestamp: 1500, attributes: { key: "abc" } }],
      status: "ok",
    },
    {
      spanId: "efgh5678efgh5678",
      parentSpanId: "abcd1234abcd1234",
      name: "gateway.anthropic.call",
      startTime: 1200,
      endTime: 1800,
      attributes: { model: "claude-sonnet-4-6", latencyMs: 600 },
      events: [],
      status: "ok",
    },
  ],
};

describe("OTLP Exporter", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("1. No-op when OTLP_ENDPOINT is not set — fetch is never called", async () => {
    vi.stubEnv("OTLP_ENDPOINT", "");
    const { exportTrace } = await import("../../../server/tracing/otlp-exporter.js");
    await exportTrace(SAMPLE_TRACE);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("2. Calls fetch with correct URL when OTLP_ENDPOINT is set", async () => {
    vi.stubEnv("OTLP_ENDPOINT", "http://jaeger:4318");
    const { exportTrace } = await import("../../../server/tracing/otlp-exporter.js?v=2");
    await exportTrace(SAMPLE_TRACE);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://jaeger:4318/v1/traces",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("3. Request body has correct OTLP JSON structure", async () => {
    vi.stubEnv("OTLP_ENDPOINT", "http://jaeger:4318");
    const { exportTrace } = await import("../../../server/tracing/otlp-exporter.js?v=3");
    await exportTrace(SAMPLE_TRACE);
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body).toHaveProperty("resourceSpans");
    expect(body.resourceSpans[0]).toHaveProperty("scopeSpans");
    expect(body.resourceSpans[0].scopeSpans[0]).toHaveProperty("spans");
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });

  it("4. Authorization: Bearer header is added when OTLP_API_KEY is set", async () => {
    vi.stubEnv("OTLP_ENDPOINT", "http://jaeger:4318");
    vi.stubEnv("OTLP_API_KEY", "my-secret-key");
    const { exportTrace } = await import("../../../server/tracing/otlp-exporter.js?v=4");
    await exportTrace(SAMPLE_TRACE);
    const [, options] = mockFetch.mock.calls[0];
    expect((options.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-secret-key");
  });

  it("5. OTLP_HEADERS JSON is merged into request headers", async () => {
    vi.stubEnv("OTLP_ENDPOINT", "http://jaeger:4318");
    vi.stubEnv("OTLP_HEADERS", JSON.stringify({ "X-Org": "acme", "X-Env": "prod" }));
    const { exportTrace } = await import("../../../server/tracing/otlp-exporter.js?v=5");
    await exportTrace(SAMPLE_TRACE);
    const [, options] = mockFetch.mock.calls[0];
    expect((options.headers as Record<string, string>)["X-Org"]).toBe("acme");
    expect((options.headers as Record<string, string>)["X-Env"]).toBe("prod");
  });

  it("6. TRACE_SAMPLE_RATE=0 — never calls fetch", async () => {
    vi.stubEnv("OTLP_ENDPOINT", "http://jaeger:4318");
    vi.stubEnv("TRACE_SAMPLE_RATE", "0");
    // Stub Math.random to return 0.5 > 0 so it always gets filtered
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { exportTrace } = await import("../../../server/tracing/otlp-exporter.js?v=6");
    await exportTrace(SAMPLE_TRACE);
    expect(mockFetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("7. TRACE_SAMPLE_RATE=1 — always calls fetch", async () => {
    vi.stubEnv("OTLP_ENDPOINT", "http://jaeger:4318");
    vi.stubEnv("TRACE_SAMPLE_RATE", "1");
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { exportTrace } = await import("../../../server/tracing/otlp-exporter.js?v=7");
    await exportTrace(SAMPLE_TRACE);
    expect(mockFetch).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("8. fetch throwing does not propagate — exportTrace resolves without throwing", async () => {
    vi.stubEnv("OTLP_ENDPOINT", "http://jaeger:4318");
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const { exportTrace } = await import("../../../server/tracing/otlp-exporter.js?v=8");
    await expect(exportTrace(SAMPLE_TRACE)).resolves.toBeUndefined();
  });

  it("9. HTTP 500 response from endpoint does not throw", async () => {
    vi.stubEnv("OTLP_ENDPOINT", "http://jaeger:4318");
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" });
    const { exportTrace } = await import("../../../server/tracing/otlp-exporter.js?v=9");
    await expect(exportTrace(SAMPLE_TRACE)).resolves.toBeUndefined();
  });

  it("10. startTimeUnixNano is span.startTime * 1_000_000 as string", async () => {
    vi.stubEnv("OTLP_ENDPOINT", "http://jaeger:4318");
    const { exportTrace } = await import("../../../server/tracing/otlp-exporter.js?v=10");
    await exportTrace(SAMPLE_TRACE);
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body as string);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.startTimeUnixNano).toBe(String(1000 * 1_000_000));
    expect(span.endTimeUnixNano).toBe(String(2000 * 1_000_000));
  });
});
