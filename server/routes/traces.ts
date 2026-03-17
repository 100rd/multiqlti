// server/routes/traces.ts
import { z } from "zod";
import type { Express } from "express";
import type { IStorage } from "../storage";

// ─── Zod Validation Schemas ──────────────────────────────────────────────────

const RunIdParamSchema = z.object({
  runId: z.string().uuid("runId must be a valid UUID"),
});

const TraceIdParamSchema = z.object({
  traceId: z.string().min(1).max(64).regex(/^[0-9a-f]{1,64}$/, "traceId must be a hex string"),
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
});

// ─── Route Registration ───────────────────────────────────────────────────────

export function registerTraceRoutes(app: Express, storage: IStorage): void {
  // GET /api/runs/:runId/trace
  app.get("/api/runs/:runId/trace", async (req, res) => {
    const paramResult = RunIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      return res.status(400).json({ error: paramResult.error.message });
    }
    const { runId } = paramResult.data;
    try {
      const trace = await storage.getTraceByRunId(runId);
      if (!trace) {
        return res.status(404).json({ error: `No trace found for run ${runId}` });
      }
      res.json(trace);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/traces
  app.get("/api/traces", async (req, res) => {
    const queryResult = ListTracesQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: queryResult.error.message });
    }
    const { limit, offset } = queryResult.data;
    try {
      const traceList = await storage.getTraces(limit, offset);
      res.json({ traces: traceList, total: traceList.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/traces/:traceId
  app.get("/api/traces/:traceId", async (req, res) => {
    const paramResult = TraceIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      return res.status(400).json({ error: paramResult.error.message });
    }
    try {
      const trace = await storage.getTraceByTraceId(paramResult.data.traceId);
      if (!trace) {
        return res.status(404).json({ error: `Trace not found: ${paramResult.data.traceId}` });
      }
      res.json(trace);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      res.status(500).json({ error: msg });
    }
  });
}
