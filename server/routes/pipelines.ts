import { Router } from "express";
import type { IStorage } from "../storage";

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
      return res.status(404).json({ message: "Pipeline not found" });
    res.json(pipeline);
  });

  router.post("/api/pipelines", async (req, res) => {
    const pipeline = await storage.createPipeline(req.body);
    res.status(201).json(pipeline);
  });

  router.patch("/api/pipelines/:id", async (req, res) => {
    try {
      const pipeline = await storage.updatePipeline(req.params.id, req.body);
      res.json(pipeline);
    } catch (e) {
      res.status(404).json({ message: (e as Error).message });
    }
  });

  router.delete("/api/pipelines/:id", async (req, res) => {
    await storage.deletePipeline(req.params.id);
    res.status(204).end();
  });
}
