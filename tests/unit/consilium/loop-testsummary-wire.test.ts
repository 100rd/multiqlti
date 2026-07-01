/**
 * loop-testsummary-wire.test.ts — Stage 2b: the testSummary CONVERGENCE WIRE.
 *
 * The develop phase's per-criterion verification result must reach the NEXT review
 * round so the judge's convergence verdict is GROUNDED in real test results:
 *   develop → SdlcHandoffResult.testSummary → consilium_loop_rounds.testSummary
 *   → (next round) buildDiffContext({ testSummary }) → judge input.
 *
 * Here we assert the two ends that are observable without a live repo:
 *   1. The controller PERSISTS a settled run's `testSummary` to the round row (and
 *      does NOT when verification produced none — INERT / Stage-2a).
 *   2. The storage round-trip (append → update → read) + the "latest non-null"
 *      selection the controller's review wire relies on.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ConsiliumLoopController,
} from "../../../server/services/consilium/consilium-loop-controller.js";
import { MemStorage } from "../../../server/storage.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";
import type { ConvergenceVerdict } from "@shared/types";

const verdict = (openP0: number): ConvergenceVerdict => ({
  converged: false,
  openP0,
  openActionPoints: Array.from({ length: openP0 }, (_, i) => ({ title: `ap${i}`, priority: "P0" })),
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop-1",
    projectId: "proj1",
    groupId: "grp1",
    state: "deciding",
    round: 2,
    maxRounds: 6,
    repoPath: process.cwd(),
    lastReviewedCommit: null,
    currentIterationNumber: 2,
    devPipelineId: "dev-pipe",
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

function fakeStorage(loop: ConsiliumLoopRow) {
  let current = loop;
  const updateLoopRoundTestSummary = vi.fn(async () => undefined);
  const storage = {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => []),
    casLoopState: vi.fn(async (id: string, expected: ConsiliumLoopState, next: ConsiliumLoopState, extra?: Record<string, unknown>) => {
      if (id !== current.id || current.state !== expected) return undefined;
      current = { ...current, ...(extra ?? {}), state: next };
      return current;
    }),
    claimRedrive: vi.fn(async () => undefined),
    appendLoopRound: vi.fn(async () => ({})),
    updateLoopRoundTestSummary,
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, input: "objective" })),
    updateTaskGroup: vi.fn(async () => ({})),
    getIteration: vi.fn(async () => ({ id: "it1", iterationNumber: 2, status: "completed" })),
    getExecutionsByIteration: vi.fn(async () => []),
  };
  return { storage, updateLoopRoundTestSummary };
}

interface CfgOver {
  verificationEnabled?: boolean;
  trustedRepoAck?: boolean;
  sandbox?: boolean;
  finalVerificationEnabled?: boolean;
}

const makeConfig =
  (over: CfgOver = {}) =>
  () =>
    ({
      features: { sandbox: { enabled: over.sandbox ?? false } },
      pipeline: {
        consiliumLoop: {
          enabled: true,
          maxRounds: 6,
          pollIntervalMs: 5000,
          maxDiffBytes: 200000,
          allowedRepoPaths: [process.cwd()],
          devPipelineId: "dev-pipe",
          implement: {
            enabled: true,
            verification: { enabled: over.verificationEnabled ?? true },
            trustedRepoAck: over.trustedRepoAck ?? false,
            maxFixIterations: 3,
            testCommand: null,
            testRunTimeoutMs: 300000,
            finalVerification: { enabled: over.finalVerificationEnabled ?? false, maxFinalFixIterations: 1 },
          },
        },
      },
    }) as never;

// Default: verification ON + operator ack ON ⇒ effectively enabled (so the
// persistence tests below exercise the real run path).
const fakeConfig = makeConfig({ verificationEnabled: true, trustedRepoAck: true });

describe("Stage 2b — controller persists the develop run's testSummary (convergence wire)", () => {
  it("a settled run carrying testSummary is written to consilium_loop_rounds.testSummary", async () => {
    const loop = makeLoop({ state: "deciding", round: 2 });
    const { storage, updateLoopRoundTestSummary } = fakeStorage(loop);
    const runCloseout = vi.fn(async () => ({
      prRef: "https://github.com/x/y/pull/1",
      headCommit: "abc",
      testSummary: "Per-criterion verification: 1/1 green.",
    }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(2),
      runCloseout,
    });
    await controller.tick(loop.id); // deciding → developing → dispatch (background)
    await flush(); // let the fire-and-forget closeout settle + persist

    expect(updateLoopRoundTestSummary).toHaveBeenCalledTimes(1);
    expect(updateLoopRoundTestSummary).toHaveBeenCalledWith("loop-1", 2, "Per-criterion verification: 1/1 green.");
  });

  it("INERT: a run with NO testSummary (verification off) does NOT touch the round summary", async () => {
    const loop = makeLoop({ state: "deciding", round: 2 });
    const { storage, updateLoopRoundTestSummary } = fakeStorage(loop);
    const runCloseout = vi.fn(async () => ({ prRef: "https://github.com/x/y/pull/2", headCommit: "abc" }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(2),
      runCloseout,
    });
    await controller.tick(loop.id);
    await flush();
    expect(updateLoopRoundTestSummary).not.toHaveBeenCalled();
  });
});

describe("Stage 2b — storage round-trip + latest-non-null selection", () => {
  it("appendLoopRound leaves testSummary null (the baseline the wire is additive over)", async () => {
    const s = new MemStorage();
    await s.appendLoopRound({ loopId: "L1", round: 0, iterationNumber: 0 } as never);
    const [row] = await s.getLoopRounds("L1");
    expect(row.testSummary).toBeNull();
  });

  it("updateLoopRoundTestSummary sets the summary; getLoopRounds reflects it", async () => {
    const s = new MemStorage();
    await s.appendLoopRound({ loopId: "L1", round: 0, iterationNumber: 0 } as never);
    await s.updateLoopRoundTestSummary("L1", 0, "PASS 2/2");
    const [row] = await s.getLoopRounds("L1");
    expect(row.testSummary).toBe("PASS 2/2");
  });

  it("a no-match (loop, round) update is a no-op (never throws)", async () => {
    const s = new MemStorage();
    await expect(s.updateLoopRoundTestSummary("nope", 9, "x")).resolves.toBeUndefined();
  });

  it("the most-recent round with a non-null summary is selectable (the review wire's pick)", async () => {
    const s = new MemStorage();
    await s.appendLoopRound({ loopId: "L1", round: 0, iterationNumber: 0 } as never);
    await s.appendLoopRound({ loopId: "L1", round: 1, iterationNumber: 1 } as never);
    await s.updateLoopRoundTestSummary("L1", 0, "round0 PASS");
    // round 1 has no summary → the latest NON-NULL is round 0.
    const rounds = await s.getLoopRounds("L1");
    const latest = [...rounds].reverse().find((r) => r.testSummary && r.testSummary.trim().length > 0);
    expect(latest?.testSummary).toBe("round0 PASS");
  });
});

describe("MED-2 — fail-closed enable-gate (sandbox OR trustedRepoAck required)", () => {
  function controllerWith(config: () => unknown, runSdlc: ReturnType<typeof vi.fn>, storage: unknown) {
    return new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: config as never,
      readIterationVerdict: async () => verdict(2),
      runSdlc: runSdlc as never,
    });
  }

  it("verification.enabled but NEITHER sandbox NOR ack ⇒ runSdlc gets verification:null (Stage-2a) + warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loop = makeLoop({ state: "deciding", round: 2, repoPath: process.cwd() });
    const { storage } = fakeStorage(loop);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = controllerWith(
      makeConfig({ verificationEnabled: true, trustedRepoAck: false, sandbox: false }),
      runSdlc,
      storage,
    );
    await controller.tick(loop.id);
    await flush();
    expect(runSdlc).toHaveBeenCalledTimes(1);
    expect(runSdlc.mock.calls[0][0].verification).toBeNull(); // gated OFF ⇒ Stage-2a
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("verification.enabled ignored"));
    warn.mockRestore();
  });

  it("trustedRepoAck=true ⇒ runSdlc gets verification ENABLED", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, repoPath: process.cwd() });
    const { storage } = fakeStorage(loop);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = controllerWith(
      makeConfig({ verificationEnabled: true, trustedRepoAck: true, sandbox: false }),
      runSdlc,
      storage,
    );
    await controller.tick(loop.id);
    await flush();
    expect(runSdlc.mock.calls[0][0].verification).toEqual(
      expect.objectContaining({ enabled: true, maxFixIterations: 3, testRunTimeoutMs: 300000 }),
    );
  });

  it("features.sandbox.enabled=true ⇒ runSdlc gets verification ENABLED (no ack needed)", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, repoPath: process.cwd() });
    const { storage } = fakeStorage(loop);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = controllerWith(
      makeConfig({ verificationEnabled: true, trustedRepoAck: false, sandbox: true }),
      runSdlc,
      storage,
    );
    await controller.tick(loop.id);
    await flush();
    expect(runSdlc.mock.calls[0][0].verification).toEqual(expect.objectContaining({ enabled: true }));
  });
});

describe("Stage A — controller threads finalVerification under the SAME sandbox gate", () => {
  function controllerWith(config: () => unknown, runSdlc: ReturnType<typeof vi.fn>, storage: unknown) {
    return new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: config as never,
      readIterationVerdict: async () => verdict(2),
      runSdlc: runSdlc as never,
    });
  }

  it("finalVerification.enabled + verification gate satisfied ⇒ runSdlc gets finalVerification ENABLED", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, repoPath: process.cwd() });
    const { storage } = fakeStorage(loop);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = controllerWith(
      makeConfig({ verificationEnabled: true, trustedRepoAck: true, finalVerificationEnabled: true }),
      runSdlc,
      storage,
    );
    await controller.tick(loop.id);
    await flush();
    expect(runSdlc.mock.calls[0][0].finalVerification).toEqual(
      expect.objectContaining({ enabled: true, maxFinalFixIterations: 1 }),
    );
  });

  it("finalVerification.enabled but the verification sandbox gate is CLOSED ⇒ finalVerification NULL", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, repoPath: process.cwd() });
    const { storage } = fakeStorage(loop);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    // verification on but NEITHER sandbox NOR ack ⇒ effectiveVerificationEnabled=false ⇒
    // final verification must ALSO be gated off (it runs the host test command too).
    const controller = controllerWith(
      makeConfig({ verificationEnabled: true, trustedRepoAck: false, sandbox: false, finalVerificationEnabled: true }),
      runSdlc,
      storage,
    );
    await controller.tick(loop.id);
    await flush();
    expect(runSdlc.mock.calls[0][0].finalVerification).toBeNull();
  });

  it("finalVerification OFF (default) ⇒ runSdlc gets finalVerification NULL (INERT)", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, repoPath: process.cwd() });
    const { storage } = fakeStorage(loop);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = controllerWith(
      makeConfig({ verificationEnabled: true, trustedRepoAck: true, finalVerificationEnabled: false }),
      runSdlc,
      storage,
    );
    await controller.tick(loop.id);
    await flush();
    expect(runSdlc.mock.calls[0][0].finalVerification).toBeNull();
  });
});
