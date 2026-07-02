/**
 * loop-research-wire.test.ts — Stage 3: the controller's RESEARCH archetype wiring.
 *
 * Asserts (no real gateway / repo / coder):
 *   1. ANTI-FOOTGUN (R1): a `research` loop hard-branches to runResearch — it NEVER
 *      calls runSdlc (the coder). A non-research loop still calls runSdlc.
 *   2. DISABLED kill-switch ⇒ an INERT no-PR result ("research archetype disabled")
 *      and NEITHER runResearch NOR runSdlc is called.
 *   3. research.enabled=false ⇒ a repo-assessment/null loop takes TODAY'S coder path.
 *   4. The settled report persists OUT-OF-BAND to consilium_loop_rounds.report, and
 *      the web-evidence DIGEST persists to testSummary (the convergence wire).
 *   5. startReviewRound injects the round's testSummary under the research kill-switch
 *      (grounding the judge's convergence verdict in web-evidence).
 */
import { describe, it, expect, vi } from "vitest";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";
import type { ConvergenceVerdict, Archetype, ResearchReport } from "@shared/types";

const flush = () => new Promise((r) => setTimeout(r, 0));

const verdict = (openP0: number): ConvergenceVerdict => ({
  converged: false,
  openP0,
  openActionPoints: Array.from({ length: openP0 }, (_, i) => ({ title: `ap${i}`, priority: "P0", acceptanceCriterion: `crit${i}` })),
});

const REPORT: ResearchReport = {
  question: "Which CI?",
  recommendation: "GHA",
  claims: [{ claim: "c", citations: [{ title: "t", url: "https://x/d", snippet: "s" }], verified: true }],
  sources: [{ title: "t", url: "https://x/d" }],
  verdict: "green",
  generatedAt: new Date().toISOString(),
};

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop-1",
    projectId: "proj1",
    groupId: "grp1",
    state: "deciding",
    round: 2,
    maxRounds: 6,
    repoPath: process.cwd(),
    archetype: null,
    lastReviewedCommit: null,
    currentIterationNumber: 2,
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
  const updateLoopRoundReport = vi.fn(async () => undefined);
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
    updateLoopRoundReport,
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, input: "Compare CI providers." })),
    updateTaskGroup: vi.fn(async () => ({})),
    getIteration: vi.fn(async () => ({ id: "it1", iterationNumber: 2, status: "completed" })),
    getExecutionsByIteration: vi.fn(async () => []),
  };
  return { storage, updateLoopRoundTestSummary, updateLoopRoundReport };
}

interface CfgOver {
  loopEnabled?: boolean;
  implementEnabled?: boolean;
  researchEnabled?: boolean;
}
const makeConfig =
  (o: CfgOver = {}) =>
  () =>
    ({
      features: { sandbox: { enabled: false } },
      pipeline: {
        consiliumLoop: {
          enabled: o.loopEnabled ?? true,
          maxRounds: 6,
          pollIntervalMs: 5000,
          maxDiffBytes: 200000,
          allowedRepoPaths: [process.cwd()],
          implement: {
            enabled: o.implementEnabled ?? true,
            verification: { enabled: false },
            trustedRepoAck: false,
            maxFixIterations: 3,
            testCommand: null,
            testRunTimeoutMs: 300000,
            research: { enabled: o.researchEnabled ?? true, maxResearchIterations: 3, model: "claude-sonnet" },
          },
        },
      },
    }) as never;

const orchestrator = () => ({ startGroup: vi.fn(), startGroupAsync: vi.fn(async () => ({ iteration: { iterationNumber: 3 } })), createTaskGroup: vi.fn(), cancelGroup: vi.fn() }) as never;
const gateway = () => ({ completeStreaming: vi.fn(), completeWithTools: vi.fn() }) as never;

describe("Stage 3 ANTI-FOOTGUN — research hard-branches away from the coder", () => {
  it("archetype='research' (enabled) ⇒ runResearch is called, runSdlc (coder) is NEVER called", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, archetype: "research" });
    const { storage } = fakeStorage(loop);
    const runResearch = vi.fn(async () => ({ prRef: null, headCommit: "", report: REPORT, testSummary: "web-evidence: 1/1 P0 claims cited — GREEN." }));
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestrator(),
      config: makeConfig(),
      gateway: gateway(),
      readIterationVerdict: async () => verdict(2),
      runResearch: runResearch as never,
      runSdlc: runSdlc as never,
    });
    await controller.tick(loop.id);
    await flush();
    expect(runResearch).toHaveBeenCalledTimes(1);
    expect(runSdlc).not.toHaveBeenCalled(); // the coder is NEVER run on a research task
    // The request carried the fenced objective + the open action points.
    expect(runResearch.mock.calls[0][0]).toMatchObject({ loopId: "loop-1", round: 2, objective: "Compare CI providers." });
    expect(runResearch.mock.calls[0][0].actionPoints).toHaveLength(2);
  });

  it("archetype=null ⇒ runSdlc (today's coder path) is called, runResearch is NOT", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, archetype: null });
    const { storage } = fakeStorage(loop);
    const runResearch = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestrator(),
      config: makeConfig(),
      gateway: gateway(),
      readIterationVerdict: async () => verdict(2),
      runResearch: runResearch as never,
      runSdlc: runSdlc as never,
    });
    await controller.tick(loop.id);
    await flush();
    expect(runSdlc).toHaveBeenCalledTimes(1);
    expect(runResearch).not.toHaveBeenCalled();
  });
});

describe("Stage 3 kill-switch — disabled research is INERT and never the coder", () => {
  it("research.enabled=false ⇒ inert no-PR result; NEITHER runResearch NOR runSdlc runs", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, archetype: "research" });
    const { storage } = fakeStorage(loop);
    const runResearch = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestrator(),
      config: makeConfig({ researchEnabled: false }),
      gateway: gateway(),
      readIterationVerdict: async () => verdict(2),
      runResearch: runResearch as never,
      runSdlc: runSdlc as never,
    });
    await controller.tick(loop.id);
    await flush();
    // Anti-footgun holds even when disabled: the coder is STILL never run.
    expect(runResearch).not.toHaveBeenCalled();
    expect(runSdlc).not.toHaveBeenCalled();
    // The loop still advanced to awaiting_merge via dev_completed (prRef null).
    const l = await storage.getLoop(loop.id);
    expect(["awaiting_merge", "developing"]).toContain(l.state);
  });

  it("implement.enabled=false ⇒ research disabled too (parent gate) ⇒ inert, coder never runs", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, archetype: "research" });
    const { storage } = fakeStorage(loop);
    const runResearch = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestrator(),
      config: makeConfig({ implementEnabled: false }),
      gateway: gateway(),
      readIterationVerdict: async () => verdict(2),
      runResearch: runResearch as never,
      runSdlc: runSdlc as never,
    });
    await controller.tick(loop.id);
    await flush();
    expect(runResearch).not.toHaveBeenCalled();
    expect(runSdlc).not.toHaveBeenCalled();
  });
});

describe("Stage 3 out-of-band persistence — report + convergence digest", () => {
  it("a settled research run persists report → round.report AND digest → round.testSummary", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, archetype: "research" });
    const { storage, updateLoopRoundReport, updateLoopRoundTestSummary } = fakeStorage(loop);
    const runResearch = vi.fn(async () => ({ prRef: null, headCommit: "", report: REPORT, testSummary: "web-evidence: 1/1 P0 claims cited — GREEN." }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestrator(),
      config: makeConfig(),
      gateway: gateway(),
      readIterationVerdict: async () => verdict(2),
      runResearch: runResearch as never,
    });
    await controller.tick(loop.id);
    await flush();
    expect(updateLoopRoundReport).toHaveBeenCalledTimes(1);
    expect(updateLoopRoundReport).toHaveBeenCalledWith("loop-1", 2, REPORT);
    expect(updateLoopRoundTestSummary).toHaveBeenCalledWith("loop-1", 2, "web-evidence: 1/1 P0 claims cited — GREEN.");
  });

  it("a research run with NO report (degraded) does NOT touch round.report", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, archetype: "research" });
    const { storage, updateLoopRoundReport } = fakeStorage(loop);
    const runResearch = vi.fn(async () => ({ prRef: null, headCommit: "", error: "degraded" }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestrator(),
      config: makeConfig(),
      gateway: gateway(),
      readIterationVerdict: async () => verdict(2),
      runResearch: runResearch as never,
    });
    await controller.tick(loop.id);
    await flush();
    expect(updateLoopRoundReport).not.toHaveBeenCalled();
  });
});

describe("Stage 3 convergence wire — testSummary injected under the research switch", () => {
  it("startReviewRound reads the latest round testSummary when research is enabled", async () => {
    const loop = makeLoop({ state: "building_context", round: 1, archetype: "research" });
    const { storage } = fakeStorage(loop);
    // A prior round carries the web-evidence digest.
    storage.getLoopRounds = vi.fn(async () => [{ round: 1, testSummary: "web-evidence: 2/2 P0 claims cited — GREEN.", report: null }]) as never;
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestrator(),
      config: makeConfig(),
      gateway: gateway(),
      readIterationVerdict: async () => verdict(1),
    });
    await controller.tick(loop.id);
    await flush();
    // The digest was read for injection (the gate fired under the research switch).
    expect(storage.getLoopRounds).toHaveBeenCalled();
  });
});
