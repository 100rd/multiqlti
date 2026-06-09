/**
 * Unit tests for Active Knowledge Base UI logic (frontend).
 *
 * Like manager-ui.test.ts, these exercise the pure helpers that back the
 * components — freshness/staleness classification, review-queue selection, the
 * review/maintain role gates, and the supersede picker — without a DOM renderer.
 */
import { describe, it, expect } from "vitest";
import {
  computeFreshness,
  freshnessLabel,
  confidenceBand,
  confidencePercent,
  canReview,
  canMaintain,
  pendingReviewCards,
  supersedeCandidates,
  STALE_AFTER_DAYS,
  AGING_AFTER_DAYS,
} from "@/lib/practice-cards";
import type { PracticeCard } from "@/hooks/use-practice-cards";
import type { User } from "@shared/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-08T00:00:00.000Z");

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

function makeCard(overrides: Partial<PracticeCard> = {}): PracticeCard {
  return {
    id: "card-1",
    workspaceId: "ws-1",
    topic: "terraform-module-best-practices",
    statement: "Pin module versions",
    rationale: "Reproducible builds",
    appliesTo: { tool: "terraform" },
    sources: [],
    confidence: 0.8,
    status: "active",
    supersedes: [],
    supersededBy: [],
    ingestedBy: "agent:researcher",
    ingestedByUserId: "u-ingest",
    verifiedBy: "agent:critic",
    verifiedByUserId: "u-verify",
    verification: {},
    reviewState: "accepted",
    contentHash: "hash",
    lastVerifiedAt: daysAgo(1),
    createdAt: daysAgo(10),
    updatedAt: daysAgo(1),
    ...overrides,
  } as PracticeCard;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u-1",
    email: "a@b.c",
    name: "A",
    isActive: true,
    role: "user",
    lastLoginAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

// ─── Freshness ────────────────────────────────────────────────────────────────

describe("computeFreshness", () => {
  it("flags never-verified cards as stale", () => {
    const info = computeFreshness(null, NOW);
    expect(info.freshness).toBe("never_verified");
    expect(info.ageDays).toBeNull();
    expect(info.isStale).toBe(true);
  });

  it("treats invalid dates as never verified", () => {
    const info = computeFreshness("not-a-date", NOW);
    expect(info.freshness).toBe("never_verified");
    expect(info.isStale).toBe(true);
  });

  it("classifies a recent verification as fresh", () => {
    const info = computeFreshness(daysAgo(3), NOW);
    expect(info.freshness).toBe("fresh");
    expect(info.ageDays).toBe(3);
    expect(info.isStale).toBe(false);
  });

  it("classifies the aging band just below the stale threshold", () => {
    const info = computeFreshness(daysAgo(AGING_AFTER_DAYS), NOW);
    expect(info.freshness).toBe("aging");
    expect(info.isStale).toBe(false);
  });

  it("flags cards past the stale threshold as stale", () => {
    const info = computeFreshness(daysAgo(STALE_AFTER_DAYS), NOW);
    expect(info.freshness).toBe("stale");
    expect(info.ageDays).toBe(STALE_AFTER_DAYS);
    expect(info.isStale).toBe(true);
  });

  it("accepts ISO strings as well as Date objects", () => {
    const info = computeFreshness(daysAgo(100).toISOString(), NOW);
    expect(info.freshness).toBe("stale");
  });

  it("never reports a negative age for future dates", () => {
    const info = computeFreshness(new Date(NOW.getTime() + 10_000), NOW);
    expect(info.ageDays).toBe(0);
    expect(info.freshness).toBe("fresh");
  });
});

describe("freshnessLabel", () => {
  it("labels never-verified, today, single, and plural days", () => {
    expect(freshnessLabel(computeFreshness(null, NOW))).toBe("Never verified");
    expect(freshnessLabel(computeFreshness(daysAgo(0), NOW))).toBe("Verified today");
    expect(freshnessLabel(computeFreshness(daysAgo(1), NOW))).toBe(
      "Verified 1 day ago",
    );
    expect(freshnessLabel(computeFreshness(daysAgo(5), NOW))).toBe(
      "Verified 5 days ago",
    );
  });
});

// ─── Confidence ───────────────────────────────────────────────────────────────

describe("confidence helpers", () => {
  it("bands confidence into low/medium/high", () => {
    expect(confidenceBand(0.2)).toBe("low");
    expect(confidenceBand(0.5)).toBe("medium");
    expect(confidenceBand(0.9)).toBe("high");
  });

  it("clamps and rounds percentages", () => {
    expect(confidencePercent(0.834)).toBe(83);
    expect(confidencePercent(1.5)).toBe(100);
    expect(confidencePercent(-1)).toBe(0);
  });
});

// ─── Role gates ─────────────────────────────────────────────────────────────

describe("canReview", () => {
  it("denies anonymous users", () => {
    expect(canReview(null, "owner-1")).toBe(false);
  });

  it("allows admins regardless of ownership", () => {
    expect(canReview(makeUser({ role: "admin", id: "x" }), "owner-1")).toBe(true);
  });

  it("allows the workspace owner even without an elevated role", () => {
    expect(canReview(makeUser({ role: "user", id: "owner-1" }), "owner-1")).toBe(
      true,
    );
  });

  it("denies maintainers who are not the owner (review is admin/owner only)", () => {
    expect(canReview(makeUser({ role: "maintainer", id: "m" }), "owner-1")).toBe(
      false,
    );
  });

  it("denies plain users who are not the owner", () => {
    expect(canReview(makeUser({ role: "user", id: "u" }), "owner-1")).toBe(false);
  });
});

describe("canMaintain", () => {
  it("allows admin, maintainer, and the owner; denies others", () => {
    expect(canMaintain(makeUser({ role: "admin", id: "a" }), "o")).toBe(true);
    expect(canMaintain(makeUser({ role: "maintainer", id: "m" }), "o")).toBe(true);
    expect(canMaintain(makeUser({ role: "user", id: "o" }), "o")).toBe(true);
    expect(canMaintain(makeUser({ role: "user", id: "u" }), "o")).toBe(false);
    expect(canMaintain(null, "o")).toBe(false);
  });
});

// ─── Review queue ─────────────────────────────────────────────────────────────

describe("pendingReviewCards", () => {
  it("returns only cards awaiting human review", () => {
    const cards = [
      makeCard({ id: "a", reviewState: "pending_review" }),
      makeCard({ id: "b", reviewState: "accepted" }),
      makeCard({ id: "c", reviewState: "pending_verification" }),
      makeCard({ id: "d", reviewState: "pending_review" }),
    ];
    const queue = pendingReviewCards(cards);
    expect(queue.map((c) => c.id)).toEqual(["a", "d"]);
  });

  it("returns an empty array when nothing is pending", () => {
    expect(pendingReviewCards([makeCard({ reviewState: "accepted" })])).toEqual([]);
  });
});

describe("supersedeCandidates", () => {
  const target = makeCard({ id: "new", reviewState: "pending_review" });

  it("offers active, accepted cards on the same topic, excluding the target", () => {
    const cards = [
      target,
      makeCard({ id: "old", status: "active", reviewState: "accepted" }),
      makeCard({
        id: "self",
        status: "active",
        reviewState: "accepted",
        topic: target.topic,
      }),
    ];
    // Exclude the card under review (id "self") from its own supersede list.
    const candidates = supersedeCandidates(
      cards,
      makeCard({ id: "self", topic: target.topic }),
    );
    expect(candidates.map((c) => c.id)).toContain("old");
    expect(candidates.map((c) => c.id)).not.toContain("self");
  });

  it("excludes superseded, rejected, and different-topic cards", () => {
    const cards = [
      target,
      makeCard({ id: "superseded", status: "superseded", reviewState: "accepted" }),
      makeCard({ id: "rejected", status: "active", reviewState: "rejected" }),
      makeCard({
        id: "other-topic",
        status: "active",
        reviewState: "accepted",
        topic: "other",
      }),
      makeCard({ id: "valid", status: "active", reviewState: "accepted" }),
    ];
    const candidates = supersedeCandidates(cards, target);
    expect(candidates.map((c) => c.id)).toEqual(["valid"]);
  });
});
