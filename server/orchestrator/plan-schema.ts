/**
 * Strict zod schemas for the Opus-authored orchestrator plan and per-step args.
 *
 * SECURITY: the plan is raw LLM JSON. We NEVER trust it. Every field is bounded
 * (`.max()` on strings + arrays), the step `type` is a closed enum (unknown
 * types rejected), and the plan length is clamped to BOTH the caller's maxSteps
 * AND a hard ceiling. `parsePlan` wraps JSON.parse so a malformed payload yields
 * a typed error result and NEVER throws (the manager-allowlist lesson).
 *
 * Structural control (which steps run, bounds, the candidate-URL list) is taken
 * ONLY from this validated plan — never re-derived from fetched content (C3).
 */
import { z } from "zod";
import type { OrchestratorStepArgs } from "@shared/types";

/** Absolute upper bound on plan length, independent of any caller maxSteps. */
export const PLAN_STEP_HARD_MAX = 20;

/** Bounds chosen to stop prompt-size / storage DoS while leaving real headroom. */
const MAX_STR = 50_000;
const MAX_QUERY = 50_000;
const MAX_URLS_PER_STEP = 50;
const MAX_URL_LEN = 2_048;
const MAX_PATHS = 50;
const MAX_PATH_LEN = 1_024;

const researchArgs = z.object({
  type: z.literal("research"),
  query: z.string().min(1).max(MAX_QUERY),
  candidateUrls: z.array(z.string().max(MAX_URL_LEN)).max(MAX_URLS_PER_STEP),
});

const analyzeCodeArgs = z.object({
  type: z.literal("analyze-code"),
  query: z.string().min(1).max(MAX_QUERY),
  paths: z.array(z.string().max(MAX_PATH_LEN)).max(MAX_PATHS).optional(),
});

const debateArgs = z.object({
  type: z.literal("debate"),
  question: z.string().min(1).max(MAX_STR),
  // Clamped again at runtime against config.maxDebateRounds (defense in depth).
  rounds: z.number().int().min(1).max(5).optional(),
});

const groundArgs = z.object({
  type: z.literal("ground"),
  query: z.string().min(1).max(MAX_QUERY),
});

const synthesizeArgs = z.object({
  type: z.literal("synthesize"),
  instruction: z.string().max(MAX_STR).optional(),
});

/** Discriminated union over the closed set of step types. Unknown types reject. */
export const StepSchema = z.discriminatedUnion("type", [
  researchArgs,
  analyzeCodeArgs,
  debateArgs,
  groundArgs,
  synthesizeArgs,
]);

export type PlanStep = z.infer<typeof StepSchema>;

/** The top-level plan envelope. Length is re-checked against maxSteps below. */
export const PlanSchema = z.object({
  steps: z.array(StepSchema).min(1).max(PLAN_STEP_HARD_MAX),
});

export type ParsedPlan =
  | { ok: true; steps: OrchestratorStepArgs[] }
  | { ok: false; error: string };

/** Clamp the effective step limit to the hard ceiling (never trust a big config). */
function effectiveMax(maxSteps: number): number {
  if (!Number.isFinite(maxSteps) || maxSteps < 1) return 1;
  return Math.min(Math.floor(maxSteps), PLAN_STEP_HARD_MAX);
}

/** First zod issue rendered as a short, safe message (no payload echo). */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid plan";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Validate an already-parsed steps[] array (used by approve-plan edits, H3).
 * Re-clamps the plan length to min(maxSteps, hard-max). Never throws.
 */
export function validateSteps(steps: unknown, maxSteps: number): ParsedPlan {
  const limit = effectiveMax(maxSteps);
  const parsed = PlanSchema.safeParse({ steps });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }
  if (parsed.data.steps.length > limit) {
    return {
      ok: false,
      error: `plan has more steps (${parsed.data.steps.length}) than allowed (${limit})`,
    };
  }
  return { ok: true, steps: parsed.data.steps as OrchestratorStepArgs[] };
}

/**
 * Safely parse a raw LLM JSON plan string. Wraps JSON.parse so malformed input
 * yields a typed error result and NEVER throws. Validates + clamps via zod.
 */
export function parsePlan(raw: string, maxSteps: number): ParsedPlan {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, error: "plan is not valid JSON" };
  }
  if (typeof payload !== "object" || payload === null || !("steps" in payload)) {
    return { ok: false, error: "plan must be an object with a steps array" };
  }
  return validateSteps((payload as { steps: unknown }).steps, maxSteps);
}
