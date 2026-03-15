import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import { EXECUTION_STRATEGY_PRESETS } from "@shared/constants";
import type { ExecutionStrategy, PipelineStageConfig, TeamId } from "@shared/types";

// ─── Zod schemas for input validation ────────────────────────────────────────

const ProposerConfigSchema = z.object({
  modelSlug: z.string().min(1).max(200),
  role: z.string().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const AggregatorConfigSchema = z.object({
  modelSlug: z.string().min(1).max(200),
  systemPrompt: z.string().max(10000).optional(),
});

const MoaStrategySchema = z.object({
  type: z.literal("moa"),
  proposers: z.array(ProposerConfigSchema).min(1).max(5),
  aggregator: AggregatorConfigSchema,
  proposerPromptOverride: z.string().max(10000).optional(),
});

const DebateParticipantSchema = z.object({
  modelSlug: z.string().min(1).max(200),
  role: z.enum(["proposer", "critic", "devil_advocate"]),
  persona: z.string().max(500).optional(),
});

const JudgeConfigSchema = z.object({
  modelSlug: z.string().min(1).max(200),
  criteria: z.array(z.string().max(500)).max(20).optional(),
});

const DebateStrategySchema = z.object({
  type: z.literal("debate"),
  participants: z.array(DebateParticipantSchema).min(2).max(20),
  judge: JudgeConfigSchema,
  rounds: z.number().int().min(1).max(5),
  stopEarly: z.boolean().optional(),
});

const CandidateConfigSchema = z.object({
  modelSlug: z.string().min(1).max(200),
  temperature: z.number().min(0).max(2).optional(),
});

const VotingStrategySchema = z.object({
  type: z.literal("voting"),
  candidates: z.array(CandidateConfigSchema).min(2).max(7),
  threshold: z.number().min(0.5).max(1.0),
  validationMode: z.enum(["text_similarity", "test_execution"]),
});

const SingleStrategySchema = z.object({ type: z.literal("single") });

const ExecutionStrategySchema = z.discriminatedUnion("type", [
  SingleStrategySchema,
  MoaStrategySchema,
  DebateStrategySchema,
  VotingStrategySchema,
]);

export function registerStrategyRoutes(router: Router, storage: IStorage): void {
  // GET /api/strategies/presets — return named execution strategy presets
  router.get("/api/strategies/presets", (_req, res) => {
    res.json(EXECUTION_STRATEGY_PRESETS);
  });

  // PATCH /api/pipelines/:id/stages/:stageIndex/strategy — update strategy for a stage
  router.patch(
    "/api/pipelines/:id/stages/:stageIndex/strategy",
    async (req, res) => {
      const pipelineId = req.params.id;
      const stageIndex = parseInt(req.params.stageIndex, 10);

      if (isNaN(stageIndex) || stageIndex < 0) {
        return res.status(400).json({ error: "Invalid stageIndex" });
      }

      const parseResult = ExecutionStrategySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: "Validation failed",
          issues: parseResult.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }

      const strategy = parseResult.data as ExecutionStrategy;

      const pipeline = await storage.getPipeline(pipelineId);
      if (!pipeline) {
        return res.status(404).json({ error: "Pipeline not found" });
      }

      const stages = pipeline.stages as PipelineStageConfig[];
      if (stageIndex >= stages.length) {
        return res.status(400).json({ error: "Stage index out of bounds" });
      }

      const updatedStages = stages.map((s, idx) => {
        if (idx !== stageIndex) return s;
        if (strategy.type === "single") {
          const { executionStrategy: _removed, ...rest } = s as PipelineStageConfig & { executionStrategy?: ExecutionStrategy };
          return rest as PipelineStageConfig;
        }
        return { ...s, executionStrategy: strategy };
      });

      const updated = await storage.updatePipeline(pipelineId, { stages: updatedStages });
      res.json(updated);
    },
  );

  // PATCH /api/pipelines/:id/execution-preset — apply a named execution strategy preset
  router.patch("/api/pipelines/:id/execution-preset", async (req, res) => {
    const schema = z.object({ presetId: z.string().min(1) });
    const parseResult = schema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: parseResult.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }

    const preset = EXECUTION_STRATEGY_PRESETS.find((p) => p.id === parseResult.data.presetId);
    if (!preset) {
      return res.status(404).json({ error: "Execution strategy preset not found" });
    }

    const pipeline = await storage.getPipeline(req.params.id);
    if (!pipeline) {
      return res.status(404).json({ error: "Pipeline not found" });
    }

    const stages = pipeline.stages as PipelineStageConfig[];
    const updatedStages = stages.map((s) => {
      const stageStrategy = preset.stageStrategies[s.teamId as TeamId];
      if (!stageStrategy) {
        // No override — reset to single
        const { executionStrategy: _removed, ...rest } = s as PipelineStageConfig & { executionStrategy?: ExecutionStrategy };
        return rest as PipelineStageConfig;
      }
      return { ...s, executionStrategy: stageStrategy };
    });

    const updated = await storage.updatePipeline(req.params.id, { stages: updatedStages });
    res.json(updated);
  });
}
