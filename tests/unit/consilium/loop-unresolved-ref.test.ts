/**
 * loop-unresolved-ref.test.ts — BUG 2 fail-closed for an unresolvable diff ref.
 *
 * Live evidence: loop 73fddadc — a github_event trigger fired via polling on an
 * Omniscience PR ran a diff-pr-review; the round errored with
 * `fatal: Needed a single revision` (the PR head/base sha was never fetched into
 * the local checkout) and the loop sat in `state=reviewing, round=0/1` FOREVER.
 *
 * Root cause: `startReviewRound`'s `buildDiffContext` failure returned `{ error }`,
 * which left the loop in `reviewing` with a NULL child ref. `redriveStranded` then
 * re-attempted the SAME missing sha every grace window — a deterministic failure
 * that a retry can never fix, so the round never advanced and `maxRounds` never
 * tripped. Stuck reviewing.
 *
 * Fix: a DETERMINISTIC `unresolved-ref` GitFail is signalled `terminal: true` and
 * the controller drives the loop `reviewing → failed` via the EXISTING
 * `review_failed` edge, recording the operator-readable reason on `loop.error` —
 * NOT stranded. These tests assert the primary entry path (building_context →
 * reviewing → failed) AND the stranded-redrive path both land terminal-with-reason
 * and then no-op (never re-drive), and that a TRANSIENT git failure is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The unresolved-ref reason the resolver produces (see diff-context.ts).
const UNRESOLVED_REASON =
  "diff head 0000000 is not present in the local checkout of omniscience; " +
  "fetch the PR ref or point the review at a local branch";

// Per-test control over what buildDiffContext returns.
const buildDiffContextMock = vi.fn();
vi.mock("../../../server/services/consilium/diff-context.js", () => ({
  buildDiffContext: (...args: unknown[]) => buildDiffContextMock(...args),
}));

import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";

const MIN = 60_000;

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop-73fddadc",
    projectId: "proj1",
    groupId: "grp1",
    state: "building_context",
    round: 0,
    maxRounds: 1,
    repoPath: process.cwd(),
    // A diff-pr-review: base sha (baseline) + PR head sha (reviewRef), both absent
    // from the local checkout in the live case.
    lastReviewedCommit: "b".repeat(40),
    reviewRef: "0".repeat(40),
    currentIterationNumber: null,
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

const makeConfig = () => () =>
  ({
    pipeline: {
      consiliumLoop: {
        enabled: true,
        maxRounds: 1,
        pollIntervalMs: 5000,
        maxDiffBytes: 200_000,
        allowedRepoPaths: [process.cwd()],
        reviewStallTimeoutMs: 900_000,
        reviewMaxRedrives: 3,
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

function fakeStorage(loop: ConsiliumLoopRow) {
  let current = loop;
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
  const startGroupAsync = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
  const storage = {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => []),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, input: "objective", projectId: current.projectId })),
    updateTaskGroup: vi.fn(async () => ({})),
    getIteration: vi.fn(async () => undefined),
    updateIteration: vi.fn(async () => ({})),
    getExecutionsByIteration: vi.fn(async () => []),
    getLlmRequests: vi.fn(async () => ({ rows: [], total: 0 })),
    claimReviewRedrive: vi.fn(async () => undefined),
    // Faithful redrive claim: null child ref in `reviewing`, past grace → winner.
    claimRedrive: vi.fn(async (id: string, expected: ConsiliumLoopState) => {
      if (id !== current.id || current.state !== expected) return undefined;
      current = { ...current, updatedAt: new Date() };
      return current;
    }),
    casLoopState,
    updateLoop,
    appendLoopRound: vi.fn(async () => ({})),
  };
  return { storage, casLoopState, updateLoop, startGroupAsync, get: () => current };
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

const unresolvedFail = () => ({ ok: false, errorKind: "unresolved-ref", message: UNRESOLVED_REASON });

describe("BUG 2 — unresolvable diff ref fails CLOSED (loop-73fddadc class)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildDiffContextMock.mockReset();
  });

  it("primary path: building_context → reviewing → FAILED with the operator reason (not stuck)", async () => {
    buildDiffContextMock.mockResolvedValue(unresolvedFail());
    const loop = makeLoop({ state: "building_context" });
    const { storage, casLoopState, startGroupAsync, get } = fakeStorage(loop);
    const controller = makeController(storage, startGroupAsync, makeConfig());

    await controller.tick(loop.id);

    // The review was never dispatched (the ref could not be resolved)…
    expect(startGroupAsync).not.toHaveBeenCalled();
    // …and the loop was driven to a TERMINAL state, carrying the reason.
    expect(casLoopState).toHaveBeenCalledWith("loop-73fddadc", "reviewing", "failed", expect.any(Object));
    const final = get();
    expect(final.state).toBe("failed");
    expect(final.error).toBe(UNRESOLVED_REASON);
    expect(final.error).not.toContain("Needed a single revision");
    expect(final.completedAt).toBeInstanceOf(Date);
  });

  it("a FAILED loop is terminal: the next tick is a no-op (never re-drives the missing sha)", async () => {
    buildDiffContextMock.mockResolvedValue(unresolvedFail());
    const loop = makeLoop({ state: "building_context" });
    const { storage, startGroupAsync, get } = fakeStorage(loop);
    const controller = makeController(storage, startGroupAsync, makeConfig());

    await controller.tick(loop.id); // → failed
    buildDiffContextMock.mockClear();
    const res = await controller.tick(loop.id); // terminal → no-op

    expect(res).toBeNull();
    expect(buildDiffContextMock).not.toHaveBeenCalled(); // no re-attempt of the ref
    expect(get().state).toBe("failed");
  });

  it("stranded-redrive path: a reviewing loop with a null child ref also fails closed", async () => {
    // Simulate a loop already parked in `reviewing` with a null iteration ref, past
    // the grace window — redriveStranded re-runs startReviewRound, which now returns
    // the terminal unresolved-ref and must FAIL the loop instead of re-stranding it.
    buildDiffContextMock.mockResolvedValue(unresolvedFail());
    const loop = makeLoop({
      state: "reviewing",
      round: 0,
      currentIterationNumber: null,
      updatedAt: new Date(Date.now() - 30 * MIN),
    });
    const { storage, casLoopState, get } = fakeStorage(loop);
    const controller = makeController(storage, storage.startGroupAsync ?? vi.fn(), makeConfig());

    await controller.tick(loop.id);

    expect(casLoopState).toHaveBeenCalledWith("loop-73fddadc", "reviewing", "failed", expect.any(Object));
    expect(get().state).toBe("failed");
    expect(get().error).toBe(UNRESOLVED_REASON);
  });

  it("a TRANSIENT git failure is UNCHANGED: stays reviewing (redrive path), not failed", async () => {
    // Only `unresolved-ref` is terminal. A non-deterministic failure keeps the
    // legacy strand-and-redrive behaviour so a transient blip is retried.
    buildDiffContextMock.mockResolvedValue({ ok: false, errorKind: "unknown", message: "transient git blip" });
    const loop = makeLoop({ state: "building_context" });
    const { storage, casLoopState, startGroupAsync, get } = fakeStorage(loop);
    const controller = makeController(storage, startGroupAsync, makeConfig());

    await controller.tick(loop.id);

    // NOT driven terminal — no reviewing→failed CAS.
    expect(casLoopState).not.toHaveBeenCalledWith(
      "loop-73fddadc",
      "reviewing",
      "failed",
      expect.any(Object),
    );
    expect(get().state).toBe("reviewing");
    expect(get().error).toBe("transient git blip");
  });
});
