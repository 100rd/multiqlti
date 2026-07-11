/**
 * loop-throttle-auto-resume.test.ts — "throttled v2" Part A: bounded AUTO-RESUME.
 *
 * The throttled MVP (state `throttled`, `throttledPhase`, `isRateLimitError`,
 * `controller.retryThrottled(loopId)`) already pauses a loop that hits an agent
 * usage/rate limit. This adds a SELF-resume on top: a loop resting in `throttled`
 * past its stamped `throttledUntil` deadline resumes itself via the EXISTING
 * `retryThrottled` command — bounded by `resumeAttempts < maxAutoResumeAttempts`
 * and gated by `throttle.autoResume`.
 *
 * These tests prove:
 *   1. `reduce()` stamps `throttledUntil` on both throttled-entry transitions
 *      (`review_throttled` cooldown-default; `dev_completed{rateLimited}` parses a
 *      Retry-After hint from `event.error` when present, else falls back to cooldown).
 *   2. `reduce()` clears `throttledUntil`/resets `resumeAttempts` on `retry_requested`
 *      (the SAME branch both operator Retry and the auto-resume guard funnel through).
 *   3. `tickInner` (via `controller.tick()`) auto-resumes a throttled loop whose
 *      deadline has passed and whose `resumeAttempts` is under the cap — genuinely
 *      driving it out of `throttled` (proves the in-process reentrancy guard doesn't
 *      deadlock the self-call).
 *   4. `tickInner` does NOT auto-resume once `resumeAttempts >= maxAutoResumeAttempts`.
 *   5. `tickInner` does NOT auto-resume when `throttle.autoResume === false`.
 *   6. Operator `retryThrottled` resets `resumeAttempts` to 0 (mirrors #2 end-to-end).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Deterministic review-input build: decouples the review-phase resume
// (`retryThrottledReview` → `startReviewRound`) from real git, mirroring
// loop-review-recovery.test.ts's convention.
vi.mock("../../../server/services/consilium/diff-context.js", () => ({
  buildDiffContext: vi.fn(async () => ({ ok: true, input: "REVIEW INPUT" })),
}));

import {
  ConsiliumLoopController,
  reduce,
} from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";

const MIN = 60_000;

function makeLoop(over: Partial<ConsiliumLoopRow> = {}): ConsiliumLoopRow {
  return {
    id: "loop-1",
    projectId: "proj1",
    groupId: "grp1",
    state: "throttled",
    round: 1,
    maxRounds: 6,
    repoPath: process.cwd(),
    lastReviewedCommit: null,
    reviewRef: null,
    currentIterationNumber: 2,
    reviewRedrive: null,
    throttledPhase: "review",
    throttledUntil: new Date(Date.now() - MIN), // deadline already passed
    resumeAttempts: 0,
    devGroupId: null,
    prRef: null,
    headCommitAtReview: null,
    openP0: null,
    error: "rate limited",
    createdBy: "user1",
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...over,
  } as ConsiliumLoopRow;
}

interface ThrottleCfg {
  autoResume?: boolean;
  cooldownSeconds?: number;
  maxAutoResumeAttempts?: number;
}
const makeConfig =
  (over: ThrottleCfg = {}) =>
  () =>
    ({
      pipeline: {
        consiliumLoop: {
          enabled: true,
          maxRounds: 6,
          pollIntervalMs: 5000,
          maxDiffBytes: 200_000,
          allowedRepoPaths: [process.cwd()],
          reviewStallTimeoutMs: 900_000,
          reviewMaxRedrives: 3,
          throttle: {
            autoResume: over.autoResume ?? true,
            cooldownSeconds: over.cooldownSeconds ?? 300,
            maxAutoResumeAttempts: over.maxAutoResumeAttempts ?? 3,
          },
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

  const startGroupAsync = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 99 } }));

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
    getIteration: vi.fn(async () => undefined),
    updateIteration: vi.fn(async () => ({})),
    getExecutionsByIteration: vi.fn(async () => []),
    getLlmRequests: vi.fn(async () => ({ rows: [], total: 0 })),
    claimReviewRedrive: vi.fn(async () => undefined),
    claimRedrive: vi.fn(async () => undefined),
    casLoopState,
    updateLoop,
    appendLoopRound: vi.fn(async () => ({})),
  };

  return { storage, startGroupAsync, casLoopState, updateLoop, get: () => current };
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

describe('reduce() — "throttled v2" Part A: deadline stamping + clearing', () => {
  it("review_throttled stamps throttledUntil using the configured cooldown default", () => {
    const before = Date.now();
    const t = reduce("reviewing", { kind: "review_throttled" }, { throttleCooldownSeconds: 120 });
    expect(t?.to).toBe("throttled");
    expect(t?.extra?.throttledPhase).toBe("review");
    const stamped = (t?.extra as { throttledUntil?: Date })?.throttledUntil;
    expect(stamped).toBeInstanceOf(Date);
    const deltaMs = (stamped as Date).getTime() - before;
    expect(deltaMs).toBeGreaterThan(119_000);
    expect(deltaMs).toBeLessThan(121_000);
  });

  it("dev_completed{rateLimited} parses a Retry-After hint from event.error over the cooldown default", () => {
    const before = Date.now();
    const t = reduce(
      "developing",
      { kind: "dev_completed", prRef: null, headCommit: "c", error: "Retry-After: 45", rateLimited: true },
      { throttleCooldownSeconds: 300 },
    );
    expect(t?.to).toBe("throttled");
    expect(t?.extra?.throttledPhase).toBe("develop");
    const stamped = (t?.extra as { throttledUntil?: Date })?.throttledUntil;
    const deltaMs = (stamped as Date).getTime() - before;
    expect(deltaMs).toBeGreaterThan(44_000);
    expect(deltaMs).toBeLessThan(46_000); // ~45s, NOT the 300s cooldown default
  });

  it("dev_completed{rateLimited} falls back to the cooldown default when event.error has no parseable hint", () => {
    const before = Date.now();
    const t = reduce(
      "developing",
      { kind: "dev_completed", prRef: null, headCommit: "c", error: "agent usage limit hit", rateLimited: true },
      { throttleCooldownSeconds: 300 },
    );
    const stamped = (t?.extra as { throttledUntil?: Date })?.throttledUntil;
    const deltaMs = (stamped as Date).getTime() - before;
    expect(deltaMs).toBeGreaterThan(299_000);
    expect(deltaMs).toBeLessThan(301_000);
  });

  it("dev_completed{rateLimited} NEVER threads the raw error text onto loop.error (Security L1)", () => {
    const t = reduce(
      "developing",
      { kind: "dev_completed", prRef: null, headCommit: "c", error: "Retry-After: 45", rateLimited: true },
      { throttleCooldownSeconds: 300 },
    );
    expect(t?.extra?.error).not.toContain("Retry-After");
  });

  it("retry_requested clears throttledUntil and resets resumeAttempts (operator OR auto-resume path)", () => {
    const t = reduce("throttled", { kind: "retry_requested", throttledPhase: "develop" });
    expect(t?.extra?.throttledUntil).toBeNull();
    expect(t?.extra?.resumeAttempts).toBe(0);
  });
});

describe('tickInner — "throttled v2" Part A: bounded auto-resume guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-resumes a throttled loop past its deadline & under the cap (drives it OUT of throttled)", async () => {
    const loop = makeLoop({ throttledUntil: new Date(Date.now() - MIN), resumeAttempts: 0 });
    const { storage, startGroupAsync, casLoopState } = fakeStorage(loop);
    const controller = makeController(storage, startGroupAsync, makeConfig({ maxAutoResumeAttempts: 3 }));

    const res = await controller.tick(loop.id);

    // The bump (throttled -> throttled, resumeAttempts: 1) genuinely fired...
    expect(casLoopState).toHaveBeenCalledWith("loop-1", "throttled", "throttled", { resumeAttempts: 1 });
    // ...and the resume itself actually ran (review resume dispatches a review round),
    // proving the reentrancy guard was released before the self-call, not deadlocked.
    expect(startGroupAsync).toHaveBeenCalledTimes(1);
    expect(res?.state).toBe("reviewing");
    // Resume (via retry_requested) clears the pause bookkeeping for the NEXT throttle.
    expect(res?.throttledUntil).toBeNull();
    expect(res?.resumeAttempts).toBe(0);
  });

  it("does NOT auto-resume once resumeAttempts is at the cap (stays throttled, no resume side effect)", async () => {
    const loop = makeLoop({ throttledUntil: new Date(Date.now() - MIN), resumeAttempts: 3 });
    const { storage, startGroupAsync, casLoopState } = fakeStorage(loop);
    const controller = makeController(storage, startGroupAsync, makeConfig({ maxAutoResumeAttempts: 3 }));

    const res = await controller.tick(loop.id);

    expect(casLoopState).not.toHaveBeenCalled();
    expect(startGroupAsync).not.toHaveBeenCalled();
    expect(res).toBeNull();

    const stillThrottled = await storage.getLoop(loop.id);
    expect(stillThrottled.state).toBe("throttled");
    expect(stillThrottled.resumeAttempts).toBe(3);
  });

  it("does NOT auto-resume when throttle.autoResume is false (stays throttled for operator Retry)", async () => {
    const loop = makeLoop({ throttledUntil: new Date(Date.now() - MIN), resumeAttempts: 0 });
    const { storage, startGroupAsync, casLoopState } = fakeStorage(loop);
    const controller = makeController(storage, startGroupAsync, makeConfig({ autoResume: false }));

    const res = await controller.tick(loop.id);

    expect(casLoopState).not.toHaveBeenCalled();
    expect(startGroupAsync).not.toHaveBeenCalled();
    expect(res).toBeNull();
    expect((await storage.getLoop(loop.id)).state).toBe("throttled");
  });

  it("does NOT auto-resume before the deadline has passed", async () => {
    const loop = makeLoop({ throttledUntil: new Date(Date.now() + MIN), resumeAttempts: 0 });
    const { storage, startGroupAsync, casLoopState } = fakeStorage(loop);
    const controller = makeController(storage, startGroupAsync, makeConfig());

    const res = await controller.tick(loop.id);

    expect(casLoopState).not.toHaveBeenCalled();
    expect(startGroupAsync).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it("operator retryThrottled resets resumeAttempts to 0 (same clearing branch as auto-resume)", async () => {
    const loop = makeLoop({ throttledUntil: new Date(Date.now() - MIN), resumeAttempts: 2 });
    const { storage, startGroupAsync } = fakeStorage(loop);
    const controller = makeController(storage, startGroupAsync, makeConfig());

    const result = await controller.retryThrottled(loop.id);

    expect(result.ok).toBe(true);
    expect(result.ok && result.loop.resumeAttempts).toBe(0);
    expect(result.ok && result.loop.throttledUntil).toBeNull();
    expect(result.ok && result.loop.state).toBe("reviewing");
  });
});
