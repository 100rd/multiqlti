// server/routes/workspace-traces.ts
// Workspace-scoped trace viewer endpoints — /workspaces/:id/traces
//
// Repointed (task #29) from the legacy `traces` table — whose only writer,
// the pipeline tracer's flushTrace(), was retired along with the pipelines
// engine (migration 0053) and fully removed in the OTel/core-tracer sweep —
// to the live consilium task-tracing source (task-tracer.ts / task_traces).
// The response shape (WorkspaceTraceSummary/Detail, TraceSpan) is unchanged
// so the client page needs no changes; task_traces rows are adapted into the
// same OpenInference-flavoured TraceSpan shape via taskSpanToTraceSpan below.
import { z } from "zod";
import type { Express } from "express";
import type { IStorage } from "../storage";
import type { WorkspaceTraceSummary, WorkspaceTraceDetail, TraceSpan, TaskTraceSpan } from "@shared/types";
import type { TaskTraceRow } from "@shared/schema";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const WorkspaceIdSchema = z.object({
  id: z.string().min(1).max(64),
});

const RunIdParamSchema = z.object({
  run_id: z.string().min(1).max(64),
});

const ListTracesQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 50))
    .pipe(z.number().int().min(1).max(200)),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 0))
    .pipe(z.number().int().min(0)),
  runId: z.string().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Aggregate LLM span metrics from a span list. */
function aggregateSpanMetrics(spans: TraceSpan[]): {
  startTime: number;
  endTime: number;
  totalTokens: number;
  costUsd: number;
  provider: string;
  model: string;
} {
  let startTime = Infinity;
  let endTime = 0;
  let totalTokens = 0;
  let costUsd = 0;
  const providerCounts: Record<string, number> = {};
  const modelCounts: Record<string, number> = {};

  for (const span of spans) {
    if (span.startTime < startTime) startTime = span.startTime;
    if ((span.endTime || span.startTime) > endTime) endTime = span.endTime || span.startTime;

    const toks = span.attributes["llm.token_count.total"];
    if (typeof toks === "number") totalTokens += toks;

    const cost = span.attributes["llm.cost_usd"];
    if (typeof cost === "number") costUsd += cost;

    const prov = span.attributes["llm.provider"];
    if (typeof prov === "string" && prov) {
      providerCounts[prov] = (providerCounts[prov] ?? 0) + 1;
    }

    const model = span.attributes["llm.model"];
    if (typeof model === "string" && model) {
      modelCounts[model] = (modelCounts[model] ?? 0) + 1;
    }
  }

  const provider = Object.keys(providerCounts).sort((a, b) => providerCounts[b] - providerCounts[a])[0] ?? "";
  const model    = Object.keys(modelCounts).sort((a, b) => modelCounts[b] - modelCounts[a])[0] ?? "";

  return {
    startTime: startTime === Infinity ? 0 : startTime,
    endTime,
    totalTokens,
    costUsd,
    provider,
    model,
  };
}

function toTraceSummary(traceId: string, runId: string, spans: TraceSpan[]): WorkspaceTraceSummary {
  const metrics = aggregateSpanMetrics(spans);
  return {
    traceId,
    runId,
    spanCount: spans.length,
    ...metrics,
  };
}

/**
 * Adapt a TaskTracer span (task_traces.spans, TaskTraceSpanType/metadata
 * shape) into the OpenInference-flavoured TraceSpan the page already renders.
 * TaskTracer never captured raw prompt/response text or tool-call args — only
 * token/cost/model metadata — so those page sections simply stay empty
 * (the page already handles missing attributes gracefully).
 */
function taskSpanToTraceSpan(span: TaskTraceSpan): TraceSpan {
  const kind =
    span.type === "llm_call" ? "LLM" :
    span.type === "task"     ? "AGENT" :
    "CHAIN"; // "stage" | "task_group"

  const attributes: Record<string, string | number> = {
    "openinference.span.kind": kind,
  };
  if (span.metadata.provider) attributes["llm.provider"] = span.metadata.provider;
  if (span.metadata.modelSlug) attributes["llm.model"] = span.metadata.modelSlug;
  if (typeof span.metadata.tokensUsed === "number") attributes["llm.token_count.total"] = span.metadata.tokensUsed;
  if (typeof span.metadata.inputTokens === "number") attributes["llm.token_count.prompt"] = span.metadata.inputTokens;
  if (typeof span.metadata.outputTokens === "number") attributes["llm.token_count.completion"] = span.metadata.outputTokens;
  if (typeof span.metadata.estimatedCostUsd === "number") attributes["llm.cost_usd"] = span.metadata.estimatedCostUsd;
  if (span.metadata.error) attributes["error.message"] = span.metadata.error;

  return {
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? undefined,
    name: span.name,
    startTime: span.startTime,
    endTime: span.endTime ?? span.startTime,
    attributes,
    events: [],
    status: span.status === "failed" ? "error" : "ok",
  };
}

/** task_traces row → WorkspaceTraceSummary. `runId` = groupId (the closest task-groups-v2 analog to a "pipeline run"). */
function toWorkspaceSummaryFromTaskTrace(row: TaskTraceRow): WorkspaceTraceSummary {
  const spans = row.spans.map(taskSpanToTraceSpan);
  return toTraceSummary(row.traceId, row.groupId, spans);
}

// ─── Route Registration ───────────────────────────────────────────────────────

export function registerWorkspaceTraceRoutes(app: Express, storage: IStorage): void {
  // GET /api/workspaces/:id/traces
  // List trace summaries for a workspace. Scoping: the workspace must exist
  // AND belong to the caller's project (storage.getWorkspace enforces that via
  // ALS project context / requireProject on the /api/workspaces mount); traces
  // are then restricted to task_traces whose group has a task recorded against
  // THIS workspace id (server/storage.ts getWorkspaceTaskTraces) — no cross-
  // workspace leakage even within the same project.
  app.get("/api/workspaces/:id/traces", async (req, res) => {
    const wsResult = WorkspaceIdSchema.safeParse(req.params);
    if (!wsResult.success) {
      return res.status(400).json({ error: wsResult.error.message });
    }

    const queryResult = ListTracesQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: queryResult.error.message });
    }

    const { id: workspaceId } = wsResult.data;
    const { limit, offset, runId } = queryResult.data;

    try {
      const workspace = await storage.getWorkspace(workspaceId);
      if (!workspace) {
        return res.status(404).json({ error: `Workspace not found: ${workspaceId}` });
      }

      const allTraces = await storage.getWorkspaceTaskTraces(workspaceId, limit + offset, 0);

      const filtered = runId ? allTraces.filter((t) => t.groupId === runId) : allTraces;
      const page = filtered.slice(offset, offset + limit);
      const summaries: WorkspaceTraceSummary[] = page.map(toWorkspaceSummaryFromTaskTrace);

      return res.json({
        traces: summaries,
        total: filtered.length,
        limit,
        offset,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: msg });
    }
  });

  // GET /api/workspaces/:id/traces/:run_id
  // Return full trace detail including span tree. `run_id` is the task
  // group's id — the trace lookup is only permitted if that group has a task
  // scoped to THIS workspace (getWorkspaceTaskTraceByGroupId), otherwise 404.
  app.get("/api/workspaces/:id/traces/:run_id", async (req, res) => {
    const wsResult = WorkspaceIdSchema.safeParse({ id: req.params.id });
    if (!wsResult.success) {
      return res.status(400).json({ error: wsResult.error.message });
    }

    const runResult = RunIdParamSchema.safeParse({ run_id: req.params.run_id });
    if (!runResult.success) {
      return res.status(400).json({ error: runResult.error.message });
    }

    const { id: workspaceId } = wsResult.data;
    const { run_id } = runResult.data;

    try {
      const workspace = await storage.getWorkspace(workspaceId);
      if (!workspace) {
        return res.status(404).json({ error: `Workspace not found: ${workspaceId}` });
      }

      const trace = await storage.getWorkspaceTaskTraceByGroupId(workspaceId, run_id);
      if (!trace) {
        return res.status(404).json({ error: `No trace found for run ${run_id}` });
      }

      const spans = trace.spans.map(taskSpanToTraceSpan);
      const summary = toTraceSummary(trace.traceId, trace.groupId, spans);
      const detail: WorkspaceTraceDetail = {
        ...summary,
        spans,
      };

      return res.json(detail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: msg });
    }
  });
}
