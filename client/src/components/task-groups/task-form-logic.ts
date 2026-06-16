/**
 * Pure task-group form logic — NO React/JSX/UI imports — so it is importable in
 * the node-env vitest projects without jsdom (mirrors lib/activity.ts). The
 * presentational TaskRow lives in task-form.tsx and re-exports everything here.
 *
 * dependsOn semantics differ by surface:
 *  - CREATE: tasks have no server ids yet, so dependsOn is keyed by task NAME.
 *  - EDIT: tasks exist on the server, so dependsOn is keyed by task ID.
 * Either way `dependsOn` holds the same key as the surface's `task.id`, so the
 * reducers below work for both.
 */
import type { TaskGroupStatus } from "@shared/types";

export type ExecutionMode = "direct_llm" | "pipeline_run";

export interface TaskDraft {
  id: string;
  name: string;
  description: string;
  executionMode: ExecutionMode;
  dependsOn: string[];
}

export interface GroupDraft {
  name: string;
  description: string;
  input: string;
}

/** A sibling option for the dependsOn picker: chip shows `name`, toggles `id`. */
export interface SiblingOption {
  id: string;
  name: string;
}

export function emptyTask(): TaskDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    executionMode: "direct_llm",
    dependsOn: [],
  };
}

/**
 * Mirror of the server gating (the server is authoritative; the FE only avoids
 * showing controls that would 409):
 *  - `pending` → full edit (group name/description/input + tasks).
 *  - terminal  → relabel only (group name/description).
 *  - otherwise (running / ready / blocked) → read-only.
 */
export function isGroupEditable(status: string): boolean {
  return status === "pending";
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Terminal groups allow ONLY name/description relabel (no input, no tasks). */
export function isGroupRelabelOnly(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Toggle a dependency id on a task, immutably. */
export function toggleDependency(task: TaskDraft, depId: string): TaskDraft {
  const next = task.dependsOn.includes(depId)
    ? task.dependsOn.filter((d) => d !== depId)
    : [...task.dependsOn, depId];
  return { ...task, dependsOn: next };
}

/** Replace one task in the list by id, immutably. */
export function updateTaskInList(
  tasks: readonly TaskDraft[],
  id: string,
  updated: TaskDraft,
): TaskDraft[] {
  return tasks.map((t) => (t.id === id ? updated : t));
}

/**
 * Remove a task by id and strip its id from every sibling's dependsOn (mirrors
 * the server, which strips the removed id from siblings on DELETE). Works for
 * both id-spaces because dependsOn always holds the same key as `task.id`.
 */
export function removeTaskFromList(
  tasks: readonly TaskDraft[],
  id: string,
): TaskDraft[] {
  return tasks
    .filter((t) => t.id !== id)
    .map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== id) }));
}

/** Append a fresh empty task, immutably. */
export function addTaskToList(tasks: readonly TaskDraft[]): TaskDraft[] {
  return [...tasks, emptyTask()];
}

// ─── Validation ────────────────────────────────────────────────────────────────

export interface ValidationErrors {
  name?: string;
  description?: string;
  input?: string;
  tasks?: string;
  taskErrors?: Record<string, { name?: string; description?: string }>;
}

export interface ValidateOptions {
  /** Skip the `input` requirement (terminal relabel mode has no input field). */
  requireInput?: boolean;
  /** Skip task validation (relabel-only mode does not edit tasks). */
  requireTasks?: boolean;
}

export function validate(
  group: GroupDraft,
  tasks: readonly TaskDraft[],
  options: ValidateOptions = { requireInput: true, requireTasks: true },
): ValidationErrors {
  const { requireInput = true, requireTasks = true } = options;
  const errors: ValidationErrors = {};

  if (!group.name.trim()) errors.name = "Name is required.";
  if (!group.description.trim()) errors.description = "Description is required.";
  if (requireInput && !group.input.trim()) errors.input = "Input is required.";

  if (requireTasks) {
    if (tasks.length === 0) errors.tasks = "Add at least one task.";

    const taskErrors: Record<string, { name?: string; description?: string }> = {};
    tasks.forEach((t) => {
      const te: { name?: string; description?: string } = {};
      if (!t.name.trim()) te.name = "Task name is required.";
      if (!t.description.trim()) te.description = "Task description is required.";
      if (Object.keys(te).length > 0) taskErrors[t.id] = te;
    });
    if (Object.keys(taskErrors).length > 0) errors.taskErrors = taskErrors;
  }

  return errors;
}

export function hasErrors(errors: ValidationErrors): boolean {
  return (
    !!errors.name ||
    !!errors.description ||
    !!errors.input ||
    !!errors.tasks ||
    (errors.taskErrors != null && Object.keys(errors.taskErrors).length > 0)
  );
}

export type { TaskGroupStatus };
