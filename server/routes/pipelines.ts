import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import { requireRole, requireOwnerOrRole } from "../auth/middleware";

const ParallelConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["auto", "manual"]),
  maxAgents: z.number().int().min(1).max(10),
  splitterModelSlug: z.string().max(200).optional(),
  mergerModelSlug: z.string().max(200).optional(),
  mergeStrategy: z.enum(["concatenate", "review", "auto"]),
}).optional();

const PipelineStageConfigSchema = z.object({
  teamId: z.string().min(1).max(100),
  modelSlug: z.string().min(1).max(200),
  systemPromptOverride: z.string().max(50000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(100000).optional(),
  enabled: z.boolean(),
  approvalRequired: z.boolean().optional(),
  parallel: ParallelConfigSchema,
}).passthrough();

const CreatePipelineSchema = z.object({
  name: z.string().min(1).max(100).transform((s) => s.replace(/<[^>]*>/g, "").trim()),
  description: z.string().max(2000).optional().transform((s) => s?.replace(/<[^>]*>/g, "").trim()),
  stages: z.array(PipelineStageConfigSchema).max(50).default([]),
  createdBy: z.string().max(100).optional(),
  isTemplate: z.boolean().optional(),
});

const UpdatePipelineSchema = CreatePipelineSchema.partial();

export function registerPipelineRoutes(router: Router, storage: IStorage) {
  // GET /api/pipelines — any authenticated user (requireAuth already applied globally)
  router.get("/api/pipelines", async (_req, res) => {
    const pipelines = await storage.getPipelines();
    res.json(pipelines);
  });

  router.get("/api/pipelines/templates", async (_req, res) => {
    const templates = await storage.getTemplates();
    res.json(templates);
  });

  router.get("/api/pipelines/:id", async (req, res) => {
    const pipeline = await storage.getPipeline(req.params.id);
    if (!pipeline)
      return res.status(404).json({ error: "Pipeline not found" });
    res.json(pipeline);
  });

  // POST /api/pipelines — maintainer or admin only
  router.post(
    "/api/pipelines",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      const result = CreatePipelineSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
      const ownerId = req.user?.id;
      const pipeline = await storage.createPipeline({
        ...result.data,
        ownerId: ownerId ?? null,
      });
      res.status(201).json(pipeline);
    },
  );

  // PATCH /api/pipelines/:id — owner or admin
  router.patch("/api/pipelines/:id", async (req, res, next) => {
    // Look up pipeline owner first, then apply ownership check
    const pipeline = await storage.getPipeline(req.params.id);
    if (!pipeline) {
      return res.status(404).json({ error: "Pipeline not found" });
    }

    const ownerId = pipeline.ownerId;
    const middleware = requireOwnerOrRole(() => ownerId, "admin");
    middleware(req, res, async () => {
      const result = UpdatePipelineSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
      try {
        const updated = await storage.updatePipeline(req.params.id, result.data);
        res.json(updated);
      } catch (e) {
        res.status(404).json({ error: (e as Error).message });
      }
    });
  });

  // DELETE /api/pipelines/:id — owner or admin
  router.delete("/api/pipelines/:id", async (req, res) => {
    const pipeline = await storage.getPipeline(req.params.id);
    if (!pipeline) {
      return res.status(404).json({ error: "Pipeline not found" });
    }

    const ownerId = pipeline.ownerId;
    const middleware = requireOwnerOrRole(() => ownerId, "admin");
    middleware(req, res, async () => {
      await storage.deletePipeline(req.params.id);
      res.status(204).end();
    });
  });
}
