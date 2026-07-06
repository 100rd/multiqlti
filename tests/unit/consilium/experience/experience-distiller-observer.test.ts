/**
 * experience-distiller-observer.test.ts — DREAM-1: the background, READ-ONLY observer.
 * FAKE storage (stateful, so a re-observe "sees" what the first pass wrote) + a FAKE
 * loop/round source. Covers:
 *   - kill-switch OFF ⇒ start() does not start and observeAll writes nothing;
 *   - a terminal loop is distilled ONCE ⇒ exactly one createExperienceItems call;
 *   - a re-observe of a distilled loop writes NO duplicate (idempotent via source-loop probe);
 *   - a RUNNING (non-terminal) loop is NEVER distilled;
 *   - the grounding ratio is computed and threaded onto the written item;
 *   - the observer touches ONLY read seams (getLoops/getLoopRounds) + the items writer —
 *     never a loop-controller mutation (there is no controller dep to call).
 */
import { describe, it, expect, vi } from "vitest";
import {
  ExperienceDistillerObserver,
  type ExperienceDistillerObserverDeps,
  type DistillerRound,
} from "../../../../server/services/consilium/experience/experience-distiller-observer.js";
import type { ConsiliumLoopRow, InsertExperienceItem, ExperienceItemRow } from "@shared/schema";
import type { ExecutionTrace, ExecutionCriterion } from "@shared/types";
import type { AppConfig } from "../../../../server/config/schema.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

function cfg(enabled: boolean): AppConfig {
  return {
    pipeline: { consiliumLoop: { experiencePlane: { enabled, intervalMs: 60_000 } } },
  } as unknown as AppConfig;
}

function makeLoop(p: Partial<ConsiliumLoopRow> & { id: string }): ConsiliumLoopRow {
  const base = {
    projectId: "proj-1",
    groupId: "grp-1",
    state: "converged",
    round: 1,
    maxRounds: 6,
    repoPath: "/repos/widget",
    prRef: "acme/widget#7",
    archetype: "repo-assessment",
    archetypeSource: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T01:00:00.000Z"),
    completedAt: null,
  };
  return { ...base, ...p } as unknown as ConsiliumLoopRow;
}

function crit(p: Partial<ExecutionCriterion>): ExecutionCriterion {
  return { criterion: "When run, Then pass", method: "test-run", ran: true, passed: true, ...p };
}

function traceWith(criteria: ExecutionCriterion[]): ExecutionTrace {
  return {
    schemaVersion: 1,
    archetype: "repo-assessment",
    controller: {
      kind: "sdlc-executor",
      label: "x",
      green: true,
      workers: [{ index: 1, priority: "P0", title: "Add coverage gate", status: "completed", skills: [], criteria }],
    },
  };
}

/** A stateful fake storage — items persist across passes so idempotency is exercised. */
function fakeStorage(rounds: DistillerRound[]) {
  const items: ExperienceItemRow[] = [];
  const createSpy = vi.fn(async (batch: InsertExperienceItem[]) => {
    const written = batch.map((d, i) => ({ ...d, id: `it-${items.length + i}`, createdAt: new Date() })) as unknown as ExperienceItemRow[];
    items.push(...written);
    return written;
  });
  return {
    items,
    createSpy,
    getExperienceItemsBySourceLoop: async (loopId: string) => items.filter((i) => i.sourceLoopId === loopId),
    getLoopRounds: async (_loopId: string) => rounds,
    createExperienceItems: createSpy,
  };
}

function makeObserver(
  loops: ConsiliumLoopRow[],
  store: ReturnType<typeof fakeStorage>,
  config: AppConfig,
): ExperienceDistillerObserver {
  const deps: ExperienceDistillerObserverDeps = {
    runInSystem: (fn) => fn(),
    getLoops: async () => loops,
    getLoopRounds: store.getLoopRounds,
    getExperienceItemsBySourceLoop: store.getExperienceItemsBySourceLoop,
    createExperienceItems: store.createExperienceItems,
    config: () => config,
    log: () => {},
    now: () => new Date("2026-07-01T02:00:00.000Z").getTime(),
  };
  return new ExperienceDistillerObserver(deps);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ExperienceDistillerObserver", () => {
  it("kill-switch OFF ⇒ observeAll writes nothing", async () => {
    const store = fakeStorage([{ round: 1, executionTrace: traceWith([crit({})]), openActionPoints: null, headCommit: "c1", createdAt: new Date() }]);
    const obs = makeObserver([makeLoop({ id: "loop-1" })], store, cfg(false));
    await obs.observeAll();
    expect(store.createSpy).not.toHaveBeenCalled();
    expect(store.items).toHaveLength(0);
  });

  it("kill-switch OFF ⇒ start() does not start the interval", () => {
    const store = fakeStorage([]);
    const obs = makeObserver([], store, cfg(false));
    const spy = vi.spyOn(global, "setInterval");
    obs.start();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("distils a terminal loop ONCE and is idempotent on re-observe (no duplicate)", async () => {
    const store = fakeStorage([
      { round: 1, executionTrace: traceWith([crit({ method: "test-run", ran: true, passed: true })]), openActionPoints: null, headCommit: "c1", createdAt: new Date() },
    ]);
    const obs = makeObserver([makeLoop({ id: "loop-1" })], store, cfg(true));

    await obs.observeAll();
    expect(store.createSpy).toHaveBeenCalledTimes(1);
    expect(store.items).toHaveLength(1);
    expect(store.items[0].confidence).toBe("verified");

    // Second pass — the source-loop probe now returns the written item ⇒ SKIP, no dup.
    await obs.observeAll();
    expect(store.createSpy).toHaveBeenCalledTimes(1);
    expect(store.items).toHaveLength(1);
  });

  it("a RUNNING (non-terminal) loop is NEVER distilled", async () => {
    const store = fakeStorage([
      { round: 1, executionTrace: traceWith([crit({})]), openActionPoints: null, headCommit: "c1", createdAt: new Date() },
    ]);
    const obs = makeObserver([makeLoop({ id: "loop-1", state: "developing" })], store, cfg(true));
    await obs.observeAll();
    expect(store.createSpy).not.toHaveBeenCalled();
    expect(store.items).toHaveLength(0);
  });

  it("computes the grounding ratio and threads it onto the written item", async () => {
    // One test-run (mechanical) criterion ⇒ groundingRatio = 1/1 = 1.
    const store = fakeStorage([
      { round: 1, executionTrace: traceWith([crit({ method: "test-run", ran: true, passed: true })]), openActionPoints: null, headCommit: "c1", createdAt: new Date("2026-07-01T00:30:00.000Z") },
    ]);
    const obs = makeObserver([makeLoop({ id: "loop-1" })], store, cfg(true));
    await obs.observeAll();
    expect(store.items[0].verification.groundingRatioAtTime).toBe(1);
  });

  it("a terminal loop with no gradeable trace writes nothing (and re-checks harmlessly)", async () => {
    const store = fakeStorage([{ round: 1, executionTrace: null, openActionPoints: null, headCommit: null, createdAt: new Date() }]);
    const obs = makeObserver([makeLoop({ id: "loop-1", state: "cancelled" })], store, cfg(true));
    await obs.observeAll();
    expect(store.createSpy).not.toHaveBeenCalled();
    expect(store.items).toHaveLength(0);
  });
});
