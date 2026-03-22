import type { Router } from "express";
import { z } from "zod";
import { LmStudioProvider } from "../gateway/providers/lmstudio";
import type { IStorage } from "../storage";
import type { Gateway } from "../gateway/index";

const DEFAULT_ENDPOINT = "http://localhost:1234";

// In-memory endpoint override. Falls back to LMSTUDIO_ENDPOINT env var or default.
let endpointOverride: string | null = null;

function getEndpoint(): string {
  return endpointOverride ?? process.env.LMSTUDIO_ENDPOINT ?? DEFAULT_ENDPOINT;
}

const ImportSchema = z.object({
  models: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
    }),
  ).min(1),
  endpoint: z.string().url().optional(),
});

const EndpointSchema = z.object({
  endpoint: z.string().url(),
});

export function registerLmStudioRoutes(
  router: Router,
  storage: IStorage,
  gateway: Gateway,
): void {
  /**
   * GET /api/lmstudio/status
   * Check LM Studio connectivity and list loaded models.
   */
  router.get("/api/lmstudio/status", async (_req, res) => {
    const endpoint = getEndpoint();
    const provider = new LmStudioProvider(endpoint);

    try {
      const connected = await provider.healthCheck();
      if (!connected) {
        return res.json({
          connected: false,
          endpoint,
          models: [],
          error: "LM Studio is not reachable at this endpoint",
        });
      }

      const models = await provider.listModels();
      res.json({ connected: true, endpoint, models });
    } catch (err) {
      res.json({
        connected: false,
        endpoint,
        models: [],
        error: (err as Error).message,
      });
    }
  });

  /**
   * POST /api/lmstudio/import
   * Import selected models from LM Studio into the registered models table.
   */
  router.post("/api/lmstudio/import", async (req, res) => {
    const result = ImportSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: result.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    }

    const endpoint = result.data.endpoint ?? getEndpoint();
    const imported: Array<{ slug: string; name: string }> = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const model of result.data.models) {
      const slug = model.id
        .replace(/[^a-z0-9\-]/gi, "-")
        .toLowerCase()
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      try {
        // Check if model already exists
        const existing = await storage.getModelBySlug(slug);
        if (existing) {
          errors.push({ id: model.id, error: `Model "${slug}" already registered` });
          continue;
        }

        await storage.createModel({
          name: model.name,
          slug,
          provider: "lmstudio",
          modelId: model.id,
          endpoint,
          contextLimit: 4096,
          capabilities: ["chat"],
          isActive: true,
        });

        imported.push({ slug, name: model.name });
      } catch (err) {
        errors.push({ id: model.id, error: (err as Error).message });
      }
    }

    // Ensure LM Studio provider is registered in the gateway
    gateway.connectLmStudio(endpoint);

    res.json({ imported, errors });
  });

  /**
   * PUT /api/lmstudio/endpoint
   * Change the LM Studio endpoint URL.
   */
  router.put("/api/lmstudio/endpoint", async (req, res) => {
    const result = EndpointSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: result.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    }

    endpointOverride = result.data.endpoint;

    // Reconnect gateway with new endpoint
    gateway.connectLmStudio(endpointOverride);

    res.json({ endpoint: endpointOverride });
  });
}
