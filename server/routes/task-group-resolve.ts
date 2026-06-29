/**
 * GET /api/task-groups/:id/project — resolve which project a task group lives
 * in, IGNORING the active-project scope.
 *
 * The scoped detail route (GET /api/task-groups/:id) filters by the selected
 * project via `withProject`, so a direct link to a group that belongs to a
 * different project returns 404 even though the caller owns it. This resolver
 * lets the UI offer "open in project X" instead of a dead end.
 *
 * Owner-or-admin only (same `isVisible` gate as the detail route) — it returns
 * ONLY the projectId, and never to a caller who can't see the group, so it
 * leaks nothing beyond "this group of yours is in that project".
 *
 * Mounted on `app`, so it inherits the `/api/task-groups` requireAuth +
 * requireProject middleware. requireProject validates the *currently selected*
 * project (which the client always has); the lookup itself is unscoped.
 */
import type { Router } from "express";
import { db } from "../db";
import { taskGroups } from "@shared/schema";
import { eq } from "drizzle-orm";
import { isVisible } from "./authorize-run.js";

export function registerTaskGroupResolveRoute(app: Router) {
  app.get("/api/task-groups/:id/project", async (req, res) => {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      const [group] = await db
        .select({ projectId: taskGroups.projectId, createdBy: taskGroups.createdBy })
        .from(taskGroups)
        .where(eq(taskGroups.id, String(req.params.id)));

      if (!group) {
        return res.status(404).json({ error: "Task group not found" });
      }
      if (!isVisible(group.createdBy, req.user)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      res.json({ projectId: group.projectId });
    } catch {
      res.status(500).json({ error: "Failed to resolve task group project" });
    }
  });
}
