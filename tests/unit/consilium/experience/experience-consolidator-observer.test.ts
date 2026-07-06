/**
 * experience-consolidator-observer.test.ts — DREAM-3: the background, SCHEDULED
 * consolidator observer. FAKE storage (stateful, so a re-run "sees" the applied result)
 * exercises the read → pure-consolidate → apply(updates + deletes) loop. Covers:
 *   - kill-switch OFF ⇒ start() does not start AND a manual pass writes nothing;
 *   - kill-switch ON ⇒ a duplicate pair is MERGED (one update, one delete);
 *   - a re-run is IDEMPOTENT (no further writes — the store has converged);
 *   - a write that throws is CAUGHT (the pass never crashes the interval);
 *   - it touches ONLY the experience_items seams (list/update/delete) — never a loop.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ExperienceConsolidatorObserver,
  type ExperienceConsolidatorObserverDeps,
} from "../../../../server/services/consilium/experience/experience-consolidator-observer.js";
import type { ExperienceItemRow } from "@shared/schema";
import type { ExperienceConfidence, ExperienceEvidence } from "@shared/types";
import type { AppConfig } from "../../../../server/config/schema.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

function cfg(consolidateEnabled: boolean): AppConfig {
  return {
    pipeline: {
      consiliumLoop: {
        experiencePlane: {
          enabled: true,
          read: { staleVerifiedDays: 60 },
          consolidate: { enabled: consolidateEnabled, intervalSec: 3_600 },
        },
      },
    },
  } as unknown as AppConfig;
}

const T0 = "2026-07-06T00:00:00.000Z";

function ev(loopId: string, round: number): ExperienceEvidence {
  return { loopId, round, apTitle: `AP ${loopId}`, diffRef: "sha" };
}

function item(p: Partial<ExperienceItemRow> & { id: string }): ExperienceItemRow {
  const confidence: ExperienceConfidence = p.confidence ?? "verified";
  const base: ExperienceItemRow = {
    id: p.id,
    projectId: "proj-1",
    scope: { repo: "widget", archetype: "repo-assessment", criterionClass: "test-run" },
    claim: "On widget, the coverage gate was VERIFIED (test-run).",
    evidence: [ev(`loop-${p.id}`, 1)],
    verification: { method: "test-run", outcome: "independent-pass", groundingRatioAtTime: 1 },
    confidence,
    successDelta: null,
    provenance: { createdAt: T0, dreamRunId: "dr-0", sourceLoops: [`loop-${p.id}`] },
    freshness: { lastConfirmedAt: T0, decayPolicy: "reuse:5" },
    consolidation: null,
    relatedComponents: [],
    sourceLoopId: `loop-${p.id}`,
    createdAt: new Date(T0),
  } as ExperienceItemRow;
  return { ...base, ...p } as ExperienceItemRow;
}

/** A stateful fake store — updates/deletes persist so idempotency is exercised. */
function fakeStore(seed: ExperienceItemRow[]) {
  const map = new Map(seed.map((i) => [i.id, { ...i }]));
  const updateSpy = vi.fn(async (id: string, patch: Partial<ExperienceItemRow>) => {
    const cur = map.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch } as ExperienceItemRow;
    map.set(id, next);
    return next;
  });
  const deleteSpy = vi.fn(async (ids: string[]) => {
    for (const id of ids) map.delete(id);
  });
  const listSpy = vi.fn(async (_limit: number) => Array.from(map.values()));
  return { map, updateSpy, deleteSpy, listSpy };
}

function makeObserver(store: ReturnType<typeof fakeStore>, config: AppConfig): ExperienceConsolidatorObserver {
  const deps: ExperienceConsolidatorObserverDeps = {
    runInSystem: (fn) => fn(),
    listExperienceItems: store.listSpy,
    updateExperienceItem: store.updateSpy,
    deleteExperienceItems: store.deleteSpy,
    config: () => config,
    log: () => {},
    now: () => new Date("2026-07-06T00:00:00.000Z"),
  };
  return new ExperienceConsolidatorObserver(deps);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ExperienceConsolidatorObserver", () => {
  it("kill-switch OFF ⇒ start() does not start and a pass writes nothing", () => {
    const store = fakeStore([item({ id: "a", confidence: "observed" }), item({ id: "b" })]);
    const obs = makeObserver(store, cfg(false));
    obs.start();
    expect(store.listSpy).not.toHaveBeenCalled();
  });

  it("kill-switch OFF ⇒ runPass no-ops (never reads or writes)", async () => {
    const store = fakeStore([item({ id: "a" })]);
    const obs = makeObserver(store, cfg(false));
    await obs.runPass();
    expect(store.listSpy).not.toHaveBeenCalled();
    expect(store.updateSpy).not.toHaveBeenCalled();
    expect(store.deleteSpy).not.toHaveBeenCalled();
  });

  it("kill-switch ON ⇒ merges a duplicate pair (one update, one delete)", async () => {
    const a = item({ id: "a", confidence: "observed", evidence: [ev("loop-a", 1)] });
    const b = item({ id: "b", confidence: "verified", evidence: [ev("loop-b", 2)] });
    const store = fakeStore([a, b]);
    const obs = makeObserver(store, cfg(true));

    await obs.runPass();

    expect(store.updateSpy).toHaveBeenCalledTimes(1);
    expect(store.deleteSpy).toHaveBeenCalledTimes(1);
    // The store now holds exactly one survivor, verified, with unioned evidence.
    expect(store.map.size).toBe(1);
    const survivor = Array.from(store.map.values())[0];
    expect(survivor.confidence).toBe("verified");
    expect(survivor.evidence.map((e) => e.loopId).sort()).toEqual(["loop-a", "loop-b"]);
  });

  it("is idempotent: a second pass writes nothing more", async () => {
    const a = item({ id: "a", confidence: "observed", evidence: [ev("loop-a", 1)] });
    const b = item({ id: "b", confidence: "verified", evidence: [ev("loop-b", 2)] });
    const store = fakeStore([a, b]);
    const obs = makeObserver(store, cfg(true));

    await obs.runPass();
    store.updateSpy.mockClear();
    store.deleteSpy.mockClear();

    await obs.runPass();
    expect(store.updateSpy).not.toHaveBeenCalled();
    expect(store.deleteSpy).not.toHaveBeenCalled();
  });

  it("a throwing update is caught — the pass never rejects", async () => {
    const a = item({ id: "a", confidence: "observed", evidence: [ev("loop-a", 1)] });
    const b = item({ id: "b", confidence: "verified", evidence: [ev("loop-b", 2)] });
    const store = fakeStore([a, b]);
    store.updateSpy.mockRejectedValueOnce(new Error("db down"));
    const obs = makeObserver(store, cfg(true));

    // consolidateSafe swallows; runPass surfaces the update error only via the guarded loop
    // (it does not throw — a bad write must never kill the interval).
    await expect(obs.runPass()).resolves.toBeUndefined();
  });

  it("empty store ⇒ no writes", async () => {
    const store = fakeStore([]);
    const obs = makeObserver(store, cfg(true));
    await obs.runPass();
    expect(store.updateSpy).not.toHaveBeenCalled();
    expect(store.deleteSpy).not.toHaveBeenCalled();
  });
});
