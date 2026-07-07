/**
 * loop-round-persist-failure.test.ts — regression coverage for the silent
 * round-audit failure: `recordRound()` (consilium-loop-controller.ts) used to
 * do `.appendLoopRound({...}).catch(() => undefined)`, swallowing EVERY insert
 * error — not just the expected `UNIQUE(loop,round)` re-tick conflict. That
 * left `consilium_loop_rounds` silently empty on any transient storage error
 * (a dropped connection, a serialization failure, disk full, …), so the loop
 * detail page rendered blank with `loop.error` empty even though a Judge had
 * produced a real verdict.
 *
 * The fix must:
 *   - swallow ONLY the `consilium_loop_rounds_uq` unique-conflict (idempotent
 *     re-tick / redrive) — in BOTH the Postgres shape (`err.code === "23505"`
 *     + the constraint name in the message) and the `MemStorage` shape (a
 *     bare `Error("consilium_loop_rounds_uq")`, no `.code` — see
 *     server/storage.ts:1956-1962), matching the detection convention already
 *     used in server/routes/model-skill-bindings.ts:115.
 *   - surface every OTHER insert failure: log it and set `loop.error`, without
 *     blocking the FSM transition itself (fail-open on state, fail-loud on the
 *     audit row).
 *
 * These tests drive the controller through the PUBLIC `tick()` entry point
 * (never the private `recordRound`), so they also prove the fix survives
 * `tick()`'s own follow-up `updateLoop(won.id, extra)` merge
 * (consilium-loop-controller.ts:1340-1342) — i.e. whichever call actually
 * persists `loop.error`, the final row must carry it.
 *
 * STOPPED_CAP note: this used to be a SEPARATE gap (flagged to the team while
 * writing this file) — `STOPPED_CAP` is committed via an early-exit in
 * `tickInner()` (~L1310-1318) that returns directly from `commit()`, so it
 * never reached `runSideEffect()`/`recordRound()` at all, independent of the
 * swallow bug. Fixed in 929aa8c ("record the round on the stopped_cap cap
 * early-exit"), so it's covered as a normal case below alongside the other
 * three decided outcomes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";
import type { ConvergenceVerdict } from "@shared/types";

const verdict = (converged: boolean, openP0: number): ConvergenceVerdict => ({
  converged,
  openP0,
  openActionPoints: Array.from({ length: openP0 }, (_, i) => ({
    title: `ap${i}`,
    priority: "P0",
  })),
});

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop1",
    groupId: "grp1",
    state: "deciding",
    round: 2,
    maxRounds: 6,
    repoPath: process.cwd(),
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

/**
 * Same shape as `makeFakeStorage` in loop-fsm.test.ts, with an OVERRIDABLE
 * `appendLoopRound` so each test can inject a specific failure. `getLoop()`
 * (via `get()`) always reflects the LATEST merge from either `casLoopState`
 * or `updateLoop` — so asserting against `get()` is robust to whichever of
 * the two the fix uses to persist `loop.error` (a direct `updateLoop` inside
 * `recordRound`'s catch, or folding it into the transition's returned
 * `extra`); we deliberately do NOT assert on `tick()`'s return value alone.
 */
function makeFakeStorage(
  loop: ConsiliumLoopRow,
  rounds: { round: number; openP0: number }[] = [],
) {
  let current = loop;
  const cas = vi.fn(
    async (
      id: string,
      expected: ConsiliumLoopState,
      next: ConsiliumLoopState,
      extra?: Record<string, unknown>,
    ) => {
      if (id !== current.id || current.state !== expected) return undefined;
      current = { ...current, ...(extra ?? {}), state: next };
      return current;
    },
  );
  const storage = {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => rounds.map((r) => ({ ...r }))),
    casLoopState: cas,
    claimRedrive: vi.fn(async () => undefined),
    appendLoopRound: vi.fn(async () => ({})),
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, input: "objective" })),
    updateTaskGroup: vi.fn(async () => ({})),
    createTaskGroup: vi.fn(async () => ({ group: { id: "devgrp" } })),
    getIteration: vi.fn(async () => ({
      id: "it1",
      iterationNumber: current.currentIterationNumber ?? 1,
      status: "completed",
    })),
    getExecutionsByIteration: vi.fn(async () => []),
  };
  return { storage, cas, get: () => current };
}

const fakeConfig = () =>
  ({
    pipeline: {
      consiliumLoop: {
        enabled: true,
        maxRounds: 6,
        pollIntervalMs: 5000,
        maxDiffBytes: 200000,
        allowedRepoPaths: [process.cwd()],
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

/** Postgres-realistic unique-violation shape (server/routes/model-skill-bindings.ts:115). */
const pgUniqueErr = () =>
  Object.assign(
    new Error('duplicate key value violates unique constraint "consilium_loop_rounds_uq"'),
    { code: "23505" },
  );
/** The EXACT shape MemStorage.appendLoopRound throws today (storage.ts:1956-1962) — no `.code`. */
const memUniqueErr = () => new Error("consilium_loop_rounds_uq");
/** A genuinely transient, non-conflict failure (dropped connection, disk full, …). */
const transientErr = () => new Error("connection terminated unexpectedly");

describe("recordRound — a non-unique appendLoopRound failure MUST surface (not be swallowed)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("CONVERGED: transition still completes, but loop.error is set + the failure is logged", async () => {
    const loop = makeLoop({ round: 2, maxRounds: 6, currentIterationNumber: 2, error: null });
    const { storage, get } = makeFakeStorage(loop, [{ round: 1, openP0: 1 }]);
    storage.appendLoopRound.mockRejectedValue(transientErr());
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: {
        startGroup: vi.fn(),
        startGroupAsync: vi.fn(),
        createTaskGroup: vi.fn(),
        cancelGroup: vi.fn(),
      } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(true, 0),
    });

    const res = await controller.tick(loop.id);

    // The FSM transition itself must NOT be blocked by the audit-write failure.
    expect(res?.state).toBe("converged");
    expect(storage.appendLoopRound).toHaveBeenCalledTimes(1);

    // The failure must surface on the loop, never vanish silently.
    const persisted = get();
    expect(persisted.error).toBeTruthy();
    expect(persisted.error).toMatch(/round|persist|append/i);

    // ...and be logged (this.log()'s `console.log` convention, consilium-loop-controller.ts:792-795).
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(loop.id));
  });

  it("ESCALATED (anti-stall): transition still completes, loop.error is set + logged", async () => {
    const loop = makeLoop({ round: 3, maxRounds: 6, currentIterationNumber: 3, error: null });
    const { storage, get } = makeFakeStorage(loop, [
      { round: 1, openP0: 3 },
      { round: 2, openP0: 3 },
    ]);
    storage.appendLoopRound.mockRejectedValue(transientErr());
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: {
        startGroup: vi.fn(),
        startGroupAsync: vi.fn(),
        createTaskGroup: vi.fn(),
        cancelGroup: vi.fn(),
      } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 3), // flat at 3 → anti-stall
    });

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("escalated");
    expect(storage.appendLoopRound).toHaveBeenCalledTimes(1);
    const persisted = get();
    expect(persisted.error).toBeTruthy();
    expect(persisted.error).toMatch(/round|persist|append/i);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(loop.id));
  });

  it("DEVELOPING: transition still completes (coder still dispatches), loop.error is set + logged", async () => {
    const loop = makeLoop({ round: 2, maxRounds: 6, currentIterationNumber: 2, error: null });
    const { storage, get } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    storage.appendLoopRound.mockRejectedValue(transientErr());
    const runCloseout = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: {
        startGroup: vi.fn(),
        startGroupAsync: vi.fn(),
        createTaskGroup: vi.fn(),
        cancelGroup: vi.fn(),
      } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2), // open P0s, room left → DEVELOPING
      runCloseout,
    });

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("developing");
    expect(storage.appendLoopRound).toHaveBeenCalledTimes(1);
    const persisted = get();
    expect(persisted.error).toBeTruthy();
    expect(persisted.error).toMatch(/round|persist|append/i);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(loop.id));
  });

  // Fixed in 929aa8c ("record the round on the stopped_cap cap early-exit") —
  // see the file header note. The cap-precedence early-exit in `tickInner()`
  // now calls `recordRound` on the CAS winner before returning, mirroring the
  // converged/escalated terminal exits.
  it("STOPPED_CAP (cap round, open P0s): a round IS recorded and a persist failure surfaces the same way", async () => {
    const loop = makeLoop({ round: 6, maxRounds: 6, currentIterationNumber: 6, error: null });
    const { storage, get } = makeFakeStorage(loop, [
      { round: 1, openP0: 3 },
      { round: 2, openP0: 2 },
    ]);
    storage.appendLoopRound.mockRejectedValue(transientErr());
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: {
        startGroup: vi.fn(),
        startGroupAsync: vi.fn(),
        createTaskGroup: vi.fn(),
        cancelGroup: vi.fn(),
      } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2), // still open → cap binds
    });

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("stopped_cap");
    expect(storage.appendLoopRound).toHaveBeenCalledTimes(1);
    const persisted = get();
    expect(persisted.error).toBeTruthy();
    expect(persisted.error).toMatch(/round|persist|append/i);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(loop.id));
  });
});

describe("recordRound — UNIQUE(loop,round) conflict stays a silent, idempotent no-op", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("Postgres-shaped conflict (code 23505 + constraint name): transition completes, loop.error UNCHANGED", async () => {
    const loop = makeLoop({ round: 2, maxRounds: 6, currentIterationNumber: 2, error: null });
    const { storage, get } = makeFakeStorage(loop, [{ round: 1, openP0: 1 }]);
    storage.appendLoopRound.mockRejectedValue(pgUniqueErr());
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: {
        startGroup: vi.fn(),
        startGroupAsync: vi.fn(),
        createTaskGroup: vi.fn(),
        cancelGroup: vi.fn(),
      } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(true, 0),
    });

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("converged");
    expect(get().error).toBeNull(); // NOT clobbered — a duplicate re-tick is a true no-op
  });

  it("MemStorage-shaped conflict (bare Error, no `.code`): transition completes, loop.error UNCHANGED", async () => {
    // The exact shape MemStorage.appendLoopRound throws today (storage.ts:1956-1962).
    // A fix that only checks `err.code === "23505"` would MISS this and misclassify
    // every dev/in-memory-mode re-tick as a surfaced failure.
    const loop = makeLoop({ round: 2, maxRounds: 6, currentIterationNumber: 2, error: null });
    const { storage, get } = makeFakeStorage(loop, [{ round: 1, openP0: 1 }]);
    storage.appendLoopRound.mockRejectedValue(memUniqueErr());
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: {
        startGroup: vi.fn(),
        startGroupAsync: vi.fn(),
        createTaskGroup: vi.fn(),
        cancelGroup: vi.fn(),
      } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(true, 0),
    });

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("converged");
    expect(get().error).toBeNull();
  });

  it("a genuine re-tick of an ALREADY-recorded round (redrive/CAS-race replay) is a true no-op", async () => {
    // Round 1 already succeeded once (simulated: appendLoopRound resolves on the
    // FIRST call, then throws the unique conflict on every subsequent call for the
    // same round) — a second tick for the SAME decided round must not surface an
    // error or duplicate anything.
    const loop = makeLoop({ round: 2, maxRounds: 6, currentIterationNumber: 2, error: null, state: "deciding" });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 1 }]);
    storage.appendLoopRound.mockResolvedValueOnce({} as never).mockRejectedValue(memUniqueErr());
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: {
        startGroup: vi.fn(),
        startGroupAsync: vi.fn(),
        createTaskGroup: vi.fn(),
        cancelGroup: vi.fn(),
      } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(true, 0),
    });

    const first = await controller.tick(loop.id);
    expect(first?.state).toBe("converged");
    expect(first?.error ?? null).toBeNull();
    // A second tick on an already-terminal (converged) loop is a straight no-op
    // (isTerminal short-circuits in tickInner) — appendLoopRound must not be
    // called again, and error stays untouched either way.
    const second = await controller.tick(loop.id);
    expect(second).toBeNull();
    expect(storage.appendLoopRound).toHaveBeenCalledTimes(1);
  });
});

describe("deciding — an unresolvable/malformed judge verdict no-ops cleanly (no round recorded)", () => {
  it("tick() returns null; appendLoopRound and casLoopState are never called", async () => {
    const loop = makeLoop({ round: 2, maxRounds: 6, currentIterationNumber: 2, state: "deciding" });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 1 }]);
    // No `readIterationVerdict` injected → falls back to the default
    // getIteration/getExecutionsByIteration/pickJudgeOutput path; the fake's
    // getExecutionsByIteration resolves `[]`, so pickJudgeOutput returns
    // undefined and resolveVerdict/deriveDecideEvent resolve null.
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: {
        startGroup: vi.fn(),
        startGroupAsync: vi.fn(),
        createTaskGroup: vi.fn(),
        cancelGroup: vi.fn(),
      } as never,
      config: fakeConfig,
    });

    const res = await controller.tick(loop.id);

    expect(res).toBeNull();
    expect(storage.appendLoopRound).not.toHaveBeenCalled();
    expect(storage.casLoopState).not.toHaveBeenCalled();
  });
});
