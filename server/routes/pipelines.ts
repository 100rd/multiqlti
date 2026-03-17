import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { Gateway } from "../gateway/index";
import { requireRole, requireOwnerOrRole } from "../auth/middleware";
import { SwarmConfigSchema } from "@shared/types";

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

export function registerPipelineRoutes(router: Router, storage: IStorage, gateway?: Gateway) {
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

  // ─── Manager Config Endpoints (Phase 6.6) ───────────────────────────────────

  const ManagerConfigSchema = z.object({
    managerModel: z.string().min(1).max(200),
    availableTeams: z.array(z.string().min(1).max(100)).min(1).max(50),
    maxIterations: z.number().int().min(1).max(20),
    goal: z.string().min(1).max(10000),
  });

  // PATCH /api/pipelines/:id/manager-config — set manager mode config (maintainer or admin)
  router.patch(
    "/api/pipelines/:id/manager-config",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      const id = String(req.params.id);
      const pipeline = await storage.getPipeline(id);
      if (!pipeline) {
        return res.status(404).json({ error: "Pipeline not found" });
      }
      const result = ManagerConfigSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: "Validation failed", issues: result.error.issues });
      }
      // H3: Validate managerModel is an active model in the system
      // Skip validation if no models are configured (development/test environments)
      const activeModels = await storage.getActiveModels();
      if (activeModels.length > 0) {
        const validSlugs = activeModels.map((m) => m.slug);
        if (!validSlugs.includes(result.data.managerModel)) {
          return res.status(400).json({
            error: `Validation failed: managerModel "${result.data.managerModel}" is not an active model. Valid options: ${validSlugs.join(", ")}`,
          });
        }
      }
      const updated = await storage.updatePipeline(id, {
        managerConfig: result.data,
      } as Parameters<typeof storage.updatePipeline>[1]);
      res.json(updated);
    },
  );

  // DELETE /api/pipelines/:id/manager-config — disable manager mode (maintainer or admin)
  router.delete(
    "/api/pipelines/:id/manager-config",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      const id = String(req.params.id);
      const pipeline = await storage.getPipeline(id);
      if (!pipeline) {
        return res.status(404).json({ error: "Pipeline not found" });
      }
      const updated = await storage.updatePipeline(id, {
        managerConfig: null,
      } as Parameters<typeof storage.updatePipeline>[1]);
      res.json(updated);
    },
  );

  // ─── Swarm Config Endpoints (Phase 6.7) ─────────────────────────────────────

  const SwarmRouteParamsSchema = z.object({
    id: z.string().min(1).max(100),
    stageIndex: z.coerce.number().int().min(0).max(99),
  });

  const SwarmRunParamsSchema = z.object({
    runId: z.string().min(1).max(100),
    stageIndex: z.coerce.number().int().min(0).max(99),
  });

  const GeneratePerspectivesBodySchema = z.object({
    stageDescription: z.string().min(1).max(500),
    cloneCount: z.number().int().min(2).max(20).optional().default(3),
  });

  // PATCH /api/pipelines/:id/stages/:stageIndex/swarm — set/update swarm config
  router.patch(
    "/api/pipelines/:id/stages/:stageIndex/swarm",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      const paramsResult = SwarmRouteParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
        return res.status(400).json({ error: "Invalid params", issues: paramsResult.error.issues });
      }
      const { id, stageIndex } = paramsResult.data;

      const pipeline = await storage.getPipeline(id);
      if (!pipeline) {
        return res.status(404).json({ error: "Pipeline not found" });
      }

      const stages = pipeline.stages as import("@shared/types").PipelineStageConfig[];
      if (stageIndex < 0 || stageIndex >= stages.length) {
        return res.status(400).json({ error: `stageIndex ${stageIndex} is out of range (pipeline has ${stages.length} stages)` });
      }

      const stage = stages[stageIndex];
      if (stage.parallel?.enabled) {
        return res.status(409).json({ error: "Stage has parallel execution enabled. Disable parallel before enabling swarm." });
      }

      const bodyResult = SwarmConfigSchema.safeParse(req.body);
      if (!bodyResult.success) {
        return res.status(400).json({ error: "Validation failed", issues: bodyResult.error.issues });
      }

      const updatedStages = [...stages];
      updatedStages[stageIndex] = { ...stage, swarm: bodyResult.data };

      const updated = await storage.updatePipeline(id, { stages: updatedStages } as Parameters<typeof storage.updatePipeline>[1]);
      res.json({ stage: (updated.stages as import("@shared/types").PipelineStageConfig[])[stageIndex] });
    },
  );

  // DELETE /api/pipelines/:id/stages/:stageIndex/swarm — remove swarm config
  router.delete(
    "/api/pipelines/:id/stages/:stageIndex/swarm",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      const paramsResult = SwarmRouteParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
        return res.status(400).json({ error: "Invalid params", issues: paramsResult.error.issues });
      }
      const { id, stageIndex } = paramsResult.data;

      const pipeline = await storage.getPipeline(id);
      if (!pipeline) {
        return res.status(404).json({ error: "Pipeline not found" });
      }

      const stages = pipeline.stages as import("@shared/types").PipelineStageConfig[];
      if (stageIndex < 0 || stageIndex >= stages.length) {
        return res.status(400).json({ error: `stageIndex ${stageIndex} is out of range` });
      }

      const stage = stages[stageIndex];
      const updatedStage = { ...stage };
      delete updatedStage.swarm;

      const updatedStages = [...stages];
      updatedStages[stageIndex] = updatedStage;

      const updated = await storage.updatePipeline(id, { stages: updatedStages } as Parameters<typeof storage.updatePipeline>[1]);
      res.json({ stage: (updated.stages as import("@shared/types").PipelineStageConfig[])[stageIndex] });
    },
  );

  // GET /api/runs/:runId/stages/:stageIndex/swarm-results — get per-clone results
  router.get(
    "/api/runs/:runId/stages/:stageIndex/swarm-results",
    async (req, res) => {
      const paramsResult = SwarmRunParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
        return res.status(400).json({ error: "Invalid params", issues: paramsResult.error.issues });
      }
      const { runId, stageIndex } = paramsResult.data;

      // Ownership check
      const run = await storage.getPipelineRun(runId);
      if (!run) {
        return res.status(404).json({ error: "Run not found" });
      }
      const userId = req.user?.id;
      const isAdmin = req.user?.role === "admin";
      if (!isAdmin && run.triggeredBy && run.triggeredBy !== userId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const executions = await storage.getStageExecutions(runId);
      const stageExec = executions.find((e) => e.stageIndex === stageIndex);
      if (!stageExec || !stageExec.swarmMeta) {
        return res.status(404).json({ error: "No swarm data for this stage" });
      }

      res.json({
        swarmMeta: stageExec.swarmMeta,
        cloneResults: stageExec.swarmCloneResults ?? [],
      });
    },
  );

  // POST /api/pipelines/:id/stages/:stageIndex/swarm/generate-perspectives
  router.post(
    "/api/pipelines/:id/stages/:stageIndex/swarm/generate-perspectives",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      const paramsResult = SwarmRouteParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
        return res.status(400).json({ error: "Invalid params", issues: paramsResult.error.issues });
      }
      const { id, stageIndex } = paramsResult.data;

      const pipeline = await storage.getPipeline(id);
      if (!pipeline) {
        return res.status(404).json({ error: "Pipeline not found" });
      }

      const stages = pipeline.stages as import("@shared/types").PipelineStageConfig[];
      if (stageIndex < 0 || stageIndex >= stages.length) {
        return res.status(400).json({ error: `stageIndex ${stageIndex} is out of range` });
      }

      const bodyResult = GeneratePerspectivesBodySchema.safeParse(req.body);
      if (!bodyResult.success) {
        return res.status(400).json({ error: "Validation failed", issues: bodyResult.error.issues });
      }
      const { stageDescription, cloneCount } = bodyResult.data;

      if (!gateway) {
        return res.status(503).json({ error: "Gateway not available" });
      }

      const stage = stages[stageIndex];
      const modelSlug = (stage.swarm?.mergerModelSlug) ?? stage.modelSlug;
      const n = cloneCount ?? 3;

      const prompt = `Generate ${n} distinct expert review perspectives for a stage described as: ${stageDescription}. Output JSON: [{"label": "...", "systemPromptSuffix": "..."}]`;

      try {
        const response = await gateway.complete({
          modelSlug,
          messages: [{ role: "user", content: prompt }],
          maxTokens: 1000,
        });

        let perspectives: import("@shared/types").SwarmPerspective[] = [];
        const match = response.content.match(/\[[\s\S]*\]/);
        if (match) {
          try {
            const parsed = JSON.parse(match[0]) as unknown;
            if (Array.isArray(parsed)) {
              perspectives = parsed
                .filter(
                  (p): p is import("@shared/types").SwarmPerspective =>
                    typeof p === "object" &&
                    p !== null &&
                    typeof (p as Record<string, unknown>).label === "string" &&
                    typeof (p as Record<string, unknown>).systemPromptSuffix === "string",
                )
                .slice(0, n);
            }
          } catch {
            // Parse failed — return generic
          }
        }

        if (perspectives.length < n) {
          for (let i = perspectives.length; i < n; i++) {
            perspectives.push({
              label: `Perspective ${i + 1}`,
              systemPromptSuffix: `Analyze this from perspective ${i + 1} of ${n}, focusing on a unique angle.`,
            });
          }
        }

        res.json({ perspectives });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );
}
