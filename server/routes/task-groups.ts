import { Router } from "express";
import { z } from "zod";
import type { Request, Response } from "express";
import type { IStorage } from "../storage";
import type { TaskOrchestrator } from "../services/task-orchestrator";
import { validateBody } from "../middleware/validate.js";
import { authorizeTaskGroup } from "./authorize-task-group.js";
import { isVisible } from "./authorize-run.js";
import {
  TaskGroupEditor,
  TaskGroupEditError,
} from "../services/task-group-editor.js";
import {
  RunActiveError,
  IterationCapError,
  NoReadyTasksError,
  InvalidTaskGraphError,
} from "../services/task-orchestrator.js";
import { IterationConflictError } from "../storage-task-groups-v2.js";

// ─── Validation Schemas ─────────────────────────────────────────────────────

// `.strict()` so a now-removed `templateId` (Task Library, deleted) — or any
// other unknown field — is rejected with 400 rather than silently stripped.
const TaskFieldsSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(5000),
    executionMode: z.enum(["direct_llm"]).optional(),
    dependsOn: z.array(z.string().max(200)).max(50).optional(),
    pipelineId: z.string().max(100).optional(),
    modelSlug: z.string().max(100).optional(),
    teamId: z.string().max(100).optional(),
    input: z.record(z.unknown()).optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

const CreateTaskGroupSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  input: z.string().min(1).max(50000),
  tasks: z.array(TaskFieldsSchema).min(1).max(100),
});

/** PATCH group — all optional, at least one required. */
const UpdateTaskGroupSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(5000).optional(),
    input: z.string().min(1).max(50000).optional(),
  })
  .refine((b) => b.name !== undefined || b.description !== undefined || b.input !== undefined, {
    message: "At least one of name, description, input is required",
  });

/** PATCH task — all optional, at least one required. */
const UpdateTaskSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(5000).optional(),
    executionMode: z.enum(["direct_llm"]).optional(),
    dependsOn: z.array(z.string().max(200)).max(50).optional(),
    pipelineId: z.string().max(100).optional(),
    modelSlug: z.string().max(100).optional(),
    teamId: z.string().max(100).optional(),
    input: z.record(z.unknown()).optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "At least one field is required" });

/** POST new task — same per-task field bounds as create. */
const AddTaskSchema = TaskFieldsSchema;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Map a thrown error to a generic client response (M1: never leak String(err)).
 * Edit-layer errors carry their HTTP status; everything else is a generic 500.
 */
function sendError(res: Response, err: unknown, fallbackMessage: string): void {
  if (err instanceof TaskGroupEditError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // L2: a dangling/self/cyclic dependsOn from the create path → 400.
  if (err instanceof InvalidTaskGraphError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: fallbackMessage });
}

// ─── Route Registration ─────────────────────────────────────────────────────

export function registerTaskGroupRoutes(
  router: Router,
  storage: IStorage,
  orchestrator: TaskOrchestrator,
) {
  const editor = new TaskGroupEditor(storage);

  // List task groups — owner-scoped (C1). Non-admins see only their own; admins
  // see all + an ownerId on each row.
  router.get("/api/task-groups", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    const isAdmin = req.user.role === "admin";
    try {
      const groups = await storage.getTaskGroups();
      const visible = groups.filter((g) => isVisible(g.createdBy, req.user));
      const result = await Promise.all(
        visible.map(async (g) => {
          // #3: `completedCount` must reflect the LATEST ITERATION's executions,
          // not the task DEFINITION statuses (which stay blocked/ready, so a fully
          // executed group used to show 0/N). taskCount = number of definitions;
          // completedCount = executions with status "completed" in the latest
          // iteration. One extra latest-iteration + executions read per group
          // (project-scoped via the storage context) — bounded, no N+1 blow-up.
          const tasks = await storage.getTasksByGroup(g.id);
          const latest = await storage.getLatestIteration(g.id);
          const executions = latest
            ? await storage.getExecutionsByIteration(g.id, latest.id)
            : [];
          const row: Record<string, unknown> = {
            ...g,
            taskCount: tasks.length,
            completedCount: executions.filter((e) => e.status === "completed").length,
          };
          // Owner attribution is admin-only; hide createdBy from non-admins.
          if (!isAdmin) delete row.createdBy;
          return row;
        }),
      );
      res.json(result);
    } catch {
      res.status(500).json({ error: "Failed to load task groups" });
    }
  });

  // Get single task group with all tasks (C1 gated).
  router.get("/api/task-groups/:id", async (req: Request, res: Response) => {
    const auth = await authorizeTaskGroup(req, res, storage, String(req.params.id));
    if (!auth) return;
    try {
      const tasks = await storage.getTasksByGroup(auth.group.id);
      res.json({ ...auth.group, tasks });
    } catch {
      res.status(500).json({ error: "Failed to load task group" });
    }
  });

  // Create task group with tasks (stamps createdBy from the session).
  router.post("/api/task-groups", validateBody(CreateTaskGroupSchema), async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    try {
      const body = req.body as z.infer<typeof CreateTaskGroupSchema>;
      const result = await orchestrator.createTaskGroup({
        ...body,
        createdBy: req.user.id,
      });
      res.status(201).json({ ...result.group, tasks: result.tasks });
    } catch (err) {
      sendError(res, err, "Failed to create task group");
    }
  });

  // Start (or re-run) a task group — creates a fresh iteration (C1 gated).
  router.post("/api/task-groups/:id/start", async (req: Request, res: Response) => {
    const auth = await authorizeTaskGroup(req, res, storage, String(req.params.id));
    if (!auth) return;
    try {
      const { group, iteration } = await orchestrator.startGroup(String(req.params.id), {
        triggeredBy: req.user?.id ?? null,
      });
      res.json({ group, iteration });
    } catch (err) {
      // 409 when a run is already active / the iteration cap is hit / the UNIQUE
      // backstop catches a concurrent start; otherwise a generic 400.
      if (
        err instanceof RunActiveError ||
        err instanceof IterationCapError ||
        err instanceof IterationConflictError
      ) {
        return res.status(409).json({ error: err.message });
      }
      // H1: zero ready tasks (0-definition or all-blocked) → 400 (design §5.1).
      if (err instanceof NoReadyTasksError) {
        return res.status(400).json({ error: err.message });
      }
      const message = err instanceof Error ? err.message : "Failed to start task group";
      res.status(400).json({ error: message });
    }
  });

  // Cancel task group (C1 gated).
  router.post("/api/task-groups/:id/cancel", async (req: Request, res: Response) => {
    const auth = await authorizeTaskGroup(req, res, storage, String(req.params.id));
    if (!auth) return;
    try {
      await orchestrator.cancelGroup(String(req.params.id));
      const group = await storage.getTaskGroup(String(req.params.id));
      res.json(group);
    } catch {
      res.status(500).json({ error: "Failed to cancel task group" });
    }
  });

  // Delete task group (C1 gated). Refuse while the latest iteration is running
  // (DELETE-WHILE-RUNNING → 409; mirrors the assertNotRunning edit guard).
  router.delete("/api/task-groups/:id", async (req: Request, res: Response) => {
    const auth = await authorizeTaskGroup(req, res, storage, String(req.params.id));
    if (!auth) return;
    try {
      const latest = await storage.getLatestIteration(String(req.params.id));
      const effectiveStatus = latest?.status ?? auth.group.status;
      if (effectiveStatus === "running") {
        return res.status(409).json({ error: "Cancel the running iteration first" });
      }
      await storage.deleteTaskGroup(String(req.params.id));
      res.status(204).end();
    } catch {
      res.status(500).json({ error: "Failed to delete task group" });
    }
  });

  // Retry a failed task (C1 + C2: authorize the group AND assert task ∈ group).
  router.post("/api/task-groups/:id/tasks/:taskId/retry", async (req: Request, res: Response) => {
    const auth = await authorizeTaskGroup(req, res, storage, String(req.params.id));
    if (!auth) return;
    try {
      // C2/M3: the definition must belong to this group AND have an execution in
      // the latest iteration, else 404 (cross-group tamper / no run to retry).
      const task = await storage.getTask(String(req.params.taskId));
      if (!task || task.groupId !== String(req.params.id)) {
        return res.status(404).json({ error: "Task not found" });
      }
      const iteration = await storage.getLatestIteration(String(req.params.id));
      const hasExecution = iteration
        ? (await storage.getExecutionsByIteration(String(req.params.id), iteration.id)).some(
            (e) => e.taskId === String(req.params.taskId),
          )
        : false;
      if (!hasExecution) {
        return res.status(404).json({ error: "Task not found" });
      }
      await orchestrator.retryTask(String(req.params.taskId));
      const updated = await storage.getTask(String(req.params.taskId));
      res.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to retry task";
      res.status(400).json({ error: message });
    }
  });

  // ─── Edit endpoints (A) — all C1 gated + pending-guarded in the editor ──────

  // PATCH group (name/description/input).
  router.patch(
    "/api/task-groups/:id",
    validateBody(UpdateTaskGroupSchema),
    async (req: Request, res: Response) => {
      const auth = await authorizeTaskGroup(req, res, storage, String(req.params.id));
      if (!auth) return;
      try {
        const patch = req.body as z.infer<typeof UpdateTaskGroupSchema>;
        const group = await editor.updateGroup(String(req.params.id), patch);
        const tasks = await storage.getTasksByGroup(group.id);
        res.json({ ...group, tasks });
      } catch (err) {
        sendError(res, err, "Failed to update task group");
      }
    },
  );

  // PATCH a task.
  router.patch(
    "/api/task-groups/:id/tasks/:taskId",
    validateBody(UpdateTaskSchema),
    async (req: Request, res: Response) => {
      const auth = await authorizeTaskGroup(req, res, storage, String(req.params.id));
      if (!auth) return;
      try {
        const patch = req.body as z.infer<typeof UpdateTaskSchema>;
        const task = await editor.updateTask(String(req.params.id), String(req.params.taskId), patch);
        res.json(task);
      } catch (err) {
        sendError(res, err, "Failed to update task");
      }
    },
  );

  // POST a new task into a group.
  router.post(
    "/api/task-groups/:id/tasks",
    validateBody(AddTaskSchema),
    async (req: Request, res: Response) => {
      const auth = await authorizeTaskGroup(req, res, storage, String(req.params.id));
      if (!auth) return;
      try {
        const body = req.body as z.infer<typeof AddTaskSchema>;
        const task = await editor.addTask(String(req.params.id), {
          ...body,
        });
        res.status(201).json(task);
      } catch (err) {
        sendError(res, err, "Failed to add task");
      }
    },
  );

  // DELETE a task from a group.
  router.delete("/api/task-groups/:id/tasks/:taskId", async (req: Request, res: Response) => {
    const auth = await authorizeTaskGroup(req, res, storage, String(req.params.id));
    if (!auth) return;
    try {
      await editor.removeTask(String(req.params.id), String(req.params.taskId));
      res.status(204).end();
    } catch (err) {
      sendError(res, err, "Failed to delete task");
    }
  });
}
