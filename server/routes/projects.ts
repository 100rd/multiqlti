import { Router } from "express";
import { db } from "../db";
import { projects, projectMembers, insertProjectSchema } from "../../shared/schema";
import { eq, or, and } from "drizzle-orm";
import { requireAuth } from "../auth/middleware";

const router = Router();

// Get all projects the user has access to
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    
    // We could use a complex join, but a union or simple query works.
    // For now, let's just fetch projects they own. If they are members, we'll fetch those too.
    const userProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.ownerId, userId));

    const memberProjects = await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        ownerId: projects.ownerId,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .innerJoin(projectMembers, eq(projects.id, projectMembers.projectId))
      .where(eq(projectMembers.userId, userId));

    const allProjects = [...userProjects, ...memberProjects];
    
    // Deduplicate
    const uniqueProjects = Array.from(new Map(allProjects.map(p => [p.id, p])).values());

    res.json(uniqueProjects);
  } catch (error) {
    console.error("Error fetching projects:", error);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const data = insertProjectSchema.omit({ ownerId: true }).parse(req.body);
    const userId = req.user!.id;

    // Reject a duplicate name for the same owner (409). A DB unique index on
    // (owner_id, name) is the hard backstop against the create-create race.
    const [existing] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.ownerId, userId), eq(projects.name, data.name)));
    if (existing) {
      return res.status(409).json({ error: `A project named "${data.name}" already exists` });
    }

    const [newProject] = await db
      .insert(projects)
      .values({
        ...data,
        ownerId: userId,
      })
      .returning();

    res.status(201).json(newProject);
  } catch (error: any) {
    // 23505 = Postgres unique_violation (the (owner_id, name) index backstop).
    if (error?.code === "23505") {
      return res.status(409).json({ error: "A project with this name already exists" });
    }
    console.error("Error creating project:", error);
    res.status(400).json({ error: error.message || "Failed to create project" });
  }
});

// Delete a project. Owner-or-admin only (mirrors the isVisible gate used by the
// run / task-group routes): members can read but not delete. All dependent rows
// (task_groups, pipelines, skills, … — 31 child tables) are removed by the
// ON DELETE CASCADE foreign keys, so this single delete tears down the tree.
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === "admin";
    const id = String(req.params.id);

    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (project.ownerId !== userId && !isAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await db.delete(projects).where(eq(projects.id, id));
    res.status(204).end();
  } catch (error) {
    console.error("Error deleting project:", error);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

export default router;
