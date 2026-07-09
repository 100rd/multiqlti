/**
 * trigger-form-logic.ts — pure, node-testable logic for the trigger form + card.
 *
 * Extracted from TriggerForm.tsx / TriggerCard.tsx (no JSX / React) so the unit
 * tests can import it in the node environment (mirrors task-form-logic.ts). All
 * SECURITY boundaries (repoPath allowlist, untrusted-text sanitization) live
 * SERVER-SIDE in the review factory — this module only shapes the request.
 */
import type {
  Trigger,
  TriggerType,
  ConsiliumReviewPreset,
  ConsiliumReviewTriggerAction,
  ScheduleTriggerConfig,
  GitHubEventTriggerConfig,
  GitLabEventTriggerConfig,
  FileChangeTriggerConfig,
  TrackerEventTriggerConfig,
} from "@shared/types";

/** Trigger types whose firing creates a consilium loop (carry a loop template). */
export const LOOP_FIRING_TYPES: ReadonlySet<TriggerType> = new Set(["schedule", "file_change"]);

/**
 * owner/repo format — MIRRORS `GitHubConfigSchema.repository` on the server
 * (`server/routes/triggers.ts`). Kept in sync so the form rejects a malformed repo
 * BEFORE it hits the API (and the submit button reflects it), instead of relying on
 * a round-trip 400.
 */
export const GITHUB_REPO_REGEX = /^[^/]+\/[^/]+$/;

/** Whether `repo` is a valid `owner/repo` slug (trimmed). */
export function isGitHubRepoValid(repo: string): boolean {
  return GITHUB_REPO_REGEX.test(repo.trim());
}

/**
 * Events pre-selected for a NEW github_event trigger. The server schema requires
 * `events.min(1)`, so a fresh form MUST NOT start empty — it would fail validation
 * with nothing selected. These two cover the mapped review-firing events.
 */
export const GITHUB_DEFAULT_EVENTS: readonly string[] = ["pull_request", "push"];

/**
 * group/.../project format — MIRRORS `GitLabConfigSchema.project` on the server
 * (`server/routes/triggers.ts`). Kept in sync so the form rejects a malformed
 * project path BEFORE it hits the API (and the submit button reflects it), instead
 * of relying on a round-trip 400.
 */
export const GITLAB_PROJECT_REGEX = /^[^/]+(\/[^/]+)+$/;

/** Whether `project` is a valid `group/.../project` path (trimmed). */
export function isGitLabProjectValid(project: string): boolean {
  return GITLAB_PROJECT_REGEX.test(project.trim());
}

/**
 * Events pre-selected for a NEW gitlab_event trigger (GitLab mirror of
 * GITHUB_DEFAULT_EVENTS). The server schema requires `events.min(1)`, so a fresh
 * form MUST NOT start empty. These cover the mapped review-firing events.
 */
export const GITLAB_DEFAULT_EVENTS: readonly string[] = ["Merge Request Hook", "Push Hook"];

/** A server-side zod issue, as surfaced in the 400 body's `issues[]`. */
export interface TriggerValidationIssue {
  /** Field path (may nest, may include array indices). */
  path?: ReadonlyArray<string | number>;
  message?: string;
}

/**
 * Format server validation `issues[]` into human-readable "field path: message"
 * lines. Nested paths join with " → " (e.g. `action → repoPath`); a root-level issue
 * (empty path) renders the message alone.
 *
 * SECURITY: only the field PATH and zod's generic message are shown — the rejected
 * VALUE is never echoed, so an over-long `secret` (or any other input) cannot leak
 * its bytes into the UI.
 */
export function formatValidationIssues(
  issues: ReadonlyArray<TriggerValidationIssue> | undefined,
): string[] {
  if (!Array.isArray(issues)) return [];
  return issues.map((iss) => {
    const segments = Array.isArray(iss.path)
      ? iss.path
          .filter((p: string | number) => p !== "" && p !== null && p !== undefined)
          .map(String)
      : [];
    const label = segments.join(" → ");
    const msg = iss.message && iss.message.trim().length > 0 ? iss.message : "Invalid value";
    return label ? `${label}: ${msg}` : msg;
  });
}

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
  glProject: string;
  glEvents: string[];
  watchPath: string;
  preset: string;
  repoPath: string;
}): boolean {
  const { type, cron, ghRepo, ghEvents, glProject, glEvents, watchPath, preset, repoPath } = input;
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
    // The repo must be a well-formed owner/repo slug (server enforces the same regex),
    // so a malformed value is caught here instead of via a round-trip 400.
    return isGitHubRepoValid(ghRepo) && ghEvents.length > 0 && repoPath.trim().length > 0;
  }
  if (type === "gitlab_event") {
    // GitLab mirror of the github_event check above: a project path (server enforces
    // the same regex), at least one event, and a target repoPath for the loop.
    return isGitLabProjectValid(glProject) && glEvents.length > 0 && repoPath.trim().length > 0;
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
 * Human summary of which consilium loop each GitLab event launches (mirror of
 * GITHUB_EVENT_MAPPINGS) — shown in the form so the operator knows what a
 * subscription actually does. Events not listed here are received + acknowledged
 * (200) but launch nothing.
 */
export const GITLAB_EVENT_MAPPINGS: ReadonlyArray<{ event: string; effect: string }> = [
  { event: "Merge Request Hook (open / update / reopen)", effect: "diff-PR review of the MR head vs its base" },
  { event: "Push Hook to the default branch", effect: "post-merge review of the merged diff" },
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
 * One-line, human-readable summary of a trigger's config — the mono line on the
 * trigger card. Extracted here (from TriggerCard.tsx) so it is node-testable and
 * has a single source of truth.
 *
 * ROBUSTNESS: `events`/`patterns` are typed `string[]` but a trigger created via
 * the API can omit them entirely (e.g. the spec-watch demo file_change trigger is
 * just `{ watchPath, action }`). An unguarded `cfg.events.join`/`cfg.patterns.join`
 * on `undefined` throws and takes the WHOLE TriggersPage into its error boundary.
 * We coalesce to `[]` and, when the array is empty/absent, fall back to a sensible
 * summary (repository / watchPath alone) rather than a trailing " · ".
 */
export function configSummary(trigger: Trigger): string {
  switch (trigger.type) {
    case "webhook":
      return trigger.webhookUrl
        ? `POST ${trigger.webhookUrl}`
        : "Webhook endpoint auto-assigned";
    case "schedule": {
      const cfg = trigger.config as ScheduleTriggerConfig;
      return cfg.cron;
    }
    case "github_event": {
      const cfg = trigger.config as GitHubEventTriggerConfig;
      const events = (cfg.events ?? []).join(", ");
      return events ? `${cfg.repository} · ${events}` : cfg.repository;
    }
    case "gitlab_event": {
      const cfg = trigger.config as GitLabEventTriggerConfig;
      const events = (cfg.events ?? []).join(", ");
      return events ? `${cfg.project} · ${events}` : cfg.project;
    }
    case "file_change": {
      const cfg = trigger.config as FileChangeTriggerConfig;
      const patterns = (cfg.patterns ?? []).join(", ");
      return patterns ? `${cfg.watchPath} · ${patterns}` : cfg.watchPath;
    }
    case "tracker_event": {
      const cfg = trigger.config as TrackerEventTriggerConfig;
      const label = cfg.filter?.label;
      return label ? `${cfg.repo} · ${label}` : cfg.repo;
    }
  }
}

/**
 * The repo basename + preset the trigger's loop targets, or null when the trigger
 * carries no loop template (webhook/github). Shown on the trigger card.
 */
export function loopTargetSummary(trigger: Trigger): string | null {
  const action = (trigger.config as { action?: ConsiliumReviewTriggerAction }).action;
  if (!action || action.kind !== "consilium_review") return null;
  const repo = action.repoPath ? action.repoPath.split("/").filter(Boolean).pop() : undefined;
  return repo ? `${action.preset} → ${repo}` : action.preset;
}
