/**
 * loop-autoplan-develop.test.ts — finding #8: the intent planner must run BEFORE the
 * develop dispatch so the AUTOMATIC deciding→developing transition (and a human
 * POST /:id/develop from a verdict-terminal state) engages the SKILLED implement path
 * instead of the legacy unskilled single-coder path.
 *
 * Live evidence: loop 83190a0e (maxRounds=2) auto-entered `developing` with
 * archetype=None/source=None — the planner was reachable ONLY via the manual
 * POST /:id/plan, so any maxRounds>1 loop that auto-developed skipped it entirely.
 *
 * We drive the REAL controller (fake storage + injected `readIterationVerdict`,
 * `readRepoHead`, `runSdlc`, and a fake planner gateway) and assert what the SDLC
 * executor seam (`runSdlc`) receives — its `archetype` input is exactly what
 * `selectSkillSet` keys off inside the executor.
 */
import { describe, it, expect, vi } from "vitest";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { PlannerGateway } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";
import type { ConvergenceVerdict } from "@shared/types";

const flush = () => new Promise((r) => setTimeout(r, 0));

const JUDGE_WITH_APS = {
  verdict: "needs work",
  action_points: [
    { title: "DEV AP1", priority: "P0", acceptanceCriterion: "When built, then green CI" },
    { title: "DEV AP2", priority: "P2" },
  ],
};

const verdict = (openP0: number): ConvergenceVerdict => ({
  converged: false,
  openP0,
  openActionPoints: Array.from({ length: openP0 }, (_, i) => ({ title: `ap${i}`, priority: "P0" })),
});

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
    reviewRef: null,
    engineerInstruction: null,
    archetype: null,
    archetypeSource: null,
    archetypeRationale: null,
    archetypeParams: null,
    archetypeDecidedAt: null,
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

/** Fake storage — mutable `current` row, generic CAS, and the planner write. */
function fakeStorage(loop: ConsiliumLoopRow, over: { activeLoop?: unknown } = {}) {
  let current = loop;
  const updateLoopArchetypeIfNotOverridden = vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
    if (current.archetypeSource === "override") return undefined;
    current = { ...current, ...(extra ?? {}) };
    return current;
  });
  const storage = {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => []),
    getActiveLoopByGroup: vi.fn(async () => over.activeLoop ?? null),
    getWorkspaces: vi.fn(async () => [{ path: process.cwd() }]),
    casLoopState: vi.fn(async (id: string, expected: ConsiliumLoopState, next: ConsiliumLoopState, extra?: Record<string, unknown>) => {
      if (id !== current.id || current.state !== expected) return undefined;
      current = { ...current, ...(extra ?? {}), state: next };
      return current;
    }),
    claimRedrive: vi.fn(async () => undefined),
    appendLoopRound: vi.fn(async () => ({})),
    updateLoopRoundActionPoints: vi.fn(async () => undefined),
    updateLoopRoundTestSummary: vi.fn(async () => undefined),
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
    updateLoopArchetypeIfNotOverridden,
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, input: "objective" })),
    updateTaskGroup: vi.fn(async () => ({})),
    getIteration: vi.fn(async () => ({ id: "it1", iterationNumber: 2, status: "completed" })),
    getExecutionsByIteration: vi.fn(async () => [{ output: JUDGE_WITH_APS }]),
  };
  return { storage, updateLoopArchetypeIfNotOverridden, get: () => current };
}

interface CfgOpts {
  plannerEnabled?: boolean;
  model?: string;
}
const makeConfig =
  (opts: CfgOpts = {}) =>
  () =>
    ({
      features: { sandbox: { enabled: false } },
      providers: {},
      pipeline: {
        taskGroups: { taskTimeoutMs: 600000 },
        consiliumLoop: {
          enabled: true,
          maxRounds: 6,
          pollIntervalMs: 5000,
          maxDiffBytes: 200000,
          allowedRepoPaths: [process.cwd()],
          sdlcTimeoutMs: 1200000,
          planner: {
            enabled: opts.plannerEnabled ?? true,
            model: opts.model ?? "claude-sonnet",
            criteriaQa: { enabled: false },
          },
          implement: {
            enabled: true,
            verification: { enabled: false },
            trustedRepoAck: false,
            maxFixIterations: 3,
            testCommand: null,
            testRunTimeoutMs: 300000,
            lintCommand: null,
            perCriterionMethod: { enabled: false, judgeModel: "claude-sonnet" },
            finalVerification: { enabled: false, maxFinalFixIterations: 1 },
            research: { enabled: false },
          },
        },
      },
    }) as never;

function fakeGateway(content: string | (() => never)): { gateway: PlannerGateway; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => {
    if (typeof content === "function") return content();
    return { content };
  });
  return { gateway: { completeStreaming: spy } as unknown as PlannerGateway, spy };
}

function makeController(opts: {
  storage: unknown;
  gateway?: PlannerGateway;
  runSdlc: ReturnType<typeof vi.fn>;
  cfg?: CfgOpts;
}) {
  return new ConsiliumLoopController({
    storage: opts.storage as never,
    taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
    config: makeConfig(opts.cfg),
    readIterationVerdict: async () => verdict(2),
    readRepoHead: async () => "headsha",
    runSdlc: opts.runSdlc as never,
    gateway: opts.gateway,
  });
}

const PROPOSAL = JSON.stringify({ archetype: "infra", rationale: "needs terraform + k8s", params: { cloud: "aws" } });

// ─── Auto-transition (deciding→developing via tick) ──────────────────────────

describe("finding #8 — the AUTOMATIC deciding→developing path plans before dispatch", () => {
  it("runs the planner FIRST, then dispatches the SKILLED coder (runSdlc gets the archetype)", async () => {
    const loop = makeLoop({ state: "deciding", archetype: null });
    const { storage, updateLoopArchetypeIfNotOverridden } = fakeStorage(loop);
    const { gateway, spy } = fakeGateway(PROPOSAL);
    const runSdlc = vi.fn(async () => ({ prRef: "https://github.com/x/y/pull/1", headCommit: "abc" }));
    const controller = makeController({ storage, gateway, runSdlc });

    await controller.tick(loop.id); // deciding → developing → plan → dispatch
    await flush(); // let the fire-and-forget closeout settle

    // The planner ran once on the configured planner model…
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as { modelSlug: string }).modelSlug).toBe("claude-sonnet");
    // …the archetype was persisted proposed…
    expect(updateLoopArchetypeIfNotOverridden).toHaveBeenCalledTimes(1);
    const wrote = updateLoopArchetypeIfNotOverridden.mock.calls[0][1] as Record<string, unknown>;
    expect(wrote.archetype).toBe("infra");
    expect(wrote.archetypeSource).toBe("proposed");
    // …and the SDLC executor received it (this is what selectSkillSet keys off).
    expect(runSdlc).toHaveBeenCalledTimes(1);
    expect(runSdlc.mock.calls[0][0].archetype).toBe("infra");
    expect(runSdlc.mock.calls[0][0].archetypeParams).toEqual({ cloud: "aws" });
  });

  it("FAIL-SOFT: an unparseable planner reply → UNSKILLED dispatch (archetype null) + a visible note", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const loop = makeLoop({ state: "deciding", archetype: null });
    const { storage, updateLoopArchetypeIfNotOverridden } = fakeStorage(loop);
    const { gateway, spy } = fakeGateway("I reckon this one is infra, honestly.");
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = makeController({ storage, gateway, runSdlc });

    await controller.tick(loop.id);
    await flush();

    expect(spy).toHaveBeenCalledTimes(1); // planner ran…
    expect(updateLoopArchetypeIfNotOverridden).not.toHaveBeenCalled(); // …but wrote nothing
    expect(runSdlc).toHaveBeenCalledTimes(1);
    expect(runSdlc.mock.calls[0][0].archetype).toBeNull(); // UNSKILLED fallback
    // The operator can SEE the fallback (research-preflight fail-soft convention).
    expect(log.mock.calls.some((c) => String(c[0]).includes("UNSKILLED fallback"))).toBe(true);
    log.mockRestore();
  });

  it("FAIL-SOFT: a planner gateway ERROR does not throw and dispatches UNSKILLED", async () => {
    const loop = makeLoop({ state: "deciding", archetype: null });
    const { storage, updateLoopArchetypeIfNotOverridden } = fakeStorage(loop);
    const { gateway } = fakeGateway(() => {
      throw new Error("boom");
    });
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = makeController({ storage, gateway, runSdlc });

    await controller.tick(loop.id);
    await flush();

    expect(updateLoopArchetypeIfNotOverridden).not.toHaveBeenCalled();
    expect(runSdlc).toHaveBeenCalledTimes(1);
    expect(runSdlc.mock.calls[0][0].archetype).toBeNull();
  });

  it("OVERRIDE respected: a pre-develop engineer override is NEVER re-planned or clobbered", async () => {
    const loop = makeLoop({ state: "deciding", archetype: "infra", archetypeSource: "override" });
    const { storage, updateLoopArchetypeIfNotOverridden } = fakeStorage(loop);
    const { gateway, spy } = fakeGateway(JSON.stringify({ archetype: "research", rationale: "x" }));
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = makeController({ storage, gateway, runSdlc });

    await controller.tick(loop.id);
    await flush();

    expect(spy).not.toHaveBeenCalled(); // planner SKIPPED (archetype already decided)
    expect(updateLoopArchetypeIfNotOverridden).not.toHaveBeenCalled();
    expect(runSdlc.mock.calls[0][0].archetype).toBe("infra"); // the override drives dispatch
  });

  it("IDEMPOTENT: a prior 'proposed' archetype (e.g. after a crash-redrive) is not re-planned", async () => {
    const loop = makeLoop({ state: "deciding", archetype: "infra", archetypeSource: "proposed" });
    const { storage, updateLoopArchetypeIfNotOverridden } = fakeStorage(loop);
    const { gateway, spy } = fakeGateway(PROPOSAL);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = makeController({ storage, gateway, runSdlc });

    await controller.tick(loop.id);
    await flush();

    expect(spy).not.toHaveBeenCalled();
    expect(updateLoopArchetypeIfNotOverridden).not.toHaveBeenCalled();
    expect(runSdlc.mock.calls[0][0].archetype).toBe("infra");
  });

  it("planner.enabled=false ⇒ BYTE-IDENTICAL to today: no planner call, UNSKILLED dispatch, no note", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const loop = makeLoop({ state: "deciding", archetype: null });
    const { storage, updateLoopArchetypeIfNotOverridden } = fakeStorage(loop);
    const { gateway, spy } = fakeGateway(PROPOSAL);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = makeController({ storage, gateway, runSdlc, cfg: { plannerEnabled: false } });

    await controller.tick(loop.id);
    await flush();

    expect(spy).not.toHaveBeenCalled();
    expect(updateLoopArchetypeIfNotOverridden).not.toHaveBeenCalled();
    expect(runSdlc.mock.calls[0][0].archetype).toBeNull();
    // No auto-plan note is emitted when the kill-switch is off (path untouched).
    expect(log.mock.calls.some((c) => String(c[0]).includes("auto-plan before develop"))).toBe(false);
    log.mockRestore();
  });

  it("planner enabled but NO gateway wired ⇒ UNSKILLED dispatch (planner treated as disabled)", async () => {
    const loop = makeLoop({ state: "deciding", archetype: null });
    const { storage, updateLoopArchetypeIfNotOverridden } = fakeStorage(loop);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = makeController({ storage, gateway: undefined, runSdlc });

    await controller.tick(loop.id);
    await flush();

    expect(updateLoopArchetypeIfNotOverridden).not.toHaveBeenCalled();
    expect(runSdlc.mock.calls[0][0].archetype).toBeNull();
  });
});

// ─── Manual POST /:id/develop (verdict-terminal → developing) ────────────────

describe("finding #8 — the manual develop() path from a terminal state ALSO plans first", () => {
  it("a human re-open of a CONVERGED loop with null archetype runs the planner, then dispatches SKILLED", async () => {
    const loop = makeLoop({ state: "converged", archetype: null });
    const { storage, updateLoopArchetypeIfNotOverridden } = fakeStorage(loop);
    const { gateway, spy } = fakeGateway(PROPOSAL);
    const runSdlc = vi.fn(async () => ({ prRef: "https://github.com/x/y/pull/9", headCommit: "abc" }));
    const controller = makeController({ storage, gateway, runSdlc });

    const res = await controller.develop(loop.id);
    await flush();

    expect(res.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1); // planner ran on the manual path too
    expect(updateLoopArchetypeIfNotOverridden).toHaveBeenCalledTimes(1);
    expect(runSdlc).toHaveBeenCalledTimes(1);
    expect(runSdlc.mock.calls[0][0].archetype).toBe("infra");
  });

  it("a human re-open with a pre-set override dispatches on the override — no planner call", async () => {
    const loop = makeLoop({ state: "converged", archetype: "infra", archetypeSource: "override" });
    const { storage } = fakeStorage(loop);
    const { gateway, spy } = fakeGateway(JSON.stringify({ archetype: "research", rationale: "x" }));
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = makeController({ storage, gateway, runSdlc });

    const res = await controller.develop(loop.id);
    await flush();

    expect(res.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(runSdlc.mock.calls[0][0].archetype).toBe("infra");
  });
});
