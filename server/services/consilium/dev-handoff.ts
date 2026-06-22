/**
 * dev-handoff.ts — B.4 of the consilium loop (design §3 DEVELOPING transition).
 *
 * Server-side port of `client/src/components/task-groups/verdict-panel.tsx`
 * `sendToPipeline` (~L176): turns the judge's still-open action points into a
 * `createTaskGroup` payload with ONE `pipeline_run` task per action point, all
 * routed to the loop's DEV pipeline. The loop's controller hands this group off,
 * starts it, then polls it to completion before opening the merge gate.
 *
 * Pure (no storage, no I/O, no `any`): given the open action points + the DEV
 * pipeline id, it returns the exact `CreateTaskGroupParams` the orchestrator's
 * `createTaskGroup` accepts. The bounds (count + per-field length) were already
 * applied upstream in `readConvergence` (Security L-2); we re-clamp the strings
 * here defensively so the payload can never exceed the column limits.
 */
import type { ActionPoint } from "@shared/types";
import type { CreateTaskGroupParams, CreateTaskParam } from "../task-orchestrator.js";

/** Mirror the verdict-panel `.slice(...)` caps so the payload stays bounded. */
const NAME_MAX = 200;
const DESC_MAX = 5000;
const INPUT_MAX = 50_000;

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** One action point → one `pipeline_run` task (verdict-panel:189 shape). */
function actionPointToTask(
  ap: ActionPoint,
  index: number,
  devPipelineId: string,
  source: string,
): CreateTaskParam {
  const description =
    [ap.rationale ?? "", ap.tradeoff ? `Trade-off: ${ap.tradeoff}` : ""]
      .filter((s) => s.length > 0)
      .join(" ")
      .trim() || ap.title;
  return {
    name: clamp(`[${ap.priority ?? "-"}] ${ap.title}`, NAME_MAX),
    description: clamp(description, DESC_MAX),
    executionMode: "pipeline_run",
    pipelineId: devPipelineId,
    sortOrder: index,
    input: {
      feature: ap.title,
      rationale: ap.rationale ?? "",
      tradeoff: ap.tradeoff ?? "",
      priority: ap.priority ?? "",
      effort: ap.effort ?? "",
      source,
    },
  };
}

export interface DevHandoffRequest {
  /** The still-open action points from the judge verdict (already bounded). */
  openActionPoints: ActionPoint[];
  /** The DEV pipeline every handoff task runs through. */
  devPipelineId: string;
  /** Loop/group name surfaced in the handoff group's name + task input. */
  source: string;
  /** Optional creator id stamped on the handoff group (owner inheritance). */
  createdBy?: string;
}

/**
 * Build the `createTaskGroup` payload for the DEV step. Throws when there are no
 * open action points or no DEV pipeline — the controller MUST only call this on
 * the DEVELOPING transition, where both are guaranteed present.
 */
export function buildDevHandoffGroup(req: DevHandoffRequest): CreateTaskGroupParams {
  if (req.openActionPoints.length === 0) {
    throw new Error("buildDevHandoffGroup: no open action points to hand off");
  }
  if (!req.devPipelineId) {
    throw new Error("buildDevHandoffGroup: no DEV pipeline configured");
  }
  return {
    name: clamp(`Consilium DEV handoff: ${req.source}`, NAME_MAX),
    description: clamp(
      `Open action points from the consilium verdict (${req.source}) handed to the DEV pipeline.`,
      DESC_MAX,
    ),
    input: clamp(`Consilium loop DEV handoff for: ${req.source}`, INPUT_MAX),
    tasks: req.openActionPoints.map((ap, i) =>
      actionPointToTask(ap, i, req.devPipelineId, req.source),
    ),
    createdBy: req.createdBy,
  };
}
