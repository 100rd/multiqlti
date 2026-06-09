import type { InsertLesson, StageExecution } from "@shared/schema";

/** Max length of a derived title / error-pattern, to keep rows bounded. */
const TITLE_MAX = 120;
const PATTERN_MAX = 160;

/** Context shared by every lesson derived from a single run. */
export interface LessonRunContext {
  readonly runId: string;
  readonly workspaceId: string | null;
}

/** Collapse a free-form error into a coarse, groupable signature. */
export function normalizeErrorPattern(error: string): string {
  const firstLine = error.split("\n", 1)[0] ?? error;
  const withoutDigits = firstLine.replace(/\b\d[\d.,:_-]*\b/g, "#");
  const collapsed = withoutDigits.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, PATTERN_MAX);
}

/** Classify a failed stage into a coarse category for filtering. */
export function classifyFailure(stage: Readonly<StageExecution>): string {
  if (stage.rejectionReason != null) return "rejection";
  const err = stage.error ?? "";
  if (/sandbox/i.test(err)) return "sandbox";
  if (/timeout|timed out/i.test(err)) return "timeout";
  if (/guardrail/i.test(err)) return "guardrail";
  return "exception";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Derive a lesson from a single stage execution outcome, or null when the stage
 * carries nothing worth remembering (e.g. still pending). Pure: no I/O, fully
 * unit-testable.
 */
export function deriveStageLesson(
  stage: Readonly<StageExecution>,
  ctx: Readonly<LessonRunContext>,
): InsertLesson | null {
  if (stage.status === "failed") return failureLesson(stage, ctx);
  if (stage.status === "completed") return successLesson(stage, ctx);
  return null;
}

function failureLesson(
  stage: Readonly<StageExecution>,
  ctx: Readonly<LessonRunContext>,
): InsertLesson {
  const reason = stage.rejectionReason ?? stage.error ?? "Unknown failure";
  const category = classifyFailure(stage);
  return {
    workspaceId: ctx.workspaceId,
    runId: ctx.runId,
    stageId: stage.id,
    teamId: stage.teamId,
    modelSlug: stage.modelSlug,
    outcome: "failure",
    category,
    errorPattern: normalizeErrorPattern(reason),
    title: truncate(`${stage.teamId} failed: ${reason}`, TITLE_MAX),
    summary: reason,
    detail: {
      category,
      error: stage.error ?? null,
      rejectionReason: stage.rejectionReason ?? null,
      stageIndex: stage.stageIndex,
    },
  };
}

function successLesson(
  stage: Readonly<StageExecution>,
  ctx: Readonly<LessonRunContext>,
): InsertLesson {
  const summaryText = stageSummaryText(stage) ?? `${stage.teamId} stage completed.`;
  return {
    workspaceId: ctx.workspaceId,
    runId: ctx.runId,
    stageId: stage.id,
    teamId: stage.teamId,
    modelSlug: stage.modelSlug,
    outcome: "success",
    category: null,
    errorPattern: null,
    title: truncate(`${stage.teamId} succeeded`, TITLE_MAX),
    summary: truncate(summaryText, TITLE_MAX * 4),
    detail: { stageIndex: stage.stageIndex, tokensUsed: stage.tokensUsed ?? 0 },
  };
}

/** Best-effort human summary from a stage's structured output. */
function stageSummaryText(stage: Readonly<StageExecution>): string | null {
  const output = stage.output;
  if (output == null || typeof output !== "object") return null;
  const summary = (output as Record<string, unknown>).summary;
  return typeof summary === "string" && summary.length > 0 ? summary : null;
}
