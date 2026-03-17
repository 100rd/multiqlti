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

  const SwarmPerspectiveSchema = z.object({
    label: z.string().min(1).max(100),
    systemPromptSuffix: z.string().min(1).max(4000),
  });

  const SwarmConfigSchema = z.object({
    enabled: z.boolean(),
    cloneCount: z.number().int().min(2).max(20),
    splitter: z.enum(["chunks", "perspectives", "custom"]),
    merger: z.enum(["concatenate", "llm_merge", "vote"]),
    mergerModelSlug: z.string().min(1).max(200).optional(),
    perspectives: z.array(SwarmPerspectiveSchema).max(20).optional(),
    customClonePrompts: z.array(z.string().min(1).max(8000)).max(20).optional(),
  }).refine(
    (val) => {
      if (val.splitter === "custom") {
        return Array.isArray(val.customClonePrompts) &&
               val.customClonePrompts.length === val.cloneCount;
      }
      return true;
    },
    { message: "customClonePrompts length must equal cloneCount when splitter is 'custom'" },
  );

  const SwarmRouteParamsSchema = z.object({
    id: z.string().min(1).max(100),
    stageIndex: z.coerce.number().int().min(0),
  });

  const SwarmRunParamsSchema = z.object({
    runId: z.string().min(1).max(100),
    stageIndex: z.coerce.number().int().min(0),
  });

  // PATCH /api/pipelines/:id/stages/:stageIndex/swarm — set swarm config
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
      if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

      const stages = (pipeline.stages as Array<Record<string, unknown>>) ?? [];
      if (stageIndex >= stages.length) {
        return res.status(400).json({ error: `stageIndex ${stageIndex} out of range` });
      }

      const bodyResult = SwarmConfigSchema.safeParse(req.body);
      if (!bodyResult.success) {
        return res.status(400).json({ error: "Validation failed", issues: bodyResult.error.issues });
      }

      const stage = stages[stageIndex] as Record<string, unknown>;
      if (stage.parallel && (stage.parallel as Record<string, unknown>).enabled) {
        return res.status(409).json({ error: "Stage has parallel enabled; disable parallel before enabling swarm" });
      }

      stages[stageIndex] = { ...stage, swarm: bodyResult.data };
      const updated = await storage.updatePipeline(id, { stages } as Parameters<typeof storage.updatePipeline>[1]);
      const updatedStages = (updated.stages as unknown[]) ?? [];
      res.json({ stage: updatedStages[stageIndex] });
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
      if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

      const stages = (pipeline.stages as Array<Record<string, unknown>>) ?? [];
      if (stageIndex >= stages.length) {
        return res.status(400).json({ error: `stageIndex ${stageIndex} out of range` });
      }

      const { swarm: _removed, ...rest } = stages[stageIndex] as Record<string, unknown>;
      stages[stageIndex] = rest;
      const updated = await storage.updatePipeline(id, { stages } as Parameters<typeof storage.updatePipeline>[1]);
      const updatedStages = (updated.stages as unknown[]) ?? [];
      res.json({ stage: updatedStages[stageIndex] });
    },
  );

  // GET /api/runs/:runId/stages/:stageIndex/swarm-results — get clone results
  router.get(
    "/api/runs/:runId/stages/:stageIndex/swarm-results",
    async (req, res) => {
      const paramsResult = SwarmRunParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
        return res.status(400).json({ error: "Invalid params", issues: paramsResult.error.issues });
      }
      const { runId, stageIndex } = paramsResult.data;
      const executions = await storage.getStageExecutions(runId);
      const stageExec = executions.find((e) => e.stageIndex === stageIndex);
      if (!stageExec || !stageExec.swarmMeta) {
        return res.status(404).json({ error: "No swarm data found for this stage" });
      }
      res.json({ swarmMeta: stageExec.swarmMeta, cloneResults: stageExec.swarmCloneResults });
    },
  );
}
