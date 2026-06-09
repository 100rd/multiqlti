/**
 * Unit tests for the PURE practice-card diff engine.
 *
 * diffPracticeCards(currentActiveCards, candidates, now) classifies into:
 *   new        — candidate contentHash not present in the active set
 *   changed    — same topic + overlapping appliesTo, different contentHash
 *   stale      — active card lastVerifiedAt older than STALE_TTL (90d) or null,
 *                AND not re-confirmed by a candidate (same contentHash)
 *   superseded — active card whose max sources[].sourceVersion is behind a
 *                candidate's for the same topic
 * No card appears in more than one bucket. No side effects; `now` is injected.
 */
import { describe, it, expect } from "vitest";
import {
  diffPracticeCards,
  STALE_TTL_MS,
  type PracticeCardCandidate,
} from "../../../server/knowledge/diff-engine";
import type { PracticeCardRow } from "@shared/schema";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function activeCard(overrides: Partial<PracticeCardRow> = {}): PracticeCardRow {
  return {
    id: "active-" + Math.random().toString(36).slice(2),
    workspaceId: "ws-1",
    topic: "terraform-module-best-practices",
    statement: "Pin module versions.",
    rationale: "Reproducibility.",
    appliesTo: { tool: "terraform", resourceKinds: ["module"], tags: ["versioning"] },
    sources: [{ url: "https://opentofu.org/x", sourceVersion: "1.0.0", fetchedAt: NOW.toISOString() }],
    confidence: 0.8,
    status: "active",
    supersedes: [],
    supersededBy: [],
    ingestedBy: "researcher",
    ingestedByUserId: "u1",
    verifiedBy: "validator",
    verifiedByUserId: "u2",
    verification: {},
    reviewState: "accepted",
    contentHash: "hash-active",
    lastVerifiedAt: NOW, // fresh by default
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function candidate(overrides: Partial<PracticeCardCandidate> = {}): PracticeCardCandidate {
  return {
    topic: "terraform-module-best-practices",
    appliesTo: { tool: "terraform", resourceKinds: ["module"], tags: ["versioning"] },
    contentHash: "hash-candidate",
    sources: [{ url: "https://opentofu.org/x", sourceVersion: "1.0.0", fetchedAt: NOW.toISOString() }],
    ...overrides,
  };
}

describe("diffPracticeCards — STALE_TTL constant", () => {
  it("is 90 days in ms", () => {
    expect(STALE_TTL_MS).toBe(90 * DAY);
  });
});

describe("diffPracticeCards — new", () => {
  it("flags a candidate whose contentHash is not in the active set as new", () => {
    const r = diffPracticeCards([], [candidate({ contentHash: "fresh" })], NOW);
    expect(r.new).toHaveLength(1);
    expect(r.changed).toHaveLength(0);
  });

  it("does NOT flag a candidate as new when its contentHash matches an active card", () => {
    const active = activeCard({ contentHash: "shared" });
    const r = diffPracticeCards([active], [candidate({ contentHash: "shared" })], NOW);
    expect(r.new).toHaveLength(0);
  });
});

describe("diffPracticeCards — changed", () => {
  it("flags candidate with same topic+overlapping scope but different contentHash", () => {
    const active = activeCard({ contentHash: "old" });
    const r = diffPracticeCards([active], [candidate({ contentHash: "new-content" })], NOW);
    expect(r.changed).toHaveLength(1);
    expect(r.new).toHaveLength(0);
  });

  it("treats candidate as new (not changed) when scope does not overlap", () => {
    const active = activeCard({ contentHash: "old", appliesTo: { tool: "terraform", tags: ["state"] } });
    const cand = candidate({ contentHash: "different", appliesTo: { tool: "terraform", tags: ["naming"] } });
    const r = diffPracticeCards([active], [cand], NOW);
    expect(r.new).toHaveLength(1);
    expect(r.changed).toHaveLength(0);
  });

  it("overlap via resourceKinds counts as same scope", () => {
    const active = activeCard({ contentHash: "old", appliesTo: { tool: "terraform", resourceKinds: ["module", "backend"] } });
    const cand = candidate({ contentHash: "x", appliesTo: { tool: "terraform", resourceKinds: ["backend"] } });
    const r = diffPracticeCards([active], [cand], NOW);
    expect(r.changed).toHaveLength(1);
  });
});

describe("diffPracticeCards — stale (TTL boundaries)", () => {
  it("89 days old + not re-confirmed → NOT stale", () => {
    const active = activeCard({ lastVerifiedAt: new Date(NOW.getTime() - 89 * DAY) });
    const r = diffPracticeCards([active], [], NOW);
    expect(r.stale).toHaveLength(0);
  });

  it("exactly 90 days old → stale", () => {
    const active = activeCard({ lastVerifiedAt: new Date(NOW.getTime() - 90 * DAY) });
    const r = diffPracticeCards([active], [], NOW);
    expect(r.stale).toHaveLength(1);
  });

  it("91 days old → stale", () => {
    const active = activeCard({ lastVerifiedAt: new Date(NOW.getTime() - 91 * DAY) });
    const r = diffPracticeCards([active], [], NOW);
    expect(r.stale).toHaveLength(1);
  });

  it("null lastVerifiedAt → stale", () => {
    const active = activeCard({ lastVerifiedAt: null });
    const r = diffPracticeCards([active], [], NOW);
    expect(r.stale).toHaveLength(1);
  });

  it("old card re-confirmed by a candidate (same contentHash) → NOT stale", () => {
    const active = activeCard({ contentHash: "confirmed", lastVerifiedAt: new Date(NOW.getTime() - 200 * DAY) });
    const cand = candidate({ contentHash: "confirmed" });
    const r = diffPracticeCards([active], [cand], NOW);
    expect(r.stale).toHaveLength(0);
  });
});

describe("diffPracticeCards — superseded (version comparison)", () => {
  it("active behind a candidate's newer sourceVersion (same topic) → superseded", () => {
    const active = activeCard({ contentHash: "v-old", sources: [{ url: "https://opentofu.org/x", sourceVersion: "1.2.0", fetchedAt: NOW.toISOString() }] });
    const cand = candidate({ contentHash: "v-new", sources: [{ url: "https://opentofu.org/x", sourceVersion: "1.3.0", fetchedAt: NOW.toISOString() }] });
    const r = diffPracticeCards([active], [cand], NOW);
    expect(r.superseded).toHaveLength(1);
  });

  it("active version equal to candidate → NOT superseded", () => {
    const active = activeCard({ contentHash: "v-old", sources: [{ url: "https://opentofu.org/x", sourceVersion: "1.3.0", fetchedAt: NOW.toISOString() }] });
    const cand = candidate({ contentHash: "v-new", sources: [{ url: "https://opentofu.org/x", sourceVersion: "1.3.0", fetchedAt: NOW.toISOString() }] });
    const r = diffPracticeCards([active], [cand], NOW);
    expect(r.superseded).toHaveLength(0);
  });

  it("active version ahead of candidate → NOT superseded", () => {
    const active = activeCard({ contentHash: "v-old", sources: [{ url: "https://opentofu.org/x", sourceVersion: "2.0.0", fetchedAt: NOW.toISOString() }] });
    const cand = candidate({ contentHash: "v-new", sources: [{ url: "https://opentofu.org/x", sourceVersion: "1.9.0", fetchedAt: NOW.toISOString() }] });
    const r = diffPracticeCards([active], [cand], NOW);
    expect(r.superseded).toHaveLength(0);
  });

  it("missing sourceVersion on either side → NOT superseded (no false positive)", () => {
    const active = activeCard({ contentHash: "v-old", sources: [{ url: "https://opentofu.org/x", fetchedAt: NOW.toISOString() }] });
    const cand = candidate({ contentHash: "v-new", sources: [{ url: "https://opentofu.org/x", sourceVersion: "9.9.9", fetchedAt: NOW.toISOString() }] });
    const r = diffPracticeCards([active], [cand], NOW);
    expect(r.superseded).toHaveLength(0);
  });
});

describe("diffPracticeCards — no cross-bucket duplicates", () => {
  it("a superseded card is not also reported as stale", () => {
    const active = activeCard({
      contentHash: "v-old",
      lastVerifiedAt: null, // would be stale
      sources: [{ url: "https://opentofu.org/x", sourceVersion: "1.0.0", fetchedAt: NOW.toISOString() }],
    });
    const cand = candidate({ contentHash: "v-new", sources: [{ url: "https://opentofu.org/x", sourceVersion: "2.0.0", fetchedAt: NOW.toISOString() }] });
    const r = diffPracticeCards([active], [cand], NOW);
    const ids = [...r.stale, ...r.superseded].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.superseded).toHaveLength(1);
    expect(r.stale).toHaveLength(0);
  });

  it("a changed candidate is not also reported as new", () => {
    const active = activeCard({ contentHash: "old" });
    const cand = candidate({ contentHash: "new-content" });
    const r = diffPracticeCards([active], [cand], NOW);
    expect(r.new).toHaveLength(0);
    expect(r.changed).toHaveLength(1);
  });
});

describe("diffPracticeCards — empty sets", () => {
  it("empty active + empty candidates → all empty, unchangedCount 0", () => {
    const r = diffPracticeCards([], [], NOW);
    expect(r).toEqual({ new: [], changed: [], stale: [], superseded: [], unchangedCount: 0 });
  });

  it("fresh active + empty candidates (cadence run) → unchangedCount counts fresh actives", () => {
    const a1 = activeCard({ contentHash: "a1" });
    const a2 = activeCard({ contentHash: "a2" });
    const r = diffPracticeCards([a1, a2], [], NOW);
    expect(r.new).toHaveLength(0);
    expect(r.changed).toHaveLength(0);
    expect(r.stale).toHaveLength(0);
    expect(r.superseded).toHaveLength(0);
    expect(r.unchangedCount).toBe(2);
  });
});

describe("diffPracticeCards — scale/correctness 200x200", () => {
  it("classifies a large mixed set without dupes", () => {
    const actives: PracticeCardRow[] = [];
    for (let i = 0; i < 200; i++) {
      // Half are stale (null lastVerifiedAt), half fresh.
      actives.push(activeCard({ id: `a-${i}`, contentHash: `h-${i}`, lastVerifiedAt: i % 2 === 0 ? null : NOW }));
    }
    const candidates: PracticeCardCandidate[] = [];
    for (let i = 0; i < 200; i++) {
      candidates.push(candidate({ contentHash: `cand-${i}` }));
    }
    const r = diffPracticeCards(actives, candidates, NOW);
    const allFlagged = [...r.stale, ...r.superseded];
    const ids = allFlagged.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 100 stale (the null ones, none re-confirmed since hashes differ)
    expect(r.stale.length).toBe(100);
  });
});
