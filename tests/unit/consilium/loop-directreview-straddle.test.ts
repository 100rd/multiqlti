/**
 * loop-directreview-straddle.test.ts — B7 (Phase 2) capstone: the directReview kill-switch
 * straddle proven END-TO-END through `controller.tick()`.
 *
 * The straddle READS already landed in B4/B5/B6 and NONE consult the live flag on read
 * (dispatch keys off the flag; deriveReviewEvent keys off the reviewRuns ENTRY; resolveVerdict
 * keys off currentIterationNumber+participants). This file is the pure test proof:
 *   1. kill-switch parity SNAPSHOT — flag OFF ⇒ startGroupAsync + marker set, reviewRuns
 *      EMPTY, runReview NEVER called, full lifecycle byte-identical.
 *   2. mid-flip STRADDLE, BOTH directions — a round STARTED under one mode READS BACK under
 *      that mode even when the operator flips the flag mid-flight (inv #5: the read keys off
 *      the round's ACTUAL mode, never the live flag).
 *   3. single-verifier round>1 via `buildSingleVerifierTask` DIRECT (runner path) — ONE
 *      gateway call carrying the verifier prompt; round 1 is the full preset DAG (N calls).
 *
 * `config` is a live getter over a mutable flag closure, flipped BETWEEN ticks to simulate a
 * mid-flight toggle. Legacy dispatch runs the real `startReviewRound`→`buildDiffContext`, which
 * with `lastReviewedCommit=null` only resolves the committed HEAD ref (`revparse HEAD^{commit}`
 * — no collectDiff, no working-tree read → deterministic), the same pattern the B4 flag-OFF
 * test already relies on. `readRepoHead` is injected so recordRound never touches git.
 */
import { describe, it, expect, vi } from "vitest";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState, ConsiliumLoopRoundRow, InsertConsiliumLoopRound } from "@shared/schema";
import type { RoundVerdict, RoundParticipant, ActionPoint, ConvergenceVerdict } from "@shared/types";

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

const AP0: ActionPoint = { title: "fix the null deref", priority: "P0" } as ActionPoint;
const VERDICT: RoundVerdict = { verdict: "one P0 open", pros: [], cons: ["gap"], actionPoints: [AP0] };
const PARTS: RoundParticipant[] = [{ name: "rev-a", model: "claude-opus", role: "primary", text: "found it" }];
const CONVERGED: ConvergenceVerdict = { converged: true, openP0: 0, openActionPoints: [] };

/** Storage honouring the CAS + storing rounds with a real UNIQUE(loop,round) guard. */
function makeFakeStorage(loop: ConsiliumLoopRow, iter: { status: string }) {
  let current = loop;
  const roundRows: ConsiliumLoopRoundRow[] = [];
  const cas = vi.fn(
    async (id: string, expected: ConsiliumLoopState, next: ConsiliumLoopState, extra?: Record<string, unknown>) => {
      if (id !== current.id || current.state !== expected) return undefined;
      current = { ...current, ...(extra ?? {}), state: next };
      return current;
    },
  );
  const appendLoopRound = vi.fn(async (data: InsertConsiliumLoopRound) => {
    if (roundRows.some((r) => r.loopId === data.loopId && r.round === data.round)) {
      const err = new Error("consilium_loop_rounds_uq");
      (err as NodeJS.ErrnoException).code = "23505";
      throw err;
    }
    const row = { id: `r${roundRows.length}`, createdAt: new Date(), ...data } as ConsiliumLoopRoundRow;
    roundRows.push(row);
    return row;
  });
  const storage = {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => [...roundRows].sort((a, b) => a.round - b.round)),
    casLoopState: cas,
    claimRedrive: vi.fn(async () => undefined),
    appendLoopRound,
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, name: "[consilium-review:sdlc-cross-review] x", input: "the objective" })),
    updateTaskGroup: vi.fn(async () => ({})),
    getIteration: vi.fn(async () => (iter.status ? { id: "it", status: iter.status } : undefined)),
    getExecutionsByIteration: vi.fn(async () => []),
  };
  return { storage, get: () => current, rounds: () => roundRows };
}

const makeConfig = (flag: { on: boolean }) =>
  (() => ({
    pipeline: {
      taskGroups: { taskTimeoutMs: 300000, defaultModel: "claude-opus" },
      consiliumLoop: {
        enabled: true,
        maxRounds: 6,
        pollIntervalMs: 5000,
        maxDiffBytes: 200000,
        allowedRepoPaths: [process.cwd()],
        directReview: { enabled: flag.on }, // LIVE — re-read on every config() call
        implement: { enabled: false, verification: { enabled: false }, research: { enabled: false } },
      },
    },
    providers: {},
  })) as never;

const orchestrator = (startGroupAsync: unknown) =>
  ({ startGroup: startGroupAsync, startGroupAsync, createTaskGroup: vi.fn(), cancelGroup: vi.fn() }) as never;

const reviewRunsOf = (c: ConsiliumLoopController): Map<string, unknown> =>
  (c as unknown as { reviewRuns: Map<string, unknown> }).reviewRuns;

const flush = () => new Promise((r) => setImmediate(r));

describe("B7 — directReview kill-switch straddle proven end-to-end", () => {
  it("parity SNAPSHOT: flag OFF ⇒ startGroupAsync + marker set, reviewRuns EMPTY, runReview NEVER called (byte-identical legacy)", async () => {
    const flag = { on: false };
    const iter = { status: "" };
    const loop = makeLoop({ state: "building_context", round: 0 });
    const { storage, get, rounds } = makeFakeStorage(loop, iter);
    const startGroupAsync = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const runReview = vi.fn();
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestrator(startGroupAsync),
      config: makeConfig(flag),
      runReview: runReview as never,
      readRepoHead: async () => "HEADSHA",
      readIterationVerdict: async () => CONVERGED, // round-1 immediate convergence ⇒ terminal
    });

    await controller.tick(loop.id); // building_context → reviewing (LEGACY dispatch)
    expect(get().state).toBe("reviewing");
    expect(get().currentIterationNumber).toBe(1); // legacy marker set
    expect(startGroupAsync).toHaveBeenCalledTimes(1);
    expect(reviewRunsOf(controller).size).toBe(0); // NO runner entry

    iter.status = "completed";
    await controller.tick(loop.id); // reviewing → deciding (via the ITERATION)
    expect(get().state).toBe("deciding");
    await controller.tick(loop.id); // deciding → converged (terminal)
    expect(get().state).toBe("converged");

    expect(runReview).not.toHaveBeenCalled(); // the runner is NEVER touched under flag OFF
    expect(reviewRunsOf(controller).size).toBe(0); // reviewRuns stays empty the whole lifecycle
    expect(rounds()).toHaveLength(1);
    expect(rounds()[0].participants ?? null).toBeNull(); // legacy round ⇒ no participants
  });

  it("mid-flip ON→OFF: a RUNNER-dispatched round reads back via the ENTRY after the flag flips OFF", async () => {
    const flag = { on: true };
    const iter = { status: "" };
    const loop = makeLoop({ state: "building_context", round: 0 });
    const { storage, get, rounds } = makeFakeStorage(loop, iter);
    const startGroupAsync = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const runReview = vi.fn(async () => ({
      converged: false, openP0: 1, openActionPoints: [AP0], verdict: VERDICT, participants: PARTS,
    }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestrator(startGroupAsync),
      config: makeConfig(flag),
      runReview: runReview as never,
      readRepoHead: async () => "HEADSHA",
    });

    await controller.tick(loop.id); // building_context → reviewing (RUNNER dispatch, flag ON)
    expect(get().state).toBe("reviewing");
    expect(get().currentIterationNumber ?? null).toBeNull(); // runner marker: NO iteration
    expect(startGroupAsync).not.toHaveBeenCalled(); // ZERO task-group iterations
    expect(runReview).toHaveBeenCalledTimes(1);
    await flush(); // let the fire-and-forget runner settle into reviewRuns
    expect(reviewRunsOf(controller).get(loop.id)).toMatchObject({ round: 1, done: true });

    flag.on = false; // ── OPERATOR FLIPS THE FLAG OFF MID-FLIGHT ──

    const res = await controller.tick(loop.id); // reviewing → deciding VIA THE ENTRY (runner)
    expect(res?.state).toBe("deciding");
    // Read back under the RUNNER despite flag OFF: the round carries participants, and the
    // legacy startGroupAsync was NEVER called.
    expect(rounds()).toHaveLength(1);
    expect(rounds()[0].participants).toEqual(PARTS);
    expect(startGroupAsync).not.toHaveBeenCalled();
    expect(reviewRunsOf(controller).get(loop.id)).toBeUndefined(); // consumed + dropped
  });

  it("mid-flip OFF→ON: a LEGACY-dispatched round reads back via the ITERATION after the flag flips ON", async () => {
    const flag = { on: false };
    const iter = { status: "" };
    const loop = makeLoop({ state: "building_context", round: 0 });
    const { storage, get, rounds } = makeFakeStorage(loop, iter);
    const startGroupAsync = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const runReview = vi.fn(); // MUST never be called
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestrator(startGroupAsync),
      config: makeConfig(flag),
      runReview: runReview as never,
      readRepoHead: async () => "HEADSHA",
      readIterationVerdict: async () => CONVERGED,
    });

    await controller.tick(loop.id); // building_context → reviewing (LEGACY dispatch, flag OFF)
    expect(get().state).toBe("reviewing");
    expect(get().currentIterationNumber).toBe(1); // legacy marker set
    expect(startGroupAsync).toHaveBeenCalledTimes(1);
    expect(reviewRunsOf(controller).size).toBe(0); // NO runner entry

    flag.on = true; // ── OPERATOR FLIPS THE FLAG ON MID-FLIGHT ──
    iter.status = "completed";

    await controller.tick(loop.id); // reviewing → deciding VIA THE ITERATION (legacy)
    expect(get().state).toBe("deciding");
    await controller.tick(loop.id); // deciding → converged (terminal)
    expect(get().state).toBe("converged");

    // Read back under LEGACY despite flag ON: the runner was NEVER dispatched, no entry ever
    // existed, and the round carries NO participants.
    expect(runReview).not.toHaveBeenCalled();
    expect(reviewRunsOf(controller).size).toBe(0);
    expect(rounds()).toHaveLength(1);
    expect(rounds()[0].participants ?? null).toBeNull();
  });
});

// ─── single-verifier round>1 via the RUNNER path (buildSingleVerifierTask DIRECT) ───────

/** A verifier/judge reply in the canonical execution.output shape (mirrors review-runner.test). */
const judgeReply = (converged: boolean, openP0: number): string =>
  JSON.stringify({
    summary: "verifier summary",
    output: {
      verdict: "the verdict", pros: [], cons: [],
      action_points: openP0 > 0 ? [{ title: "fix it", priority: "P0" }] : [],
      convergence: { converged, open_p0: openP0, open_action_points: openP0 > 0 ? [{ title: "fix it", priority: "P0" }] : [] },
    },
  });

/** Controller wired for a DIRECT runReviewFromLoop call — fake gateway captures the prompts.
 *  Deterministic: lastReviewedCommit=null ⇒ buildDiffContext resolves only the committed HEAD
 *  ref (revparse HEAD^{commit}); no collectDiff, no working-tree read. */
function makeRunnerController(systems: string[]) {
  const storage = {
    getLoopRounds: vi.fn(async () => []),
    getTaskGroup: vi.fn(async () => ({ id: "grp1", name: "[consilium-review:sdlc-cross-review] x", input: "the objective" })),
    getActiveModels: vi.fn(async () => []),
  };
  const gateway = {
    completeStreaming: vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
      systems.push(req.messages.find((m) => m.role === "system")?.content ?? "");
      return { content: judgeReply(false, 1) };
    }),
  };
  const controller = new ConsiliumLoopController({
    storage: storage as never,
    taskOrchestrator: orchestrator(vi.fn()),
    config: makeConfig({ on: true }),
    gateway: gateway as never,
  });
  return { controller, gateway };
}
type RunnerPriv = { runReviewFromLoop(loop: ConsiliumLoopRow): Promise<{ converged: boolean; openP0: number; error?: string }> };

describe("B7 — single-verifier round>1 runs buildSingleVerifierTask DIRECT (runner path)", () => {
  it("round > 1 + single-verifier ⇒ EXACTLY ONE gateway call carrying the Verifier prompt", async () => {
    const systems: string[] = [];
    const { controller, gateway } = makeRunnerController(systems);
    const loop = makeLoop({ round: 2, reviewMode: "single-verifier", lastReviewedCommit: null, reviewRef: null });

    const r = await (controller as unknown as RunnerPriv).runReviewFromLoop(loop);

    expect(r.error).toBeUndefined();
    expect(gateway.completeStreaming).toHaveBeenCalledTimes(1); // ONE task, not the DAG
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain("Your specific task: Verifier"); // buildSingleVerifierTask, direct
    // The verifier output feeds convergence via VERIFIER_TASK_NAME as the judge.
    expect(r.converged).toBe(false);
    expect(r.openP0).toBe(1);
  });

  it("round 1 is ALWAYS the full preset DAG (N gateway calls) — NEVER the single verifier", async () => {
    const systems: string[] = [];
    const { controller, gateway } = makeRunnerController(systems);
    // Same single-verifier mode, but round 1 ⇒ the `round > 1` guard forces the full DAG.
    const loop = makeLoop({ round: 1, reviewMode: "single-verifier", lastReviewedCommit: null, reviewRef: null });

    await (controller as unknown as RunnerPriv).runReviewFromLoop(loop);

    expect((gateway.completeStreaming as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    expect(systems.some((s) => s.includes("Your specific task: Verifier"))).toBe(false); // no lone verifier
  });
});
