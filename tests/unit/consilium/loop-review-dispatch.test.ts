/**
 * loop-review-dispatch.test.ts — B4 (Phase 2) coverage for the runner-mode DISPATCH
 * side of the reviewing transition, driven end-to-end through `controller.tick()`.
 *
 * With `pipeline.consiliumLoop.directReview.enabled = true`, entering `reviewing`
 * must dispatch a BACKGROUND direct review (a `reviewRuns` entry keyed off the round
 * the review is FOR) and mint ZERO task_group iterations — currentIterationNumber
 * stays NULL (the marker). The flag-OFF parity is proven by the entire existing
 * consilium/loop-fsm suite passing UNMODIFIED, so this file only pins the flag-ON
 * dispatch contract + the kill-switch parity at the single-transition level.
 *
 * Round-2 note: the settle→advance (deriveReviewEvent reads the settled reviewRuns
 * result) is B5; this file asserts the dispatch happened, not the consume.
 */
import { describe, it, expect, vi } from "vitest";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop1",
    groupId: "grp1",
    state: "building_context",
    round: 0,
    maxRounds: 6,
    repoPath: process.cwd(),
    lastReviewedCommit: null,
    currentIterationNumber: null,
    devGroupId: null,
    prRef: null,
    headCommitAtReview: null,
    openP0: null,
    error: null,
    createdBy: "user1",
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...over,
  } as ConsiliumLoopRow;
}

/** Minimal fake storage honouring the CAS (mirrors loop-fsm.test.ts's harness). */
function makeFakeStorage(loop: ConsiliumLoopRow) {
  let current = loop;
  const cas = vi.fn(
    async (id: string, expected: ConsiliumLoopState, next: ConsiliumLoopState, extra?: Record<string, unknown>) => {
      if (id !== current.id || current.state !== expected) return undefined;
      current = { ...current, ...(extra ?? {}), state: next };
      return current;
    },
  );
  const storage = {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => []),
    casLoopState: cas,
    claimRedrive: vi.fn(async () => undefined),
    appendLoopRound: vi.fn(async () => ({})),
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, name: "[consilium-review:sdlc-cross-review] x", input: "objective" })),
    updateTaskGroup: vi.fn(async () => ({})),
    createTaskGroup: vi.fn(async () => ({ group: { id: "g" } })),
    getIteration: vi.fn(async () => undefined),
    getExecutionsByIteration: vi.fn(async () => []),
  };
  return { storage, get: () => current };
}

const configWith = (directReviewEnabled: boolean) =>
  (() => ({
    pipeline: {
      taskGroups: { taskTimeoutMs: 300000, defaultModel: "claude-opus" },
      consiliumLoop: {
        enabled: true,
        maxRounds: 6,
        pollIntervalMs: 5000,
        maxDiffBytes: 200000,
        allowedRepoPaths: [process.cwd()],
        directReview: { enabled: directReviewEnabled },
        implement: { enabled: false, verification: { enabled: false }, research: { enabled: false } },
      },
    },
  })) as never;

describe("B4 — reviewing dispatch keys off the live directReview flag", () => {
  it("flag ON: entering reviewing dispatches the runner, mints ZERO iterations, marker stays NULL", async () => {
    const loop = makeLoop({ state: "building_context", round: 0 });
    const { storage } = makeFakeStorage(loop);
    const startGroupAsync = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    let release: (r: unknown) => void = () => {};
    const runReview = vi.fn(() => new Promise((res) => { release = res; })); // stays in-flight
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: startGroupAsync, startGroupAsync, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: configWith(true),
      runReview: runReview as never,
    });

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("reviewing");
    expect(res?.round).toBe(1); // nextRound
    expect(res?.currentIterationNumber ?? null).toBeNull(); // marker NULL — no iteration
    expect(startGroupAsync).not.toHaveBeenCalled(); // ZERO task_group iterations minted
    expect(runReview).toHaveBeenCalledTimes(1); // the direct runner was dispatched
    // reviewRuns entry keyed off the round the review is FOR (nextRound).
    const c = controller as unknown as { reviewRuns: Map<string, { round: number; done: boolean }> };
    expect(c.reviewRuns.get(loop.id)).toMatchObject({ round: 1, done: false });
    release({ converged: false, openP0: 1, openActionPoints: [], verdict: null, participants: null });
  });

  it("flag ON: a STALE currentIterationNumber (from a prior OLD-path round) is CLEARED to explicit null", async () => {
    // A round ran earlier on the legacy path (currentIterationNumber persisted), then the
    // flag flips ON. The runner extra MUST set currentIterationNumber: null explicitly —
    // otherwise the stale non-null value survives and, on a crash, redriveStranded's
    // null-ref check reads false (round stuck) + the straddle misreads it as old-path.
    const loop = makeLoop({ state: "building_context", round: 1, currentIterationNumber: 5 });
    const { storage, get } = makeFakeStorage(loop);
    const startGroupAsync = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 9 } }));
    let release: (r: unknown) => void = () => {};
    const runReview = vi.fn(() => new Promise((res) => { release = res; }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: startGroupAsync, startGroupAsync, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: configWith(true),
      runReview: runReview as never,
    });

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("reviewing");
    expect(res?.round).toBe(2); // nextRound
    // toBeNull fails on undefined — so an OMITTED field (stale 5 surviving) is caught.
    expect(res?.currentIterationNumber).toBeNull(); // stale 5 EXPLICITLY cleared
    expect(get().currentIterationNumber).toBeNull(); // persisted null
    expect(startGroupAsync).not.toHaveBeenCalled();
    release({ converged: true, openP0: 0, openActionPoints: [], verdict: null, participants: null });
  });

  it("flag OFF: entering reviewing runs the legacy startGroupAsync path (byte-identical), NO reviewRuns entry", async () => {
    const loop = makeLoop({ state: "building_context", round: 0, lastReviewedCommit: null });
    const { storage } = makeFakeStorage(loop);
    const startGroupAsync = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const runReview = vi.fn();
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: startGroupAsync, startGroupAsync, createTaskGroup: storage.createTaskGroup, cancelGroup: vi.fn() } as never,
      config: configWith(false),
      runReview: runReview as never,
    });

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("reviewing");
    expect(res?.currentIterationNumber).toBe(1); // legacy: a real iteration
    expect(startGroupAsync).toHaveBeenCalledTimes(1); // legacy dispatch
    expect(runReview).not.toHaveBeenCalled(); // runner never touched
    const c = controller as unknown as { reviewRuns: Map<string, unknown> };
    expect(c.reviewRuns.get(loop.id)).toBeUndefined(); // no runner-mode entry
  });
});
