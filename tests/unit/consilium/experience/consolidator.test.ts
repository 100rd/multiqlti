/**
 * consolidator.test.ts — DREAM-3: the PURE consolidation logic (dedup/merge, decay,
 * contradiction, successDelta). Spec: experience-plane-dream.md §4/§6/§9.
 *
 * Covers (the adversarial checklist from the ticket):
 *   - two duplicate items in a scope → MERGED: evidence unioned, strongest verification
 *     kept, relatedComponents unioned, the duplicate DELETED (never loses evidence);
 *   - a stale `verified` item → DECAYED to `observed`, written back (decayedFrom audit);
 *   - contradictory items (verified + refuted, same scope+claim) → BOTH kept + conflict
 *     flagged (fresher-verified leads), never a silent overwrite / verified→refuted flip;
 *   - `successDelta` recomputed from a reuse signal (same pattern re-verified across loops);
 *   - the pass is IDEMPOTENT: a second run over the applied result yields no updates/deletes;
 *   - a HUGE store is BOUNDED (maxItems cap; evidence/sourceLoops bounded — no OOM);
 *   - different projects with a same-basename repo NEVER cross-merge (isolation).
 */
import { describe, it, expect } from "vitest";
import { consolidate, type ConsolidateOptions } from "../../../../server/services/consilium/experience/consolidator.js";
import type { ExperienceItemRow } from "@shared/schema";
import type { ExperienceConfidence, ExperienceEvidence } from "@shared/types";

// ── Fixtures ────────────────────────────────────────────────────────────────

const T0 = new Date("2026-07-06T00:00:00.000Z");
/** A fixed "now" far enough after the fixtures that a 60-day stale item is stale. */
const NOW = new Date("2026-07-06T00:00:00.000Z");

function ev(loopId: string, round: number, diffRef: string | null = "sha"): ExperienceEvidence {
  return { loopId, round, apTitle: `AP ${loopId}`, diffRef };
}

function item(p: Partial<ExperienceItemRow> & { id: string }): ExperienceItemRow {
  const confidence: ExperienceConfidence = p.confidence ?? "verified";
  const base: ExperienceItemRow = {
    id: p.id,
    projectId: "proj-1",
    scope: { repo: "widget", archetype: "repo-assessment", criterionClass: "test-run" },
    claim: "On widget, the criterion \"coverage gate\" was VERIFIED (test-run).",
    evidence: [ev(`loop-${p.id}`, 1)],
    verification: { method: "test-run", outcome: "independent-pass", groundingRatioAtTime: 1 },
    confidence,
    successDelta: null,
    provenance: { createdAt: T0.toISOString(), dreamRunId: "dr-0", sourceLoops: [`loop-${p.id}`] },
    freshness: { lastConfirmedAt: T0.toISOString(), decayPolicy: "reuse:5" },
    consolidation: null,
    relatedComponents: [],
    sourceLoopId: `loop-${p.id}`,
    createdAt: T0,
  } as ExperienceItemRow;
  return { ...base, ...p } as ExperienceItemRow;
}

function opts(over: Partial<ConsolidateOptions> = {}): ConsolidateOptions {
  return { dreamRunId: "dr-1", staleVerifiedDays: 60, now: () => NOW, ...over };
}

/** Apply a plan to a working set (mimics the observer) so idempotency can be re-checked. */
function apply(items: ExperienceItemRow[], plan: ReturnType<typeof consolidate>): ExperienceItemRow[] {
  const map = new Map(items.map((i) => [i.id, { ...i }]));
  for (const u of plan.updates) {
    const cur = map.get(u.id);
    if (cur) map.set(u.id, { ...cur, ...u.patch } as ExperienceItemRow);
  }
  for (const id of plan.deletes) map.delete(id);
  return Array.from(map.values());
}

// ── Dedup / merge ─────────────────────────────────────────────────────────────

describe("consolidate — dedup / merge", () => {
  it("merges two duplicate items: evidence unioned, strongest verification kept, duplicate deleted", () => {
    const a = item({ id: "a", confidence: "observed", evidence: [ev("loop-a", 1)], relatedComponents: ["svc:auth"] });
    const b = item({
      id: "b",
      confidence: "verified",
      evidence: [ev("loop-b", 2)],
      relatedComponents: ["svc:db"],
      sourceLoopId: "loop-b",
      provenance: { createdAt: T0.toISOString(), dreamRunId: "dr-0", sourceLoops: ["loop-b"] },
    });
    const plan = consolidate([a, b], opts());

    // Exactly one survivor updated, exactly one duplicate deleted.
    expect(plan.deletes).toHaveLength(1);
    expect(plan.updates).toHaveLength(1);
    const survivorId = plan.updates[0].id;
    const deletedId = plan.deletes[0];
    expect(new Set([survivorId, deletedId])).toEqual(new Set(["a", "b"]));

    const patch = plan.updates[0].patch;
    // Strongest verification kept (verified beats observed) — NEVER downgraded.
    expect(patch.confidence).toBe("verified");
    expect(patch.verification?.outcome).toBe("independent-pass");
    // Evidence UNIONED (both links present) — never lost.
    expect(patch.evidence?.map((e) => e.loopId).sort()).toEqual(["loop-a", "loop-b"]);
    // relatedComponents unioned.
    expect(patch.relatedComponents?.sort()).toEqual(["svc:auth", "svc:db"]);
    // sourceLoops unioned.
    expect(patch.provenance?.sourceLoops.sort()).toEqual(["loop-a", "loop-b"]);
    expect(plan.stats.merged).toBe(1);
  });

  it("never flips a verified survivor to refuted when merging with an observed duplicate", () => {
    const a = item({ id: "a", confidence: "verified" });
    const b = item({ id: "b", confidence: "observed", sourceLoopId: "loop-b" });
    const plan = consolidate([a, b], opts());
    expect(plan.updates[0].patch.confidence).toBe("verified");
  });
});

// ── Decay ─────────────────────────────────────────────────────────────────────

describe("consolidate — decay (§6 self-correction)", () => {
  it("demotes a stale verified item to observed and writes it back with a decay audit", () => {
    const stale = item({
      id: "stale",
      confidence: "verified",
      freshness: { lastConfirmedAt: "2026-01-01T00:00:00.000Z", decayPolicy: "reuse:5" }, // ~186 days old
    });
    const plan = consolidate([stale], opts({ staleVerifiedDays: 60 }));
    expect(plan.updates).toHaveLength(1);
    expect(plan.deletes).toHaveLength(0);
    const patch = plan.updates[0].patch;
    expect(patch.confidence).toBe("observed");
    expect(patch.consolidation?.decayedFrom).toBe("verified");
    expect(plan.stats.decayed).toBe(1);
  });

  it("does NOT decay a fresh verified item (no update, no thrash)", () => {
    const fresh = item({
      id: "fresh",
      confidence: "verified",
      freshness: { lastConfirmedAt: "2026-07-01T00:00:00.000Z", decayPolicy: "reuse:5" }, // 5 days old
    });
    const plan = consolidate([fresh], opts({ staleVerifiedDays: 60 }));
    expect(plan.updates).toHaveLength(0);
    expect(plan.deletes).toHaveLength(0);
  });

  it("does NOT re-demote an already-observed item (idempotent decay)", () => {
    const obs = item({
      id: "obs",
      confidence: "observed",
      freshness: { lastConfirmedAt: "2026-01-01T00:00:00.000Z", decayPolicy: "reuse:5" },
    });
    const plan = consolidate([obs], opts());
    expect(plan.updates).toHaveLength(0);
  });
});

// ── Contradiction ───────────────────────────────────────────────────────────

describe("consolidate — contradiction (§6)", () => {
  // REALISTIC distiller-shaped claims: the SAME criterion, but the outcome verb differs
  // (VERIFIED vs REFUTED). The outcome-independent grouping MUST still unite them so the
  // contradiction is detected (a raw-claim-match would miss it — the guard this asserts).
  const goodClaim = 'On widget, the criterion "coverage gate" was VERIFIED (test-run).';
  const badClaim = 'On widget, the criterion "coverage gate" was REFUTED (test-run) — the change did not close it.';

  it("keeps BOTH a verified and a refuted item on the same scope+criterion, flags the conflict", () => {
    const good = item({
      id: "good",
      confidence: "verified",
      claim: goodClaim,
      freshness: { lastConfirmedAt: "2026-07-05T00:00:00.000Z", decayPolicy: "reuse:5" }, // fresher
    });
    const bad = item({
      id: "bad",
      confidence: "refuted",
      claim: badClaim,
      verification: { method: "test-run", outcome: "independent-fail", groundingRatioAtTime: 1 },
      sourceLoopId: "loop-bad",
      provenance: { createdAt: T0.toISOString(), dreamRunId: "dr-0", sourceLoops: ["loop-bad"] },
      freshness: { lastConfirmedAt: "2026-06-01T00:00:00.000Z", decayPolicy: "reuse:5" },
    });
    const plan = consolidate([good, bad], opts());

    // BOTH kept — neither deleted (no silent overwrite).
    expect(plan.deletes).toHaveLength(0);
    expect(plan.updates).toHaveLength(2);
    expect(plan.stats.conflicts).toBe(1);

    const byId = new Map(plan.updates.map((u) => [u.id, u.patch]));
    // Neither side's grounded confidence is flipped.
    expect(byId.get("good")?.confidence).toBe("verified");
    expect(byId.get("bad")?.confidence).toBe("refuted");
    // Cross-linked conflict flags (fresher-verified leads).
    expect(byId.get("good")?.consolidation?.conflict?.withItemId).toBe("bad");
    expect(byId.get("good")?.consolidation?.conflict?.opposingConfidence).toBe("refuted");
    expect(byId.get("bad")?.consolidation?.conflict?.withItemId).toBe("good");
    expect(byId.get("bad")?.consolidation?.conflict?.opposingConfidence).toBe("verified");
  });

  it("collapses same-polarity duplicates within each side of a contradiction", () => {
    const v1 = item({ id: "v1", confidence: "verified", claim: goodClaim, evidence: [ev("loop-v1", 1)] });
    const v2 = item({ id: "v2", confidence: "verified", claim: goodClaim, evidence: [ev("loop-v2", 1)], sourceLoopId: "loop-v2",
      provenance: { createdAt: T0.toISOString(), dreamRunId: "dr-0", sourceLoops: ["loop-v2"] } });
    const r1 = item({ id: "r1", confidence: "refuted", claim: badClaim, sourceLoopId: "loop-r1",
      provenance: { createdAt: T0.toISOString(), dreamRunId: "dr-0", sourceLoops: ["loop-r1"] } });
    const plan = consolidate([v1, v2, r1], opts());
    // One verified survivor (v1|v2 merged, the other deleted) + one refuted survivor kept.
    expect(plan.deletes).toHaveLength(1);
    expect(plan.updates).toHaveLength(2);
    expect(plan.stats.conflicts).toBe(1);
  });
});

// ── successDelta from reuse ───────────────────────────────────────────────────

describe("consolidate — successDelta from reuse (§3 R2 / §6)", () => {
  it("sets successDelta=1 when the same pattern was verified across two independent loops", () => {
    const a = item({ id: "a", confidence: "verified", sourceLoopId: "loop-1",
      provenance: { createdAt: T0.toISOString(), dreamRunId: "dr-0", sourceLoops: ["loop-1"] } });
    const b = item({ id: "b", confidence: "verified", sourceLoopId: "loop-2",
      provenance: { createdAt: T0.toISOString(), dreamRunId: "dr-0", sourceLoops: ["loop-2"] } });
    const plan = consolidate([a, b], opts());
    expect(plan.updates[0].patch.successDelta).toBe(1);
    expect(plan.stats.successDeltaSet).toBe(1);
  });

  it("leaves successDelta null for a single occurrence (no reuse to measure)", () => {
    const a = item({ id: "a", confidence: "verified" });
    const plan = consolidate([a], opts());
    // Nothing to consolidate ⇒ no update at all.
    expect(plan.updates).toHaveLength(0);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("consolidate — idempotency (anti-thrash, §4)", () => {
  it("a re-run over the applied result yields NO updates and NO deletes", () => {
    const a = item({ id: "a", confidence: "observed", evidence: [ev("loop-a", 1)] });
    const b = item({ id: "b", confidence: "verified", evidence: [ev("loop-b", 2)], sourceLoopId: "loop-b",
      provenance: { createdAt: T0.toISOString(), dreamRunId: "dr-0", sourceLoops: ["loop-b"] } });
    const first = consolidate([a, b], opts());
    const afterFirst = apply([a, b], first);

    const second = consolidate(afterFirst, opts({ dreamRunId: "dr-2" }));
    expect(second.updates).toHaveLength(0);
    expect(second.deletes).toHaveLength(0);
  });

  it("a stable contradiction re-run yields NO further writes", () => {
    const good = item({ id: "good", confidence: "verified", claim: 'On widget, the criterion "x" was VERIFIED (test-run).' });
    const bad = item({ id: "bad", confidence: "refuted", claim: 'On widget, the criterion "x" was REFUTED (test-run).', sourceLoopId: "loop-bad",
      verification: { method: "test-run", outcome: "independent-fail", groundingRatioAtTime: 1 },
      provenance: { createdAt: T0.toISOString(), dreamRunId: "dr-0", sourceLoops: ["loop-bad"] } });
    const first = consolidate([good, bad], opts());
    const afterFirst = apply([good, bad], first);
    const second = consolidate(afterFirst, opts({ dreamRunId: "dr-2" }));
    expect(second.updates).toHaveLength(0);
    expect(second.deletes).toHaveLength(0);
  });
});

// ── Bounds / isolation ────────────────────────────────────────────────────────

describe("consolidate — bounds + isolation", () => {
  it("respects the maxItems cap on a huge store (never OOMs)", () => {
    const many = Array.from({ length: 10_000 }, (_, i) =>
      item({ id: `i${i}`, claim: `distinct claim ${i}`, sourceLoopId: `loop-${i}` }),
    );
    const plan = consolidate(many, opts({ maxItems: 100 }));
    expect(plan.stats.scanned).toBe(100);
    expect(plan.stats.groups).toBeLessThanOrEqual(100);
  });

  it("never cross-merges two projects that share a repo basename", () => {
    const p1 = item({ id: "p1", projectId: "proj-1", sourceLoopId: "loop-p1" });
    const p2 = item({ id: "p2", projectId: "proj-2", sourceLoopId: "loop-p2",
      provenance: { createdAt: T0.toISOString(), dreamRunId: "dr-0", sourceLoops: ["loop-p2"] } });
    const plan = consolidate([p1, p2], opts());
    // Same repo/claim but DIFFERENT projects ⇒ two groups ⇒ no merge, no delete.
    expect(plan.deletes).toHaveLength(0);
    expect(plan.stats.groups).toBe(2);
  });

  it("bounds unioned evidence on a survivor (no unbounded growth)", () => {
    const claim = "On widget, one shared claim.";
    const dupes = Array.from({ length: 40 }, (_, i) =>
      item({ id: `d${i}`, claim, evidence: [ev(`loop-${i}`, i)], sourceLoopId: `loop-${i}`,
        provenance: { createdAt: T0.toISOString(), dreamRunId: "dr-0", sourceLoops: [`loop-${i}`] } }),
    );
    const plan = consolidate(dupes, opts());
    expect(plan.updates).toHaveLength(1);
    expect(plan.deletes).toHaveLength(39);
    expect(plan.updates[0].patch.evidence!.length).toBeLessThanOrEqual(16);
  });
});
