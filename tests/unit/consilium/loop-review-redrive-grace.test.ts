/**
 * loop-review-redrive-grace.test.ts — M-1 (Security MEDIUM): the reviewing-runner redrive
 * grace must cover a WHOLE multi-wave runner review, not the bare ~30s null-ref base.
 *
 * A runner review keeps `currentIterationNumber` NULL (⇒ `nullRef` true in redriveStranded).
 * The in-process `reviewRuns` registry gates the SAME instance, but a DIFFERENT instance holds
 * no local entry — so without a round-sized grace it would redrive a LIVE multi-wave review at
 * ~30s (duplicate model spend + round-counter inflation + a redrive storm). This sizes the
 * reviewing grace to `taskTimeoutMs × REVIEW_RUNNER_WAVES` — the reviewing peer of the developing
 * round-sized grace — while still redriving a GENUINELY stranded review past that window.
 *
 * The extension is GATED on the runner kill-switch to keep FLAG-OFF byte-identical: under flag
 * OFF the reviewing grace stays the bare base, so the legacy crash-window redrive (null-ref
 * before the iteration child-ref write) recovers at the SHORT grace exactly as before.
 */
import { describe, it, expect, vi } from "vitest";
import { ConsiliumLoopController, REVIEW_RUNNER_WAVES } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";

const MIN = 60_000;
const TASK_TIMEOUT_MS = 600_000; // 10 min per wave
const BASE_GRACE = 30_000; // max(2×poll=10s, 30s)
const ROUND_GRACE = TASK_TIMEOUT_MS * REVIEW_RUNNER_WAVES; // 30 min

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop1",
    groupId: "grp1",
    state: "reviewing",
    round: 1,
    maxRounds: 6,
    repoPath: process.cwd(),
    lastReviewedCommit: null,
    currentIterationNumber: null,
    devGroupId: null,
    prRef: null,
    headCommitAtReview: null,
    reviewMode: null,
    reviewRef: null,
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
  const claimRedrive = vi.fn(async () => undefined); // always "claim lost" ⇒ no side effect runs
  const storage = {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => []),
    casLoopState: vi.fn(async () => undefined),
    claimRedrive,
    appendLoopRound: vi.fn(async () => ({})),
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, input: "obj" })),
    updateTaskGroup: vi.fn(async () => ({})),
    getIteration: vi.fn(async () => undefined),
    getExecutionsByIteration: vi.fn(async () => []),
  };
  return { storage, claimRedrive };
}

const configWith = (directReviewEnabled: boolean) =>
  (() => ({
    pipeline: {
      taskGroups: { taskTimeoutMs: TASK_TIMEOUT_MS },
      consiliumLoop: { enabled: true, maxRounds: 6, pollIntervalMs: 5000, maxDiffBytes: 200000, allowedRepoPaths: [process.cwd()], directReview: { enabled: directReviewEnabled }, implement: { enabled: false, verification: { enabled: false }, research: { enabled: false } } },
    },
  })) as never;

function makeController(loop: ConsiliumLoopRow, directReviewEnabled: boolean) {
  const { storage, claimRedrive } = makeFakeStorage(loop);
  const controller = new ConsiliumLoopController({
    storage: storage as never,
    taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
    config: configWith(directReviewEnabled),
    readRepoHead: async () => "HEADSHA",
  });
  return { controller, claimRedrive };
}
type Priv = { redriveGraceMs(state?: ConsiliumLoopState): number };

describe("M-1 — reviewing-runner redrive grace (flag ON)", () => {
  it("redriveGraceMs(reviewing) is sized to taskTimeoutMs × REVIEW_RUNNER_WAVES, far above the base", () => {
    const { controller } = makeController(makeLoop({}), true);
    const p = controller as unknown as Priv;
    expect(p.redriveGraceMs("reviewing")).toBe(ROUND_GRACE); // 30 min
    expect(p.redriveGraceMs("reviewing")).toBeGreaterThan(p.redriveGraceMs("building_context"));
    expect(p.redriveGraceMs("building_context")).toBe(BASE_GRACE);
  });

  it("a runner reviewing loop (no local reviewRuns entry) WITHIN the grace is NOT cross-instance redrive-eligible", async () => {
    // Age 5 min ≪ 30 min grace: a legitimately-in-flight multi-wave review on another instance.
    const loop = makeLoop({ state: "reviewing", round: 1, currentIterationNumber: null, updatedAt: new Date(Date.now() - 5 * MIN) });
    const { controller, claimRedrive } = makeController(loop, true);

    await controller.tick(loop.id);

    expect(claimRedrive).not.toHaveBeenCalled(); // within grace ⇒ no cross-instance redrive
  });

  it("a runner reviewing loop PAST the grace still redrives (never stranded-forever)", async () => {
    // Age 40 min > 30 min grace: a genuinely crashed/registry-lost review.
    const loop = makeLoop({ state: "reviewing", round: 1, currentIterationNumber: null, updatedAt: new Date(Date.now() - 40 * MIN) });
    const { controller, claimRedrive } = makeController(loop, true);

    await controller.tick(loop.id);

    expect(claimRedrive).toHaveBeenCalledTimes(1); // past grace ⇒ cross-instance claim attempted
    expect(claimRedrive).toHaveBeenCalledWith(loop.id, "reviewing", ROUND_GRACE);
  });
});

describe("M-1 — FLAG-OFF parity: reviewing grace stays the bare base", () => {
  it("redriveGraceMs(reviewing) === the base grace under flag OFF (round-sized NOT applied)", () => {
    const { controller } = makeController(makeLoop({}), false);
    expect((controller as unknown as Priv).redriveGraceMs("reviewing")).toBe(BASE_GRACE);
  });

  it("a null-ref reviewing loop under flag OFF PAST the base grace redrives at the SHORT window (legacy crash-window recovery unchanged)", async () => {
    // Age 2 min: past the 30s base, WITHIN the 30-min round grace. Under flag OFF the base grace
    // applies, so this legacy crash-window still redrives promptly (the pre-M-1 behaviour).
    const loop = makeLoop({ state: "reviewing", round: 1, currentIterationNumber: null, updatedAt: new Date(Date.now() - 2 * MIN) });
    const { controller, claimRedrive } = makeController(loop, false);

    await controller.tick(loop.id);

    expect(claimRedrive).toHaveBeenCalledTimes(1); // base grace ⇒ redrives (NOT held by the round grace)
    expect(claimRedrive).toHaveBeenCalledWith(loop.id, "reviewing", BASE_GRACE);
  });
});
