import { Router } from "express";
import type { IStorage } from "../storage";

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
    if (!model) return res.status(404).json({ message: "Model not found" });
    res.json(model);
  });

  router.post("/api/models", async (req, res) => {
    const model = await storage.createModel(req.body);
    res.status(201).json(model);
  });

  router.patch("/api/models/:id", async (req, res) => {
    try {
      const model = await storage.updateModel(req.params.id, req.body);
      res.json(model);
    } catch (e) {
      res.status(404).json({ message: (e as Error).message });
    }
  });

  router.delete("/api/models/:id", async (req, res) => {
    try {
      await storage.deleteModel(req.params.id);
      res.status(204).end();
    } catch (e) {
      res.status(404).json({ message: (e as Error).message });
    }
  });
}
