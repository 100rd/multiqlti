// server/tracing/openinference.ts
// OpenInference semantic conventions for LLM spans.
// Spec: https://github.com/Arize-ai/openinference/tree/main/spec

/** OpenInference attribute key constants */
export const OI = {
  // LLM span attributes
  LLM_PROVIDER:          "llm.provider",
  LLM_MODEL:             "llm.model",
  LLM_SYSTEM:            "llm.system",
  LLM_PROMPT_TOKENS:     "llm.token_count.prompt",
  LLM_COMPLETION_TOKENS: "llm.token_count.completion",
  LLM_TOTAL_TOKENS:      "llm.token_count.total",
  LLM_COST_USD:          "llm.cost_usd",
  LLM_TEMPERATURE:       "llm.invocation_parameters.temperature",
  LLM_MAX_TOKENS:        "llm.invocation_parameters.max_tokens",
  LLM_STOP:              "llm.invocation_parameters.stop",
  LLM_INPUT_VALUE:       "input.value",   // prompt text (redactable)
  LLM_OUTPUT_VALUE:      "output.value",  // response text (redactable)
  LLM_SYSTEM_PROMPT:     "llm.prompts.0.system", // system prompt (redactable)

  // Tool-call span attributes
  TOOL_NAME:             "tool.name",
  TOOL_ARGS:             "tool.call.arguments",  // redacted
  TOOL_RESULT:           "tool.call.result",     // redacted

  // Strategy / pipeline attributes
  STAGE_ID:              "stage.id",
  STAGE_ROLE:            "stage.role",
  PIPELINE_RUN_ID:       "pipeline.run_id",

  // Span kinds (stored as span name prefix convention)
  KIND_LLM:              "llm",
  KIND_TOOL:             "tool",
  KIND_STRATEGY:         "strategy",
  KIND_CHAIN:            "chain",
} as const;

/** OpenInference span kinds (for the openinference.span.kind attribute) */
export const OI_SPAN_KIND = {
  LLM:      "LLM",
  TOOL:     "TOOL",
  CHAIN:    "CHAIN",
  AGENT:    "AGENT",
  RERANKER: "RERANKER",
  RETRIEVER: "RETRIEVER",
  EMBEDDING: "EMBEDDING",
  GUARDRAIL: "GUARDRAIL",
  EVALUATOR: "EVALUATOR",
} as const;

export type OISpanKind = typeof OI_SPAN_KIND[keyof typeof OI_SPAN_KIND];

/** Redacted placeholder — replaces sensitive content when redaction is enabled */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/** Redact a value if redaction is enabled. */
export function maybeRedact(value: string, redact: boolean): string {
  return redact ? REDACTED_PLACEHOLDER : value;
}

/** Truncate a string to maxLen characters, appending "…" if truncated. */
export function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen - 1) + "…";
}

/**
 * Cost-per-million-tokens lookup table (input token price).
 * Prices are approximate USD/1M tokens as of 2025-Q2.
 * Models not listed fall back to 0.
 */
const COST_PER_1M_TOKENS: Record<string, number> = {
  "claude-opus-4":              15.00,
  "claude-sonnet-4":             3.00,
  "claude-sonnet-4-5":           3.00,
  "claude-sonnet-4-6":           3.00,
  "claude-haiku-3":              0.25,
  "claude-3-5-sonnet":           3.00,
  "claude-3-5-haiku":            0.80,
  "gpt-4o":                      5.00,
  "gpt-4o-mini":                 0.15,
  "gpt-4-turbo":                10.00,
  "gemini-1.5-pro":              7.00,
  "gemini-1.5-flash":            0.075,
  "gemini-2.0-flash":            0.10,
  "grok-2":                      5.00,
  "grok-3":                     15.00,
};

/**
 * Estimate cost in USD for a given model and token count.
 * Returns 0 if the model is not in the price table.
 */
export function estimateCostUsd(modelId: string, totalTokens: number): number {
  // Try exact match first, then prefix match
  const exactPrice = COST_PER_1M_TOKENS[modelId];
  if (exactPrice !== undefined) {
    return (totalTokens / 1_000_000) * exactPrice;
  }

  // Prefix match (e.g. "claude-sonnet-4-6-20251101" → "claude-sonnet-4-6")
  for (const [key, price] of Object.entries(COST_PER_1M_TOKENS)) {
    if (modelId.startsWith(key)) {
      return (totalTokens / 1_000_000) * price;
    }
  }

  return 0;
}

/**
 * Derive the provider string from a model slug using conventional prefixes.
 */
export function inferProviderFromModelSlug(modelSlug: string): string {
  if (modelSlug.startsWith("claude")) return "anthropic";
  if (modelSlug.startsWith("gpt") || modelSlug.startsWith("o1") || modelSlug.startsWith("o3")) return "openai";
  if (modelSlug.startsWith("gemini")) return "google";
  if (modelSlug.startsWith("grok")) return "xai";
  if (modelSlug.startsWith("llama") || modelSlug.startsWith("mistral") || modelSlug.startsWith("mixtral")) return "ollama";
  return "unknown";
}
