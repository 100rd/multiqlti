// server/tracing/otlp-exporter.ts
// Native fetch OTLP HTTP exporter — no @opentelemetry npm packages required.
import type { PipelineTrace, TraceSpan } from "@shared/types";

const toNano = (ms: number): string => String(ms * 1_000_000);

function buildAttribute(key: string, value: string | number): object {
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { key, value: { intValue: value } };
    }
    return { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

function buildOtlpSpan(span: TraceSpan, traceId: string): object {
  const otlpSpan: Record<string, unknown> = {
    traceId,
    spanId: span.spanId,
    name: span.name,
    kind: 1, // INTERNAL
    startTimeUnixNano: toNano(span.startTime),
    endTimeUnixNano: toNano(span.endTime),
    attributes: Object.entries(span.attributes).map(([k, v]) => buildAttribute(k, v)),
    events: span.events.map((e) => ({
      name: e.name,
      timeUnixNano: toNano(e.timestamp),
      attributes: e.attributes
        ? Object.entries(e.attributes).map(([k, v]) => ({ key: k, value: { stringValue: v } }))
        : [],
    })),
    status: {
      code: span.status === "ok" ? 1 : 2,
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
            { key: "service.name", value: { stringValue: "multiqlti" } },
            { key: "service.version", value: { stringValue: "1.0.0" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "multiqlti/pipeline" },
            spans: trace.spans.map((span) => buildOtlpSpan(span, trace.traceId)),
          },
        ],
      },
    ],
  };
}

export async function exportTrace(trace: PipelineTrace): Promise<void> {
  const endpoint = process.env.OTLP_ENDPOINT;
  if (!endpoint) return;

  const sampleRate = parseFloat(process.env.TRACE_SAMPLE_RATE ?? "1.0");
  if (Math.random() > sampleRate) return;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const apiKey = process.env.OTLP_API_KEY;
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Security fix: wrap OTLP_HEADERS JSON.parse in try/catch
  const rawHeaders = process.env.OTLP_HEADERS;
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders) as Record<string, string>;
      Object.assign(headers, parsed);
    } catch {
      console.warn("[otlp] Invalid OTLP_HEADERS JSON — ignoring custom headers");
    }
  }

  const payload = buildOtlpPayload(trace);

  try {
    const res = await fetch(`${endpoint}/v1/traces`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn(`[otlp] Export failed with HTTP ${res.status}: ${res.statusText}`);
    }
  } catch (err) {
    console.warn("[otlp]", err instanceof Error ? err.message : String(err));
  }
}
