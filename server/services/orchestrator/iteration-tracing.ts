/**
 * Tracer-binding glue for the Task Groups v2 orchestrator (BE4), extracted from
 * TaskOrchestrator (L3 — keep the orchestrator file <800 lines).
 *
 * Owns the optional `TaskTracer` and the per-group active-trace context map, and
 * exposes thin span helpers (iteration / task / llm-call / group completion).
 * EVERY method is non-fatal: a tracer-less deployment or a tracer
 * throw must NEVER block or fail execution. Liveness tracking
 * (`getActiveGroupIds`) lives in the orchestrator, INDEPENDENTLY of this (M1).
 */
import type { TaskTracer } from "../task-tracer.js";
import type { IStorage } from "../../storage.js";
import type { TaskGroupRow, TaskGroupIterationRow, TaskRow } from "@shared/schema";

/** Per-active-iteration trace context. */
interface ActiveTrace {
  traceId: string;
  iterationId: string;
  taskSpanIds: Map<string, string>;
}

export class IterationTracing {
  private tracer: TaskTracer | null = null;
  private readonly active = new Map<string, ActiveTrace>();

  constructor(private readonly storage: IStorage) {}

  /** Attach a tracer instance (called during route registration). */
  setTracer(tracer: TaskTracer): void {
    this.tracer = tracer;
  }

  /** Open + bind a per-iteration trace; non-fatal on tracer failure. */
  async openIteration(group: TaskGroupRow, iteration: TaskGroupIterationRow): Promise<void> {
    if (!this.tracer) return;
    try {
      const traceId = await this.tracer.startIterationTrace(
        group.id,
        iteration.id,
        `TaskGroup: ${group.name}`,
      );
      this.active.set(group.id, { traceId, iterationId: iteration.id, taskSpanIds: new Map() });
      await this.storage.updateIteration(iteration.id, { traceId });
    } catch {
      // Tracing failure must never block execution.
    }
  }

  /** Start a task-level span; returns "" if tracing is off. */
  startTaskSpan(groupId: string, task: TaskRow): string {
    const ctx = this.active.get(groupId);
    if (!this.tracer || !ctx) return "";
    try {
      const spanId = this.tracer.startTaskSpan(ctx.traceId, task.id, `Task: ${task.name}`);
      ctx.taskSpanIds.set(task.id, spanId);
      return spanId;
    } catch {
      return "";
    }
  }

  completeTaskSpan(groupId: string, taskId: string, spanId: string): void {
    const ctx = this.active.get(groupId);
    if (!this.tracer || !ctx || !spanId) return;
    try {
      this.tracer.completeSpan(ctx.traceId, spanId, { taskId });
    } catch {
      // Non-fatal
    }
  }

  failTaskSpan(groupId: string, spanId: string, error: string): void {
    const ctx = this.active.get(groupId);
    if (!this.tracer || !ctx || !spanId) return;
    try {
      this.tracer.failSpan(ctx.traceId, spanId, error);
    } catch {
      // Non-fatal
    }
  }

  /** Open an LLM-call span under the task's span; "" if tracing off. */
  startLlmSpan(groupId: string, taskId: string, modelSlug: string): string {
    const ctx = this.active.get(groupId);
    const taskSpanId = ctx?.taskSpanIds.get(taskId) ?? "";
    if (!this.tracer || !ctx || !taskSpanId) return "";
    try {
      return this.tracer.startLlmCallSpan(ctx.traceId, taskSpanId, modelSlug, "gateway");
    } catch {
      return "";
    }
  }

  /** Complete the LLM-call span with token/size metadata; non-fatal. */
  completeLlmSpan(
    groupId: string,
    llmSpanId: string,
    meta: { response: { tokensUsed?: number; content: string }; modelSlug: string; inputContent: string },
  ): void {
    const ctx = this.active.get(groupId);
    if (!this.tracer || !ctx || !llmSpanId) return;
    try {
      this.tracer.completeSpan(ctx.traceId, llmSpanId, {
        tokensUsed: meta.response.tokensUsed,
        modelSlug: meta.modelSlug,
        inputSizeBytes: new TextEncoder().encode(meta.inputContent).length,
        outputSizeBytes: new TextEncoder().encode(meta.response.content).length,
      });
    } catch {
      // Non-fatal
    }
  }

  /** Complete the iteration's root span (group success/cancel) + drop context. */
  completeGroup(groupId: string): void {
    this.settleRootSpan(groupId, (traceId, spanId) => this.tracer!.completeSpan(traceId, spanId));
  }

  /** Fail the iteration's root span (group failure) + drop context. */
  failGroup(groupId: string, error: string): void {
    this.settleRootSpan(groupId, (traceId, spanId) => this.tracer!.failSpan(traceId, spanId, error));
  }

  /** Resolve the iteration's trace, settle its root span, and drop the context. */
  private settleRootSpan(groupId: string, settle: (traceId: string, spanId: string) => void): void {
    if (!this.tracer) return;
    const ctx = this.active.get(groupId);
    if (!ctx) return;
    try {
      this.storage
        .getTaskTraceByIteration(groupId, ctx.iterationId)
        .then((trace) => {
          const spans = (trace?.spans as Array<{ spanId: string }> | undefined) ?? [];
          if (spans.length > 0) settle(ctx.traceId, spans[0].spanId);
        })
        .catch(() => {
          /* swallow */
        });
    } catch {
      // Non-fatal
    }
    this.active.delete(groupId);
  }
}
