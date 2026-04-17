import { describe, it, expect } from "vitest";
import {
  LlmSpanEnricher,
  buildLlmSpanAttributes,
  buildToolCallAttributes,
} from "../../../server/tracing/llm-span.js";
import { Tracer } from "../../../server/tracing/tracer.js";
import {
  OI,
  OI_SPAN_KIND,
  REDACTED_PLACEHOLDER,
} from "../../../server/tracing/openinference.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEnricher(opts?: { storePrompts?: boolean; storeToolData?: boolean }) {
  const testTracer = new Tracer();
  const enricher = new LlmSpanEnricher(opts, testTracer);
  return { testTracer, enricher };
}

// ─── buildLlmSpanAttributes ───────────────────────────────────────────────────

describe("buildLlmSpanAttributes", () => {
  it("1. sets openinference.span.kind = LLM", () => {
    const attrs = buildLlmSpanAttributes({ modelSlug: "claude-sonnet-4-6" });
    expect(attrs["openinference.span.kind"]).toBe(OI_SPAN_KIND.LLM);
  });

  it("2. sets llm.provider = anthropic for claude-* models", () => {
    const attrs = buildLlmSpanAttributes({ modelSlug: "claude-sonnet-4-6" });
    expect(attrs[OI.LLM_PROVIDER]).toBe("anthropic");
  });

  it("3. sets llm.model to the provided slug", () => {
    const attrs = buildLlmSpanAttributes({ modelSlug: "gpt-4o-mini" });
    expect(attrs[OI.LLM_MODEL]).toBe("gpt-4o-mini");
  });

  it("4. redacts prompt when redactContent=true (default)", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      prompt: "What is the capital of France?",
    });
    expect(attrs[OI.LLM_INPUT_VALUE]).toBe(REDACTED_PLACEHOLDER);
  });

  it("5. stores prompt when redactContent=false", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      prompt: "What is the capital of France?",
      redactContent: false,
    });
    expect(attrs[OI.LLM_INPUT_VALUE]).toBe("What is the capital of France?");
  });

  it("6. redacts response when redactContent=true", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      response: "Paris",
      redactContent: true,
    });
    expect(attrs[OI.LLM_OUTPUT_VALUE]).toBe(REDACTED_PLACEHOLDER);
  });

  it("7. stores response when redactContent=false", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      response: "Paris",
      redactContent: false,
    });
    expect(attrs[OI.LLM_OUTPUT_VALUE]).toBe("Paris");
  });

  it("8. redacts system prompt when redactContent=true", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      systemPrompt: "You are a helpful assistant.",
      redactContent: true,
    });
    expect(attrs[OI.LLM_SYSTEM_PROMPT]).toBe(REDACTED_PLACEHOLDER);
  });

  it("9. sets token counts when totalTokens provided", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      promptTokens: 50,
      completionTokens: 100,
      totalTokens: 150,
    });
    expect(attrs[OI.LLM_PROMPT_TOKENS]).toBe(50);
    expect(attrs[OI.LLM_COMPLETION_TOKENS]).toBe(100);
    expect(attrs[OI.LLM_TOTAL_TOKENS]).toBe(150);
  });

  it("10. derives totalTokens from promptTokens + completionTokens if not provided", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      promptTokens: 50,
      completionTokens: 100,
    });
    expect(attrs[OI.LLM_TOTAL_TOKENS]).toBe(150);
  });

  it("11. sets llm.cost_usd for known models with non-zero tokens", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      totalTokens: 1_000_000,
    });
    expect(typeof attrs[OI.LLM_COST_USD]).toBe("number");
    expect((attrs[OI.LLM_COST_USD] as number)).toBeGreaterThan(0);
  });

  it("12. does not set cost_usd when totalTokens = 0", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      totalTokens: 0,
    });
    expect(attrs[OI.LLM_COST_USD]).toBeUndefined();
  });

  it("13. sets temperature and max_tokens when provided", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "gpt-4o",
      temperature: 0.7,
      maxTokens: 2048,
    });
    expect(attrs[OI.LLM_TEMPERATURE]).toBe(0.7);
    expect(attrs[OI.LLM_MAX_TOKENS]).toBe(2048);
  });

  it("14. sets stage.id and stage.role when provided", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      stageId: "planning",
      stageRole: "proposer",
    });
    expect(attrs[OI.STAGE_ID]).toBe("planning");
    expect(attrs[OI.STAGE_ROLE]).toBe("proposer");
  });

  it("15. sets pipeline.run_id when runId provided", () => {
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      runId: "run-abc-123",
    });
    expect(attrs[OI.PIPELINE_RUN_ID]).toBe("run-abc-123");
  });

  it("16. truncates very long prompts to avoid unbounded growth", () => {
    const longPrompt = "x".repeat(10_000);
    const attrs = buildLlmSpanAttributes({
      modelSlug: "claude-sonnet-4-6",
      prompt: longPrompt,
      redactContent: false,
    });
    const stored = attrs[OI.LLM_INPUT_VALUE] as string;
    expect(stored.length).toBeLessThanOrEqual(8_193);
  });
});

// ─── buildToolCallAttributes ──────────────────────────────────────────────────

describe("buildToolCallAttributes", () => {
  it("17. sets openinference.span.kind = TOOL", () => {
    const attrs = buildToolCallAttributes({ toolName: "read_file", toolArgs: { path: "/etc/hosts" } });
    expect(attrs["openinference.span.kind"]).toBe(OI_SPAN_KIND.TOOL);
  });

  it("18. sets tool.name", () => {
    const attrs = buildToolCallAttributes({ toolName: "bash", toolArgs: {} });
    expect(attrs[OI.TOOL_NAME]).toBe("bash");
  });

  it("19. redacts tool args by default", () => {
    const attrs = buildToolCallAttributes({
      toolName: "read_file",
      toolArgs: { path: "/etc/secret" },
    });
    expect(attrs[OI.TOOL_ARGS]).toBe(REDACTED_PLACEHOLDER);
  });

  it("20. stores tool args when redactContent=false", () => {
    const attrs = buildToolCallAttributes({
      toolName: "read_file",
      toolArgs: { path: "/public/file" },
      redactContent: false,
    });
    expect(attrs[OI.TOOL_ARGS]).toContain("/public/file");
  });

  it("21. redacts tool result by default", () => {
    const attrs = buildToolCallAttributes({
      toolName: "read_file",
      toolArgs: {},
      result: "file contents",
    });
    expect(attrs[OI.TOOL_RESULT]).toBe(REDACTED_PLACEHOLDER);
  });

  it("22. stores tool result when redactContent=false", () => {
    const attrs = buildToolCallAttributes({
      toolName: "read_file",
      toolArgs: {},
      result: "file contents",
      redactContent: false,
    });
    expect(attrs[OI.TOOL_RESULT]).toBe("file contents");
  });
});

// ─── LlmSpanEnricher ──────────────────────────────────────────────────────────

describe("LlmSpanEnricher", () => {
  it("23. startLlmCall returns a valid span ID present in the trace", () => {
    const { testTracer, enricher } = makeEnricher();
    const tid = testTracer.startTrace("run-23");
    const spanId = enricher.startLlmCall({
      traceId: tid,
      modelSlug: "claude-sonnet-4-6",
      prompt: "hello",
    });
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    const trace = testTracer.getTrace(tid);
    expect(trace!.spans.find((s) => s.spanId === spanId)).toBeDefined();
  });

  it("24. endLlmCall writes response, tokens, and cost to span attributes", () => {
    const { testTracer, enricher } = makeEnricher({ storePrompts: true });
    const tid = testTracer.startTrace("run-24");
    const spanId = enricher.startLlmCall({
      traceId: tid,
      modelSlug: "claude-sonnet-4-6",
      prompt: "What is 2+2?",
    });
    enricher.endLlmCall(spanId, tid, {
      response: "4",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    }, "ok", "claude-sonnet-4-6");

    const trace = testTracer.getTrace(tid);
    const span = trace!.spans.find((s) => s.spanId === spanId)!;
    expect(span.attributes[OI.LLM_TOTAL_TOKENS]).toBe(15);
    expect(span.attributes[OI.LLM_OUTPUT_VALUE]).toBe("4");
  });

  it("25. redaction is active by default — endLlmCall stores REDACTED_PLACEHOLDER for response", () => {
    const { testTracer, enricher } = makeEnricher();
    const tid = testTracer.startTrace("run-25");
    const spanId = enricher.startLlmCall({
      traceId: tid,
      modelSlug: "gpt-4o-mini",
      prompt: "Secret prompt",
    });
    enricher.endLlmCall(spanId, tid, { response: "Secret response" }, "ok", "gpt-4o-mini");

    const trace = testTracer.getTrace(tid);
    const span = trace!.spans.find((s) => s.spanId === spanId)!;
    expect(span.attributes[OI.LLM_OUTPUT_VALUE]).toBe(REDACTED_PLACEHOLDER);
  });

  it("26. startStrategySpan creates a CHAIN kind span", () => {
    const { testTracer, enricher } = makeEnricher();
    const tid = testTracer.startTrace("run-26");
    const spanId = enricher.startStrategySpan({
      traceId: tid,
      strategyType: "debate",
      runId: "run-26",
    });
    enricher.endStrategySpan(spanId, "ok", { candidateCount: 3, rounds: 2 });

    const trace = testTracer.getTrace(tid);
    const span = trace!.spans.find((s) => s.spanId === spanId)!;
    expect(span).toBeDefined();
    expect(span.attributes["openinference.span.kind"]).toBe(OI_SPAN_KIND.CHAIN);
    expect(span.attributes["strategy.type"]).toBe("debate");
    expect(span.attributes["strategy.candidate_count"]).toBe(3);
    expect(span.attributes["strategy.rounds"]).toBe(2);
  });

  it("27. tool call span is created with TOOL kind and correct tool name", () => {
    const { testTracer, enricher } = makeEnricher();
    const tid = testTracer.startTrace("run-27");
    const spanId = enricher.startToolCall({
      traceId: tid,
      toolName: "bash_run",
      toolArgs: { cmd: "ls -la" },
    });
    enricher.endToolCall(spanId, { result: "total 32\n..." });

    const trace = testTracer.getTrace(tid);
    const span = trace!.spans.find((s) => s.spanId === spanId)!;
    expect(span).toBeDefined();
    expect(span.name).toBe("tool.bash_run");
    expect(span.attributes["openinference.span.kind"]).toBe(OI_SPAN_KIND.TOOL);
    expect(span.attributes[OI.TOOL_NAME]).toBe("bash_run");
  });

  it("28. tool call with error sets span status=error", () => {
    const { testTracer, enricher } = makeEnricher();
    const tid = testTracer.startTrace("run-28");
    const spanId = enricher.startToolCall({
      traceId: tid,
      toolName: "bash_run",
      toolArgs: { cmd: "failing_cmd" },
    });
    enricher.endToolCall(spanId, { result: "command not found", isError: true });

    const trace = testTracer.getTrace(tid);
    const span = trace!.spans.find((s) => s.spanId === spanId)!;
    expect(span.status).toBe("error");
  });
});
