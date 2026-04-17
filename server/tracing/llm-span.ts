// server/tracing/llm-span.ts
// LLM span enrichment layer.
// Wraps the core Tracer to attach OpenInference semantic convention attributes
// to every LLM call, tool call, and strategy execution span.
import type { TraceSpan } from "@shared/types";
import { tracer as defaultTracer, type Tracer } from "./tracer";
import {
  OI,
  OI_SPAN_KIND,
  estimateCostUsd,
  inferProviderFromModelSlug,
  maybeRedact,
  truncate,
} from "./openinference";

/** Maximum characters stored for prompt / response text. */
const MAX_TEXT_LEN = 8_192;

// ─── Public Configuration ────────────────────────────────────────────────────

export interface LlmSpanConfig {
  /** Whether to store prompt/response text.  Defaults to false (redacted). */
  storePrompts: boolean;
  /** Whether to store tool arguments and results.  Defaults to false (redacted). */
  storeToolData: boolean;
}

const DEFAULT_CONFIG: LlmSpanConfig = {
  storePrompts: false,
  storeToolData: false,
};

// ─── Input Types ─────────────────────────────────────────────────────────────

export interface LlmCallInput {
  traceId: string;
  parentSpanId?: string;
  modelSlug: string;
  systemPrompt?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: string[];
  stageId?: string;
  stageRole?: string;
  runId?: string;
  config?: Partial<LlmSpanConfig>;
}

export interface LlmCallOutput {
  response: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ToolCallInput {
  traceId: string;
  parentSpanId?: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  runId?: string;
  config?: Partial<LlmSpanConfig>;
}

export interface ToolCallOutput {
  result: string;
  isError?: boolean;
}

export interface StrategySpanInput {
  traceId: string;
  parentSpanId?: string;
  strategyType: "moa" | "debate" | "voting";
  runId?: string;
  stageId?: string;
}

// ─── LlmSpanEnricher ─────────────────────────────────────────────────────────

/**
 * Enriches the core Tracer with LLM-specific attributes following the
 * OpenInference semantic convention.
 *
 * Accepts an optional Tracer instance for testability; defaults to the process
 * singleton.
 *
 * Usage:
 *   const enricher = new LlmSpanEnricher();
 *   const spanId = enricher.startLlmCall(input);
 *   // ... execute LLM call ...
 *   enricher.endLlmCall(spanId, traceId, output, "ok");
 */
export class LlmSpanEnricher {
  protected readonly cfg: LlmSpanConfig;
  private readonly _tracer: Tracer;

  constructor(config?: Partial<LlmSpanConfig>, tracerOverride?: Tracer) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this._tracer = tracerOverride ?? defaultTracer;
  }

  /**
   * Start an LLM call span.  Returns the spanId.
   */
  startLlmCall(input: LlmCallInput): string {
    const cfg = { ...this.cfg, ...input.config };
    const spanName = `llm.${input.modelSlug}`;
    const spanId = this._tracer.startSpan(input.traceId, spanName, input.parentSpanId);

    const attrs: Record<string, string | number> = {
      "openinference.span.kind": OI_SPAN_KIND.LLM,
      [OI.LLM_PROVIDER]: inferProviderFromModelSlug(input.modelSlug),
      [OI.LLM_MODEL]: input.modelSlug,
    };

    if (input.systemPrompt !== undefined) {
      attrs[OI.LLM_SYSTEM_PROMPT] = maybeRedact(
        truncate(input.systemPrompt, MAX_TEXT_LEN),
        !cfg.storePrompts,
      );
    }

    if (input.prompt) {
      attrs[OI.LLM_INPUT_VALUE] = maybeRedact(
        truncate(input.prompt, MAX_TEXT_LEN),
        !cfg.storePrompts,
      );
    }

    if (input.temperature !== undefined) {
      attrs[OI.LLM_TEMPERATURE] = input.temperature;
    }

    if (input.maxTokens !== undefined) {
      attrs[OI.LLM_MAX_TOKENS] = input.maxTokens;
    }

    if (input.stop && input.stop.length > 0) {
      attrs[OI.LLM_STOP] = JSON.stringify(input.stop);
    }

    if (input.tools && input.tools.length > 0) {
      attrs["llm.tools"] = JSON.stringify(input.tools);
    }

    if (input.stageId) {
      attrs[OI.STAGE_ID] = input.stageId;
    }

    if (input.stageRole) {
      attrs[OI.STAGE_ROLE] = input.stageRole;
    }

    if (input.runId) {
      attrs[OI.PIPELINE_RUN_ID] = input.runId;
    }

    this._tracer.addSpanEvent(spanId, "llm.call.started", {
      model: input.modelSlug,
      provider: inferProviderFromModelSlug(input.modelSlug),
    });

    this._pendingAttrs.set(spanId, attrs);
    return spanId;
  }

  /**
   * End an LLM call span with response data.
   */
  endLlmCall(
    spanId: string,
    traceId: string,
    output: LlmCallOutput,
    status: "ok" | "error",
    modelSlug?: string,
  ): void {
    const cfg = this.cfg;
    const pending = this._pendingAttrs.get(spanId) ?? {};
    this._pendingAttrs.delete(spanId);

    const attrs: Record<string, string | number> = { ...pending };

    if (output.response) {
      attrs[OI.LLM_OUTPUT_VALUE] = maybeRedact(
        truncate(output.response, MAX_TEXT_LEN),
        !cfg.storePrompts,
      );
    }

    const promptTok = output.promptTokens ?? 0;
    const completionTok = output.completionTokens ?? 0;
    const totalTok = output.totalTokens ?? (promptTok + completionTok);

    if (totalTok > 0) {
      attrs[OI.LLM_PROMPT_TOKENS]     = promptTok;
      attrs[OI.LLM_COMPLETION_TOKENS] = completionTok;
      attrs[OI.LLM_TOTAL_TOKENS]      = totalTok;
    }

    const slug = modelSlug ?? (pending[OI.LLM_MODEL] as string | undefined) ?? "";
    if (slug && totalTok > 0) {
      const costUsd = estimateCostUsd(slug, totalTok);
      if (costUsd > 0) {
        attrs[OI.LLM_COST_USD] = costUsd;
      }
    }

    // Suppress unused variable warning
    void traceId;

    this._tracer.endSpan(spanId, status, attrs);
  }

  /**
   * Start a tool-call span.  Returns the spanId.
   */
  startToolCall(input: ToolCallInput): string {
    const cfg = { ...this.cfg, ...input.config };
    const spanName = `tool.${input.toolName}`;
    const spanId = this._tracer.startSpan(input.traceId, spanName, input.parentSpanId);

    const argsStr = JSON.stringify(input.toolArgs);
    const attrs: Record<string, string | number> = {
      "openinference.span.kind": OI_SPAN_KIND.TOOL,
      [OI.TOOL_NAME]: input.toolName,
      [OI.TOOL_ARGS]: maybeRedact(truncate(argsStr, MAX_TEXT_LEN), !cfg.storeToolData),
    };

    if (input.runId) {
      attrs[OI.PIPELINE_RUN_ID] = input.runId;
    }

    this._pendingAttrs.set(spanId, attrs);
    return spanId;
  }

  /**
   * End a tool-call span with its result.
   */
  endToolCall(
    spanId: string,
    output: ToolCallOutput,
  ): void {
    const cfg = this.cfg;
    const pending = this._pendingAttrs.get(spanId) ?? {};
    this._pendingAttrs.delete(spanId);

    const status: "ok" | "error" = output.isError ? "error" : "ok";
    const attrs: Record<string, string | number> = { ...pending };

    attrs[OI.TOOL_RESULT] = maybeRedact(
      truncate(output.result, MAX_TEXT_LEN),
      !cfg.storeToolData,
    );

    this._tracer.endSpan(spanId, status, attrs);
  }

  /**
   * Start a strategy wrapper span (debate / voting / moa).
   * Returns the spanId.  Candidate/judge spans are children of this span.
   */
  startStrategySpan(input: StrategySpanInput): string {
    const spanName = `strategy.${input.strategyType}`;
    const spanId = this._tracer.startSpan(input.traceId, spanName, input.parentSpanId);

    const attrs: Record<string, string | number> = {
      "openinference.span.kind": OI_SPAN_KIND.CHAIN,
      "strategy.type": input.strategyType,
    };

    if (input.runId) {
      attrs[OI.PIPELINE_RUN_ID] = input.runId;
    }

    if (input.stageId) {
      attrs[OI.STAGE_ID] = input.stageId;
    }

    this._pendingAttrs.set(spanId, attrs);
    return spanId;
  }

  /**
   * End a strategy span.
   */
  endStrategySpan(
    spanId: string,
    status: "ok" | "error",
    extra?: { candidateCount?: number; winnerModel?: string; rounds?: number },
  ): void {
    const pending = this._pendingAttrs.get(spanId) ?? {};
    this._pendingAttrs.delete(spanId);

    const attrs: Record<string, string | number> = { ...pending };

    if (extra?.candidateCount !== undefined) {
      attrs["strategy.candidate_count"] = extra.candidateCount;
    }

    if (extra?.winnerModel !== undefined) {
      attrs["strategy.winner_model"] = extra.winnerModel;
    }

    if (extra?.rounds !== undefined) {
      attrs["strategy.rounds"] = extra.rounds;
    }

    this._tracer.endSpan(spanId, status, attrs);
  }

  // ─── Internal state ───────────────────────────────────────────────────────

  /** Attributes pending to be flushed at span end. */
  private readonly _pendingAttrs = new Map<string, Record<string, string | number>>();
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const llmSpanEnricher = new LlmSpanEnricher();

// ─── Helpers exported for thought-tree-collector integration ─────────────────

/**
 * Build a set of OpenInference attributes for an LLM span from thought-tree
 * collector context.  Does not interact with the tracer directly.
 */
export function buildLlmSpanAttributes(params: {
  modelSlug: string;
  systemPrompt?: string;
  prompt?: string;
  response?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  temperature?: number;
  maxTokens?: number;
  stageId?: string;
  stageRole?: string;
  runId?: string;
  redactContent?: boolean;
}): Record<string, string | number> {
  const redact = params.redactContent ?? true;
  const attrs: Record<string, string | number> = {
    "openinference.span.kind": OI_SPAN_KIND.LLM,
    [OI.LLM_PROVIDER]: inferProviderFromModelSlug(params.modelSlug),
    [OI.LLM_MODEL]: params.modelSlug,
  };

  if (params.systemPrompt !== undefined) {
    attrs[OI.LLM_SYSTEM_PROMPT] = maybeRedact(truncate(params.systemPrompt, MAX_TEXT_LEN), redact);
  }

  if (params.prompt) {
    attrs[OI.LLM_INPUT_VALUE] = maybeRedact(truncate(params.prompt, MAX_TEXT_LEN), redact);
  }

  if (params.response) {
    attrs[OI.LLM_OUTPUT_VALUE] = maybeRedact(truncate(params.response, MAX_TEXT_LEN), redact);
  }

  if (params.temperature !== undefined) attrs[OI.LLM_TEMPERATURE] = params.temperature;
  if (params.maxTokens !== undefined)   attrs[OI.LLM_MAX_TOKENS] = params.maxTokens;
  if (params.stageId)                   attrs[OI.STAGE_ID] = params.stageId;
  if (params.stageRole)                 attrs[OI.STAGE_ROLE] = params.stageRole;
  if (params.runId)                     attrs[OI.PIPELINE_RUN_ID] = params.runId;

  const promptTok = params.promptTokens ?? 0;
  const completionTok = params.completionTokens ?? 0;
  const totalTok = params.totalTokens ?? (promptTok + completionTok);

  if (totalTok > 0) {
    attrs[OI.LLM_PROMPT_TOKENS]     = promptTok;
    attrs[OI.LLM_COMPLETION_TOKENS] = completionTok;
    attrs[OI.LLM_TOTAL_TOKENS]      = totalTok;

    const costUsd = estimateCostUsd(params.modelSlug, totalTok);
    if (costUsd > 0) attrs[OI.LLM_COST_USD] = costUsd;
  }

  return attrs;
}

/**
 * Build tool-call span attributes.
 */
export function buildToolCallAttributes(params: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  result?: string;
  redactContent?: boolean;
}): Record<string, string | number> {
  const redact = params.redactContent ?? true;
  const attrs: Record<string, string | number> = {
    "openinference.span.kind": OI_SPAN_KIND.TOOL,
    [OI.TOOL_NAME]: params.toolName,
    [OI.TOOL_ARGS]: maybeRedact(truncate(JSON.stringify(params.toolArgs), MAX_TEXT_LEN), redact),
  };

  if (params.result !== undefined) {
    attrs[OI.TOOL_RESULT] = maybeRedact(truncate(params.result, MAX_TEXT_LEN), redact);
  }

  return attrs;
}

/**
 * Enrich an existing TraceSpan with OpenInference LLM attributes.
 * Used by the thought-tree-collector refactor.
 */
export function enrichSpanWithLlmAttributes(
  span: TraceSpan,
  params: Parameters<typeof buildLlmSpanAttributes>[0],
): TraceSpan {
  const attrs = buildLlmSpanAttributes(params);
  return {
    ...span,
    attributes: { ...span.attributes, ...attrs },
  };
}
