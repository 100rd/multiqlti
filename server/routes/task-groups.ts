import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { TaskOrchestrator } from "../services/task-orchestrator";
import { validateBody } from "../middleware/validate.js";

// ─── Validation Schemas ─────────────────────────────────────────────────────

const CreateTaskGroupSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  input: z.string().min(1).max(50000),
  tasks: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().min(1).max(5000),
        executionMode: z.enum(["pipeline_run", "direct_llm"]).optional(),
        dependsOn: z.array(z.string().max(200)).max(50).optional(),
        pipelineId: z.string().max(100).optional(),
        modelSlug: z.string().max(100).optional(),
        teamId: z.string().max(100).optional(),
        input: z.record(z.unknown()).optional(),
        sortOrder: z.number().int().min(0).max(1000).optional(),
      }),
    )
    .min(1)
    .max(100),
});

// ─── Route Registration ─────────────────────────────────────────────────────

export function registerTaskGroupRoutes(
  router: Router,
  storage: IStorage,
  orchestrator: TaskOrchestrator,
) {
  // List all task groups
  router.get("/api/task-groups", async (_req, res) => {
    try {
      const groups = await storage.getTaskGroups();
      // Attach task counts
      const result = await Promise.all(
        groups.map(async (g) => {
          const tasks = await storage.getTasksByGroup(g.id);
          return {
            ...g,
            taskCount: tasks.length,
            completedCount: tasks.filter((t) => t.status === "completed").length,
          };
        }),
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get single task group with all tasks
  router.get("/api/task-groups/:id", async (req, res) => {
    try {
      const group = await storage.getTaskGroup(req.params.id);
      if (!group) return res.status(404).json({ error: "Task group not found" });
      const tasks = await storage.getTasksByGroup(group.id);
      res.json({ ...group, tasks });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Create task group with tasks
  router.post("/api/task-groups", validateBody(CreateTaskGroupSchema), async (req, res) => {
    try {
      const body = req.body as z.infer<typeof CreateTaskGroupSchema>;
      const userId = (req as unknown as { user?: { id: string } }).user?.id;
      const result = await orchestrator.createTaskGroup({
        ...body,
        createdBy: userId,
      });
      res.status(201).json({ ...result.group, tasks: result.tasks });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Start task group execution
  router.post("/api/task-groups/:id/start", async (req, res) => {
    try {
      await orchestrator.startGroup(req.params.id);
      const group = await storage.getTaskGroup(req.params.id);
      res.json(group);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Cancel task group
  router.post("/api/task-groups/:id/cancel", async (req, res) => {
    try {
      await orchestrator.cancelGroup(req.params.id);
      const group = await storage.getTaskGroup(req.params.id);
      res.json(group);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Delete task group
  router.delete("/api/task-groups/:id", async (req, res) => {
    try {
      await storage.deleteTaskGroup(req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Retry a failed task
  router.post("/api/task-groups/:id/tasks/:taskId/retry", async (req, res) => {
    try {
      await orchestrator.retryTask(req.params.taskId);
      const task = await storage.getTask(req.params.taskId);
      res.json(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });
}
