import type { Express } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { SpecializationProfile } from "@shared/types";

// ─── Built-in Presets ─────────────────────────────────────────────────────────

const BUILT_IN_PRESETS: SpecializationProfile[] = [
  {
    id: "balanced",
    name: "Balanced",
    isBuiltIn: true,
    assignments: {},
  },
  {
    id: "provider-strengths",
    name: "Provider Strengths",
    isBuiltIn: true,
    assignments: {
      planning: "claude-3-5-sonnet",
      architecture: "claude-3-5-sonnet",
      development: "claude-3-5-sonnet",
      testing: "claude-3-5-sonnet",
      code_review: "claude-3-5-sonnet",
      deployment: "gemini-2-0-flash",
      monitoring: "grok-3",
    },
  },
  {
    id: "claude-only",
    name: "Claude Only",
    isBuiltIn: true,
    assignments: {
      planning: "claude-3-5-sonnet",
      architecture: "claude-3-5-sonnet",
      development: "claude-3-5-sonnet",
      testing: "claude-3-5-sonnet",
      code_review: "claude-3-5-sonnet",
      deployment: "claude-3-5-sonnet",
      monitoring: "claude-3-5-sonnet",
    },
  },
  {
    id: "gemini-only",
    name: "Gemini Only",
    isBuiltIn: true,
    assignments: {
      planning: "gemini-2-0-flash",
      architecture: "gemini-2-0-flash",
      development: "gemini-2-0-flash",
      testing: "gemini-2-0-flash",
      code_review: "gemini-2-0-flash",
      deployment: "gemini-2-0-flash",
      monitoring: "gemini-2-0-flash",
    },
  },
  {
    id: "grok-only",
    name: "Grok Only",
    isBuiltIn: true,
    assignments: {
      planning: "grok-3",
      architecture: "grok-3",
      development: "grok-3",
      testing: "grok-3",
      code_review: "grok-3",
      deployment: "grok-3",
      monitoring: "grok-3",
    },
  },
];

// ─── Validation Schemas ───────────────────────────────────────────────────────

const CreateProfileSchema = z.object({
  name: z
    .string()
    .min(1, "name is required")
    .max(100, "name must be at most 100 characters")
    .transform((v) => v.replace(/<[^>]*>/g, "").trim()),
  assignments: z
    .record(z.string().max(200, "model slug must be at most 200 characters"))
    .default({}),
});

// ─── Route Registration ───────────────────────────────────────────────────────

export function registerSpecializationRoutes(app: Express, storage: IStorage) {
  // GET /api/specialization-profiles — return built-ins + user-defined
  app.get("/api/specialization-profiles", async (_req, res) => {
    const userProfiles = await storage.getSpecializationProfiles();
    const combined: SpecializationProfile[] = [
      ...BUILT_IN_PRESETS,
      ...userProfiles.map((p) => ({
        id: p.id,
        name: p.name,
        isBuiltIn: p.isBuiltIn,
        assignments: (p.assignments ?? {}) as Record<string, string>,
        createdAt: p.createdAt ?? undefined,
      })),
    ];
    res.json(combined);
  });

  // POST /api/specialization-profiles — create user-defined profile
  app.post("/api/specialization-profiles", async (req, res) => {
    const result = CreateProfileSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.errors[0]?.message ?? "Invalid input" });
    }
    const { name, assignments } = result.data;
    const created = await storage.createSpecializationProfile({ name, isBuiltIn: false, assignments });
    res.status(201).json({
      id: created.id,
      name: created.name,
      isBuiltIn: created.isBuiltIn,
      assignments: (created.assignments ?? {}) as Record<string, string>,
      createdAt: created.createdAt ?? undefined,
    });
  });

  // DELETE /api/specialization-profiles/:id — delete user-defined profile
  app.delete("/api/specialization-profiles/:id", async (req, res) => {
    const id = req.params.id as string;

    // Guard: cannot delete built-in presets
    if (BUILT_IN_PRESETS.some((p) => p.id === id)) {
      return res.status(403).json({ error: "Cannot delete a built-in preset" });
    }

    const profiles = await storage.getSpecializationProfiles();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    await storage.deleteSpecializationProfile(id);
    res.status(204).end();
  });
}
