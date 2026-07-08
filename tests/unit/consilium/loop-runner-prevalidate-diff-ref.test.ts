/**
 * loop-runner-prevalidate-diff-ref.test.ts — #21 (B4-review follow-up) coverage.
 *
 * In runner-mode (`directReview.enabled`), `startReviewRound` now pre-validates the
 * diff ref BEFORE dispatching the background runner (`dispatchReview`). A
 * DETERMINISTIC `unresolved-ref` `buildDiffContext` failure must fail the loop
 * CLOSED with the curated `failUnresolvedReview` terminal reason — the SAME
 * operator-readable explanation the legacy (task-group) path has surfaced since
 * loop-unresolved-ref.test.ts (BUG 2) — instead of ever reaching the runner, whose
 * own `buildDiffContext` call (inside `runReviewFromLoop`) would otherwise settle it
 * as a generic scrubbed `{error}` via `review_failed`.
 *
 * Any OTHER (non-"unresolved-ref") `buildDiffContext` failure is a genuinely
 * transient condition — it must NOT be treated as terminal here; the runner is
 * still dispatched and keeps the existing generic degraded-result path.
 *
 * The legacy (directReview OFF) path is untouched by this change — pinned here
 * against the SAME mock to prove it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const UNRESOLVED_REASON =
  "diff head 0000000 not present in local checkout omniscience; fetch PR ref or point review to a local branch";

const buildDiffContextMock = vi.fn();
vi.mock("../../../server/services/consilium/diff-context.js", () => ({
  buildDiffContext: (...args: unknown[]) => buildDiffContextMock(...args),
}));

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
    reviewRef: null,
    reviewMode: null,
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

const unresolvedFail = () => ({
  ok: false,
  errorKind: "unresolved-ref",
  message: UNRESOLVED_REASON,
});

const transientFail = () => ({
  ok: false,
  errorKind: "unknown",
  message: "transient git failure (flaky fetch)",
});

describe("#21 — runner-mode pre-validates the diff ref before dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildDiffContextMock.mockReset();
  });

  it("unresolvable ref: fails CLOSED with the curated terminal reason, runner NEVER dispatched", async () => {
    buildDiffContextMock.mockResolvedValue(unresolvedFail());
    const loop = makeLoop({ state: "building_context", round: 0 });
    const { storage, get } = makeFakeStorage(loop);
    const runReview = vi.fn();
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: configWith(true),
      runReview: runReview as never,
    });

    // The building_context -> reviewing CAS wins first (runSideEffect then runs
    // the terminal fail-closed AS A FOLLOW-UP commit), so — mirroring
    // loop-unresolved-ref.test.ts — assert the FINAL persisted row, not tick()'s
    // return value (which reflects the intermediate `reviewing` CAS winner).
    await controller.tick(loop.id);

    // The runner was NEVER dispatched — the ref could not be resolved.
    expect(runReview).not.toHaveBeenCalled();
    // The loop was driven straight to the terminal `failed` state, carrying the
    // SAME curated reason the legacy path's `failUnresolvedReview` uses (not the
    // runner's generic scrubbed error).
    const final = get();
    expect(final.state).toBe("failed");
    expect(final.error).toBe(UNRESOLVED_REASON);
    expect(final.completedAt).toBeInstanceOf(Date);
    const c = controller as unknown as { reviewRuns: Map<string, unknown> };
    expect(c.reviewRuns.get(loop.id)).toBeUndefined(); // no runner-mode entry registered
  });

  it("transient buildDiffContext failure: NOT terminal — runner still dispatched, generic path unchanged", async () => {
    buildDiffContextMock.mockResolvedValue(transientFail());
    const loop = makeLoop({ state: "building_context", round: 0 });
    const { storage } = makeFakeStorage(loop);
    let release: (r: unknown) => void = () => {};
    const runReview = vi.fn(() => new Promise((res) => { release = res; }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: configWith(true),
      runReview: runReview as never,
    });

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("reviewing"); // NOT failed — dispatch proceeded
    expect(runReview).toHaveBeenCalledTimes(1); // the runner WAS dispatched
    const c = controller as unknown as { reviewRuns: Map<string, { round: number; done: boolean }> };
    expect(c.reviewRuns.get(loop.id)).toMatchObject({ round: 1, done: false });
    release({ converged: false, openP0: 1, openActionPoints: [], verdict: null, participants: null });
  });

  it("legacy (directReview OFF) path is untouched by the SAME unresolved-ref failure", async () => {
    buildDiffContextMock.mockResolvedValue(unresolvedFail());
    const loop = makeLoop({ state: "building_context", round: 0 });
    const { storage, get } = makeFakeStorage(loop);
    const startGroupAsync = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const runReview = vi.fn();
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: startGroupAsync, startGroupAsync, createTaskGroup: storage.createTaskGroup, cancelGroup: vi.fn() } as never,
      config: configWith(false),
      runReview: runReview as never,
    });

    await controller.tick(loop.id);

    expect(startGroupAsync).not.toHaveBeenCalled(); // never dispatched (as before)
    expect(runReview).not.toHaveBeenCalled(); // runner never touched (legacy mode)
    const final = get();
    expect(final.state).toBe("failed");
    expect(final.error).toBe(UNRESOLVED_REASON);
  });
});
