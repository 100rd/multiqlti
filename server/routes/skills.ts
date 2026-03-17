import type { Express } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { InsertSkill, Skill } from "@shared/schema";
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

const ImportSkillsSchema = z.object({
  skills: z.array(z.record(z.unknown())),
  conflictStrategy: z.enum(["skip", "overwrite"]).default("skip"),
});

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

  // GET /api/skills/export
  // Must be registered BEFORE /api/skills/:id to avoid route collision.
  app.get("/api/skills/export", async (req, res) => {
    const userId = req.user?.id ?? "user";
    const allSkills = await storage.getSkills({ isBuiltin: false });
    const userSkills = allSkills.filter((s) => s.createdBy === userId);

    const payload = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      skills: userSkills,
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="skills-export.json"',
    );
    res.json(payload);
  });

  // POST /api/skills/import
  // Must be registered BEFORE /api/skills/:id to avoid route collision.
  app.post("/api/skills/import", async (req, res) => {
    const parseResult = ImportSkillsSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res
        .status(400)
        .json({ error: parseResult.error.errors[0]?.message ?? "Invalid input" });
    }

    const { skills: incoming, conflictStrategy } = parseResult.data;
    const userId = req.user?.id ?? "user";

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Load existing user skills once for conflict detection
    const existingSkills: Skill[] = await storage.getSkills({ isBuiltin: false });
    const existingByName = new Map<string, Skill>();
    for (const s of existingSkills) {
      if (s.createdBy === userId) {
        existingByName.set(s.name, s);
      }
    }

    for (let i = 0; i < incoming.length; i++) {
      const raw = incoming[i];

      // Strip server-controlled fields before validation
      const sanitized = { ...raw };
      delete sanitized["id"];
      delete sanitized["isBuiltin"];
      delete sanitized["createdBy"];
      delete sanitized["createdAt"];
      delete sanitized["updatedAt"];

      const validation = CreateSkillSchema.safeParse(sanitized);
      if (!validation.success) {
        errors.push(
          `Skill at index ${i}: ${validation.error.errors[0]?.message ?? "Invalid skill data"}`,
        );
        continue;
      }

      const skillData = validation.data;
      const existing = existingByName.get(skillData.name);

      if (existing) {
        if (conflictStrategy === "skip") {
          skipped++;
          continue;
        }
        // overwrite
        await storage.updateSkill(existing.id, skillData as Partial<InsertSkill>);
        imported++;
      } else {
        const insertData: InsertSkill = {
          ...skillData,
          isBuiltin: false,
          createdBy: userId,
        };
        const created = await storage.createSkill(insertData);
        existingByName.set(created.name, created);
        imported++;
      }
    }

    res.status(200).json({ imported, skipped, errors });
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
