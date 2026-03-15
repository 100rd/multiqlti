import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import { requireRole, requireOwnerOrRole } from "../auth/middleware";

const PipelineStageConfigSchema = z.object({
  teamId: z.string().min(1),
  modelSlug: z.string().min(1),
  systemPromptOverride: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  enabled: z.boolean(),
});

const CreatePipelineSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  stages: z.array(PipelineStageConfigSchema).default([]),
  createdBy: z.string().optional(),
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
        return res.status(400).json({ error: result.error.message });
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
        return res.status(400).json({ error: result.error.message });
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
