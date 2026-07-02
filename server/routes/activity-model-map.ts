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
