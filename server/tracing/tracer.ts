// server/tracing/tracer.ts
// Imports ONLY from @shared/types — never from server modules (circular import prevention)
import type { PipelineTrace, TraceSpan } from "@shared/types";
import type { IStorage } from "../storage";
import { randomUUID } from "crypto";

interface ActiveTrace {
  traceId: string;
  runId: string;
  spans: Map<string, TraceSpan>;  // spanId → TraceSpan
}

export class Tracer {
  // runId → ActiveTrace
  private activeTraces: Map<string, ActiveTrace> = new Map();
  // spanId → runId (reverse lookup for endSpan)
  private spanIndex: Map<string, string> = new Map();

  /** Start a new trace for a run. Returns traceId (32 hex chars). Idempotent. */
  startTrace(runId: string): string {
    const existing = this.activeTraces.get(runId);
    if (existing) return existing.traceId;

    const traceId = randomUUID().replace(/-/g, "");
    this.activeTraces.set(runId, {
      traceId,
      runId,
      spans: new Map(),
    });
    return traceId;
  }

  /** Start a span within a trace. Returns spanId (16 hex chars). */
  startSpan(traceId: string, name: string, parentSpanId?: string): string {
    const spanId = randomUUID().replace(/-/g, "").slice(0, 16);

    // Find ActiveTrace by traceId
    let foundTrace: ActiveTrace | undefined;
    for (const trace of this.activeTraces.values()) {
      if (trace.traceId === traceId) {
        foundTrace = trace;
        break;
      }
    }

    if (!foundTrace) {
      // Tracer disabled or no active trace — return no-op span ID
      return spanId;
    }

    const span: TraceSpan = {
      spanId,
      parentSpanId,
      name,
      startTime: Date.now(),
      endTime: 0,
      attributes: {},
      events: [],
      status: "ok",
    };

    foundTrace.spans.set(spanId, span);
    this.spanIndex.set(spanId, foundTrace.runId);
    return spanId;
  }

  /** End a span, set its status and attributes. */
  endSpan(spanId: string, status: "ok" | "error", attributes?: Record<string, string | number>): void {
    const runId = this.spanIndex.get(spanId);
    if (!runId) return;

    const trace = this.activeTraces.get(runId);
    if (!trace) return;

    const span = trace.spans.get(spanId);
    if (!span) return;

    span.endTime = Date.now();
    span.status = status;
    if (attributes) {
      Object.assign(span.attributes, attributes);
    }

    this.spanIndex.delete(spanId);
  }

  /** Add an event to a span. No-op if span not found. */
  addSpanEvent(spanId: string, name: string, attributes?: Record<string, string>): void {
    const runId = this.spanIndex.get(spanId);
    if (!runId) return;

    const trace = this.activeTraces.get(runId);
    if (!trace) return;

    const span = trace.spans.get(spanId);
    if (!span) return;

    span.events.push({ name, timestamp: Date.now(), attributes });
  }

  /** Get the current PipelineTrace for a traceId (spans sorted by startTime). */
  getTrace(traceId: string): PipelineTrace | null {
    for (const trace of this.activeTraces.values()) {
      if (trace.traceId === traceId) {
        const spans = Array.from(trace.spans.values()).sort(
          (a, b) => a.startTime - b.startTime,
        );
        return { traceId, runId: trace.runId, spans };
      }
    }
    return null;
  }

  /** Get the active traceId for a runId. */
  getActiveTraceId(runId: string): string | undefined {
    return this.activeTraces.get(runId)?.traceId;
  }

  /** Persist trace to storage and remove from memory. Swallows errors. */
  async flushTrace(traceId: string, storage: IStorage): Promise<void> {
    const pipelineTrace = this.getTrace(traceId);
    if (!pipelineTrace) return;

    // Clean up span index entries for this trace
    for (const trace of this.activeTraces.values()) {
      if (trace.traceId === traceId) {
        for (const spanId of trace.spans.keys()) {
          this.spanIndex.delete(spanId);
        }
        this.activeTraces.delete(trace.runId);
        break;
      }
    }

    try {
      await storage.createTrace({
        traceId: pipelineTrace.traceId,
        runId: pipelineTrace.runId,
        spans: pipelineTrace.spans,
      });
    } catch (err) {
      console.warn("[tracer] Failed to flush trace to storage:", err instanceof Error ? err.message : err);
    }
  }
}

// Singleton export — one Tracer instance for the process
export const tracer = new Tracer();
