import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { InsertModelSkillBinding } from "@shared/schema";
import { DEFAULT_MODELS } from "@shared/constants";

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Allowed model IDs: the modelId field from DEFAULT_MODELS plus any
 * slug-based identifiers. We build a Set of accepted values at startup.
 *
 * Pattern prefixes are also accepted for self-hosted (ollama/*, vllm/*).
 */
const KNOWN_MODEL_ID_SET = new Set<string>(
  DEFAULT_MODELS.flatMap((m) => {
    const ids: string[] = [m.slug];
    if ("modelId" in m && m.modelId) ids.push(m.modelId as string);
    return ids;
  }),
);

const DYNAMIC_MODEL_PATTERNS: RegExp[] = [
  /^ollama\/.+/,
  /^vllm\/.+/,
];

function isValidModelId(modelId: string): boolean {
  if (KNOWN_MODEL_ID_SET.has(modelId)) return true;
  return DYNAMIC_MODEL_PATTERNS.some((p) => p.test(modelId));
}

const ModelIdParamSchema = z.string().min(1).max(200).refine(
  (v) => isValidModelId(v),
  { message: "Unknown or disallowed model ID" },
);

const SkillIdParamSchema = z.string().uuid({ message: "skillId must be a valid UUID" });

// ─── Helper ──────────────────────────────────────────────────────────────────

function isOwnerOrAdmin(skillCreatedBy: string, req: Request): boolean {
  const user = req.user;
  if (!user) return false;
  if (user.role === "admin") return true;
  return skillCreatedBy === user.id;
}

// ─── Route Registration ──────────────────────────────────────────────────────

export function registerModelSkillBindingRoutes(app: Express, storage: IStorage): void {
  /**
   * GET /api/skills/models
   * List all distinct model IDs that have at least one skill binding.
   * Requires auth (enforced by middleware in routes.ts).
   */
  app.get("/api/skills/models", async (_req: Request, res: Response) => {
    const modelIds = await storage.getModelsWithSkillBindings();
    res.json(modelIds);
  });

  /**
   * GET /api/skills/models/:modelId
   * List all skills bound to the given model.
   */
  app.get("/api/skills/models/:modelId", async (req: Request, res: Response) => {
    const parsed = ModelIdParamSchema.safeParse(req.params.modelId);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid modelId" });
    }

    const skills = await storage.resolveSkillsForModel(parsed.data);
    res.json(skills);
  });

  /**
   * POST /api/skills/models/:modelId/:skillId
   * Bind a skill to a model.
   * Requires: admin OR skill owner.
   */
  app.post("/api/skills/models/:modelId/:skillId", async (req: Request, res: Response) => {
    const modelParsed = ModelIdParamSchema.safeParse(req.params.modelId);
    if (!modelParsed.success) {
      return res.status(400).json({ error: modelParsed.error.errors[0]?.message ?? "Invalid modelId" });
    }

    const skillParsed = SkillIdParamSchema.safeParse(req.params.skillId);
    if (!skillParsed.success) {
      return res.status(400).json({ error: skillParsed.error.errors[0]?.message ?? "Invalid skillId" });
    }

    // Verify skill exists (returns 404 rather than FK 500)
    const skill = await storage.getSkill(skillParsed.data);
    if (!skill) {
      return res.status(404).json({ error: "Skill not found" });
    }

    // Authorization: admin or owner
    if (!isOwnerOrAdmin(skill.createdBy, req)) {
      return res.status(403).json({ error: "Forbidden -- must be skill owner or admin" });
    }

    try {
      const data: InsertModelSkillBinding = {
        modelId: modelParsed.data,
        skillId: skillParsed.data,
        createdBy: req.user?.id ?? null,
      };
      const binding = await storage.createModelSkillBinding(data);
      res.status(201).json(binding);
    } catch (err) {
      // Unique constraint violation → 409
      const code = (err as NodeJS.ErrnoException).code;
      const message = err instanceof Error ? err.message : "";
      if (code === "23505" || message.includes("unique") || message.includes("Unique")) {
        return res.status(409).json({ error: "Skill is already bound to this model" });
      }
      throw err;
    }
  });

  /**
   * DELETE /api/skills/models/:modelId/:skillId
   * Unbind a skill from a model.
   * Requires: admin OR skill owner.
   */
  app.delete("/api/skills/models/:modelId/:skillId", async (req: Request, res: Response) => {
    const modelParsed = ModelIdParamSchema.safeParse(req.params.modelId);
    if (!modelParsed.success) {
      return res.status(400).json({ error: modelParsed.error.errors[0]?.message ?? "Invalid modelId" });
    }

    const skillParsed = SkillIdParamSchema.safeParse(req.params.skillId);
    if (!skillParsed.success) {
      return res.status(400).json({ error: skillParsed.error.errors[0]?.message ?? "Invalid skillId" });
    }

    // Verify skill exists
    const skill = await storage.getSkill(skillParsed.data);
    if (!skill) {
      return res.status(404).json({ error: "Skill not found" });
    }

    // Authorization: admin or owner
    if (!isOwnerOrAdmin(skill.createdBy, req)) {
      return res.status(403).json({ error: "Forbidden -- must be skill owner or admin" });
    }

    try {
      await storage.deleteModelSkillBinding(modelParsed.data, skillParsed.data);
      res.status(204).end();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("not found")) {
        return res.status(404).json({ error: "Binding not found" });
      }
      throw err;
    }
  });
}
