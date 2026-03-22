import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";

const MODEL_PROVIDERS = ["vllm", "ollama", "mock", "anthropic", "google", "xai", "lmstudio"] as const;

const CreateModelSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(200),
  provider: z.enum(MODEL_PROVIDERS).default("mock"),
  modelId: z.string().optional(),
  endpoint: z.string().url().optional().or(z.literal("")).transform(v => v || undefined),
  contextLimit: z.number().int().positive().default(4096),
  capabilities: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
});

const UpdateModelSchema = CreateModelSchema.partial();

export function registerModelRoutes(router: Router, storage: IStorage) {
  router.get("/api/models", async (_req, res) => {
    const models = await storage.getModels();
    res.json(models);
  });

  router.get("/api/models/active", async (_req, res) => {
    const models = await storage.getActiveModels();
    res.json(models);
  });

  router.get("/api/models/:slug", async (req, res) => {
    const model = await storage.getModelBySlug(req.params.slug);
    if (!model) return res.status(404).json({ error: "Model not found" });
    res.json(model);
  });

  router.post("/api/models", async (req, res) => {
    const result = CreateModelSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const model = await storage.createModel(result.data);
    res.status(201).json(model);
  });

  router.patch("/api/models/:id", async (req, res) => {
    const result = UpdateModelSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    try {
      const model = await storage.updateModel(req.params.id, result.data);
      res.json(model);
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  router.delete("/api/models/:id", async (req, res) => {
    try {
      await storage.deleteModel(req.params.id);
      res.status(204).end();
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });
}
