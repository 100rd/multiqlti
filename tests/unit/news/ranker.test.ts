/**
 * Unit tests for the pure relevance ranker.
 *
 * score = clamp01( profileMatch(stack/role hits) + affectsBoost(max impact_score)
 *                 + feedbackEffect(up boost / down reduce / read demote) )
 * Force-drop (score 0): item.category in muted, OR feedback === "hidden".
 * Ordering: DESC by score, stable + deterministic. Never throws on injection /
 * empty / null inputs.
 */
import { describe, it, expect } from "vitest";
import { rankItems, type RankableItem } from "../../../server/news/relevance-ranker";
import type { NewsProfileRow } from "@shared/schema";

function profile(overrides: Partial<NewsProfileRow> = {}): NewsProfileRow {
  return {
    id: "p1",
    workspaceId: "ws-1",
    userId: "u1",
    role: "sre",
    stack: ["terraform", "kubernetes", "aws"],
    mutedCategories: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function item(overrides: Partial<RankableItem> = {}): RankableItem {
  return {
    id: "i1",
    category: "external",
    title: "Generic release",
    summary: "Some changelog.",
    sourceName: "vendor",
    affects: [],
    readState: "unread",
    feedback: "none",
    ...overrides,
  };
}

describe("rankItems — profile match", () => {
  it("scores a stack-keyword-matching item above a non-matching one", () => {
    const matching = item({ id: "match", title: "Terraform 1.9 released", summary: "kubernetes support" });
    const other = item({ id: "other", title: "Unrelated weather news", summary: "sunny" });
    const ranked = rankItems([other, matching], profile(), []);
    expect(ranked[0].id).toBe("match");
    expect(ranked[0].relevanceScore).toBeGreaterThan(ranked[1].relevanceScore);
  });

  it("role synonyms contribute to the score", () => {
    const roleHit = item({ id: "role", title: "SRE on-call rotation tips", summary: "reliability" });
    const none = item({ id: "none", title: "zzz", summary: "qqq" });
    const ranked = rankItems([none, roleHit], profile({ role: "sre" }), []);
    expect(ranked[0].id).toBe("role");
  });
});

describe("rankItems — affects boost", () => {
  it("an internal item touching the platform floats above a plain match", () => {
    const affected = item({
      id: "affected",
      category: "internal",
      title: "deploy",
      affects: [{ entityId: "svc-a", entityType: "service", impactScore: 0.9, confidence: 1, path: [] }],
    });
    const plain = item({ id: "plain", title: "terraform aws kubernetes" });
    const ranked = rankItems([plain, affected], profile(), []);
    expect(ranked[0].id).toBe("affected");
  });

  it("uses the MAX impact_score across affects[]", () => {
    const withAffects = item({
      id: "multi",
      affects: [
        { entityId: "a", entityType: "service", impactScore: 0.2, confidence: 1, path: [] },
        { entityId: "b", entityType: "pod", impactScore: 0.95, confidence: 1, path: [] },
      ],
    });
    const ranked = rankItems([withAffects], profile(), []);
    expect(ranked[0].relevanceScore).toBeGreaterThanOrEqual(0.95 * 0.5);
  });
});

describe("rankItems — feedback effect", () => {
  it("an up-voted item outranks an otherwise-identical neutral one", () => {
    const up = item({ id: "up", feedback: "up" });
    const neutral = item({ id: "neutral", feedback: "none" });
    const ranked = rankItems([neutral, up], profile(), []);
    expect(ranked[0].id).toBe("up");
  });

  it("a down-voted item ranks below a neutral one", () => {
    const down = item({ id: "down", title: "terraform", feedback: "down" });
    const neutral = item({ id: "neutral", title: "terraform", feedback: "none" });
    const ranked = rankItems([down, neutral], profile(), []);
    expect(ranked[ranked.length - 1].id).toBe("down");
  });

  it("a read item is demoted relative to an unread identical one", () => {
    const read = item({ id: "read", title: "terraform", readState: "read" });
    const unread = item({ id: "unread", title: "terraform", readState: "unread" });
    const ranked = rankItems([read, unread], profile(), []);
    expect(ranked[0].id).toBe("unread");
  });
});

describe("rankItems — force-drop (muted + hidden)", () => {
  it("forces score 0 when feedback === hidden", () => {
    const hidden = item({ id: "hidden", title: "terraform aws kubernetes", feedback: "hidden" });
    const ranked = rankItems([hidden], profile(), []);
    expect(ranked[0].relevanceScore).toBe(0);
  });

  it("forces score 0 when the item's category is muted", () => {
    const muted = item({ id: "muted", category: "external", title: "terraform aws" });
    const ranked = rankItems([muted], profile({ mutedCategories: ["external"] }), []);
    expect(ranked[0].relevanceScore).toBe(0);
  });
});

describe("rankItems — ordering & boundaries", () => {
  it("clamps the score into [0,1]", () => {
    const huge = item({
      id: "huge",
      title: "terraform kubernetes aws argocd go sre devops platform",
      summary: "terraform kubernetes aws",
      feedback: "up",
      affects: [{ entityId: "x", entityType: "service", impactScore: 1, confidence: 1, path: [] }],
    });
    const ranked = rankItems([huge], profile(), []);
    expect(ranked[0].relevanceScore).toBeLessThanOrEqual(1);
    expect(ranked[0].relevanceScore).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic — same input yields same order and scores", () => {
    const items = [item({ id: "a", title: "terraform" }), item({ id: "b", title: "kubernetes" })];
    const r1 = rankItems(items, profile(), []);
    const r2 = rankItems(items, profile(), []);
    expect(r1.map((i) => i.id)).toEqual(r2.map((i) => i.id));
    expect(r1.map((i) => i.relevanceScore)).toEqual(r2.map((i) => i.relevanceScore));
  });

  it("is stable for equal scores (preserves input order by id tiebreak)", () => {
    const items = [item({ id: "z", title: "qqq" }), item({ id: "a", title: "qqq" })];
    const ranked = rankItems(items, profile(), []);
    // equal scores → deterministic tiebreak by id ascending
    expect(ranked[0].id).toBe("a");
  });

  it("returns an empty array for empty input", () => {
    expect(rankItems([], profile(), [])).toEqual([]);
  });

  it("does not throw on injection-style strings", () => {
    const evil = item({
      id: "evil",
      title: "<script>alert(1)</script> '; DROP TABLE news_item; --",
      summary: "${process.env.OMNISCIENCE_TOKEN} {{constructor}}",
    });
    expect(() => rankItems([evil], profile(), [])).not.toThrow();
  });

  it("tolerates null/undefined-ish fields without throwing", () => {
    const sparse = {
      id: "sparse",
      category: "external",
      title: "",
      summary: "",
      affects: [],
      readState: "unread",
      feedback: "none",
    } as RankableItem;
    expect(() => rankItems([sparse], profile({ stack: [] }), [])).not.toThrow();
  });
});
