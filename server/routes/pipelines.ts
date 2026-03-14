import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";

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

  router.post("/api/pipelines", async (req, res) => {
    const result = CreatePipelineSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.message });
    }
    const pipeline = await storage.createPipeline(result.data);
    res.status(201).json(pipeline);
  });

  router.patch("/api/pipelines/:id", async (req, res) => {
    const result = UpdatePipelineSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.message });
    }
    try {
      const pipeline = await storage.updatePipeline(req.params.id, result.data);
      res.json(pipeline);
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  router.delete("/api/pipelines/:id", async (req, res) => {
    await storage.deletePipeline(req.params.id);
    res.status(204).end();
  });
}
