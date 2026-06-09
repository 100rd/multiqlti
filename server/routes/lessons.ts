import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";

const querySchema = z.object({
  workspaceId: z.string().min(1).optional(),
});

/**
 * Read-only API over the native agent-experience lessons layer (Track B).
 * Writes happen implicitly via the pipeline lifecycle; this endpoint only
 * surfaces captured lessons for inspection / a future planning UI.
 */
export function registerLessonRoutes(app: Router, storage: IStorage): void {
  // GET /api/lessons?workspaceId=... — list lessons, newest first.
  app.get("/api/lessons", async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query parameters" });
    }
    try {
      const rows = await storage.getLessons(parsed.data.workspaceId);
      return res.json(rows);
    } catch {
      return res.status(500).json({ error: "Failed to load lessons" });
    }
  });
}
