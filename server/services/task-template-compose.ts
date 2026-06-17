/**
 * Composition COPY-IN (task-groups-v2 §5.3/§6, BE8).
 *
 * When a task payload carries `templateId`, the orchestrator/editor must COPY the
 * template's fields into the new `tasks` DEFINITION and stamp `tasks.template_id`
 * for provenance. The template is owner-checked ONCE here at compose time (via the
 * shared `isVisible` predicate) — the run hot path never reads `task_templates`,
 * and later editing/deleting the template can never mutate the group's definition
 * (`onDelete:"set null"` keeps provenance soft).
 *
 * Manual (no-`templateId`) tasks pass through unchanged. A missing template → 404;
 * a template the caller cannot see → 403 (cross-owner denied at compose).
 *
 * Callers: TaskOrchestrator.createTaskGroup (create flow), TaskGroupEditor.addTask
 * (add-from-template flow). Both pass the authenticated user so ownership is
 * enforced exactly once, where the copy happens.
 */
import type { IStorage } from "../storage";
import type { VisibilityUser } from "../routes/authorize-run";
import { isVisible } from "../routes/authorize-run.js";

/** A copy-in failure that the route maps to an HTTP status (404 missing / 403 denied). */
export class TaskTemplateComposeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TaskTemplateComposeError";
  }
}

/** The subset of task fields a template contributes when copied into a definition. */
export interface ComposedTaskFields {
  executionMode: "pipeline_run" | "direct_llm";
  pipelineId: string | null;
  modelSlug: string | null;
  teamId: string | null;
  input: Record<string, unknown>;
  labels: string[];
  templateId: string;
}

/**
 * Load the template, owner-check it once, and project its copy-in fields. The
 * caller overlays name/description/dependsOn (group-graph concepts) on top.
 */
export async function composeTemplateFields(
  storage: IStorage,
  templateId: string,
  user: VisibilityUser | undefined,
): Promise<ComposedTaskFields> {
  const template = await storage.getTaskTemplate(templateId);
  if (!template) {
    throw new TaskTemplateComposeError(404, "Task template not found");
  }
  if (!isVisible(template.createdBy, user)) {
    throw new TaskTemplateComposeError(403, "Forbidden");
  }
  return {
    executionMode: template.executionMode,
    pipelineId: template.pipelineId,
    modelSlug: template.modelSlug,
    teamId: template.teamId,
    input: { ...template.input },
    labels: [...template.labels],
    templateId,
  };
}
