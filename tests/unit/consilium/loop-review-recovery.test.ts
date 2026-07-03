/**
 * loop-review-recovery.test.ts — Bug #7: recover a STRANDED `reviewing` loop.
 *
 * A review round runs in the IN-PROCESS consilium workers. If they die (a crash or,
 * most commonly, a server restart) the round's task_executions stay `running`
 * forever, `deriveReviewEvent` never settles, and the loop sits in `reviewing` with
 * ZERO LLM activity — with no recovery (unlike develop's `redriveStranded`). Live
 * evidence: loop 76ce2ecd sat reviewing 45+ min with 2 executions "running" and 0
 * LLM requests after a restart.
 *
 * The controller now, on a NO-PROGRESS stall past `reviewStallTimeoutMs`:
 *   1. RE-LAUNCHES the SAME round (supersede the orphan iteration → fresh run),
 *      bounded by `reviewMaxRedrives`, recording `reviewRedrive = { round, count }`;
 *   2. only once the budget is exhausted, FAILS via the existing `review_failed`
 *      event (NO new FSM state);
 *   3. runs on every tick AND on the poller's startup sweep (the restart case).
 *
 * These tests assert: redrive-then-eventually-fail, a fresh-active review is
 * untouched, the startup sweep recovers a pre-restart orphan, the CAS/TOCTOU guard
 * never fails a just-finished review, and a very-high timeout == today's behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Deterministic review-input build: decouple `startReviewRound` from real git so a
// re-launch reliably reaches `startGroupAsync` regardless of the worktree's state.
vi.mock("../../../server/services/consilium/diff-context.js", () => ({
  buildDiffContext: vi.fn(async () => ({ ok: true, input: "REVIEW INPUT" })),
}));

import {
  ConsiliumLoopController,
  ConsiliumLoopPoller,
} from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";

const flush = () => new Promise((r) => setTimeout(r, 0));
const MIN = 60_000;

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop-1",
    projectId: "proj1",
    groupId: "grp1",
    state: "reviewing",
    round: 1,
    maxRounds: 6,
    repoPath: process.cwd(),
    lastReviewedCommit: null,
    reviewRef: null,
    currentIterationNumber: 2,
    reviewRedrive: null,
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

interface Cfg {
  reviewStallTimeoutMs?: number;
  reviewMaxRedrives?: number;
}
const makeConfig =
  (over: Cfg = {}) =>
  () =>
    ({
      pipeline: {
        consiliumLoop: {
          enabled: true,
          maxRounds: 6,
          pollIntervalMs: 5000,
          maxDiffBytes: 200_000,
          allowedRepoPaths: [process.cwd()],
          reviewStallTimeoutMs: over.reviewStallTimeoutMs ?? 900_000, // 15m
          reviewMaxRedrives: over.reviewMaxRedrives ?? 3,
          implement: {
            enabled: false,
            verification: { enabled: false },
            maxFixIterations: 3,
            testCommand: null,
            testRunTimeoutMs: 300_000,
            research: { enabled: false, maxResearchIterations: 3, model: "claude-sonnet" },
          },
        },
      },
    }) as never;

interface StoreOpts {
  /** Timestamps that make the review look alive; omit ⇒ nothing recent. */
  iterationStartedAt?: Date | null;
  llmLastAt?: Date | null;
  execs?: { startedAt?: Date | null; completedAt?: Date | null; createdAt?: Date | null }[];
  /** Iteration status returned per getIteration call (queue); falls back to `iterStatus`. */
  iterStatusSeq?: string[];
  iterStatus?: string;
}

function fakeStorage(loop: ConsiliumLoopRow, opts: StoreOpts = {}) {
  let current = loop;
  const statusSeq = [...(opts.iterStatusSeq ?? [])];
  // Real storage assigns iterationNumber from getLatestIteration, independent of
  // the loop's currentIterationNumber pointer (which the re-launch NULLs mid-flight).
  let latestIter = loop.currentIterationNumber ?? 0;

  const startGroupAsync = vi.fn(async () => {
    latestIter += 1;
    return { group: {}, iteration: { iterationNumber: latestIter } };
  });

  const getIteration = vi.fn(async (_g: string, n: number) => {
    if (n !== current.currentIterationNumber) return undefined;
    const status = statusSeq.length ? statusSeq.shift()! : (opts.iterStatus ?? "running");
    return {
      id: `it${n}`,
      iterationNumber: n,
      status,
      startedAt: opts.iterationStartedAt ?? null,
      completedAt: null,
      createdAt: opts.iterationStartedAt ?? null,
    };
  });

  const updateIteration = vi.fn(async () => ({}));

  // Faithful atomic claim (mirrors Pg/Mem): reviewing + SAME stale iteration +
  // updatedAt < threshold, then bump updatedAt so a concurrent claim loses.
  const claimReviewRedrive = vi.fn(async (id: string, expIter: number, staleThreshold: Date) => {
    if (id !== current.id || current.state !== "reviewing") return undefined;
    if (current.currentIterationNumber !== expIter) return undefined;
    if (new Date(current.updatedAt).getTime() >= staleThreshold.getTime()) return undefined;
    current = { ...current, updatedAt: new Date() };
    return current;
  });

  const casLoopState = vi.fn(
    async (id: string, expected: ConsiliumLoopState, next: ConsiliumLoopState, extra?: Record<string, unknown>) => {
      if (id !== current.id || current.state !== expected) return undefined;
      current = { ...current, ...(extra ?? {}), state: next };
      return current;
    },
  );

  const updateLoop = vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
    current = { ...current, ...(extra ?? {}) };
    return current;
  });

  const storage = {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => []),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, input: "objective", projectId: current.projectId })),
    updateTaskGroup: vi.fn(async () => ({})),
    getIteration,
    updateIteration,
    getExecutionsByIteration: vi.fn(async () => opts.execs ?? []),
    getLlmRequests: vi.fn(async () => ({
      rows: opts.llmLastAt ? [{ createdAt: opts.llmLastAt }] : [],
      total: opts.llmLastAt ? 1 : 0,
    })),
    claimReviewRedrive,
    claimRedrive: vi.fn(async () => undefined),
    casLoopState,
    updateLoop,
    appendLoopRound: vi.fn(async () => ({})),
  };

  return { storage, startGroupAsync, claimReviewRedrive, casLoopState, updateIteration, get: () => current };
}

function makeController(storage: unknown, startGroupAsync: unknown, config: () => unknown) {
  return new ConsiliumLoopController({
    storage: storage as never,
    taskOrchestrator: {
      startGroup: startGroupAsync,
      startGroupAsync,
      createTaskGroup: vi.fn(),
      cancelGroup: vi.fn(),
    } as never,
    config: config as never,
    readRepoHead: async () => "abc1234",
  });
}

/** A review with no activity for `min` minutes (updatedAt + iteration start both old). */
function strandedLoop(min = 30, over: Partial<ConsiliumLoopRow> = {}) {
  const at = new Date(Date.now() - min * MIN);
  return makeLoop({ state: "reviewing", round: 1, currentIterationNumber: 2, updatedAt: at, ...over });
}

describe("Bug #7 — stranded review is RE-LAUNCHED (redrive-first, bounded)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a review idle past the stall window is re-launched for the SAME round (attempt 1/K)", async () => {
    const loop = strandedLoop(30);
    const { storage, startGroupAsync, updateIteration, claimReviewRedrive } = fakeStorage(loop, {
      iterationStartedAt: new Date(Date.now() - 30 * MIN),
      llmLastAt: null,
    });
    const controller = makeController(storage, startGroupAsync, makeConfig());

    const res = await controller.tick(loop.id);

    expect(claimReviewRedrive).toHaveBeenCalledTimes(1);
    // Race fix: child ref is NULLed before the orphan is cancelled (a concurrent
    // tick sees null → never derives review_failed on the superseded iteration).
    expect(storage.updateLoop).toHaveBeenCalledWith("loop-1", { currentIterationNumber: null });
    expect(updateIteration).toHaveBeenCalledWith("it2", expect.objectContaining({ status: "cancelled" }));
    expect(startGroupAsync).toHaveBeenCalledTimes(1); // fresh review round dispatched
    expect(res?.state).toBe("reviewing"); // stays reviewing — autonomy, not failure
    expect(res?.round).toBe(1); // SAME round (not incremented)
    expect(res?.currentIterationNumber).toBe(3); // superseding iteration
    expect(res?.reviewRedrive).toEqual({ round: 1, count: 1 });
  });

  it("re-launches up to K, then FAILS via review_failed with a clear reason (last resort)", async () => {
    // Budget already spent (count === max) ⇒ the next detected stall fails.
    const loop = strandedLoop(30, { reviewRedrive: { round: 1, count: 3 } });
    const { storage, startGroupAsync, casLoopState } = fakeStorage(loop, {
      iterationStartedAt: new Date(Date.now() - 30 * MIN),
    });
    const controller = makeController(storage, startGroupAsync, makeConfig({ reviewMaxRedrives: 3 }));

    const res = await controller.tick(loop.id);

    expect(startGroupAsync).not.toHaveBeenCalled(); // no more re-launches
    expect(casLoopState).toHaveBeenCalledWith("loop-1", "reviewing", "failed", expect.any(Object));
    expect(res?.state).toBe("failed");
    expect(res?.error).toContain("Review stalled");
    expect(res?.error).toContain("marked failed for re-run");
  });

  it("reviewMaxRedrives = 0 ⇒ fail on the FIRST detected stall (redrive disabled)", async () => {
    const loop = strandedLoop(30);
    const { storage, startGroupAsync } = fakeStorage(loop, {
      iterationStartedAt: new Date(Date.now() - 30 * MIN),
    });
    const controller = makeController(storage, startGroupAsync, makeConfig({ reviewMaxRedrives: 0 }));

    const res = await controller.tick(loop.id);

    expect(startGroupAsync).not.toHaveBeenCalled();
    expect(res?.state).toBe("failed");
  });
});

describe("Bug #7 — a live / fresh review is NEVER touched (no false positives)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recent LLM activity (heartbeat) ⇒ not stalled, untouched", async () => {
    // Loop row itself is old, but an LLM request landed seconds ago ⇒ alive.
    const loop = strandedLoop(30);
    const { storage, startGroupAsync, claimReviewRedrive, casLoopState } = fakeStorage(loop, {
      iterationStartedAt: new Date(Date.now() - 30 * MIN),
      llmLastAt: new Date(), // heartbeat NOW
    });
    const controller = makeController(storage, startGroupAsync, makeConfig());

    const res = await controller.tick(loop.id);

    expect(claimReviewRedrive).not.toHaveBeenCalled();
    expect(startGroupAsync).not.toHaveBeenCalled();
    expect(casLoopState).not.toHaveBeenCalled();
    expect(res).toBeNull(); // no-op; still reviewing, waiting on the live round
  });

  it("a recent task-execution status change ⇒ not stalled, untouched", async () => {
    const loop = strandedLoop(30);
    const { storage, startGroupAsync, claimReviewRedrive } = fakeStorage(loop, {
      iterationStartedAt: new Date(Date.now() - 30 * MIN),
      execs: [{ completedAt: new Date() }], // a debater just finished
    });
    const controller = makeController(storage, startGroupAsync, makeConfig());

    await controller.tick(loop.id);

    expect(claimReviewRedrive).not.toHaveBeenCalled();
    expect(startGroupAsync).not.toHaveBeenCalled();
  });

  it("very HIGH reviewStallTimeoutMs ⇒ recovery effectively OFF (today's wait-forever)", async () => {
    const loop = strandedLoop(30);
    const { storage, startGroupAsync, claimReviewRedrive } = fakeStorage(loop, {
      iterationStartedAt: new Date(Date.now() - 30 * MIN),
    });
    // 24h timeout: a 30-min-idle review is nowhere near the window.
    const controller = makeController(storage, startGroupAsync, makeConfig({ reviewStallTimeoutMs: 86_400_000 }));

    const res = await controller.tick(loop.id);

    expect(claimReviewRedrive).not.toHaveBeenCalled();
    expect(startGroupAsync).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });
});

describe("Bug #7 — CAS / TOCTOU: never fail or re-run a just-finished review", () => {
  beforeEach(() => vi.clearAllMocks());

  it("iteration settles between the idle read and the claim ⇒ abort recovery", async () => {
    // getIteration calls: deriveReviewEvent(running) → idle-check(running) → post-claim(completed).
    const loop = strandedLoop(30);
    const { storage, startGroupAsync, updateIteration, casLoopState } = fakeStorage(loop, {
      iterationStartedAt: new Date(Date.now() - 30 * MIN),
      iterStatusSeq: ["running", "running", "completed"],
    });
    const controller = makeController(storage, startGroupAsync, makeConfig());

    await controller.tick(loop.id);

    expect(startGroupAsync).not.toHaveBeenCalled(); // no re-launch
    expect(updateIteration).not.toHaveBeenCalled(); // orphan NOT cancelled
    expect(casLoopState).not.toHaveBeenCalledWith("loop-1", "reviewing", "failed", expect.any(Object));
  });

  it("claim lost to a concurrent instance ⇒ no-op (no double re-launch)", async () => {
    const loop = strandedLoop(30);
    const { storage, startGroupAsync, updateIteration } = fakeStorage(loop, {
      iterationStartedAt: new Date(Date.now() - 30 * MIN),
    });
    // Simulate the loser: claim returns undefined.
    storage.claimReviewRedrive = vi.fn(async () => undefined);
    const controller = makeController(storage, startGroupAsync, makeConfig());

    const res = await controller.tick(loop.id);

    expect(startGroupAsync).not.toHaveBeenCalled();
    expect(updateIteration).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });
});

describe("Bug #7 — startup sweep recovers a pre-restart orphan", () => {
  beforeEach(() => vi.clearAllMocks());

  it("poller.sweep() re-launches a loop left `reviewing` by a prior process", async () => {
    const loop = strandedLoop(30);
    const { storage, startGroupAsync } = fakeStorage(loop, {
      iterationStartedAt: new Date(Date.now() - 30 * MIN),
    });
    const controller = makeController(storage, startGroupAsync, makeConfig());
    const poller = new ConsiliumLoopPoller(controller, storage as never, 5000);

    await poller.sweep();

    expect(startGroupAsync).toHaveBeenCalledTimes(1); // orphan re-launched on boot
    expect(storage.getLoops).toHaveBeenCalled();
  });

  it("poller.start() kicks an immediate sweep (no waiting a full interval)", async () => {
    const loop = strandedLoop(30);
    const { storage, startGroupAsync } = fakeStorage(loop, {
      iterationStartedAt: new Date(Date.now() - 30 * MIN),
    });
    const controller = makeController(storage, startGroupAsync, makeConfig());
    const poller = new ConsiliumLoopPoller(controller, storage as never, 5000);

    poller.start();
    await flush();
    await flush();
    poller.stop();

    expect(storage.getLoops).toHaveBeenCalled(); // swept at boot, not after 5s
  });
});
