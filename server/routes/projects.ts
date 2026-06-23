import { Router } from "express";
import { db } from "../db";
import { projects, projectMembers, insertProjectSchema } from "../../shared/schema";
import { eq, or } from "drizzle-orm";
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
    const data = insertProjectSchema.parse(req.body);
    const userId = req.user!.id;

    const [newProject] = await db
      .insert(projects)
      .values({
        ...data,
        ownerId: userId,
      })
      .returning();

    res.status(201).json(newProject);
  } catch (error: any) {
    console.error("Error creating project:", error);
    res.status(400).json({ error: error.message || "Failed to create project" });
  }
});

export default router;
