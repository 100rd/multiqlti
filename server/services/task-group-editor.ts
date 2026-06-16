/**
 * Task-group edit orchestration (thin collaborator over IStorage).
 *
 * Encapsulates the "editable only while pending" invariant + the dependsOn
 * rewrite / status-recompute rules so the route handlers stay thin (authorize →
 * validateBody → delegate). Mirrors how create/start/cancel delegate to the
 * orchestrator.
 *
 * Edit matrix (H2):
 *   pending   → name/description/input + tasks (add/remove/patch) all editable;
 *   running   → every edit 409 (mutating mid-run corrupts the execution record);
 *   terminal  → only name/description relabel; input + tasks 409.
 *
 * TOCTOU: each method RE-READS the group immediately before persisting and
 * re-checks `status === "pending"` (for task/input edits). The route authorizes
 * then delegates synchronously, so this re-read is the persist-time guard
 * against a concurrent `startGroup` flipping the status between auth and write.
 *
 * Errors are thrown as `TaskGroupEditError` carrying an HTTP status so the route
 * maps them generically (404 missing / 409 not-pending / 400 invalid graph).
 *
 * Caller: server/routes/task-groups.ts (PATCH/POST/DELETE task + PATCH group).
 */
import type { IStorage } from "../storage";
import type { TaskGroupRow, TaskRow, InsertTask } from "@shared/schema";
import { validateTaskGraph } from "./task-graph.js";

/** An edit-layer error that maps to a specific HTTP status in the route. */
export class TaskGroupEditError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TaskGroupEditError";
  }
}

export interface GroupPatch {
  name?: string;
  description?: string;
  input?: string;
}

export interface TaskPatch {
  name?: string;
  description?: string;
  executionMode?: "pipeline_run" | "direct_llm";
  dependsOn?: string[];
  pipelineId?: string;
  modelSlug?: string;
  teamId?: string;
  input?: Record<string, unknown>;
  sortOrder?: number;
}

export interface NewTaskInput {
  name: string;
  description: string;
  executionMode?: "pipeline_run" | "direct_llm";
  dependsOn?: string[];
  pipelineId?: string;
  modelSlug?: string;
  teamId?: string;
  input?: Record<string, unknown>;
  sortOrder?: number;
}

export class TaskGroupEditor {
  constructor(private storage: IStorage) {}

  /** Load the group fresh or throw 404 (persist-time existence check). */
  private async requireGroup(groupId: string): Promise<TaskGroupRow> {
    const group = await this.storage.getTaskGroup(groupId);
    if (!group) throw new TaskGroupEditError(404, "Task group not found");
    return group;
  }

  /** Load a task that MUST belong to `groupId`, else 404 (cross-group guard, M3). */
  private async requireTaskInGroup(groupId: string, taskId: string): Promise<TaskRow> {
    const task = await this.storage.getTask(taskId);
    if (!task || task.groupId !== groupId) {
      throw new TaskGroupEditError(404, "Task not found");
    }
    return task;
  }

  /**
   * PATCH group fields. `input` requires `pending`; `name`/`description` allowed
   * post-terminal (relabel) but blocked while `running`.
   */
  async updateGroup(groupId: string, patch: GroupPatch): Promise<TaskGroupRow> {
    const group = await this.requireGroup(groupId);
    const wantsInput = patch.input !== undefined;

    if (group.status === "running") {
      throw new TaskGroupEditError(409, "Cannot edit a running task group");
    }
    if (group.status !== "pending" && wantsInput) {
      throw new TaskGroupEditError(409, "Cannot edit input after the group has started");
    }

    const updates: Partial<TaskGroupRow> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description;
    if (wantsInput) updates.input = patch.input;

    return this.storage.updateTaskGroup(groupId, updates);
  }

  /** PATCH a single task — pending-only, DAG-validated, status recomputed. */
  async updateTask(groupId: string, taskId: string, patch: TaskPatch): Promise<TaskRow> {
    const group = await this.requireGroup(groupId);
    await this.requireTaskInGroup(groupId, taskId);
    this.assertPending(group);

    const updates: Partial<TaskRow> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.executionMode !== undefined) updates.executionMode = patch.executionMode;
    if (patch.pipelineId !== undefined) updates.pipelineId = patch.pipelineId;
    if (patch.modelSlug !== undefined) updates.modelSlug = patch.modelSlug;
    if (patch.teamId !== undefined) updates.teamId = patch.teamId;
    if (patch.input !== undefined) updates.input = patch.input;
    if (patch.sortOrder !== undefined) updates.sortOrder = patch.sortOrder;

    if (patch.dependsOn !== undefined) {
      const dependsOn = [...patch.dependsOn];
      // Validate the resulting graph (siblings unchanged, this task's deps swapped).
      await this.assertValidGraph(groupId, taskId, dependsOn);
      updates.dependsOn = dependsOn;
      updates.status = dependsOn.length === 0 ? "ready" : "blocked";
    }

    return this.storage.updateTask(taskId, updates);
  }

  /** POST a new task — pending-only, DAG-validated, sortOrder = max+1 default. */
  async addTask(groupId: string, input: NewTaskInput): Promise<TaskRow> {
    const group = await this.requireGroup(groupId);
    this.assertPending(group);

    const dependsOn = [...(input.dependsOn ?? [])];
    const siblings = await this.storage.getTasksByGroup(groupId);

    // Validate the candidate graph (siblings + the new node) before persisting.
    // The new task has no id yet → a sentinel that cannot collide with a UUID.
    const candidate = [
      ...siblings.map((s) => ({ id: s.id, dependsOn: s.dependsOn as string[] })),
      { id: "__new__", dependsOn },
    ];
    const result = validateTaskGraph(candidate);
    if (!result.ok) throw new TaskGroupEditError(400, result.reason);

    const maxSort = siblings.reduce((m, s) => Math.max(m, s.sortOrder), -1);
    const status = dependsOn.length === 0 ? "ready" : "blocked";

    return this.storage.createTask({
      groupId,
      name: input.name,
      description: input.description,
      executionMode: input.executionMode ?? "direct_llm",
      dependsOn,
      pipelineId: input.pipelineId ?? null,
      modelSlug: input.modelSlug ?? null,
      teamId: input.teamId ?? null,
      input: input.input ?? {},
      sortOrder: input.sortOrder ?? maxSort + 1,
      status,
    } as InsertTask);
  }

  /**
   * DELETE a task — pending-only. Strips the removed id from every sibling's
   * dependsOn, re-validates the remaining graph, and recomputes sibling status.
   */
  async removeTask(groupId: string, taskId: string): Promise<void> {
    const group = await this.requireGroup(groupId);
    await this.requireTaskInGroup(groupId, taskId);
    this.assertPending(group);

    await this.storage.deleteTask(taskId);

    const remaining = await this.storage.getTasksByGroup(groupId);
    // Re-validate the remaining graph (with the removed id stripped) before fixing siblings.
    const stripped = remaining.map((s) => ({
      id: s.id,
      dependsOn: (s.dependsOn as string[]).filter((d) => d !== taskId),
    }));
    const result = validateTaskGraph(stripped);
    if (!result.ok) throw new TaskGroupEditError(400, result.reason);

    // Rewrite siblings whose deps referenced the removed task, recomputing status.
    for (const s of remaining) {
      const deps = s.dependsOn as string[];
      if (!deps.includes(taskId)) continue;
      const nextDeps = deps.filter((d) => d !== taskId);
      const updates: Partial<TaskRow> = { dependsOn: nextDeps };
      // Only recompute draft statuses (blocked/ready) — never resurrect terminal ones.
      if (s.status === "blocked" || s.status === "ready") {
        updates.status = nextDeps.length === 0 ? "ready" : "blocked";
      }
      await this.storage.updateTask(s.id, updates);
    }
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private assertPending(group: TaskGroupRow): void {
    if (group.status !== "pending") {
      throw new TaskGroupEditError(409, "Task group can only be edited while pending");
    }
  }

  /**
   * Build the candidate graph for an in-place task patch (this task's deps
   * swapped, siblings untouched) and validate it.
   */
  private async assertValidGraph(
    groupId: string,
    taskId: string,
    nextDeps: string[],
  ): Promise<void> {
    const tasks = await this.storage.getTasksByGroup(groupId);
    const candidate = tasks.map((t) => ({
      id: t.id,
      dependsOn: t.id === taskId ? nextDeps : (t.dependsOn as string[]),
    }));
    const result = validateTaskGraph(candidate);
    if (!result.ok) throw new TaskGroupEditError(400, result.reason);
  }
}
