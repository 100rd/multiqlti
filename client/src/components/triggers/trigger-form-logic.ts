/**
 * trigger-form-logic.ts — pure, node-testable logic for the trigger form + card.
 *
 * Extracted from TriggerForm.tsx / TriggerCard.tsx (no JSX / React) so the unit
 * tests can import it in the node environment (mirrors task-form-logic.ts). All
 * SECURITY boundaries (repoPath allowlist, untrusted-text sanitization) live
 * SERVER-SIDE in the review factory — this module only shapes the request.
 */
import type {
  PipelineTrigger,
  TriggerType,
  ConsiliumReviewPreset,
  ConsiliumReviewTriggerAction,
} from "@shared/types";

/** Trigger types whose firing creates a consilium loop (carry a loop template). */
export const LOOP_FIRING_TYPES: ReadonlySet<TriggerType> = new Set(["schedule", "file_change"]);

export interface LoopTemplateState {
  preset: ConsiliumReviewPreset;
  repoPath: string;
  engineerInstruction: string;
  maxRounds: string;
}

/**
 * Whether the trigger form is submittable. The pipeline requirement is GONE — a
 * trigger no longer targets a pipeline. schedule/file_change require a loop template
 * (a preset and, for schedule, a repoPath since there is no watchPath to derive it
 * from). webhook/github keep their legacy fields.
 */
export function isTriggerFormValid(input: {
  type: TriggerType;
  cron: string;
  ghRepo: string;
  ghEvents: string[];
  watchPath: string;
  preset: string;
  repoPath: string;
}): boolean {
  const { type, cron, ghRepo, ghEvents, watchPath, preset, repoPath } = input;
  if (type === "schedule") {
    return cron.trim().length > 0 && preset.length > 0 && repoPath.trim().length > 0;
  }
  if (type === "file_change") {
    return watchPath.trim().length > 0 && preset.length > 0;
  }
  if (type === "github_event") {
    // T1-full: a github trigger fires a consilium loop, so it needs a target repo
    // (the loop template's repoPath) in ADDITION to the repo/events filter. Without
    // a repoPath the received events would be recorded but never launch a review.
    return ghRepo.trim().length > 0 && ghEvents.length > 0 && repoPath.trim().length > 0;
  }
  return true; // webhook
}

/**
 * Human summary of which consilium loop each github event launches — shown in the
 * form so the operator knows what a subscription actually does. Events not listed
 * here are received + acknowledged (200) but launch nothing.
 */
export const GITHUB_EVENT_MAPPINGS: ReadonlyArray<{ event: string; effect: string }> = [
  { event: "pull_request (opened / synchronize / reopened)", effect: "diff-PR review of the PR head vs its base" },
  { event: "push to the default branch", effect: "post-merge review of the merged diff" },
];

/**
 * Whether the "Add Trigger" button should be enabled: the project must have at
 * least one allowlisted workspace to target (replaces the old zero-pipelines gate),
 * and the subsystem must be configured.
 */
export function canAddTrigger(workspaceCount: number, subsystemDisabled: boolean): boolean {
  return workspaceCount > 0 && !subsystemDisabled;
}

/** Build the loop-template `action` from the form's template state. */
export function buildLoopTemplate(state: LoopTemplateState): ConsiliumReviewTriggerAction {
  const rounds = Number.parseInt(state.maxRounds, 10);
  const action: ConsiliumReviewTriggerAction = {
    kind: "consilium_review",
    preset: state.preset,
  };
  if (state.repoPath.trim().length > 0) action.repoPath = state.repoPath.trim();
  if (state.engineerInstruction.trim().length > 0) {
    action.engineerInstruction = state.engineerInstruction.trim();
  }
  if (Number.isFinite(rounds) && rounds >= 1 && rounds <= 6) action.maxRounds = rounds;
  return action;
}

/**
 * The repo basename + preset the trigger's loop targets, or null when the trigger
 * carries no loop template (webhook/github). Shown on the trigger card.
 */
export function loopTargetSummary(trigger: PipelineTrigger): string | null {
  const action = (trigger.config as { action?: ConsiliumReviewTriggerAction }).action;
  if (!action || action.kind !== "consilium_review") return null;
  const repo = action.repoPath ? action.repoPath.split("/").filter(Boolean).pop() : undefined;
  return repo ? `${action.preset} → ${repo}` : action.preset;
}
