/**
 * Unit tests for Morning Brief UI logic (frontend).
 *
 * Like practice-cards-ui.test.ts, these exercise the pure helpers that back the
 * components — relevance/impact bands, freshness, affects aggregation, feed
 * ordering, role gating, and the https-only URL guard — without a DOM renderer.
 */
import { describe, it, expect } from "vitest";
import {
  relevanceBand,
  relevancePercent,
  impactBand,
  impactPercent,
  impactLabel,
  confidencePercent,
  computeFreshness,
  freshnessLabel,
  canRefresh,
  canEditProfile,
  aggregateAffects,
  feedItems,
  safeHttpsHref,
  FRESH_WITHIN_HOURS,
  RECENT_WITHIN_HOURS,
} from "@/lib/news";
import type { NewsItem } from "@/hooks/use-news";
import type { User } from "@shared/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-09T12:00:00.000Z");

function hoursAgo(n: number): string {
  return new Date(NOW.getTime() - n * 60 * 60 * 1000).toISOString();
}

function makeItem(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    id: "item-1",
    category: "external",
    title: "Title",
    summary: "Summary",
    sourceUri: "https://example.com/post",
    sourceName: "Example",
    provider: "aws-whatsnew",
    whyRelevant: null,
    affects: [],
    relevanceScore: 0.5,
    readState: "unread",
    feedback: "none",
    createdAt: hoursAgo(1),
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "u@example.com",
    name: "U",
    isActive: true,
    role: "user",
    lastLoginAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

// ─── Relevance / impact bands ────────────────────────────────────────────────

describe("relevanceBand / impactBand", () => {
  it("buckets into low / medium / high", () => {
    expect(relevanceBand(0.1)).toBe("low");
    expect(relevanceBand(0.4)).toBe("medium");
    expect(relevanceBand(0.9)).toBe("high");
    expect(impactBand(0.0)).toBe("low");
    expect(impactBand(0.5)).toBe("medium");
    expect(impactBand(0.7)).toBe("high");
  });

  it("clamps percentages to 0..100", () => {
    expect(relevancePercent(-1)).toBe(0);
    expect(relevancePercent(2)).toBe(100);
    expect(impactPercent(0.5)).toBe(50);
    expect(confidencePercent(1.5)).toBe(100);
  });

  it("produces a deterministic impact label", () => {
    expect(impactLabel(0.82)).toBe("High impact · 82%");
    expect(impactLabel(0.4)).toBe("Medium impact · 40%");
    expect(impactLabel(0)).toBe("Low impact · 0%");
  });
});

// ─── Freshness ────────────────────────────────────────────────────────────────

describe("computeFreshness", () => {
  it("classifies fresh / recent / stale by age", () => {
    expect(computeFreshness(hoursAgo(2), NOW).freshness).toBe("fresh");
    expect(computeFreshness(hoursAgo(FRESH_WITHIN_HOURS + 1), NOW).freshness).toBe("recent");
    expect(computeFreshness(hoursAgo(RECENT_WITHIN_HOURS + 1), NOW).freshness).toBe("stale");
  });

  it("treats null / unparseable as stale with null age", () => {
    expect(computeFreshness(null, NOW)).toEqual({ freshness: "stale", ageHours: null });
    expect(computeFreshness("not-a-date", NOW).ageHours).toBeNull();
  });

  it("labels relative age", () => {
    expect(freshnessLabel(computeFreshness(hoursAgo(0), NOW))).toBe("Just now");
    expect(freshnessLabel(computeFreshness(hoursAgo(3), NOW))).toBe("3h ago");
    expect(freshnessLabel(computeFreshness(hoursAgo(48), NOW))).toBe("2d ago");
    expect(freshnessLabel(computeFreshness(null, NOW))).toBe("Unknown");
  });
});

// ─── Role gating ──────────────────────────────────────────────────────────────

describe("canRefresh", () => {
  it("allows admin and maintainer", () => {
    expect(canRefresh(makeUser({ role: "admin" }), "owner-x")).toBe(true);
    expect(canRefresh(makeUser({ role: "maintainer" }), "owner-x")).toBe(true);
  });

  it("allows the workspace owner even when role is plain user", () => {
    expect(canRefresh(makeUser({ id: "owner-1", role: "user" }), "owner-1")).toBe(true);
  });

  it("denies a non-owner plain user and a null user", () => {
    expect(canRefresh(makeUser({ id: "user-9", role: "user" }), "owner-1")).toBe(false);
    expect(canRefresh(null, "owner-1")).toBe(false);
  });
});

describe("canEditProfile", () => {
  it("allows any authenticated user, denies anonymous", () => {
    expect(canEditProfile(makeUser())).toBe(true);
    expect(canEditProfile(null)).toBe(false);
  });
});

// ─── Affects aggregation ──────────────────────────────────────────────────────

describe("aggregateAffects", () => {
  it("flattens affects across items and sorts by impactScore DESC", () => {
    const items: NewsItem[] = [
      makeItem({
        id: "a",
        affects: [{ entityId: "svc-a", entityType: "service", impactScore: 0.3, confidence: 0.5, path: [] }],
      }),
      makeItem({
        id: "b",
        affects: [
          { entityId: "svc-b", entityType: "service", impactScore: 0.9, confidence: 0.8, path: [] },
          { entityId: "svc-c", entityType: "pod", impactScore: 0.6, confidence: 0.7, path: [] },
        ],
      }),
    ];
    const out = aggregateAffects(items);
    expect(out.map((a) => a.entityId)).toEqual(["svc-b", "svc-c", "svc-a"]);
    expect(out[0].itemId).toBe("b");
    expect(out[0].itemTitle).toBe("Title");
  });

  it("returns an empty list when no item has affects", () => {
    expect(aggregateAffects([makeItem(), makeItem({ id: "x" })])).toEqual([]);
  });

  it("uses a stable id tiebreak for equal impact scores", () => {
    const items: NewsItem[] = [
      makeItem({ id: "i", affects: [{ entityId: "z", entityType: "s", impactScore: 0.5, confidence: 0.5, path: [] }] }),
      makeItem({ id: "j", affects: [{ entityId: "a", entityType: "s", impactScore: 0.5, confidence: 0.5, path: [] }] }),
    ];
    expect(aggregateAffects(items).map((a) => a.entityId)).toEqual(["a", "z"]);
  });
});

// ─── Feed ordering ────────────────────────────────────────────────────────────

describe("feedItems", () => {
  it("filters by category, drops hidden, orders by relevance DESC", () => {
    const items: NewsItem[] = [
      makeItem({ id: "x1", category: "internal", relevanceScore: 0.2 }),
      makeItem({ id: "x2", category: "internal", relevanceScore: 0.9 }),
      makeItem({ id: "x3", category: "internal", relevanceScore: 0.99, feedback: "hidden" }),
      makeItem({ id: "x4", category: "external", relevanceScore: 0.8 }),
    ];
    const internal = feedItems(items, "internal");
    expect(internal.map((i) => i.id)).toEqual(["x2", "x1"]);
    expect(feedItems(items, "external").map((i) => i.id)).toEqual(["x4"]);
  });

  it("stable id tiebreak on equal relevance", () => {
    const items: NewsItem[] = [
      makeItem({ id: "b", category: "external", relevanceScore: 0.5 }),
      makeItem({ id: "a", category: "external", relevanceScore: 0.5 }),
    ];
    expect(feedItems(items, "external").map((i) => i.id)).toEqual(["a", "b"]);
  });
});

// ─── URL safety (M2) ──────────────────────────────────────────────────────────

describe("safeHttpsHref", () => {
  it("returns the URL only for absolute https URLs", () => {
    expect(safeHttpsHref("https://aws.amazon.com/new")).toBe("https://aws.amazon.com/new");
  });

  it("rejects non-https schemes (returns null so caller renders inert text)", () => {
    expect(safeHttpsHref("http://example.com")).toBeNull();
    expect(safeHttpsHref("javascript:alert(1)")).toBeNull();
    expect(safeHttpsHref("data:text/html,<script>")).toBeNull();
    expect(safeHttpsHref("ftp://example.com")).toBeNull();
  });

  it("rejects relative / unparseable / empty values", () => {
    expect(safeHttpsHref("/relative/path")).toBeNull();
    expect(safeHttpsHref("not a url")).toBeNull();
    expect(safeHttpsHref(null)).toBeNull();
    expect(safeHttpsHref(undefined)).toBeNull();
    expect(safeHttpsHref("")).toBeNull();
  });
});
