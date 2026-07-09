/**
 * gitlab-event-map.ts — PURE mapping from a GitLab webhook event to a consilium
 * review plan (loop-triggers.md §3.1, GitLab mirror of github-event-map.ts). No I/O,
 * no DB, no factory — so the event→(preset, ref, baseline, label) decision is
 * unit-testable in isolation.
 *
 * The `fireTrigger` gitlab path (server/routes.ts → trigger-dispatch.ts) calls this
 * AFTER the token check (gitlab-event-handler.ts) has already passed, then hands the
 * plan to the SAME `createConsiliumReview` factory the file_change / schedule / UI /
 * github paths use. This module ONLY decides the shape of the review.
 *
 * SECURITY (flagged for the adversarial reviewer — mirrors github-event-map.ts G1/G2):
 *   G1. Every value read off the payload is UNTRUSTED. Only two SHAPES of value are
 *       ever emitted downstream:
 *         - `ref` / `baselineCommit`: gated to a strict git object id
 *           (`^[0-9a-f]{7,64}$`, non-zero) HERE, and re-validated at the factory
 *           boundary (ref-validator / SHA_RE) before either reaches git — always as
 *           an arg-array element behind `--end-of-options`. A non-hex head/base ⇒
 *           no-op, never a review with an attacker-shaped ref.
 *         - `eventLabel`: a single-line, control-stripped, byte-clamped human summary
 *           (MR !N: title). It flows ONLY into the review objective via the factory's
 *           `engineerInstruction`/`objectiveExtra` seam, which additionally fences +
 *           clamps it. Never a shell string, branch, or MR title sink.
 *   G2. An event we do not map (Pipeline Hook, an MR action other than
 *       open/update/reopen, a push to a non-default branch, …) is a NO-OP with a
 *       reason — NEVER an error and NEVER a review. Accept + log, so a misconfigured
 *       GitLab webhook (subscribed to everything) cannot fan out into unwanted loops.
 */
import type { ConsiliumReviewPreset } from "@shared/types";

/** A git object id: 7–64 lowercase hex chars (matches the factory's SHA_RE). */
const SHA_RE = /^[0-9a-f]{7,64}$/;
/** The all-zero object id GitLab sends for a created/deleted ref (no baseline). */
const ZERO_SHA_RE = /^0+$/;
/** Single-line clamp for the UNTRUSTED event label (re-fenced by the factory). */
const EVENT_LABEL_MAX = 200;

/** The concrete review a mapped GitLab event launches. */
export interface GitLabReviewMapping {
  /** Server-chosen preset (event-derived; OVERRIDES the trigger action's default). */
  preset: ConsiliumReviewPreset;
  /** HEAD side of the review — an MR head sha / push `after` sha (strict hex). */
  ref: string;
  /** diff baseline (MR base sha / push `before` sha); absent ⇒ objective-only. */
  baselineCommit?: string;
  /** Single-line, control-stripped human summary for the objective + provenance. */
  eventLabel: string;
}

export type GitLabMapResult =
  | { kind: "review"; mapping: GitLabReviewMapping }
  | { kind: "noop"; reason: string };

/** Narrow an `unknown` to a plain object without trusting its shape. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

/** Read a nested string field defensively (never trusts the shape). */
function str(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" ? v : undefined;
}

/** A finite number OR a numeric string → number; else undefined (MR iid). */
function num(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = obj?.[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return undefined;
}

/** True for a real, non-zero git object id (a usable ref/baseline). */
function isRealSha(v: string | undefined): v is string {
  return typeof v === "string" && SHA_RE.test(v) && !ZERO_SHA_RE.test(v);
}

/**
 * Single-line, control-stripped, whitespace-collapsed, byte-clamped label from
 * UNTRUSTED text (an MR title). Mirrors the review-factory's `sanitizeLine` intent
 * so the label is safe to compose into the objective (which fences it again).
 */
export function sanitizeEventLabel(value: string, max: number = EVENT_LABEL_MAX): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** The merge_request actions that launch a review (an update to code under review). */
const MR_REVIEWABLE_ACTIONS: ReadonlySet<string> = new Set(["open", "update", "reopen"]);

/**
 * Map a verified GitLab event to a review plan, or a no-op with a reason.
 * `eventType` is the `X-Gitlab-Event` value; `glPayload` is the parsed JSON body.
 *
 * Mappings (loop-triggers.md §3.1, GitLab mirror):
 *   - "Merge Request Hook" (action open/update/reopen) → `diff-pr-review` on the MR
 *     head (ref = object_attributes.last_commit.id, baseline =
 *     object_attributes.diff_refs.base_sha when present), label `MR !<iid>: <title>`.
 *   - "Push Hook" to the DEFAULT branch → post-merge review of `before..after`
 *     (`diff-pr-review`); a branch-create push (before = 0…0) falls back to an
 *     `sdlc-cross-review` at `after`.
 *   - anything else (Pipeline Hook, other MR actions, non-default-branch push, …) →
 *     no-op with a reason.
 */
export function mapGitLabEventToReview(eventType: string, glPayload: unknown): GitLabMapResult {
  const body = asRecord(glPayload);

  if (eventType === "Merge Request Hook") {
    const attrs = asRecord(body?.object_attributes);
    const action = str(attrs, "action") ?? "";
    if (!MR_REVIEWABLE_ACTIONS.has(action)) {
      return { kind: "noop", reason: `merge_request action "${action || "?"}" is not reviewable` };
    }
    const lastCommit = asRecord(attrs?.last_commit);
    const head = str(lastCommit, "id");
    if (!isRealSha(head)) {
      return { kind: "noop", reason: "merge_request last_commit id missing or not a valid commit id" };
    }
    const diffRefs = asRecord(attrs?.diff_refs);
    const base = str(diffRefs, "base_sha");
    const iid = num(attrs, "iid");
    const title = str(attrs, "title") ?? "";
    const label = sanitizeEventLabel(`MR !${iid ?? "?"}${title ? `: ${title}` : ""}`);
    return {
      kind: "review",
      mapping: {
        preset: "diff-pr-review",
        ref: head,
        baselineCommit: isRealSha(base) ? base : undefined,
        eventLabel: label,
      },
    };
  }

  if (eventType === "Push Hook") {
    const ref = str(body, "ref") ?? "";
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
    if (!branch) {
      return { kind: "noop", reason: `push ref "${ref || "?"}" is not a branch ref` };
    }
    const defaultBranch = str(asRecord(body?.project), "default_branch");
    if (!defaultBranch || branch !== defaultBranch) {
      return { kind: "noop", reason: `push to non-default branch "${branch}" is not reviewed` };
    }
    const after = str(body, "after");
    if (!isRealSha(after)) {
      return { kind: "noop", reason: "push after sha missing or not a valid commit id" };
    }
    const before = str(body, "before");
    const shortAfter = after.slice(0, 7);
    if (isRealSha(before)) {
      // A normal push/merge to the default branch → review the merged diff.
      return {
        kind: "review",
        mapping: {
          preset: "diff-pr-review",
          ref: after,
          baselineCommit: before,
          eventLabel: sanitizeEventLabel(`post-merge push to ${branch} (${shortAfter})`),
        },
      };
    }
    // Branch-create / no usable baseline → whole-repo review at the new tip.
    return {
      kind: "review",
      mapping: {
        preset: "sdlc-cross-review",
        ref: after,
        eventLabel: sanitizeEventLabel(`push to ${branch} (${shortAfter})`),
      },
    };
  }

  return { kind: "noop", reason: `event "${eventType || "?"}" is not mapped to a review` };
}
