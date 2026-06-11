/**
 * Pure, side-effect-free model-derivation helpers for the /api/activity lens.
 *
 * The Activity snapshot reports the model slug a run's CURRENT unit is using.
 * For modes where the model is not persisted on the per-unit row, we derive it
 * from an ENUM (orchestrator step type / SDLC team id) — never from untrusted
 * text. Best-effort: returns null when the enum value is unknown rather than
 * guessing, so the FE renders a muted "—".
 *
 * Callers: server/routes/activity.ts.
 */
import { SDLC_TEAMS } from "@shared/constants";
import type { OrchestratorStepType } from "@shared/types";

/** The fixed orchestrator slugs the engine pins per step type. */
export interface ActivityOrchestratorModels {
  planModelSlug: string;
  synthesizeModelSlug: string;
  proposerModelSlug: string;
  criticModelSlug: string;
  judgeModelSlug: string;
}

/**
 * The model slug a single orchestrator step of `type` runs on.
 *
 * research / analyze-code / ground / synthesize all run through the
 * synthesize-class model; debate is multi-model — we report the proposer slug
 * as the representative model for the row. Unknown type → null (best-effort).
 */
export function orchestratorStepModel(
  type: OrchestratorStepType,
  models: ActivityOrchestratorModels,
): string | null {
  switch (type) {
    case "research":
    case "analyze-code":
    case "ground":
    case "synthesize":
      return models.synthesizeModelSlug;
    case "debate":
      return models.proposerModelSlug;
    default:
      // Defensive: an enum we don't recognise → no guess.
      return null;
  }
}

/**
 * Best-effort model for a manager-dispatched team. The manager does not persist
 * a per-iteration model anywhere, so the snapshot resolves the team's SDLC
 * default. Unknown/custom team id (or undefined) → null.
 */
export function managerTeamModel(teamId: string | undefined): string | null {
  if (!teamId) return null;
  const team = SDLC_TEAMS[teamId as keyof typeof SDLC_TEAMS];
  return team?.defaultModelSlug ?? null;
}
