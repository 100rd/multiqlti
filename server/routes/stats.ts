import type { Express } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";

const filtersSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  model: z.string().optional(),
  provider: z.string().optional(),
  runId: z.string().optional(),
  status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

// Separate schema for export with higher limit ceiling
const exportFiltersSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(5000).optional().default(5000),
  model: z.string().optional(),
  provider: z.string().optional(),
  runId: z.string().optional(),
  status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const timelineSchema = z.object({
  granularity: z.enum(["day", "week"]).optional().default("day"),
  from: z.string().optional(),
  to: z.string().optional(),
});

const exportFormatSchema = z.object({
  format: z.enum(["csv", "json"]).optional().default("json"),
});

export function registerStatsRoutes(app: Express, storage: IStorage): void {

  // GET /api/stats/overview
  app.get("/api/stats/overview", async (_req, res) => {
    try {
      const [llmStats, allRuns] = await Promise.all([
        storage.getLlmRequestStats(),
        storage.getPipelineRuns(),
      ]);
      res.json({
        totalRequests: llmStats.totalRequests,
        totalTokens: {
          input: llmStats.totalInputTokens,
          output: llmStats.totalOutputTokens,
          total: llmStats.totalInputTokens + llmStats.totalOutputTokens,
        },
        totalCostUsd: llmStats.totalCostUsd,
        totalRuns: allRuns.length,
      });
    } catch (err) {
      console.error("/api/stats/overview error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/stats/by-model
  app.get("/api/stats/by-model", async (_req, res) => {
    try {
      const stats = await storage.getLlmStatsByModel();
      res.json(stats);
    } catch (err) {
      console.error("/api/stats/by-model error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/stats/by-provider
  app.get("/api/stats/by-provider", async (_req, res) => {
    try {
      const stats = await storage.getLlmStatsByProvider();
      res.json(stats);
    } catch (err) {
      console.error("/api/stats/by-provider error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/stats/by-team
  app.get("/api/stats/by-team", async (_req, res) => {
    try {
      const stats = await storage.getLlmStatsByTeam();
      res.json(stats);
    } catch (err) {
      console.error("/api/stats/by-team error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/stats/timeline
  app.get("/api/stats/timeline", async (req, res) => {
    try {
      const parsed = timelineSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      const { granularity, from, to } = parsed.data;
      const now = new Date();
      const fromDate = from ? new Date(from) : new Date(now.getTime() - 30 * 86_400_000);
      const toDate = to ? new Date(to) : now;

      const timeline = await storage.getLlmTimeline(fromDate, toDate, granularity);
      res.json(timeline);
    } catch (err) {
      console.error("/api/stats/timeline error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/stats/requests — paginated request log
  app.get("/api/stats/requests", async (req, res) => {
    try {
      const parsed = filtersSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      const { page, limit, model, provider, runId, status, from, to } = parsed.data;

      const result = await storage.getLlmRequests({
        page,
        limit,
        modelSlug: model,
        provider,
        runId,
        status,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
      });

      // Strip messages/responseContent from list view for safety
      const sanitizedRows = result.rows.map(({ messages: _m, responseContent: _r, ...rest }) => rest);

      res.json({ rows: sanitizedRows, total: result.total, page, limit });
    } catch (err) {
      console.error("/api/stats/requests error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/stats/requests/:id — full request detail
  app.get("/api/stats/requests/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid request ID" });
        return;
      }
      const request = await storage.getLlmRequestById(id);
      if (!request) {
        res.status(404).json({ error: "Request not found" });
        return;
      }
      res.json(request);
    } catch (err) {
      console.error("/api/stats/requests/:id error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/stats/export — CSV or JSON download
  app.post("/api/stats/export", async (req, res) => {
    try {
      const formatParsed = exportFormatSchema.safeParse(req.query);
      const format = formatParsed.success ? formatParsed.data.format : "json";

      // Parse body filters with high limit ceiling for export
      const bodyParsed = exportFiltersSchema.safeParse({ ...req.body, limit: 5000, page: 1 });
      const filterData = bodyParsed.success ? bodyParsed.data : { page: 1, limit: 5000 };

      const { rows } = await storage.getLlmRequests({
        page: filterData.page,
        limit: filterData.limit,
        modelSlug: filterData.model,
        provider: filterData.provider,
        runId: filterData.runId,
        status: filterData.status,
        from: filterData.from ? new Date(filterData.from) : undefined,
        to: filterData.to ? new Date(filterData.to) : undefined,
      });

      if (format === "csv") {
        const cols = [
          "id", "createdAt", "modelSlug", "provider", "teamId",
          "inputTokens", "outputTokens", "totalTokens",
          "estimatedCostUsd", "latencyMs", "status",
        ] as const;
        const csvRows = rows.map((r) =>
          cols.map((c) => {
            const val = r[c as keyof typeof r];
            const str = val === null || val === undefined ? "" : String(val);
            return `"${str.replace(/"/g, '""')}"`;
          }).join(",")
        );
        const csv = [cols.join(","), ...csvRows].join("\n");

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", "attachment; filename=llm_requests.csv");
        res.send(csv);
      } else {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", "attachment; filename=llm_requests.json");
        // Strip messages/response for bulk export
        const sanitized = rows.map(({ messages: _m, responseContent: _r, ...rest }) => rest);
        res.json(sanitized);
      }
    } catch (err) {
      console.error("/api/stats/export error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/runs/:runId/stages/:stageIndex/thought-tree
  // Requires authentication + run ownership (or admin role).
  app.get("/api/runs/:runId/stages/:stageIndex/thought-tree", async (req, res) => {
    try {
      // C1: Authentication check
      if (!req.user?.id) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const { runId, stageIndex } = req.params;
      const idx = parseInt(stageIndex, 10);
      if (isNaN(idx)) {
        res.status(400).json({ error: "Invalid stage index" });
        return;
      }

      // C2: Ownership check — look up run → pipeline → ownerId
      const run = await storage.getPipelineRun(runId);
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      const pipeline = await storage.getPipeline(run.pipelineId);
      if (pipeline && pipeline.ownerId != null) {
        const isOwner = pipeline.ownerId === req.user.id;
        const isAdmin = req.user?.role === "admin";
        if (!isOwner && !isAdmin) {
          res.status(403).json({ error: "Forbidden: you do not own this pipeline" });
          return;
        }
      }

      const executions = await storage.getStageExecutions(runId);
      const exec = executions.find((e) => e.stageIndex === idx);
      if (!exec) {
        res.status(404).json({ error: "Stage execution not found" });
        return;
      }

      const thoughtTree = exec.thoughtTree ?? [];
      res.json(thoughtTree);
    } catch (err) {
      console.error("/api/runs/:runId/stages/:stageIndex/thought-tree error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}
