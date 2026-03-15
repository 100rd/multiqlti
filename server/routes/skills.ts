import type { Express } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { InsertSkill } from "@shared/schema";
import { BUILTIN_SKILLS } from "../skills/builtin";

const CreateSkillSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).default(""),
  teamId: z.string().min(1).max(100),
  systemPromptOverride: z.string().max(8000).default(""),
  tools: z.array(z.string().max(100)).default([]),
  modelPreference: z.string().max(100).optional().nullable(),
  outputSchema: z.record(z.unknown()).optional().nullable(),
  tags: z.array(z.string().max(100)).default([]),
  isPublic: z.boolean().default(true),
});

const UpdateSkillSchema = CreateSkillSchema.partial();

export function registerSkillRoutes(app: Express, storage: IStorage) {
  // GET /api/skills
  app.get("/api/skills", async (req, res) => {
    const teamId = req.query.teamId as string | undefined;
    const isBuiltinParam = req.query.isBuiltin as string | undefined;
    const filter: { teamId?: string; isBuiltin?: boolean } = {};
    if (teamId) filter.teamId = teamId;
    if (isBuiltinParam !== undefined) filter.isBuiltin = isBuiltinParam === "true";
    const result = await storage.getSkills(filter);
    res.json(result);
  });

  // GET /api/skills/builtin
  app.get("/api/skills/builtin", (_req, res) => {
    res.json(BUILTIN_SKILLS);
  });

  // GET /api/skills/:id
  app.get("/api/skills/:id", async (req, res) => {
    const skill = await storage.getSkill(req.params.id as string);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    res.json(skill);
  });

  // POST /api/skills
  app.post("/api/skills", async (req, res) => {
    const result = CreateSkillSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.errors[0]?.message ?? "Invalid input" });
    }
    const data: InsertSkill = {
      ...result.data,
      isBuiltin: false,
      createdBy: req.user?.id ?? "user",
    };
    const created = await storage.createSkill(data);
    res.status(201).json(created);
  });

  // PATCH /api/skills/:id
  app.patch("/api/skills/:id", async (req, res) => {
    const result = UpdateSkillSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.errors[0]?.message ?? "Invalid input" });
    }
    const skill = await storage.getSkill(req.params.id as string);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    if (skill.isBuiltin) return res.status(403).json({ error: "Cannot modify built-in skills" });
    const updated = await storage.updateSkill(req.params.id as string, result.data as Partial<InsertSkill>);
    res.json(updated);
  });

  // DELETE /api/skills/:id
  app.delete("/api/skills/:id", async (req, res) => {
    const skill = await storage.getSkill(req.params.id as string);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    if (skill.isBuiltin) return res.status(403).json({ error: "Cannot delete built-in skills" });
    await storage.deleteSkill(req.params.id as string);
    res.status(204).end();
  });
}
