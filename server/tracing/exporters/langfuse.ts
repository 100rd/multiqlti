// server/tracing/exporters/langfuse.ts
// Langfuse OTLP-compatible exporter.
// Langfuse accepts standard OTLP/JSON on /api/public/otel/v1/traces.
// Docs: https://langfuse.com/docs/sdk/typescript/opentelemetry

import type { PipelineTrace, TraceSpan } from "@shared/types";
import { OI, OI_SPAN_KIND } from "../openinference";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LangfuseExporterConfig {
  /** Base URL, e.g. "https://cloud.langfuse.com" or "http://localhost:3000" */
  baseUrl: string;
  /** Public key from Langfuse project settings */
  publicKey: string;
  /** Secret key from Langfuse project settings */
  secretKey: string;
  /** Optional custom endpoint path.  Defaults to /api/public/otel/v1/traces */
  endpointPath?: string;
}

/** Langfuse observation type mapping */
type LangfuseObservationType = "GENERATION" | "SPAN" | "EVENT";

interface LangfuseSpan {
  id: string;
  traceId: string;
  parentObservationId?: string;
  name: string;
  type: LangfuseObservationType;
  startTime: string;      // ISO 8601
  endTime?: string;       // ISO 8601
  statusCode?: "SUCCESS" | "ERROR";
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  modelParameters?: Record<string, unknown>;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  costUsd?: number;
}

interface LangfuseIngestionBody {
  batch: Array<{
    id: string;
    type: "observation-create";
    body: LangfuseSpan;
    timestamp: string;
  }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inferObservationType(span: TraceSpan): LangfuseObservationType {
  const kind = span.attributes["openinference.span.kind"] as string | undefined;
  if (kind === OI_SPAN_KIND.LLM) return "GENERATION";
  if (span.name.startsWith("tool.")) return "SPAN";
  return "SPAN";
}

function buildLangfuseSpan(span: TraceSpan, traceId: string): LangfuseSpan {
  const type = inferObservationType(span);

  const base: LangfuseSpan = {
    id: span.spanId,
    traceId,
    name: span.name,
    type,
    startTime: new Date(span.startTime).toISOString(),
    endTime: span.endTime > 0 ? new Date(span.endTime).toISOString() : undefined,
    statusCode: span.status === "ok" ? "SUCCESS" : "ERROR",
    metadata: { ...span.attributes },
  };

  if (span.parentSpanId) {
    base.parentObservationId = span.parentSpanId;
  }

  // For GENERATION spans — extract LLM-specific fields
  if (type === "GENERATION") {
    const attrs = span.attributes;

    const model = attrs[OI.LLM_MODEL] as string | undefined;
    if (model) base.model = model;

    const temperature = attrs[OI.LLM_TEMPERATURE];
    const maxTokens   = attrs[OI.LLM_MAX_TOKENS];
    if (temperature !== undefined || maxTokens !== undefined) {
      base.modelParameters = {};
      if (temperature !== undefined) base.modelParameters.temperature = temperature;
      if (maxTokens   !== undefined) base.modelParameters.max_tokens = maxTokens;
    }

    const inputValue  = attrs[OI.LLM_INPUT_VALUE];
    const outputValue = attrs[OI.LLM_OUTPUT_VALUE];
    if (inputValue  !== undefined) base.input  = inputValue;
    if (outputValue !== undefined) base.output = outputValue;

    const promptTok     = attrs[OI.LLM_PROMPT_TOKENS];
    const completionTok = attrs[OI.LLM_COMPLETION_TOKENS];
    const totalTok      = attrs[OI.LLM_TOTAL_TOKENS];

    if (promptTok !== undefined || completionTok !== undefined || totalTok !== undefined) {
      base.usage = {
        promptTokens:     typeof promptTok     === "number" ? promptTok     : undefined,
        completionTokens: typeof completionTok === "number" ? completionTok : undefined,
        totalTokens:      typeof totalTok      === "number" ? totalTok      : undefined,
      };
    }

    const costUsd = attrs[OI.LLM_COST_USD];
    if (typeof costUsd === "number" && costUsd > 0) {
      base.costUsd = costUsd;
    }
  }

  return base;
}

function buildIngestionPayload(trace: PipelineTrace): LangfuseIngestionBody {
  const now = new Date().toISOString();
  return {
    batch: trace.spans.map((span) => ({
      id: `${trace.traceId}-${span.spanId}`,
      type: "observation-create" as const,
      body: buildLangfuseSpan(span, trace.traceId),
      timestamp: now,
    })),
  };
}

// ─── Exported Functions ───────────────────────────────────────────────────────

/**
 * Export a PipelineTrace to Langfuse via the ingestion batch API.
 * Swallows all errors — never throws.
 */
export async function exportToLangfuse(
  trace: PipelineTrace,
  config: LangfuseExporterConfig,
): Promise<void> {
  if (!config.baseUrl || !config.publicKey || !config.secretKey) return;

  const path = config.endpointPath ?? "/api/public/otel/v1/traces";
  const url  = `${config.baseUrl}${path}`;

  // Langfuse uses Basic auth: base64(publicKey:secretKey)
  const credentials = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");

  try {
    const payload = buildIngestionPayload(trace);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${credentials}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn(`[langfuse-exporter] HTTP ${res.status}: ${res.statusText}`);
    }
  } catch (err) {
    console.warn("[langfuse-exporter]", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Read Langfuse config from environment variables.
 * Returns null if required variables are not set.
 */
export function langfuseConfigFromEnv(): LangfuseExporterConfig | null {
  const baseUrl   = process.env.LANGFUSE_BASE_URL;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (!baseUrl || !publicKey || !secretKey) return null;

  return { baseUrl, publicKey, secretKey };
}

/** Export a trace to Langfuse using environment configuration. No-op if env is not set. */
export async function exportToLangfuseFromEnv(trace: PipelineTrace): Promise<void> {
  const config = langfuseConfigFromEnv();
  if (!config) return;
  return exportToLangfuse(trace, config);
}

// ─── Internal helpers exported for testing ────────────────────────────────────

export { buildLangfuseSpan, buildIngestionPayload };
