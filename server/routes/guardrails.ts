/**
 * Guardrail API routes
 *
 * GET    /api/pipelines/:id/stages/:stageId/guardrails         — list guardrails for stage
 * POST   /api/pipelines/:id/stages/:stageId/guardrails         — add guardrail
 * PUT    /api/pipelines/:id/stages/:stageId/guardrails/:gId    — update guardrail
 * DELETE /api/pipelines/:id/stages/:stageId/guardrails/:gId   — remove guardrail
 * POST   /api/guardrails/test                                  — test guardrail against sample output
 *
 * Stages are stored as JSONB in the pipelines.stages column — no separate table needed.
 * Guardrails are part of each PipelineStageConfig object in that array.
 */
import type { Express } from "express";
import { z } from "zod";
import type { IStorage } from "../storage.js";
import type { Gateway } from "../gateway/index.js";
import { requireRole } from "../auth/middleware.js";
import { GuardrailValidator } from "../pipeline/guardrail-validator.js";
import type { PipelineStageConfig, StageGuardrail } from "@shared/types";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const GuardrailConfigSchema = z.object({
  schema: z.record(z.unknown()).optional(),
  pattern: z.string().max(2000).optional(),
  validatorCode: z.string().max(500).optional(),
  llmPrompt: z.string().max(10000).optional(),
  llmModelSlug: z.string().max(200).optional(),
});

const StageGuardrailSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(["json_schema", "regex", "custom", "llm_check"]),
  config: GuardrailConfigSchema,
  onFail: z.enum(["retry", "skip", "fail", "fallback"]),
  maxRetries: z.number().int().min(0).max(10).default(1),
  fallbackValue: z.string().max(100000).optional(),
  enabled: z.boolean(),
});

const TestGuardrailSchema = z.object({
  guardrail: StageGuardrailSchema,
  sampleOutput: z.string().max(500000),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getStagesByIndex(
  pipeline: { stages: unknown },
  stageId: string,
): { stages: PipelineStageConfig[]; index: number } | null {
  const stages = pipeline.stages as PipelineStageConfig[];
  const index = stages.findIndex((_s, i) => String(i) === stageId);
  if (index === -1) return null;
  return { stages, index };
}

// ─── Route Registration ───────────────────────────────────────────────────────

export function registerGuardrailRoutes(app: Express, storage: IStorage, gateway: Gateway): void {
  const validator = new GuardrailValidator(gateway);

  // GET — list guardrails for a stage
  app.get("/api/pipelines/:id/stages/:stageId/guardrails", async (req, res) => {
    const pipeline = await storage.getPipeline(String(req.params.id));
    if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

    const found = getStagesByIndex(pipeline, String(req.params.stageId));
    if (!found) return res.status(404).json({ error: "Stage not found" });

    const stage = found.stages[found.index];
    return res.json(stage.guardrails ?? []);
  });

  // POST — add a guardrail to a stage
  app.post(
    "/api/pipelines/:id/stages/:stageId/guardrails",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      const pipeline = await storage.getPipeline(String(req.params.id));
      if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

      const found = getStagesByIndex(pipeline, String(req.params.stageId));
      if (!found) return res.status(404).json({ error: "Stage not found" });

      const result = StageGuardrailSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }

      const newGuardrail = result.data as StageGuardrail;
      const stages = [...found.stages];
      const stage = { ...stages[found.index] };
      const existing = stage.guardrails ?? [];

      if (existing.some((g) => g.id === newGuardrail.id)) {
        return res.status(409).json({ error: `Guardrail with id "${newGuardrail.id}" already exists` });
      }

      stage.guardrails = [...existing, newGuardrail];
      stages[found.index] = stage;

      await storage.updatePipeline(String(req.params.id), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stages: stages as unknown as any,
      });

      return res.status(201).json(newGuardrail);
    },
  );

  // PUT — update a guardrail
  app.put(
    "/api/pipelines/:id/stages/:stageId/guardrails/:gId",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      const pipeline = await storage.getPipeline(String(req.params.id));
      if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

      const found = getStagesByIndex(pipeline, String(req.params.stageId));
      if (!found) return res.status(404).json({ error: "Stage not found" });

      const result = StageGuardrailSchema.partial().safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }

      const gId = String(req.params.gId);
      const stages = [...found.stages];
      const stage = { ...stages[found.index] };
      const existing = stage.guardrails ?? [];
      const guardrailIndex = existing.findIndex((g) => g.id === gId);

      if (guardrailIndex === -1) {
        return res.status(404).json({ error: "Guardrail not found" });
      }

      const updatedGuardrail: StageGuardrail = {
        ...existing[guardrailIndex],
        ...result.data,
      } as StageGuardrail;

      stage.guardrails = [
        ...existing.slice(0, guardrailIndex),
        updatedGuardrail,
        ...existing.slice(guardrailIndex + 1),
      ];
      stages[found.index] = stage;

      await storage.updatePipeline(String(req.params.id), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stages: stages as unknown as any,
      });

      return res.json(updatedGuardrail);
    },
  );

  // DELETE — remove a guardrail
  app.delete(
    "/api/pipelines/:id/stages/:stageId/guardrails/:gId",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      const pipeline = await storage.getPipeline(String(req.params.id));
      if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

      const found = getStagesByIndex(pipeline, String(req.params.stageId));
      if (!found) return res.status(404).json({ error: "Stage not found" });

      const gId = String(req.params.gId);
      const stages = [...found.stages];
      const stage = { ...stages[found.index] };
      const existing = stage.guardrails ?? [];

      if (!existing.some((g) => g.id === gId)) {
        return res.status(404).json({ error: "Guardrail not found" });
      }

      stage.guardrails = existing.filter((g) => g.id !== gId);
      stages[found.index] = stage;

      await storage.updatePipeline(String(req.params.id), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stages: stages as unknown as any,
      });

      return res.status(204).end();
    },
  );

  // POST /api/guardrails/test — test a guardrail against sample output (no auth role req)
  app.post("/api/guardrails/test", async (req, res) => {
    const result = TestGuardrailSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }

    const { guardrail, sampleOutput } = result.data;
    const validationResult = await validator.validate(sampleOutput, guardrail as StageGuardrail);

    return res.json({
      passed: validationResult.passed,
      ...(validationResult.reason ? { reason: validationResult.reason } : {}),
    });
  });
}
