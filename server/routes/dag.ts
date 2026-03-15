/**
 * DAG API Routes — Phase 6.2
 *
 * GET  /api/pipelines/:id/dag          — retrieve DAG config (null if not set)
 * PUT  /api/pipelines/:id/dag          — replace entire DAG (maintainer|admin)
 * POST /api/pipelines/:id/dag/validate — validate DAG structure without saving
 */
import type { Express } from "express";
import { z } from "zod";
import type { IStorage } from "../storage.js";
import { requireRole } from "../auth/middleware.js";
import { validateBody } from "../middleware/validate.js";
import { validateDAGStructure } from "../pipeline/dag-validator.js";
import type { PipelineDAG } from "@shared/types";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const DAGConditionSchema = z.object({
  field: z
    .string()
    .min(1)
    .max(150)
    .regex(
      /^[a-zA-Z0-9_]{1,50}(\.[a-zA-Z0-9_]{1,50}){0,2}$/,
      "Field path must be alphanumeric+underscore segments separated by dots (max 3 levels)",
    ),
  operator: z.enum(["eq", "neq", "gt", "lt", "contains", "exists"]),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]).optional(),
});

const DAGEdgeSchema = z.object({
  id: z.string().min(1).max(100),
  from: z.string().min(1).max(100),
  to: z.string().min(1).max(100),
  condition: DAGConditionSchema.optional(),
  label: z.string().max(200).optional(),
});

const DAGStageSchema = z
  .object({
    id: z.string().min(1).max(100),
    teamId: z.string().min(1).max(100),
    modelSlug: z.string().min(1).max(200),
    systemPromptOverride: z.string().max(50000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(100000).optional(),
    enabled: z.boolean(),
    approvalRequired: z.boolean().optional(),
    skillId: z.string().max(200).optional(),
    position: z.object({
      x: z.number(),
      y: z.number(),
    }),
    label: z.string().max(200).optional(),
  })
  .passthrough();

export const PipelineDAGSchema = z
  .object({
    stages: z.array(DAGStageSchema).min(1).max(50),
    edges: z.array(DAGEdgeSchema).max(200),
  })
  .refine(
    (dag) => {
      const stageIds = new Set(dag.stages.map((s) => s.id));
      return dag.edges.every((e) => stageIds.has(e.from) && stageIds.has(e.to));
    },
    { message: "All edge from/to values must reference existing stage IDs" },
  );

// ─── Route Registration ───────────────────────────────────────────────────────

export function registerDAGRoutes(app: Express, storage: IStorage): void {
  // GET /api/pipelines/:id/dag — any authenticated user
  app.get("/api/pipelines/:id/dag", async (req, res) => {
    const pipeline = await storage.getPipeline(req.params.id as string);
    if (!pipeline) {
      return res.status(404).json({ error: "Pipeline not found" });
    }
    res.json(pipeline.dag ?? null);
  });

  // PUT /api/pipelines/:id/dag — maintainer or admin only
  app.put(
    "/api/pipelines/:id/dag",
    requireRole("maintainer", "admin"),
    validateBody(PipelineDAGSchema),
    async (req, res) => {
      const pipeline = await storage.getPipeline(req.params.id as string);
      if (!pipeline) {
        return res.status(404).json({ error: "Pipeline not found" });
      }

      const dag = req.body as PipelineDAG;
      const validation = validateDAGStructure(dag);
      if (!validation.ok) {
        return res.status(422).json({ error: "Invalid DAG structure", reason: validation.reason });
      }

      await storage.updatePipeline(req.params.id as string, { dag });
      res.json({ ok: true });
    },
  );

  // POST /api/pipelines/:id/dag/validate — any authenticated user
  app.post("/api/pipelines/:id/dag/validate", async (req, res) => {
    const result = PipelineDAGSchema.safeParse(req.body);
    if (!result.success) {
      return res.json({
        valid: false,
        issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }

    const validation = validateDAGStructure(result.data as PipelineDAG);
    if (!validation.ok) {
      return res.json({ valid: false, issues: [{ path: [], message: validation.reason }] });
    }

    res.json({ valid: true });
  });
}
