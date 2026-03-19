import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const CreateSkillTeamSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name must be 100 characters or less"),
  description: z.string().max(500, "Description must be 500 characters or less").default(""),
});

// ─── Route Registration ───────────────────────────────────────────────────────

export function registerSkillTeamRoutes(app: Express, storage: IStorage) {
  // ─── LIST ───────────────────────────────────────────────────────────────────

  app.get("/api/skill-teams", async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const teams = await storage.getSkillTeams();
    res.json(teams);
  });

  // ─── CREATE ─────────────────────────────────────────────────────────────────

  app.post("/api/skill-teams", async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const parsed = CreateSkillTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    }

    const team = await storage.createSkillTeam({
      name: parsed.data.name,
      description: parsed.data.description,
      createdBy: req.user.id,
    });
    res.status(201).json(team);
  });

  // ─── DELETE ─────────────────────────────────────────────────────────────────

  app.delete("/api/skill-teams/:id", async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const teams = await storage.getSkillTeams();
    const team = teams.find((t) => t.id === req.params.id);
    if (!team) return res.status(404).json({ error: "Team not found" });

    const isOwnerOrAdmin =
      req.user.role === "admin" || team.createdBy === req.user.id;
    if (!isOwnerOrAdmin) {
      return res.status(403).json({ error: "Forbidden -- must be owner or admin" });
    }

    await storage.deleteSkillTeam(req.params.id as string);
    res.status(204).end();
  });
}
