import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { InsertSkill, Skill } from "@shared/schema";
import type { SharingLevel } from "@shared/types";
import { BUILTIN_SKILLS } from "../skills/builtin";
import { bumpVersion, snapshotConfig } from "../skills/version-service";
import { serializeSkillToYaml, deserializeSkillYaml, SkillYamlSchema } from "../skills/yaml-service";
import { MarketplaceService } from "../skills/marketplace-service";

// ─── Zod Schemas ────────────────────────────────────────────────────────────

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
  sharing: z.enum(["private", "team", "public"]).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
});

const UpdateSkillSchema = CreateSkillSchema.partial().extend({
  versionBump: z.enum(["major", "minor", "patch"]).optional(),
  changelog: z.string().max(2000).optional(),
});

const ImportSkillsSchema = z.object({
  skills: z.array(z.record(z.unknown())),
  conflictStrategy: z.enum(["skip", "overwrite"]).default("skip"),
});

const ExportFormatSchema = z.object({
  format: z.enum(["json", "yaml"]).default("json"),
});

const MarketplaceQuerySchema = z.object({
  search: z.string().max(200).optional(),
  tags: z.string().max(500).optional(),
  teamId: z.string().max(100).optional(),
  author: z.string().max(200).optional(),
  sort: z.enum(["usageCount", "newest", "name"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const VersionBumpSchema = z.object({
  bump: z.enum(["major", "minor", "patch"]).default("patch"),
  changelog: z.string().max(2000).default(""),
});

const SharingUpdateSchema = z.object({
  sharing: z.enum(["private", "team", "public"]),
});

const VersionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Returns true if user is the skill owner or has admin role. */
function isOwnerOrAdmin(skill: Skill, req: Request): boolean {
  const user = req.user;
  if (!user) return false;
  if (user.role === "admin") return true;
  return skill.createdBy === user.id;
}

/** Resolves sharing from body, falling back to isPublic for backward compat. */
function resolveSharingLevel(
  sharing?: string,
  isPublic?: boolean,
): SharingLevel | undefined {
  if (sharing) return sharing as SharingLevel;
  if (isPublic === true) return "public";
  if (isPublic === false) return "private";
  return undefined;
}

// Maximum body size for YAML import (100KB)
const YAML_IMPORT_MAX_BYTES = 100 * 1024;

export function registerSkillRoutes(app: Express, storage: IStorage) {
  const marketplace = new MarketplaceService(storage);

  // ─── LIST ─────────────────────────────────────────────────────────────────

  app.get("/api/skills", async (req, res) => {
    const teamId = req.query.teamId as string | undefined;
    const isBuiltinParam = req.query.isBuiltin as string | undefined;
    const filter: { teamId?: string; isBuiltin?: boolean } = {};
    if (teamId) filter.teamId = teamId;
    if (isBuiltinParam !== undefined) filter.isBuiltin = isBuiltinParam === "true";
    const result = await storage.getSkills(filter);
    res.json(result);
  });

  // ─── BUILTIN ──────────────────────────────────────────────────────────────

  app.get("/api/skills/builtin", (_req, res) => {
    res.json(BUILTIN_SKILLS);
  });

  // ─── MARKETPLACE (must be before :id routes) ──────────────────────────────

  app.get("/api/skills/marketplace", async (req: Request, res: Response) => {
    const parsed = MarketplaceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid query" });
    }
    const { search, tags, teamId, author, sort, limit, offset } = parsed.data;
    const tagArray = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;

    const result = await storage.getMarketplaceSkills({
      search,
      tags: tagArray,
      teamId,
      author,
      sort,
      limit,
      offset,
    });
    res.json({ skills: result.skills, total: result.total });
  });

  // ─── BULK EXPORT ──────────────────────────────────────────────────────────

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
    res.setHeader("Content-Disposition", 'attachment; filename="skills-export.json"');
    res.json(payload);
  });

  // ─── YAML/JSON IMPORT (single skill) ─────────────────────────────────────

  app.post("/api/skills/import", async (req: Request, res: Response) => {
    const contentType = req.headers["content-type"] ?? "";
    const isYaml = contentType.includes("yaml") || contentType.includes("x-yaml");
    const userId = req.user?.id ?? "user";

    try {
      let parsed: z.infer<typeof SkillYamlSchema>;

      if (isYaml) {
        const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
        if (Buffer.byteLength(bodyStr, "utf8") > YAML_IMPORT_MAX_BYTES) {
          return res.status(413).json({ error: "YAML body exceeds 100KB limit" });
        }
        parsed = deserializeSkillYaml(bodyStr);
      } else {
        // Try JSON body first -- check if it matches legacy bulk import format
        if (req.body && typeof req.body === "object" && Array.isArray(req.body.skills)) {
          return handleBulkImport(req, res, storage);
        }
        // Otherwise treat as single SkillYaml JSON
        parsed = SkillYamlSchema.parse(req.body);
      }

      const insertData: InsertSkill = {
        name: parsed.metadata.name,
        description: parsed.metadata.description,
        teamId: parsed.spec.teamId,
        systemPromptOverride: parsed.spec.systemPrompt,
        tools: parsed.spec.tools,
        modelPreference: parsed.spec.modelPreference,
        outputSchema: parsed.spec.outputSchema,
        tags: parsed.metadata.tags,
        isBuiltin: false,
        isPublic: parsed.spec.sharing === "public",
        createdBy: userId,
        version: parsed.metadata.version,
        sharing: parsed.spec.sharing,
      };
      const created = await storage.createSkill(insertData);
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors[0]?.message ?? "Validation failed" });
      }
      return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid input" });
    }
  });

  // ─── SINGLE SKILL EXPORT ─────────────────────────────────────────────────

  app.get("/api/skills/:id/export", async (req: Request, res: Response) => {
    const skill = await storage.getSkill(req.params.id as string);
    if (!skill) return res.status(404).json({ error: "Skill not found" });

    const formatParsed = ExportFormatSchema.safeParse(req.query);
    if (!formatParsed.success) {
      return res.status(400).json({ error: "Invalid format parameter" });
    }

    if (formatParsed.data.format === "yaml") {
      const yamlStr = serializeSkillToYaml(skill);
      res.setHeader("Content-Type", "text/yaml");
      return res.send(yamlStr);
    }

    res.json(skill);
  });

  // ─── VERSION HISTORY ──────────────────────────────────────────────────────

  app.get("/api/skills/:id/versions", async (req: Request, res: Response) => {
    const skill = await storage.getSkill(req.params.id as string);
    if (!skill) return res.status(404).json({ error: "Skill not found" });

    const parsed = VersionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid query" });
    }

    const result = await storage.getSkillVersions(
      req.params.id as string,
      parsed.data.limit,
      parsed.data.offset,
    );
    res.json({ versions: result.rows, total: result.total });
  });

  // ─── MANUAL VERSION BUMP ─────────────────────────────────────────────────

  app.post("/api/skills/:id/versions", async (req: Request, res: Response) => {
    const skill = await storage.getSkill(req.params.id as string);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    if (skill.isBuiltin) return res.status(403).json({ error: "Cannot version built-in skills" });
    if (!isOwnerOrAdmin(skill, req)) {
      return res.status(403).json({ error: "Forbidden -- must be owner or admin" });
    }

    const parsed = VersionBumpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    }

    const currentVersion = (skill as Skill & { version?: string }).version ?? "1.0.0";
    const newVersion = bumpVersion(currentVersion, parsed.data.bump);
    const config = snapshotConfig(skill);

    const versionRecord = await storage.createSkillVersion({
      skillId: skill.id,
      version: newVersion,
      config,
      changelog: parsed.data.changelog,
      createdBy: req.user?.id ?? "user",
    });

    await storage.updateSkill(skill.id, { version: newVersion } as Partial<InsertSkill>);
    res.status(201).json(versionRecord);
  });

  // ─── ROLLBACK ─────────────────────────────────────────────────────────────

  app.post("/api/skills/:id/rollback/:version", async (req: Request, res: Response) => {
    const skill = await storage.getSkill(req.params.id as string);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    if (skill.isBuiltin) return res.status(403).json({ error: "Cannot rollback built-in skills" });
    if (!isOwnerOrAdmin(skill, req)) {
      return res.status(403).json({ error: "Forbidden -- must be owner or admin" });
    }

    const targetVersion = await storage.getSkillVersion(req.params.id as string, req.params.version as string);
    if (!targetVersion) {
      return res.status(404).json({ error: `Version ${req.params.version} not found` });
    }

    // Snapshot current state before rollback
    const currentVersion = (skill as Skill & { version?: string }).version ?? "1.0.0";
    const rollbackVersion = bumpVersion(currentVersion, "patch");

    await storage.createSkillVersion({
      skillId: skill.id,
      version: rollbackVersion,
      config: snapshotConfig(skill),
      changelog: `Rolled back to ${req.params.version}`,
      createdBy: req.user?.id ?? "user",
    });

    // Restore the config from the target version
    const restored = targetVersion.config;
    const updated = await storage.updateSkill(skill.id, {
      name: restored.name,
      description: restored.description,
      teamId: restored.teamId,
      systemPromptOverride: restored.systemPromptOverride,
      tools: restored.tools,
      modelPreference: restored.modelPreference,
      outputSchema: restored.outputSchema,
      tags: restored.tags,
      version: rollbackVersion,
    } as Partial<InsertSkill>);

    res.json(updated);
  });

  // ─── FORK ─────────────────────────────────────────────────────────────────

  app.post("/api/skills/:id/fork", async (req: Request, res: Response) => {
    const userId = req.user?.id ?? "user";
    try {
      const forked = await marketplace.fork(req.params.id as string, userId);
      res.status(201).json(forked);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Fork failed";
      const status = message === "Skill not found" ? 404 : 403;
      res.status(status).json({ error: message });
    }
  });

  // ─── USAGE COUNTER ────────────────────────────────────────────────────────

  app.post("/api/skills/:id/usage", async (req: Request, res: Response) => {
    try {
      const usageCount = await storage.incrementSkillUsage(req.params.id as string);
      res.json({ usageCount });
    } catch {
      res.status(404).json({ error: "Skill not found" });
    }
  });

  // ─── SHARING UPDATE ───────────────────────────────────────────────────────

  app.patch("/api/skills/:id/sharing", async (req: Request, res: Response) => {
    const skill = await storage.getSkill(req.params.id as string);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    if (skill.isBuiltin) return res.status(403).json({ error: "Cannot change sharing of built-in skills" });
    if (!isOwnerOrAdmin(skill, req)) {
      return res.status(403).json({ error: "Forbidden -- must be owner or admin" });
    }

    const parsed = SharingUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    }

    const updated = await storage.updateSkill(skill.id, {
      sharing: parsed.data.sharing,
      isPublic: parsed.data.sharing === "public",
    } as Partial<InsertSkill>);
    res.json(updated);
  });

  // ─── GET SINGLE SKILL ────────────────────────────────────────────────────

  app.get("/api/skills/:id", async (req, res) => {
    const skill = await storage.getSkill(req.params.id as string);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    res.json(skill);
  });

  // ─── CREATE SKILL ─────────────────────────────────────────────────────────

  app.post("/api/skills", async (req, res) => {
    const result = CreateSkillSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.errors[0]?.message ?? "Invalid input" });
    }
    const sharing = resolveSharingLevel(result.data.sharing, result.data.isPublic);
    const data: InsertSkill = {
      ...result.data,
      isBuiltin: false,
      createdBy: req.user?.id ?? "user",
      sharing: sharing ?? "public",
      version: result.data.version ?? "1.0.0",
    };
    const created = await storage.createSkill(data);
    res.status(201).json(created);
  });

  // ─── UPDATE SKILL (with auto-versioning) ──────────────────────────────────

  app.patch("/api/skills/:id", async (req: Request, res: Response) => {
    const result = UpdateSkillSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.errors[0]?.message ?? "Invalid input" });
    }

    const skill = await storage.getSkill(req.params.id as string);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    if (skill.isBuiltin) return res.status(403).json({ error: "Cannot modify built-in skills" });

    // VETO-1 fix: ownership check
    if (!isOwnerOrAdmin(skill, req)) {
      return res.status(403).json({ error: "Forbidden -- must be owner or admin" });
    }

    const { versionBump, changelog, sharing, isPublic, ...updateFields } = result.data;

    // Auto-versioning: snapshot current config before applying changes
    const currentVersion = (skill as Skill & { version?: string }).version ?? "1.0.0";
    const bump = versionBump ?? "patch";
    const newVersion = bumpVersion(currentVersion, bump);

    try {
      await storage.createSkillVersion({
        skillId: skill.id,
        version: currentVersion,
        config: snapshotConfig(skill),
        changelog: changelog ?? "",
        createdBy: req.user?.id ?? "user",
      });
    } catch {
      // Version might already exist (e.g., rapid saves); continue with update
    }

    const resolvedSharing = resolveSharingLevel(sharing, isPublic);
    const updates: Partial<InsertSkill> = {
      ...updateFields,
      version: newVersion,
    };
    if (resolvedSharing) {
      (updates as Record<string, unknown>).sharing = resolvedSharing;
      updates.isPublic = resolvedSharing === "public";
    }

    const updated = await storage.updateSkill(req.params.id as string, updates);
    res.json(updated);
  });

  // ─── DELETE SKILL ─────────────────────────────────────────────────────────

  app.delete("/api/skills/:id", async (req: Request, res: Response) => {
    const skill = await storage.getSkill(req.params.id as string);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    if (skill.isBuiltin) return res.status(403).json({ error: "Cannot delete built-in skills" });

    // VETO-1 fix: ownership check
    if (!isOwnerOrAdmin(skill, req)) {
      return res.status(403).json({ error: "Forbidden -- must be owner or admin" });
    }

    await storage.deleteSkill(req.params.id as string);
    res.status(204).end();
  });
}

// ─── Legacy bulk import handler ─────────────────────────────────────────────

async function handleBulkImport(req: Request, res: Response, storage: IStorage): Promise<void> {
  const parseResult = z.object({
    skills: z.array(z.record(z.unknown())),
    conflictStrategy: z.enum(["skip", "overwrite"]).default("skip"),
  }).safeParse(req.body);

  if (!parseResult.success) {
    res.status(400).json({ error: parseResult.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const { skills: incoming, conflictStrategy } = parseResult.data;
  const userId = req.user?.id ?? "user";

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  const existingSkills: Skill[] = await storage.getSkills({ isBuiltin: false });
  const existingByName = new Map<string, Skill>();
  for (const s of existingSkills) {
    if (s.createdBy === userId) {
      existingByName.set(s.name, s);
    }
  }

  const BasicCreateSchema = CreateSkillSchema.omit({ sharing: true, version: true });

  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i];
    const sanitized = { ...raw };
    delete sanitized["id"];
    delete sanitized["isBuiltin"];
    delete sanitized["createdBy"];
    delete sanitized["createdAt"];
    delete sanitized["updatedAt"];

    const validation = BasicCreateSchema.safeParse(sanitized);
    if (!validation.success) {
      errors.push(`Skill at index ${i}: ${validation.error.errors[0]?.message ?? "Invalid skill data"}`);
      continue;
    }

    const skillData = validation.data;
    const existing = existingByName.get(skillData.name);

    if (existing) {
      if (conflictStrategy === "skip") {
        skipped++;
        continue;
      }
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
}
