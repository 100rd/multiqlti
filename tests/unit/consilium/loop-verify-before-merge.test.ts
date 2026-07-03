/**
 * loop-verify-before-merge.test.ts — §3E verify-before-merge.
 *
 * The confirmation re-review moves BEFORE the human ship gate: after `dev_completed`
 * the loop (1) integrates its base branch into the round branch (so the PR is the
 * REALISTIC landing state) and (2) runs the confirmation review AUTOMATICALLY — no human
 * gate to START it. A converged confirmation lands at `awaiting_merge` where the human's
 * only job is the FINAL ship; the `merge_approved` event then TERMINATES the loop with NO
 * second review. All kill-switched under `pipeline.consiliumLoop.verifyBeforeMerge.enabled`
 * (default FALSE ⇒ today's flow byte-identical).
 *
 * Coverage:
 *   A. PURE reducer routing (enabled vs disabled) for all three touched transitions.
 *   B. Controller tick wiring: enabled → integrate (integrateBase=true) + confirmation
 *      BEFORE awaiting_merge; converged → awaiting_merge; not-converged → develop again;
 *      disabled → awaiting_merge (byte-identical); the human merge on an enabled loop does
 *      NOT trigger a second review.
 *   C. Adversarial: an integration CONFLICT (dev_completed carries an error) must NOT run a
 *      confirmation on a broken merge — it falls through to the human ship gate.
 */
import { describe, it, expect, vi } from "vitest";
import {
  reduce,
  ConsiliumLoopController,
  type LoopEvent,
} from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";
import type { ConvergenceVerdict } from "@shared/types";

const verdict = (converged: boolean, openP0: number): ConvergenceVerdict => ({
  converged,
  openP0,
  openActionPoints: Array.from({ length: openP0 }, (_, i) => ({ title: `ap${i}`, priority: "P0" })),
});

const VBM_ON = { verifyBeforeMerge: true } as const;
const flush = () => new Promise((r) => setTimeout(r, 0));

// ─── A. PURE reducer — verify-before-merge routing (enabled vs default OFF) ──────

describe("reduce — §3E verify-before-merge routing", () => {
  const devDone: LoopEvent = { kind: "dev_completed", prRef: "pr/1", headCommit: "h1", integrationBase: "base1" };

  it("DEFAULT OFF is byte-identical: developing+dev_completed → AWAITING_MERGE", () => {
    expect(reduce("developing", devDone)?.to).toBe("awaiting_merge");
    // and, per default, converged terminates + merge_approved re-reviews (today's flow).
    expect(reduce("deciding", { kind: "decided", verdict: verdict(true, 0), priorOpenP0: [3, 0] })?.to).toBe("converged");
    expect(reduce("awaiting_merge", { kind: "merge_approved" })?.to).toBe("building_context");
  });

  it("ON + CLEAN close-out: developing+dev_completed → BUILDING_CONTEXT (confirm before ship)", () => {
    const t = reduce("developing", devDone, VBM_ON);
    expect(t?.to).toBe("building_context");
    // prRef + reviewed head are still carried atomically (as they are into awaiting_merge).
    expect(t?.extra?.prRef).toBe("pr/1");
    expect(t?.extra?.headCommitAtReview).toBe("h1");
  });

  it("ON + close-out/integration ERROR: developing+dev_completed → AWAITING_MERGE (surface, no confirm on a broken merge)", () => {
    const t = reduce(
      "developing",
      { kind: "dev_completed", prRef: null, headCommit: "h", error: "integration conflict merging main into the round branch" },
      VBM_ON,
    );
    expect(t?.to).toBe("awaiting_merge"); // NOT building_context
    expect(t?.extra?.error).toContain("integration conflict");
  });

  it("ON: a converged CONFIRMATION (round>=2, code was developed) → AWAITING_MERGE (ship gate)", () => {
    const t = reduce("deciding", { kind: "decided", verdict: verdict(true, 0), priorOpenP0: [3, 0] }, VBM_ON);
    expect(t?.to).toBe("awaiting_merge");
  });

  it("ON: round-1 IMMEDIATE convergence (nothing developed) → CONVERGED (terminal, unchanged)", () => {
    const t = reduce("deciding", { kind: "decided", verdict: verdict(true, 0), priorOpenP0: [0] }, VBM_ON);
    expect(t?.to).toBe("converged");
  });

  it("ON: a non-converged confirmation with room left → DEVELOPING (re-develop; unchanged)", () => {
    const t = reduce("deciding", { kind: "decided", verdict: verdict(false, 1), priorOpenP0: [3, 1] }, VBM_ON);
    expect(t?.to).toBe("developing");
  });

  it("ON: awaiting_merge+merge_approved → CONVERGED (FINAL ship, NO second review)", () => {
    const t = reduce("awaiting_merge", { kind: "merge_approved" }, VBM_ON);
    expect(t?.to).toBe("converged");
    expect(t?.extra?.completedAt).toBeInstanceOf(Date);
  });
});

// ─── B/C. Controller tick wiring over fakes ─────────────────────────────────────

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop-vbm",
    projectId: "proj1",
    groupId: "grp1",
    state: "deciding",
    round: 1,
    maxRounds: 6,
    repoPath: process.cwd(),
    lastReviewedCommit: null,
    reviewRef: null,
    reviewMode: null,
    archetype: null,
    currentIterationNumber: 1,
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

function fakeStorage(loop: ConsiliumLoopRow, rounds: { round: number; openP0: number }[] = []) {
  let current = loop;
  const storage = {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => rounds.map((r) => ({ ...r }))),
    casLoopState: vi.fn(async (id: string, expected: ConsiliumLoopState, next: ConsiliumLoopState, extra?: Record<string, unknown>) => {
      if (id !== current.id || current.state !== expected) return undefined;
      current = { ...current, ...(extra ?? {}), state: next };
      return current;
    }),
    claimRedrive: vi.fn(async () => undefined),
    appendLoopRound: vi.fn(async () => ({})),
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, input: "objective" })),
    updateTaskGroup: vi.fn(async () => ({})),
    getIteration: vi.fn(async () => ({ id: "it1", iterationNumber: current.currentIterationNumber ?? 1, status: "completed" })),
    getExecutionsByIteration: vi.fn(async () => []),
    getSkills: vi.fn(async () => []),
  };
  return { storage, get: () => current };
}

/** Config for the controller. `vbm` toggles the ONLY kill-switch under test. */
const makeConfig =
  (vbm: boolean) =>
  () =>
    ({
      pipeline: {
        consiliumLoop: {
          enabled: true,
          maxRounds: 6,
          pollIntervalMs: 5000,
          maxDiffBytes: 200000,
          allowedRepoPaths: [process.cwd()],
          sdlcTimeoutMs: 300000,
          verifyBeforeMerge: { enabled: vbm },
          // The skilled SDLC executor is the only develop path; enable it so develop
          // dispatches the (injected) runSdlc. Verification OFF (schema default).
          implement: {
            enabled: true,
            verification: { enabled: false },
            maxFixIterations: 3,
            testCommand: null,
            testRunTimeoutMs: 300000,
            research: { enabled: false, maxResearchIterations: 3, model: "claude-sonnet" },
          },
        },
      },
    }) as never;

const orchestrator = () => {
  const sg = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
  return { taskOrchestrator: { startGroup: sg, startGroupAsync: sg, createTaskGroup: vi.fn(), cancelGroup: vi.fn() }, sg };
};

/** A clean develop close-out that integrated `base-sha` into the round branch. */
const cleanRunSdlc = () =>
  vi.fn(async (_req: unknown) => ({ prRef: "https://github.com/x/y/pull/9", headCommit: "devhead", integrationBase: "base-sha" }));

describe("controller — §3E verify-before-merge wiring", () => {
  it("ENABLED: develop dispatches integrateBase=true, then confirms BEFORE awaiting_merge (reviewRef→round branch, baseline→integrated base)", async () => {
    const loop = makeLoop({ state: "deciding", round: 1, currentIterationNumber: 1 });
    const { storage } = fakeStorage(loop);
    const { taskOrchestrator } = orchestrator();
    const runSdlc = cleanRunSdlc();
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: taskOrchestrator as never,
      config: makeConfig(true),
      readIterationVerdict: async () => verdict(false, 2), // open P0s, room left → DEVELOPING
      readRepoHead: async () => "repohead",
      runSdlc: runSdlc as never,
    });

    const t1 = await controller.tick(loop.id); // deciding → developing (dispatch background)
    expect(t1?.state).toBe("developing");
    await flush(); // let the fire-and-forget close-out settle into the registry

    // The develop close-out was asked to integrate the base branch (§3E).
    expect(runSdlc).toHaveBeenCalledTimes(1);
    expect((runSdlc.mock.calls[0][0] as { integrateBase?: boolean }).integrateBase).toBe(true);

    const t2 = await controller.tick(loop.id); // developing → BUILDING_CONTEXT (confirmation entry)
    expect(t2?.state).toBe("building_context"); // NOT awaiting_merge — confirmation runs first
    expect(t2?.reviewRef).toBe("consilium/loop-loop-vbm/round-1"); // review the integrated round branch
    expect(t2?.lastReviewedCommit).toBe("base-sha"); // diff base..roundBranch = what will land
  });

  it("ENABLED: a CONVERGED confirmation (round>=2) lands at AWAITING_MERGE (the human ship gate)", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, currentIterationNumber: 2 });
    const { storage } = fakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const { taskOrchestrator } = orchestrator();
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: taskOrchestrator as never,
      config: makeConfig(true),
      readIterationVerdict: async () => verdict(true, 0), // confirmation CONVERGED
    });
    const res = await controller.tick(loop.id);
    expect(res?.state).toBe("awaiting_merge");
  });

  it("ENABLED: a NON-converged confirmation with room left → DEVELOPING (loop keeps going, bounded by maxRounds)", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, currentIterationNumber: 2 });
    const { storage } = fakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const { taskOrchestrator } = orchestrator();
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: taskOrchestrator as never,
      config: makeConfig(true),
      readIterationVerdict: async () => verdict(false, 1), // still open, decreasing → re-develop
      runSdlc: cleanRunSdlc() as never,
    });
    const res = await controller.tick(loop.id);
    expect(res?.state).toBe("developing");
  });

  it("DISABLED: develop → AWAITING_MERGE and NO integration requested (byte-identical to today)", async () => {
    const loop = makeLoop({ state: "deciding", round: 1, currentIterationNumber: 1 });
    const { storage } = fakeStorage(loop);
    const { taskOrchestrator } = orchestrator();
    const runSdlc = cleanRunSdlc();
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: taskOrchestrator as never,
      config: makeConfig(false), // kill-switch OFF
      readIterationVerdict: async () => verdict(false, 2),
      runSdlc: runSdlc as never,
    });
    await controller.tick(loop.id); // deciding → developing
    await flush();
    // Off ⇒ the executor is NOT asked to integrate.
    expect((runSdlc.mock.calls[0][0] as { integrateBase?: boolean }).integrateBase).toBe(false);
    const t2 = await controller.tick(loop.id); // developing → AWAITING_MERGE (today's flow)
    expect(t2?.state).toBe("awaiting_merge");
    expect(t2?.reviewRef ?? null).toBeNull(); // reviewRef untouched on the disabled path
  });

  it("ENABLED: the human merge on an awaiting_merge loop → CONVERGED and does NOT trigger a second review", async () => {
    const loop = makeLoop({ state: "awaiting_merge", round: 2, headCommitAtReview: "confirmedhead" });
    const { storage } = fakeStorage(loop);
    const { taskOrchestrator, sg } = orchestrator();
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: taskOrchestrator as never,
      config: makeConfig(true),
      readRepoHead: async () => "confirmedhead",
    });
    const res = await controller.onMergeApproved(loop.id);
    expect(res?.state).toBe("converged"); // FINAL ship — terminal
    expect(sg).not.toHaveBeenCalled(); // NO round-2 review dispatched
  });

  it("DISABLED: the human merge re-enters BUILDING_CONTEXT (today's re-review trigger, byte-identical)", async () => {
    const loop = makeLoop({ state: "awaiting_merge", round: 1, headCommitAtReview: "h" });
    const { storage } = fakeStorage(loop);
    const { taskOrchestrator } = orchestrator();
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: taskOrchestrator as never,
      config: makeConfig(false),
      readRepoHead: async () => "h",
    });
    const res = await controller.onMergeApproved(loop.id);
    expect(res?.state).toBe("building_context");
  });
});
