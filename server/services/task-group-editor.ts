/**
 * Task-group edit orchestration (thin collaborator over IStorage).
 *
 * Encapsulates the "editable only while pending" invariant + the dependsOn
 * rewrite / status-recompute rules so the route handlers stay thin (authorize →
 * validateBody → delegate). Mirrors how create/start/cancel delegate to the
 * orchestrator.
 *
 * Edit matrix (task-groups-v2 §4.2 — "editable when NO iteration is running"):
 *   not running → name/description/input + tasks (add/remove/patch) all editable
 *                 (a terminal group is editable again to set up the next run;
 *                 input edits affect the NEXT iteration, which snapshots it);
 *   running     → every edit 409 (mutating mid-run corrupts the execution record).
 *
 * "running" = the LATEST iteration's status === "running"; for a pre-v2 group with
 * no iteration rows it falls back to the group row's own status (legacy parity).
 *
 * TOCTOU: each mutating method RE-READS the group + latest iteration immediately
 * before persisting and re-checks running-ness. The route authorizes then
 * delegates synchronously, so this re-read is the persist-time guard against a
 * concurrent `startGroup` flipping the latest iteration to running between auth
 * and write.
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
  executionMode?: "direct_llm";
  dependsOn?: string[];
  modelSlug?: string;
  teamId?: string;
  input?: Record<string, unknown>;
  sortOrder?: number;
}

export interface NewTaskInput {
  name: string;
  description: string;
  executionMode?: "direct_llm";
  dependsOn?: string[];
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
    // v2: input is editable between runs (the next iteration snapshots it).
    await this.assertNotRunning(group);

    const updates: Partial<TaskGroupRow> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.input !== undefined) updates.input = patch.input;

    return this.storage.updateTaskGroup(groupId, updates);
  }

  /** PATCH a single task — pending-only, DAG-validated, status recomputed. */
  async updateTask(groupId: string, taskId: string, patch: TaskPatch): Promise<TaskRow> {
    const group = await this.requireGroup(groupId);
    await this.requireTaskInGroup(groupId, taskId);
    await this.assertNotRunning(group);

    const updates: Partial<TaskRow> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.executionMode !== undefined) updates.executionMode = patch.executionMode;
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

  /**
   * POST a new task — pending-only, DAG-validated, sortOrder = max+1 default.
   */
  async addTask(groupId: string, input: NewTaskInput): Promise<TaskRow> {
    const group = await this.requireGroup(groupId);
    await this.assertNotRunning(group);

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
    const fields = this.resolveTaskFields(input);

    return this.storage.createTask({
      groupId,
      name: input.name,
      description: input.description,
      executionMode: fields.executionMode,
      dependsOn,
      modelSlug: fields.modelSlug,
      teamId: fields.teamId,
      input: fields.input,
      labels: fields.labels,
      sortOrder: input.sortOrder ?? maxSort + 1,
      status,
    } as InsertTask);
  }

  /** Resolve a new task's definition fields. */
  private resolveTaskFields(input: NewTaskInput): {
    executionMode: "direct_llm";
    modelSlug: string | null;
    teamId: string | null;
    input: Record<string, unknown>;
    labels: string[];
  } {
    return {
      executionMode: input.executionMode ?? "direct_llm",
      modelSlug: input.modelSlug ?? null,
      teamId: input.teamId ?? null,
      input: input.input ?? {},
      labels: [],
    };
  }

  /**
   * DELETE a task — pending-only. Strips the removed id from every sibling's
   * dependsOn, re-validates the remaining graph, and recomputes sibling status.
   */
  async removeTask(groupId: string, taskId: string): Promise<void> {
    const group = await this.requireGroup(groupId);
    await this.requireTaskInGroup(groupId, taskId);
    await this.assertNotRunning(group);

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

  /**
   * Throw 409 iff an iteration is actively running (task-groups-v2 §4.2). This is
   * the persist-time TOCTOU guard: it RE-READS the latest iteration immediately
   * before the caller writes, so a concurrent `startGroup` between auth and write
   * is caught. Falls back to the group row\'s own status for pre-v2 groups that
   * have no iteration rows yet (legacy parity).
   */
  private async assertNotRunning(group: TaskGroupRow): Promise<void> {
    const latest = await this.storage.getLatestIteration(group.id);
    const effectiveStatus = latest?.status ?? group.status;
    if (effectiveStatus === "running") {
      throw new TaskGroupEditError(409, "Cannot edit while an iteration is running");
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
