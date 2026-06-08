/**
 * Pure helpers for the Active Knowledge Base UI.
 *
 * These are deliberately framework-free so they can be unit-tested in the
 * repo's node-only vitest setup (tests/unit/*.test.ts) without a DOM renderer,
 * matching the existing manager-ui.test.ts pattern. Components import these and
 * stay thin.
 */
import type {
  PracticeCard,
  PracticeCardStatus,
  PracticeCardReviewState,
} from "@/hooks/use-practice-cards";
import type { User } from "@shared/types";

// ─── Freshness ────────────────────────────────────────────────────────────────

/** Cards unverified for longer than this are flagged stale. */
export const STALE_AFTER_DAYS = 90;
/** Cards approaching the stale threshold are flagged aging. */
export const AGING_AFTER_DAYS = 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type Freshness = "never_verified" | "fresh" | "aging" | "stale";

export interface FreshnessInfo {
  freshness: Freshness;
  /** Whole days since lastVerifiedAt, or null when never verified. */
  ageDays: number | null;
  /** True when the card should be visually flagged for human attention. */
  isStale: boolean;
}

/**
 * Classify how fresh a card's last verification is.
 *
 * `now` is injectable so the logic is deterministic under test.
 */
export function computeFreshness(
  lastVerifiedAt: Date | string | null | undefined,
  now: Date = new Date(),
): FreshnessInfo {
  if (lastVerifiedAt == null) {
    return { freshness: "never_verified", ageDays: null, isStale: true };
  }
  const verified =
    lastVerifiedAt instanceof Date ? lastVerifiedAt : new Date(lastVerifiedAt);
  if (Number.isNaN(verified.getTime())) {
    return { freshness: "never_verified", ageDays: null, isStale: true };
  }
  const ageDays = Math.max(
    0,
    Math.floor((now.getTime() - verified.getTime()) / MS_PER_DAY),
  );
  if (ageDays >= STALE_AFTER_DAYS) {
    return { freshness: "stale", ageDays, isStale: true };
  }
  if (ageDays >= AGING_AFTER_DAYS) {
    return { freshness: "aging", ageDays, isStale: false };
  }
  return { freshness: "fresh", ageDays, isStale: false };
}

/** Human-friendly relative age label, e.g. "Verified 12 days ago". */
export function freshnessLabel(info: FreshnessInfo): string {
  if (info.ageDays == null) return "Never verified";
  if (info.ageDays === 0) return "Verified today";
  if (info.ageDays === 1) return "Verified 1 day ago";
  return `Verified ${info.ageDays} days ago`;
}

// ─── Confidence ───────────────────────────────────────────────────────────────

export type ConfidenceBand = "low" | "medium" | "high";

/** Bucket a 0..1 confidence into a band for color coding. */
export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.45) return "medium";
  return "low";
}

/** Confidence as a clamped 0..100 percentage. */
export function confidencePercent(confidence: number): number {
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100);
}

// ─── Review authorization ──────────────────────────────────────────────────────

/**
 * Whether the current user may run the human review gate (accept/reject).
 *
 * The backend gates /review with `requireOwnerOrRole(ownerId, "admin")` — i.e.
 * workspace owner OR admin. There is no distinct "owner" role; ownership is the
 * workspace.ownerId field. We mirror that here for UI affordances; the server
 * remains the source of truth.
 */
export function canReview(
  user: Pick<User, "id" | "role"> | null | undefined,
  workspaceOwnerId: string | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return !!workspaceOwnerId && user.id === workspaceOwnerId;
}

/**
 * Whether the current user may mutate cards (ingest/verify) — maintainer, admin,
 * or workspace owner, matching `requireOwnerOrRole(ownerId, "maintainer", "admin")`.
 */
export function canMaintain(
  user: Pick<User, "id" | "role"> | null | undefined,
  workspaceOwnerId: string | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin" || user.role === "maintainer") return true;
  return !!workspaceOwnerId && user.id === workspaceOwnerId;
}

// ─── Review queue ───────────────────────────────────────────────────────────────

/** Cards awaiting the human accept/reject decision. */
export function pendingReviewCards(cards: PracticeCard[]): PracticeCard[] {
  return cards.filter((c) => c.reviewState === "pending_review");
}

/**
 * Candidate cards that an accept decision could supersede: currently-active,
 * already-accepted cards on the same topic, excluding the card under review.
 */
export function supersedeCandidates(
  cards: PracticeCard[],
  target: PracticeCard,
): PracticeCard[] {
  return cards.filter(
    (c) =>
      c.id !== target.id &&
      c.status === "active" &&
      c.topic === target.topic &&
      c.reviewState === "accepted",
  );
}

// ─── Display metadata ─────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<PracticeCardStatus, string> = {
  active: "Active",
  superseded: "Superseded",
  deprecated: "Deprecated",
};

export const REVIEW_STATE_LABELS: Record<PracticeCardReviewState, string> = {
  pending_verification: "Pending verification",
  pending_review: "Pending review",
  accepted: "Accepted",
  rejected: "Rejected",
};
