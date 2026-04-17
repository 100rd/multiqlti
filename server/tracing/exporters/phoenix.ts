// server/tracing/exporters/phoenix.ts
// Phoenix / Arize OpenInference OTLP exporter.
// Phoenix accepts standard OTLP/JSON via HTTP on /v1/traces.
// Docs: https://docs.arize.com/phoenix/tracing/how-to-tracing/setup-tracing/using-otel-python-sdk

import type { PipelineTrace, TraceSpan } from "@shared/types";
import { OI, OI_SPAN_KIND } from "../openinference";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PhoenixExporterConfig {
  /** Phoenix endpoint URL, e.g. "http://localhost:6006" */
  baseUrl: string;
  /** Optional API key for hosted Phoenix / Arize */
  apiKey?: string;
}

// ─── OTLP helpers (shared with base otlp-exporter) ───────────────────────────

const toNano = (ms: number): string => String(ms * 1_000_000);

function buildAttr(key: string, value: string | number): object {
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: value } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

/**
 * Convert a TraceSpan to an OTLP span object following the OpenInference
 * semantic conventions.  Phoenix/Arize parses these attributes natively.
 */
function buildOtlpSpan(span: TraceSpan, traceId: string): object {
  // Determine the SpanKind (OTLP numeric enum)
  // 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER
  const kind = span.attributes["openinference.span.kind"] as string | undefined;
  const otlpKind = kind === OI_SPAN_KIND.LLM ? 3 : 1; // CLIENT for LLM calls, INTERNAL otherwise

  const otlpSpan: Record<string, unknown> = {
    traceId,
    spanId: span.spanId,
    name: span.name,
    kind: otlpKind,
    startTimeUnixNano: toNano(span.startTime),
    endTimeUnixNano: toNano(span.endTime),
    attributes: Object.entries(span.attributes).map(([k, v]) => buildAttr(k, v)),
    events: span.events.map((e) => ({
      name: e.name,
      timeUnixNano: toNano(e.timestamp),
      attributes: e.attributes
        ? Object.entries(e.attributes).map(([k, v]) => ({ key: k, value: { stringValue: v } }))
        : [],
    })),
    status: {
      code: span.status === "ok" ? 1 : 2, // STATUS_CODE_OK = 1, ERROR = 2
    },
  };

  if (span.parentSpanId) {
    otlpSpan.parentSpanId = span.parentSpanId;
  }

  return otlpSpan;
}

function buildOtlpPayload(trace: PipelineTrace): object {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name",    value: { stringValue: "multiqlti" } },
            { key: "service.version", value: { stringValue: "1.0.0" } },
            // Phoenix-specific resource attributes
            { key: "openinference.project.name", value: { stringValue: "multiqlti" } },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: "multiqlti/pipeline",
              version: "1.0.0",
            },
            spans: trace.spans.map((span) => buildOtlpSpan(span, trace.traceId)),
          },
        ],
      },
    ],
  };
}

// ─── Exported Functions ───────────────────────────────────────────────────────

/**
 * Export a PipelineTrace to Phoenix via OTLP/JSON.
 * Swallows all errors — never throws.
 */
export async function exportToPhoenix(
  trace: PipelineTrace,
  config: PhoenixExporterConfig,
): Promise<void> {
  if (!config.baseUrl) return;

  const url = `${config.baseUrl}/v1/traces`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.apiKey) {
    headers["api_key"] = config.apiKey;
  }

  const payload = buildOtlpPayload(trace);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn(`[phoenix-exporter] HTTP ${res.status}: ${res.statusText}`);
    }
  } catch (err) {
    console.warn("[phoenix-exporter]", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Read Phoenix config from environment variables.
 * Returns null if PHOENIX_BASE_URL is not set.
 */
export function phoenixConfigFromEnv(): PhoenixExporterConfig | null {
  const baseUrl = process.env.PHOENIX_BASE_URL;
  if (!baseUrl) return null;

  return {
    baseUrl,
    apiKey: process.env.PHOENIX_API_KEY,
  };
}

/** Export a trace to Phoenix using environment configuration. No-op if env is not set. */
export async function exportToPhoenixFromEnv(trace: PipelineTrace): Promise<void> {
  const config = phoenixConfigFromEnv();
  if (!config) return;
  return exportToPhoenix(trace, config);
}

// ─── Helpers exported for testing ─────────────────────────────────────────────

export { buildOtlpSpan, buildOtlpPayload, buildAttr };
