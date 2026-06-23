import { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { projects, projectMembers } from "../../shared/schema";
import { eq, and } from "drizzle-orm";
import { requestContext } from "../context";

export async function requireProject(req: Request, res: Response, next: NextFunction): Promise<void> {
  const projectId = req.headers["x-project-id"] as string;

  if (!projectId) {
    res.status(400).json({ error: "x-project-id header is required" });
    return;
  }

  if (!req.user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.ownerId === req.user.id) {
      req.projectId = projectId;
      requestContext.run({ projectId, userId: req.user.id, role: 'owner' }, () => {
        next();
      });
      return;
    }

    const [member] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, req.user.id)))
      .limit(1);

    if (!member) {
      res.status(403).json({ error: "Access denied to this project" });
      return;
    }

    req.projectId = projectId;
    req.projectRole = member.role;
    requestContext.run({ projectId, userId: req.user.id, role: member.role }, () => {
      next();
    });
  } catch (error) {
    console.error("Error in requireProject middleware:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
