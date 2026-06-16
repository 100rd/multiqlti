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
 *
 * task-groups-v2 (FE5): TaskDraft gains `labels: string[]` (organizational tags,
 * mirroring the server `tasks.labels` array) and `templateId` (copy-in provenance
 * when a row was seeded from a library template — the SERVER re-copies the
 * template authoritatively via templateId; the client copy is for display +
 * payload). The reducers preserve both through every edit.
 */
import type { TaskGroupStatus } from "@shared/types";

export type ExecutionMode = "direct_llm" | "pipeline_run";

/**
 * Sentinel for "no explicit model" in the per-task model picker. Empty string
 * (Radix Select cannot use "" as an item value) would be ambiguous, so the
 * unset state is carried as `null` on the draft and rendered as the
 * DEFAULT_MODEL_OPTION item. On submit, a `null` modelSlug is omitted from the
 * payload so the SERVER applies its real default (pipeline.taskGroups.defaultModel)
 * — it must NEVER coerce to "mock".
 */
export const DEFAULT_MODEL_OPTION = "__default__";

export interface TaskDraft {
  id: string;
  name: string;
  description: string;
  executionMode: ExecutionMode;
  dependsOn: string[];
  /** Pinned model slug, or null to use the server's real default. */
  modelSlug: string | null;
  /** Organizational labels (free-text tags). Empty by default. */
  labels: string[];
  /**
   * Library provenance: the template id this row was seeded from, or null for an
   * ad-hoc/manual row. The server re-copies the template authoritatively when
   * this is present (§5.3 copy-in).
   */
  templateId: string | null;
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
    modelSlug: null,
    labels: [],
    templateId: null,
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

/**
 * Set a task's pinned model slug, immutably. The DEFAULT_MODEL_OPTION sentinel
 * (or any falsy value) clears the pin back to `null` so the server default wins.
 */
export function setTaskModel(task: TaskDraft, slug: string): TaskDraft {
  const next = !slug || slug === DEFAULT_MODEL_OPTION ? null : slug;
  return { ...task, modelSlug: next };
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

// ─── Labels (chip editor reducer, FE3/FE5) ──────────────────────────────────────

/**
 * Add a label to a list, immutably. Trims surrounding whitespace, rejects an
 * empty/whitespace-only value (returns the list unchanged), and de-dupes (a label
 * already present is a no-op). Insertion order is preserved — a new label is
 * appended at the end. Never mutates its input.
 */
export function addLabel(labels: readonly string[], raw: string): string[] {
  const value = raw.trim();
  if (!value) return labels.slice();
  if (labels.includes(value)) return labels.slice();
  return [...labels, value];
}

/** Remove a label by value, immutably (no-op when absent). Preserves order. */
export function removeLabel(labels: readonly string[], value: string): string[] {
  return labels.filter((l) => l !== value);
}

/** Set a task's labels, immutably (used by the per-task chip control). */
export function setTaskLabels(task: TaskDraft, labels: string[]): TaskDraft {
  return { ...task, labels };
}

// ─── Seed-from-template reducer (FE4) ────────────────────────────────────────────

/** The library template fields a seeded row copies in (subset of TaskTemplateRow). */
export interface TemplateSeed {
  id: string;
  name: string;
  description: string;
  executionMode?: ExecutionMode | string | null;
  modelSlug?: string | null;
  input?: Record<string, unknown> | null;
  labels?: string[] | null;
}

/** Normalize an arbitrary execution-mode value to the two supported modes. */
function asExecutionMode(value: ExecutionMode | string | null | undefined): ExecutionMode {
  return value === "pipeline_run" ? "pipeline_run" : "direct_llm";
}

/**
 * Build a TaskDraft row from a library template (copy-in snapshot). Copies the
 * template's name/description/mode/model/labels and stamps `templateId` for
 * provenance (so the SERVER re-copies it authoritatively at compose time). The
 * new row gets a FRESH client id (never the template id) and an empty dependsOn
 * (dependencies are a group-graph concept, resolved on this surface). Pure.
 */
export function seedTaskFromTemplate(template: TemplateSeed): TaskDraft {
  return {
    id: crypto.randomUUID(),
    name: template.name,
    description: template.description,
    executionMode: asExecutionMode(template.executionMode),
    dependsOn: [],
    modelSlug: template.modelSlug ?? null,
    labels: template.labels ? template.labels.slice() : [],
    templateId: template.id,
  };
}

/**
 * Seed one or more template rows onto the end of the existing task list,
 * immutably. Manual/existing rows are preserved verbatim and stay BEFORE the
 * seeded rows; the seeded rows append in the templates' order. Never mutates its
 * inputs. Used by the composer's "Add from library" affordance.
 */
export function seedTasksFromTemplates(
  tasks: readonly TaskDraft[],
  templates: readonly TemplateSeed[],
): TaskDraft[] {
  return [...tasks, ...templates.map(seedTaskFromTemplate)];
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
