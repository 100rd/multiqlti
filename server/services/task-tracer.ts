import { randomUUID } from "crypto";
import type { IStorage } from "../storage";
import type { WsManager } from "../ws/manager";
import type { TaskTraceSpan, TaskTraceSpanType, TaskTraceSpanMetadata, WsEvent } from "@shared/types";
import type { TaskTraceRow } from "@shared/schema";

// ─── TaskTracer ─────────────────────────────────────────────────────────────
// Records trace spans as a user request flows through
// TaskGroup → Task → Pipeline Run → Stage → LLM Call.
// Each call returns a spanId that the caller stores and passes back
// when completing or failing the span.

export class TaskTracer {
  /** In-memory buffer of active traces keyed by traceId. Flushed to DB on each mutation. */
  private activeTraces = new Map<string, { dbId: string; groupId: string; spans: TaskTraceSpan[] }>();

  constructor(
    private storage: IStorage,
    private wsManager: WsManager,
  ) {}

  // ─── Lifecycle: start spans ──────────────────────────────────────────────

  async startGroupTrace(groupId: string, name: string): Promise<string> {
    const traceId = randomUUID();
    const rootSpan = this.makeSpan(null, name, "task_group", {});

    const row = await this.storage.createTaskTrace({
      groupId,
      traceId,
      rootSpan,
      spans: [rootSpan],
      totalDurationMs: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    });

    // Link trace to group
    await this.storage.updateTaskGroup(groupId, { traceId } as Record<string, unknown>);

    this.activeTraces.set(traceId, { dbId: row.id, groupId, spans: [rootSpan] });

    this.broadcastSpanEvent(groupId, "trace:span:started", rootSpan);
    return traceId;
  }

  startTaskSpan(traceId: string, taskId: string, name: string): string {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return "";

    const rootSpanId = trace.spans[0]?.spanId ?? null;
    const span = this.makeSpan(rootSpanId, name, "task", { taskId });
    trace.spans.push(span);
    this.flushTrace(traceId);
    this.broadcastSpanEvent(trace.groupId, "trace:span:started", span);
    return span.spanId;
  }

  startPipelineRunSpan(traceId: string, parentSpanId: string, runId: string): string {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return "";

    const span = this.makeSpan(parentSpanId, `Pipeline Run`, "pipeline_run", { pipelineRunId: runId });
    trace.spans.push(span);
    this.flushTrace(traceId);
    this.broadcastSpanEvent(trace.groupId, "trace:span:started", span);
    return span.spanId;
  }

  startStageSpan(traceId: string, parentSpanId: string, stageIndex: number, modelSlug: string): string {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return "";

    const span = this.makeSpan(parentSpanId, `Stage ${stageIndex}`, "stage", { stageIndex, modelSlug });
    trace.spans.push(span);
    this.flushTrace(traceId);
    this.broadcastSpanEvent(trace.groupId, "trace:span:started", span);
    return span.spanId;
  }

  startLlmCallSpan(traceId: string, parentSpanId: string, modelSlug: string, provider: string): string {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return "";

    const span = this.makeSpan(parentSpanId, `LLM: ${modelSlug}`, "llm_call", { modelSlug, provider });
    trace.spans.push(span);
    this.flushTrace(traceId);
    this.broadcastSpanEvent(trace.groupId, "trace:span:started", span);
    return span.spanId;
  }

  // ─── Lifecycle: complete / fail ──────────────────────────────────────────

  completeSpan(traceId: string, spanId: string, metadata?: Partial<TaskTraceSpanMetadata>): void {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return;

    const span = trace.spans.find((s) => s.spanId === spanId);
    if (!span) return;

    const now = Date.now();
    span.status = "completed";
    span.endTime = now;
    span.durationMs = now - span.startTime;
    if (metadata) {
      span.metadata = { ...span.metadata, ...metadata };
    }

    this.flushTrace(traceId);
    this.broadcastSpanEvent(trace.groupId, "trace:span:completed", span);
  }

  failSpan(traceId: string, spanId: string, error: string): void {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return;

    const span = trace.spans.find((s) => s.spanId === spanId);
    if (!span) return;

    const now = Date.now();
    span.status = "failed";
    span.endTime = now;
    span.durationMs = now - span.startTime;
    span.metadata.error = error;

    this.flushTrace(traceId);
    this.broadcastSpanEvent(trace.groupId, "trace:span:failed", span);
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  async getTrace(groupId: string): Promise<TaskTraceRow | null> {
    return this.storage.getTaskTrace(groupId);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private makeSpan(
    parentSpanId: string | null,
    name: string,
    type: TaskTraceSpanType,
    metadata: TaskTraceSpanMetadata,
  ): TaskTraceSpan {
    return {
      spanId: randomUUID(),
      parentSpanId,
      name,
      type,
      status: "running",
      startTime: Date.now(),
      metadata,
    };
  }

  private flushTrace(traceId: string): void {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return;

    // Compute aggregates
    const completedSpans = trace.spans.filter((s) => s.status !== "running");
    const totalDurationMs = Math.max(0, ...completedSpans.map((s) => s.durationMs ?? 0));
    const totalTokens = trace.spans.reduce((sum, s) => sum + (s.metadata.tokensUsed ?? 0), 0);
    const totalCostUsd = trace.spans.reduce((sum, s) => sum + (s.metadata.estimatedCostUsd ?? 0), 0);

    // Fire-and-forget DB update
    this.storage.updateTaskTrace(trace.dbId, {
      spans: trace.spans,
      rootSpan: trace.spans[0] ?? null,
      totalDurationMs,
      totalTokens,
      totalCostUsd,
    } as Partial<TaskTraceRow>).catch(() => {
      // Swallow — tracing should never crash the orchestrator
    });
  }

  private broadcastSpanEvent(
    groupId: string,
    type: "trace:span:started" | "trace:span:completed" | "trace:span:failed",
    span: TaskTraceSpan,
  ): void {
    const event: WsEvent = {
      type,
      runId: groupId,
      payload: {
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        spanType: span.type,
        status: span.status,
        startTime: span.startTime,
        endTime: span.endTime,
        durationMs: span.durationMs,
        metadata: span.metadata,
      },
      timestamp: new Date().toISOString(),
    };
    this.wsManager.broadcastToRun(groupId, event);
  }
}
