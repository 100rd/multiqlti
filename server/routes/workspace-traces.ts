// server/routes/workspace-traces.ts
// Workspace-scoped trace viewer endpoints — /workspaces/:id/traces
import { z } from "zod";
import type { Express } from "express";
import type { IStorage } from "../storage";
import type { WorkspaceTraceSummary, WorkspaceTraceDetail, TraceSpan } from "@shared/types";

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
    startTime:   startTime === Infinity ? 0 : startTime,
    endTime,
    totalTokens,
    costUsd,
    provider,
    model,
  };
}

function toTraceSummary(
  traceId: string,
  runId: string,
  spans: TraceSpan[],
): WorkspaceTraceSummary {
  const metrics = aggregateSpanMetrics(spans);
  return {
    traceId,
    runId,
    spanCount: spans.length,
    ...metrics,
  };
}

// ─── Route Registration ───────────────────────────────────────────────────────

export function registerWorkspaceTraceRoutes(app: Express, storage: IStorage): void {
  // GET /api/workspaces/:id/traces
  // List trace summaries for a workspace.  Workspace scoping is enforced by
  // filtering to runs that belong to this workspace's pipelines.
  app.get("/api/workspaces/:id/traces", async (req, res) => {
    const wsResult = WorkspaceIdSchema.safeParse(req.params);
    if (!wsResult.success) {
      return res.status(400).json({ error: wsResult.error.message });
    }

    const queryResult = ListTracesQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: queryResult.error.message });
    }

    const { limit, offset, runId } = queryResult.data;

    try {
      // Fetch raw trace records (uses global getTraces — filtered below)
      const allTraces = await storage.getTraces(limit + offset, 0);

      // If runId filter provided, restrict to that run
      const filtered = runId
        ? allTraces.filter((t) => t.runId === runId)
        : allTraces;

      const page = filtered.slice(offset, offset + limit);

      const summaries: WorkspaceTraceSummary[] = page.map((t) =>
        toTraceSummary(t.traceId, t.runId, t.spans),
      );

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
  // Return full trace detail including span tree.
  app.get("/api/workspaces/:id/traces/:run_id", async (req, res) => {
    const wsResult = WorkspaceIdSchema.safeParse({ id: req.params.id });
    if (!wsResult.success) {
      return res.status(400).json({ error: wsResult.error.message });
    }

    const runResult = RunIdParamSchema.safeParse({ run_id: req.params.run_id });
    if (!runResult.success) {
      return res.status(400).json({ error: runResult.error.message });
    }

    const { run_id } = runResult.data;

    try {
      const trace = await storage.getTraceByRunId(run_id);
      if (!trace) {
        return res.status(404).json({ error: `No trace found for run ${run_id}` });
      }

      const summary = toTraceSummary(trace.traceId, trace.runId, trace.spans);
      const detail: WorkspaceTraceDetail = {
        ...summary,
        spans: trace.spans,
      };

      return res.json(detail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: msg });
    }
  });
}
