/**
 * loop-fsm.test.ts — B.7 unit coverage for the PURE consilium-loop reducer
 * (design §3 transition table) + the controller's tick over a fake storage +
 * fake orchestrator. The orchestrator fake ASSERTS startGroup is CALLED (it does
 * not really run a consilium round). The CAS no-op (H-3) and cap/anti-stall/
 * converged precedence are all exercised here.
 */
import { describe, it, expect, vi } from "vitest";
import {
  reduce,
  isAntiStall,
  pickJudgeOutput,
  ConsiliumLoopController,
  MAX_CONCURRENT_DEV_HANDOFFS,
  SDLC_DEV_REDRIVE_GRACE_MS,
  type LoopEvent,
} from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopState, ConsiliumLoopRow } from "@shared/schema";
import type { ConvergenceVerdict } from "@shared/types";

const verdict = (converged: boolean, openP0: number): ConvergenceVerdict => ({
  converged,
  openP0,
  openActionPoints: Array.from({ length: openP0 }, (_, i) => ({
    title: `ap${i}`,
    priority: "P0",
  })),
});

// ─── PURE reducer: every §3 transition row ──────────────────────────────────

describe("reduce — design §3 transition table", () => {
  const rows: Array<{ name: string; from: ConsiliumLoopState; event: LoopEvent; to: ConsiliumLoopState | null }> = [
    { name: "PENDING + start → BUILDING_CONTEXT", from: "pending", event: { kind: "start" }, to: "building_context" },
    { name: "BUILDING_CONTEXT + context_built → REVIEWING", from: "building_context", event: { kind: "context_built" }, to: "reviewing" },
    { name: "REVIEWING + review_completed → DECIDING", from: "reviewing", event: { kind: "review_completed", verdict: verdict(false, 1) }, to: "deciding" },
    { name: "REVIEWING + review_failed → FAILED", from: "reviewing", event: { kind: "review_failed", error: "x" }, to: "failed" },
    { name: "DECIDING + converged → CONVERGED", from: "deciding", event: { kind: "decided", verdict: verdict(true, 0), priorOpenP0: [0] }, to: "converged" },
    { name: "DECIDING + open P0s (room left) → DEVELOPING", from: "deciding", event: { kind: "decided", verdict: verdict(false, 2), priorOpenP0: [3, 2] }, to: "developing" },
    { name: "DEVELOPING + dev_completed → AWAITING_MERGE", from: "developing", event: { kind: "dev_completed", prRef: "pr/1", headCommit: "abc1234" }, to: "awaiting_merge" },
    { name: "AWAITING_MERGE + merge_approved → BUILDING_CONTEXT", from: "awaiting_merge", event: { kind: "merge_approved" }, to: "building_context" },
    { name: "AWAITING_MERGE + cancel → CANCELLED", from: "awaiting_merge", event: { kind: "cancel" }, to: "cancelled" },
    { name: "REVIEWING + cancel → CANCELLED (any non-terminal)", from: "reviewing", event: { kind: "cancel" }, to: "cancelled" },
    { name: "DEVELOPING + cancel → CANCELLED (any non-terminal)", from: "developing", event: { kind: "cancel" }, to: "cancelled" },
    { name: "no-op: terminal FAILED + cancel", from: "failed", event: { kind: "cancel" }, to: null },
    { name: "no-op: terminal ESCALATED + cancel", from: "escalated", event: { kind: "cancel" }, to: null },
    { name: "no-op: terminal STOPPED_CAP + cancel", from: "stopped_cap", event: { kind: "cancel" }, to: null },
    { name: "no-op: PENDING + context_built", from: "pending", event: { kind: "context_built" }, to: null },
    { name: "no-op: terminal CONVERGED + cancel", from: "converged", event: { kind: "cancel" }, to: null },
    { name: "no-op: terminal CANCELLED + start", from: "cancelled", event: { kind: "start" }, to: null },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const t = reduce(row.from, row.event);
      if (row.to === null) {
        expect(t).toBeNull();
      } else {
        expect(t).not.toBeNull();
        expect(t?.from).toBe(row.from);
        expect(t?.to).toBe(row.to);
      }
    });
  }

  it("DECIDING: converged verdict wins even with anti-stall history (precedence)", () => {
    // open_p0 flat at 3 across 3 rounds BUT converged=true → CONVERGED, not ESCALATED.
    const t = reduce("deciding", { kind: "decided", verdict: verdict(true, 0), priorOpenP0: [3, 3, 0] });
    expect(t?.to).toBe("converged");
  });

  it("DECIDING: anti-stall (open_p0 flat ×2) → ESCALATED", () => {
    // rounds 1..3 openP0 = [3,3,3] non-decreasing across 2 transitions → ESCALATED.
    const t = reduce("deciding", { kind: "decided", verdict: verdict(false, 3), priorOpenP0: [3, 3, 3] });
    expect(t?.to).toBe("escalated");
  });

  it("DECIDING: decreasing open_p0 does NOT escalate", () => {
    const t = reduce("deciding", { kind: "decided", verdict: verdict(false, 1), priorOpenP0: [3, 2, 1] });
    expect(t?.to).toBe("developing");
  });
});

// ─── Anti-stall predicate ────────────────────────────────────────────────────

describe("isAntiStall", () => {
  it("false before round 3", () => {
    expect(isAntiStall([3, 3], 2)).toBe(false);
  });
  it("true when flat for 2 consecutive rounds at round 3", () => {
    expect(isAntiStall([3, 3, 3], 3)).toBe(true);
  });
  it("true when non-decreasing (3,3,4)", () => {
    expect(isAntiStall([3, 3, 4], 3)).toBe(true);
  });
  it("false when decreasing somewhere in the window", () => {
    expect(isAntiStall([3, 2, 3], 3)).toBe(false);
    expect(isAntiStall([4, 3, 3], 3)).toBe(false);
  });
});

// ─── pickJudgeOutput ─────────────────────────────────────────────────────────

describe("pickJudgeOutput", () => {
  it("prefers an output carrying action_points", () => {
    const judge = { verdict: "ok", action_points: [{ title: "x", priority: "P0" }] };
    expect(pickJudgeOutput([{ raw: "noise" }, judge])).toBe(judge);
  });
  it("takes an output with a convergence object", () => {
    const judge = { convergence: { converged: true, open_p0: 0 } };
    expect(pickJudgeOutput([judge])).toBe(judge);
  });
  it("returns undefined when no execution carries a verdict", () => {
    expect(pickJudgeOutput([{ foo: 1 }, "str", null])).toBeUndefined();
  });
});

// ─── Controller tick over fakes (cap precedence + CAS no-op + startGroup) ────

type LoopState = ConsiliumLoopState;

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop1",
    groupId: "grp1",
    state: "pending",
    round: 0,
    maxRounds: 6,
    repoPath: process.cwd(),
    lastReviewedCommit: null,
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
  };
}

/** Minimal fake storage: one loop + rounds + a CAS that honours `expected`. */
function makeFakeStorage(loop: ConsiliumLoopRow, rounds: { round: number; openP0: number }[] = []) {
  let current = loop;
  const cas = vi.fn(async (id: string, expected: LoopState, next: LoopState, extra?: Record<string, unknown>) => {
    if (id !== current.id || current.state !== expected) return undefined; // H-3 lost CAS
    current = { ...current, ...(extra ?? {}), state: next };
    return current;
  });
  // Faithful atomic re-drive claim (mirrors Pg/Mem): state match + null child ref
  // + past-grace, then bump updatedAt so a concurrent claim's grace check fails.
  const claimRedrive = vi.fn(async (id: string, expected: LoopState, graceMs: number) => {
    if (id !== current.id || current.state !== expected) return undefined;
    const nullRef =
      expected === "reviewing"
        ? current.currentIterationNumber == null
        : expected === "developing"
          ? current.devGroupId == null
          : false;
    if (!nullRef) return undefined;
    if (Date.now() - new Date(current.updatedAt).getTime() < graceMs) return undefined;
    current = { ...current, updatedAt: new Date() }; // atomic bump → loser backs off
    return current;
  });
  const storage = {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => rounds.map((r) => ({ ...r }))),
    casLoopState: cas,
    claimRedrive,
    appendLoopRound: vi.fn(async () => ({})),
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, input: "objective" })),
    updateTaskGroup: vi.fn(async () => ({})),
    createTaskGroup: vi.fn(async () => ({ group: { id: "devgrp" } })),
    getIteration: vi.fn(async () => ({ id: "it1", iterationNumber: current.currentIterationNumber ?? 1, status: "completed" })),
    getExecutionsByIteration: vi.fn(async () => []),
  };
  return { storage, cas, claimRedrive, get: () => current };
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
        // Phase 2: the skilled SDLC executor is the ONLY develop path, so it must be
        // ENABLED for these FSM tests to dispatch the (injected fake) coder — with it
        // OFF the develop phase fails soft (see the dedicated fail-soft test below).
        // These tests inject runSdlc/runCloseout and assert the develop WIRING, not the
        // skilled-coder internals, so the fake ignores the archetype/skills args.
        // Stage 2b: verification stays OFF (mirrors the schema defaults).
        implement: {
          enabled: true,
          verification: { enabled: false },
          maxFixIterations: 3,
          testCommand: null,
          testRunTimeoutMs: 300000,
          // Coder path (archetype null/undefined ⇒ runSdlc), so research stays OFF —
          // present so `researchImplementEnabled` reads a defined key (schema default).
          research: { enabled: false, maxResearchIterations: 3, model: "claude-sonnet" },
        },
      },
    },
  }) as never;

/** Past the DEVELOPING registry-EMPTY (cross-restart) re-drive grace — sized to a
 *  WHOLE multi-AP round, not one coder run. Only relevant when the in-process
 *  sdlcRuns registry is empty (a genuine crash/restart that lost it). */
const DEV_STALE = new Date(Date.now() - SDLC_DEV_REDRIVE_GRACE_MS - 60_000);
/** Flush microtasks + one macrotask so a fire-and-forget background run settles. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("controller tick — startGroup + cap precedence + CAS no-op", () => {
  it("BUILDING_CONTEXT tick CLAIMS the CAS then CALLS orchestrator.startGroup exactly once", async () => {
    // repoPath = the real repo cwd (round 1, null baseline) so the A2
    // buildDiffContext resolves HEAD and returns ok deterministically — the
    // reviewing side effect actually runs and we can assert startGroup fires.
    const loop = makeLoop({ state: "building_context", round: 0, lastReviewedCommit: null });
    const { storage } = makeFakeStorage(loop);
    const startGroup = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup, startGroupAsync: startGroup, createTaskGroup: storage.createTaskGroup, cancelGroup: vi.fn() } as never,
      config: fakeConfig,
    });
    const res = await controller.tick(loop.id);
    expect(res).not.toBeNull();
    expect(res?.state).toBe("reviewing");
    expect(startGroup).toHaveBeenCalledTimes(1);
    // round only ever increments on entering REVIEWING (M-2) and the new
    // iteration number is persisted after the side effect on the won row.
    expect(res?.round).toBe(1);
    expect(res?.currentIterationNumber).toBe(1);
  });

  it("in-process lock: two concurrent same-process ticks → exactly ONE SDLC dispatch (2nd is locked out)", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, maxRounds: 6, currentIterationNumber: 2 });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    // H-2: the DEVELOPING side effect dispatches the SDLC close-out (background).
    // The in-process lock must bar the 2nd concurrent tick before it can dispatch.
    const runCloseout = vi.fn(async () => ({ prRef: "https://github.com/x/y/pull/1", headCommit: "abc" }));
    const startGroup = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup, startGroupAsync: startGroup, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2), // open P0s, room left → DEVELOPING
      runCloseout,
    });
    const [a, b] = await Promise.all([controller.tick(loop.id), controller.tick(loop.id)]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.state).toBe("developing");
    // The non-idempotent SDLC dispatch fires for the single in-flight tick ONLY.
    expect(runCloseout).toHaveBeenCalledTimes(1);
  });

  it("cross-instance CAS: a 2nd controller (separate process) that loses the CAS is a no-op", async () => {
    // Two controllers share storage but NOT the in-process lock (simulating two
    // pods). The first wins the CAS deciding->developing and dispatches the SDLC
    // close-out; the second's CAS sees state !== deciding → undefined → no-op, so
    // the background coder is launched exactly ONCE (H-2 single-flight on entry).
    const loop = makeLoop({ state: "deciding", round: 2, maxRounds: 6, currentIterationNumber: 2 });
    const { storage, cas } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const runCloseout = vi.fn(async () => ({ prRef: "https://github.com/x/y/pull/2", headCommit: "abc" }));
    const mkController = () =>
      new ConsiliumLoopController({
        storage: storage as never,
        taskOrchestrator: (() => { const sg = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } })); return { startGroup: sg, startGroupAsync: sg, createTaskGroup: vi.fn(), cancelGroup: vi.fn() }; })() as never,
        config: fakeConfig,
        readIterationVerdict: async () => verdict(false, 2),
        runCloseout,
      });
    const [a, b] = await Promise.all([mkController().tick(loop.id), mkController().tick(loop.id)]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(runCloseout).toHaveBeenCalledTimes(1);
    // Both instances attempted the deciding->developing CAS; only one row updated.
    expect(cas.mock.calls.filter((c) => c[1] === "deciding" && c[2] === "developing").length).toBe(2);
  });

  it("DECIDING at cap round with open P0s → STOPPED_CAP (cap precedence)", async () => {
    const loop = makeLoop({ state: "deciding", round: 6, maxRounds: 6, currentIterationNumber: 6 });
    const { storage, cas } = makeFakeStorage(loop, [
      { round: 1, openP0: 3 },
      { round: 2, openP0: 2 },
    ]);
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2), // still open → cap binds
    });
    const res = await controller.tick(loop.id);
    expect(res?.state).toBe("stopped_cap");
    expect(cas).toHaveBeenCalledWith("loop1", "deciding", "stopped_cap", expect.anything());
  });

  it("round 6 + anti-stall history → STOPPED_CAP (cap WINS over ESCALATED)", async () => {
    // At the cap round with open P0s AND a flat anti-stall history, the tick cap
    // early-exit fires STOPPED_CAP before `reduce` could ever pick ESCALATED —
    // proving the precedence the early-exit creates.
    const loop = makeLoop({ state: "deciding", round: 6, maxRounds: 6, currentIterationNumber: 6 });
    const { storage } = makeFakeStorage(loop, [
      { round: 4, openP0: 3 },
      { round: 5, openP0: 3 },
    ]);
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 3), // flat at 3 → would escalate
    });
    const res = await controller.tick(loop.id);
    expect(res?.state).toBe("stopped_cap"); // cap binds first, not "escalated"
  });

  it("DECIDING at cap round but CONVERGED → CONVERGED wins over cap", async () => {
    const loop = makeLoop({ state: "deciding", round: 6, maxRounds: 6, currentIterationNumber: 6 });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 1 }]);
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(true, 0),
    });
    const res = await controller.tick(loop.id);
    expect(res?.state).toBe("converged");
  });

  it("H-3: a lost CAS (state already advanced) is a no-op (returns null)", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, maxRounds: 6, currentIterationNumber: 2 });
    const { storage, cas } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    // Simulate a concurrent tick that already advanced the loop before our CAS:
    cas.mockImplementation(async () => undefined);
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(true, 0),
    });
    const res = await controller.tick(loop.id);
    expect(res).toBeNull(); // lost the race → no-op
  });
});

// ─── Crash-window re-drive (liveness fix) ────────────────────────────────────

describe("controller tick — crash-window re-drive of stranded loops", () => {
  // A loop whose state was persisted long ago (past the grace window) → a true
  // crash-strand, eligible for re-drive. Grace = max(2x5s, 30s) = 30s here.
  const STALE = new Date(Date.now() - 120_000);
  const FRESH = new Date(); // within grace → in-flight, must NOT re-drive

  it("REGISTRY-EMPTY re-drive (b): developing past grace + NO in-flight registry entry → re-dispatches SDLC exactly once (M-1)", async () => {
    // BUG-1 (b): a genuine crash/restart LOST the in-process sdlcRuns registry, so
    // a fresh controller sees developing+null devGroupId with NO registered run.
    // Only THEN (registry empty + past the whole-round time fallback) does the
    // redrive claim re-dispatch the SDLC close-out — exactly once; the loop stays
    // developing (background run).
    const loop = makeLoop({ state: "developing", round: 2, devGroupId: null, currentIterationNumber: 2, updatedAt: DEV_STALE });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const runCloseout = vi.fn(async () => ({ prRef: "https://github.com/x/y/pull/3", headCommit: "deadbeef" }));
    const startGroup = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup, startGroupAsync: startGroup, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2),
      readRepoHead: async () => "deadbeef",
      runCloseout,
    });
    const res = await controller.tick(loop.id);
    expect(runCloseout).toHaveBeenCalledTimes(1); // re-dispatched
    expect(res?.devGroupId ?? null).toBeNull(); // marker still null
    expect(res?.state).toBe("developing"); // background run — stays developing
  });

  it("REGISTRY GATE (a) (BUG-1): developing past the TIME grace WITH an in-flight registry run → NO second dispatch", async () => {
    // The live double-dispatch: a per-AP round runs N SEQUENTIAL coders, so it
    // routinely outlives any single-coder time grace. The process-local sdlcRuns
    // registry is AUTHORITATIVE — an in-flight run means NOT stranded, so
    // redriveStranded must NOT re-dispatch a 2nd runSdlcHandoff on the SAME branch
    // (the old behavior produced "already used by worktree" + a null-prRef clobber).
    const loop = makeLoop({ state: "deciding", round: 2, currentIterationNumber: 2 });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    let release: (r: { prRef: string | null; headCommit: string }) => void = () => {};
    // A closeout that does NOT settle until released → the registry entry stays in-flight.
    const runCloseout = vi.fn(
      () => new Promise<{ prRef: string | null; headCommit: string }>((res) => { release = res; }),
    );
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2),
      readRepoHead: async () => "abc",
      runCloseout,
    });
    const t1 = await controller.tick(loop.id); // deciding → developing (dispatch; in-flight)
    expect(t1?.state).toBe("developing");
    expect(runCloseout).toHaveBeenCalledTimes(1);
    // Age the developing row PAST the whole-round grace — a TIME-ONLY guard would
    // now re-drive; the registry gate must override the timer.
    await storage.updateLoop(loop.id, { updatedAt: DEV_STALE });
    const t2 = await controller.tick(loop.id); // developing + null devGroupId + past grace
    expect(t2).toBeNull(); // registry says in-flight → no-op, NO re-drive
    expect(runCloseout).toHaveBeenCalledTimes(1); // NOT re-dispatched (BUG-1 fixed)
    release({ prRef: "https://github.com/x/y/pull/77", headCommit: "abc" }); // settle the dangling run
    await flush();
  });

  it("IDEMPOTENT SETTLE (c) (BUG-1): a late null-prRef settle CANNOT clobber a recorded non-null prRef", () => {
    // Defensive: with the registry gate there is only one run per round, but a
    // late/duplicate settle (pre-gate double dispatch, or a redrive after registry
    // loss) must never downgrade a real Draft PR to a branch-only null.
    const controller = new ConsiliumLoopController({
      storage: {} as never,
      taskOrchestrator: {} as never,
      config: fakeConfig,
    });
    type Run = { round: number; done: boolean; result?: { prRef: string | null; headCommit: string; error?: string } };
    const c = controller as unknown as {
      sdlcRuns: Map<string, Run>;
      settleSdlcRun(loopId: string, run: Run, result: { prRef: string | null; headCommit: string; error?: string }): void;
    };
    // The good run settles with a REAL PR.
    const good: Run = { round: 2, done: false };
    c.sdlcRuns.set("loop1", good);
    c.settleSdlcRun("loop1", good, { prRef: "https://github.com/o/r/pull/7", headCommit: "abc" });
    expect(c.sdlcRuns.get("loop1")?.result?.prRef).toBe("https://github.com/o/r/pull/7");
    // A late/duplicate run for the SAME round settles branch-only (null prRef).
    const late: Run = { round: 2, done: false };
    c.settleSdlcRun("loop1", late, { prRef: null, headCommit: "def", error: "open PR manually" });
    // The good PR is preserved — null did NOT clobber it; the late run mirrors it.
    expect(c.sdlcRuns.get("loop1")?.result?.prRef).toBe("https://github.com/o/r/pull/7");
    expect(late.result?.prRef).toBe("https://github.com/o/r/pull/7");
  });

  it("CROSS-INSTANCE: two controllers re-driving the SAME stranded developing loop → EXACTLY ONE SDLC dispatch", async () => {
    // Two pods, separate in-process locks AND separate (empty) sdlcRuns registries,
    // ONE storage. Both read the stranded null-devGroupId row past the whole-round
    // grace with NO registered run; the atomic claimRedrive lets only ONE win → the
    // SDLC close-out is dispatched exactly once (no double coder).
    const loop = makeLoop({ state: "developing", round: 2, devGroupId: null, currentIterationNumber: 2, updatedAt: DEV_STALE });
    const { storage, claimRedrive } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const runCloseout = vi.fn(async () => ({ prRef: "https://github.com/x/y/pull/4", headCommit: "deadbeef" }));
    const mk = () =>
      new ConsiliumLoopController({
        storage: storage as never,
        taskOrchestrator: (() => { const sg = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } })); return { startGroup: sg, startGroupAsync: sg, createTaskGroup: vi.fn(), cancelGroup: vi.fn() }; })() as never,
        config: fakeConfig,
        readIterationVerdict: async () => verdict(false, 2),
        readRepoHead: async () => "deadbeef",
        runCloseout,
      });
    // Two SEPARATE controllers → two independent in-process Sets (simulating pods).
    const [a, b] = await Promise.all([mk().tick(loop.id), mk().tick(loop.id)]);
    expect(runCloseout).toHaveBeenCalledTimes(1); // atomic claim → no double dispatch
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(claimRedrive).toHaveBeenCalledTimes(2); // both attempted; one won
  });

  it("REGRESSION: REVIEWING with null ref but WITHIN grace (side effect in flight) → NO re-drive, NO duplicate startGroup", async () => {
    // This is the live regression: during the in-flight window the loop is
    // legitimately reviewing+null-ref. A poller tick must NOT re-drive it.
    const loop = makeLoop({ state: "reviewing", round: 1, currentIterationNumber: null, updatedAt: FRESH });
    const { storage } = makeFakeStorage(loop);
    const startGroup = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 7 } }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup, startGroupAsync: startGroup, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readRepoHead: async () => "abc1234",
    });
    const res = await controller.tick(loop.id);
    expect(startGroup).not.toHaveBeenCalled(); // in-flight → no second startGroup
    expect(res).toBeNull(); // no-op (still reviewing, waiting on the in-flight iteration)
  });

  it("REGRESSION: a SLOW startGroup in flight + a poller tick fires → EXACTLY ONE startGroup", async () => {
    // Drive the real BUILDING_CONTEXT→REVIEWING transition with a slow startGroup,
    // then fire a concurrent poller tick during the in-flight window. The
    // in-process lock bars the 2nd; net exactly one startGroup, one iteration.
    const loop = makeLoop({ state: "building_context", round: 0, lastReviewedCommit: null, updatedAt: new Date() });
    const { storage } = makeFakeStorage(loop);
    const startGroup = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { group: {}, iteration: { iterationNumber: 1 } };
    });
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup, startGroupAsync: startGroup, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readRepoHead: async () => "abc1234",
    });
    const [a, b] = await Promise.all([controller.tick(loop.id), controller.tick(loop.id)]);
    expect(startGroup).toHaveBeenCalledTimes(1); // the duplicate-iteration regression is fixed
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.currentIterationNumber).toBe(1);
  });

  it("DEVELOPING whose BACKGROUND SDLC settled → advances to AWAITING_MERGE with the real prRef (H-2)", async () => {
    // H-2: dispatch on entry (tick 1, stays developing) → background settles →
    // a later tick (tick 2) reads the settle and CASes developing→awaiting_merge
    // with the REAL prRef/headCommit. AWAITING_MERGE never opens half-formed.
    const loop = makeLoop({ state: "deciding", round: 2, currentIterationNumber: 2 });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const runCloseout = vi.fn(async () => ({ prRef: "https://github.com/x/y/pull/42", headCommit: "cafef00d" }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2),
      readRepoHead: async () => "abc",
      runCloseout,
    });
    const t1 = await controller.tick(loop.id); // deciding → developing (dispatch SDLC)
    expect(t1?.state).toBe("developing");
    await flush(); // the background close-out settles into the registry
    const t2 = await controller.tick(loop.id); // developing → awaiting_merge
    expect(t2?.state).toBe("awaiting_merge");
    expect(runCloseout).toHaveBeenCalledTimes(1); // dispatched ONCE, never inline-repeated
    expect(t2?.prRef).toBe("https://github.com/x/y/pull/42"); // real PR persisted
    expect(t2?.headCommitAtReview).toBe("cafef00d"); // M-3 captured from the settle
  });

  it("REVIEWING with null currentIterationNumber, past grace → re-drives the review side effect", async () => {
    const loop = makeLoop({ state: "reviewing", round: 0, currentIterationNumber: null, lastReviewedCommit: null, updatedAt: new Date(Date.now() - 120_000) });
    const { storage } = makeFakeStorage(loop);
    const startGroup = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup, startGroupAsync: startGroup, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readRepoHead: async () => "abc1234",
    });
    const res = await controller.tick(loop.id);
    expect(startGroup).toHaveBeenCalledTimes(1);
    expect(res?.currentIterationNumber).toBe(1);
    expect(res?.round).toBe(1); // incremented exactly once on the re-drive
    expect(res?.state).toBe("reviewing");
  });
});

// ─── D.6: non-blocking switch + prRef flow + close-out single-flight ─────────

describe("controller — D.6 non-blocking startGroupAsync + prRef close-out flow", () => {
  it("NON-BLOCKING: startReviewRound persists the iteration ref via startGroupAsync WITHOUT the child completing", async () => {
    // The fake orchestrator's startGroupAsync returns IMMEDIATELY with a stub
    // iteration whose status is NEVER flipped to completed — proving the child
    // ref is persisted on KICKOFF, not after the consilium round settles.
    const loop = makeLoop({ state: "building_context", round: 0, lastReviewedCommit: null });
    const { storage } = makeFakeStorage(loop);
    // getIteration would say "running" for the dispatched-but-not-settled child.
    storage.getIteration = vi.fn(async () => ({ id: "it1", iterationNumber: 1, status: "running" })) as never;
    const startGroup = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } })); // awaiting path
    const startGroupAsync = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup, startGroupAsync, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readRepoHead: async () => "abc1234",
    });
    const res = await controller.tick(loop.id);
    // The controller used the NON-BLOCKING path exclusively (D.6 switch).
    expect(startGroupAsync).toHaveBeenCalledTimes(1);
    expect(startGroup).not.toHaveBeenCalled();
    // Ref set on KICKOFF — the child is still "running", proving non-blocking.
    expect(res?.state).toBe("reviewing");
    expect(res?.currentIterationNumber).toBe(1);
    expect(res?.round).toBe(1);
  });

  it("MUTATION GUARD: a startGroupAsync that BLOCKS (re-introduced await) does NOT change the asserted ref-timing", async () => {
    // If a regression re-introduced an internal await on completion, the fake
    // here SLEEPS before resolving; the controller still must persist the ref
    // from the resolved iteration with state=reviewing and round incremented —
    // the assertion is identical, so the timing the test asserts is stable.
    const loop = makeLoop({ state: "building_context", round: 0, lastReviewedCommit: null });
    const { storage } = makeFakeStorage(loop);
    const startGroupAsync = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { group: {}, iteration: { iterationNumber: 3 } };
    });
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readRepoHead: async () => "abc1234",
    });
    const res = await controller.tick(loop.id);
    expect(res?.currentIterationNumber).toBe(3);
    expect(res?.state).toBe("reviewing");
  });

  it("startDevHandoff dispatches the SDLC close-out in the BACKGROUND (no pipeline group; devGroupId stays null)", async () => {
    // H-2: the DECIDING→DEVELOPING side effect no longer mints a `pipeline_run`
    // group. It records the round and DISPATCHES the SDLC close-out off the tick
    // path. devGroupId stays null (the in-progress/stranded marker); openP0 persists.
    const loop = makeLoop({ state: "deciding", round: 2, maxRounds: 6, currentIterationNumber: 2 });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const createTaskGroup = vi.fn();
    const startGroupAsync = vi.fn();
    const runCloseout = vi.fn(async () => ({ prRef: "https://github.com/x/y/pull/5", headCommit: "abc1234" }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync, createTaskGroup, cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2),
      readRepoHead: async () => "abc1234",
      runCloseout,
    });
    const res = await controller.tick(loop.id);
    expect(res?.state).toBe("developing");
    expect(res?.devGroupId ?? null).toBeNull(); // marker stays null (H-2)
    expect(res?.openP0).toBe(2);
    expect(createTaskGroup).not.toHaveBeenCalled(); // no legacy pipeline_run group
    expect(startGroupAsync).not.toHaveBeenCalled();
    expect(runCloseout).toHaveBeenCalledTimes(1); // SDLC dispatched (background)
  });

  it("prRef extraction: a settled close-out URL → AWAITING_MERGE persists exactly that prRef", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, currentIterationNumber: 2 });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const runCloseout = vi.fn(async () => ({ prRef: "https://github.com/o/r/pull/99", headCommit: "feedbead" }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2),
      readRepoHead: async () => "abc",
      runCloseout,
    });
    await controller.tick(loop.id); // deciding → developing (dispatch)
    await flush();
    const res = await controller.tick(loop.id); // developing → awaiting_merge
    expect(res?.state).toBe("awaiting_merge");
    expect(res?.prRef).toBe("https://github.com/o/r/pull/99");
    expect(res?.headCommitAtReview).toBe("feedbead");
    expect(res?.error ?? null).toBeNull();
  });

  it("prRef extraction: a branch-only settle → prRef null + error, still AWAITING_MERGE (loop NOT failed)", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, currentIterationNumber: 2 });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const runCloseout = vi.fn(async () => ({
      prRef: null,
      headCommit: "feedbead",
      error: "pushed branch consilium/loop-loop1/round-2; open PR manually",
    }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2),
      readRepoHead: async () => "abc",
      runCloseout,
    });
    await controller.tick(loop.id); // deciding → developing (dispatch)
    await flush();
    const res = await controller.tick(loop.id); // developing → awaiting_merge
    expect(res?.state).toBe("awaiting_merge"); // NOT failed — gate still meaningful
    expect(res?.prRef).toBeNull();
    expect(res?.error).toContain("open PR manually");
  });

  it("implement.enabled=false ⇒ develop FAILS SOFT: the coder NEVER runs, dev_completed carries the disabled error", async () => {
    // Phase 2: the skilled SDLC executor is the ONLY develop path. With the implement
    // kill-switch OFF there is nothing to fall back to, so the develop phase fails soft
    // (same no-PR `dev_completed` convention as a disabled research archetype) instead
    // of silently running an unskilled coder. NO FSM/reducer change: the loop still
    // enters developing, then advances to awaiting_merge carrying the error.
    const loop = makeLoop({ state: "deciding", round: 2, currentIterationNumber: 2 });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    // Inject the REAL close-out seam (runSdlc, not runCloseout) so the controller's
    // own implement-disabled guard decides — and prove the coder is never reached.
    const runSdlc = vi.fn(async () => ({ prRef: "https://github.com/o/r/pull/1", headCommit: "abc" }));
    const disabledImplement = () => {
      const c = fakeConfig() as { pipeline: { consiliumLoop: { implement: { enabled: boolean } } } };
      c.pipeline.consiliumLoop.implement.enabled = false;
      return c as never;
    };
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: disabledImplement,
      readIterationVerdict: async () => verdict(false, 2),
      readRepoHead: async () => "abc",
      runSdlc: runSdlc as never,
    });
    await controller.tick(loop.id); // deciding → developing (dispatch fail-soft close-out)
    await flush();
    const res = await controller.tick(loop.id); // developing → awaiting_merge
    expect(runSdlc).not.toHaveBeenCalled(); // the coder is NEVER run when implement is off
    expect(res?.state).toBe("awaiting_merge"); // loop is NOT failed
    expect(res?.prRef).toBeNull();
    expect(res?.error).toBe("implement path disabled by config");
  });

  it("dispatch single-flight: two concurrent DECIDING→DEVELOPING ticks dispatch the close-out ONCE (CAS-gated)", async () => {
    // H-2: the SDLC close-out is dispatched on the deciding→developing CAS WINNER
    // only. Two pods (separate in-process Sets) over one storage both attempt the
    // CAS; exactly one wins → exactly one background coder (no duplicate PR).
    const loop = makeLoop({ state: "deciding", round: 2, currentIterationNumber: 2 });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const runCloseout = vi.fn(async () => ({ prRef: "https://github.com/o/r/pull/1", headCommit: "abc" }));
    const mk = () =>
      new ConsiliumLoopController({
        storage: storage as never,
        taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
        config: fakeConfig,
        readIterationVerdict: async () => verdict(false, 2),
        readRepoHead: async () => "abc",
        runCloseout,
      });
    const [a, b] = await Promise.all([mk().tick(loop.id), mk().tick(loop.id)]);
    expect(runCloseout).toHaveBeenCalledTimes(1); // the CAS gate prevents a duplicate coder
    const winners = [a, b].filter((r) => r !== null && r.state === "developing");
    expect(winners).toHaveLength(1);
  });
});

// ─── develop_requested: authorized terminal re-open (reduce + controller) ────

describe("reduce — develop_requested (round-preserving terminal re-open)", () => {
  for (const from of ["stopped_cap", "converged", "escalated"] as const) {
    it(`${from} + develop_requested → DEVELOPING (completedAt/error cleared)`, () => {
      const t = reduce(from, { kind: "develop_requested" });
      expect(t).not.toBeNull();
      expect(t?.from).toBe(from);
      expect(t?.to).toBe("developing");
      // Round-preserving: the transition carries NO `round` mutation (M-2).
      expect(t?.extra).toMatchObject({ completedAt: null, error: null });
      expect(t?.extra && "round" in t.extra).toBe(false);
    });
  }

  for (const from of [
    "pending",
    "building_context",
    "reviewing",
    "deciding",
    "developing",
    "awaiting_merge",
    "failed",
    "cancelled",
  ] as const) {
    it(`${from} + develop_requested → null (only verdict-terminal states promote)`, () => {
      expect(reduce(from, { kind: "develop_requested" })).toBeNull();
    });
  }
});

const JUDGE_WITH_APS = {
  verdict: "needs work",
  action_points: [
    { title: "DEV AP1", priority: "P0" },
    { title: "DEV AP2", priority: "P2" },
  ],
};

/** Fake storage tailored to controller.develop (one promotable terminal loop). */
function makeDevStorage(
  loop: ConsiliumLoopRow,
  opts: { active?: unknown; executions?: { output: unknown }[]; workspaces?: { path: string }[] } = {},
) {
  let current = loop;
  const cas = vi.fn(async (id: string, expected: LoopState, next: LoopState, extra?: Record<string, unknown>) => {
    if (id !== current.id || current.state !== expected) return undefined;
    current = { ...current, ...(extra ?? {}), state: next };
    return current;
  });
  const executions = opts.executions ?? [{ output: JUDGE_WITH_APS }];
  const workspaces = opts.workspaces ?? [{ path: process.cwd() }];
  const storage = {
    getLoop: vi.fn(async () => current),
    getActiveLoopByGroup: vi.fn(async () => opts.active),
    getIteration: vi.fn(async () => ({ id: "it1", iterationNumber: current.currentIterationNumber ?? 1, status: "completed" })),
    getExecutionsByIteration: vi.fn(async () => executions),
    getWorkspaces: vi.fn(async () => workspaces),
    getLoopRounds: vi.fn(async () => []),
    appendLoopRound: vi.fn(async () => ({})),
    casLoopState: cas,
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
  };
  return { storage, cas, get: () => current };
}

function makeDevController(storage: unknown, runSdlc: ReturnType<typeof vi.fn>) {
  return new ConsiliumLoopController({
    storage: storage as never,
    taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
    config: fakeConfig,
    readRepoHead: async () => "abc1234",
    runSdlc: runSdlc as never,
  });
}

describe("controller.develop — authorized terminal re-open", () => {
  const PR = { prRef: "https://github.com/o/r/pull/7", headCommit: "abc1234" };

  it("CAS win: promotes a CONVERGED loop → developing and dispatches the FULL action-point list", async () => {
    const loop = makeLoop({ state: "converged", round: 2, currentIterationNumber: 2 });
    const { storage } = makeDevStorage(loop);
    const runSdlc = vi.fn(async () => PR);
    const controller = makeDevController(storage, runSdlc);

    const res = await controller.develop(loop.id);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.loop.state).toBe("developing");
    expect(res.loop.round).toBe(2); // round PRESERVED (M-2)
    expect(runSdlc).toHaveBeenCalledTimes(1);
    // FULL list (ALL priorities), not just open P0s.
    const aps = (runSdlc.mock.calls[0][0] as { actionPoints: { title: string }[] }).actionPoints;
    expect(aps.map((a) => a.title)).toEqual(["DEV AP1", "DEV AP2"]);
  });

  it("NO_ACTION_POINTS: a verdict with no action points is rejected, executor never run", async () => {
    const loop = makeLoop({ state: "escalated", round: 3, currentIterationNumber: 3 });
    const { storage } = makeDevStorage(loop, { executions: [{ output: { verdict: "ok" } }] });
    const runSdlc = vi.fn(async () => PR);
    const controller = makeDevController(storage, runSdlc);

    const res = await controller.develop(loop.id);
    expect(res).toEqual({ ok: false, code: "NO_ACTION_POINTS" });
    expect(runSdlc).not.toHaveBeenCalled();
  });

  it("ACTIVE_LOOP_EXISTS: a second active loop on the group blocks the re-open", async () => {
    const loop = makeLoop({ state: "stopped_cap", round: 6, currentIterationNumber: 6 });
    const { storage } = makeDevStorage(loop, { active: { id: "other", state: "reviewing" } });
    const runSdlc = vi.fn(async () => PR);
    const controller = makeDevController(storage, runSdlc);

    const res = await controller.develop(loop.id);
    expect(res).toEqual({ ok: false, code: "ACTIVE_LOOP_EXISTS" });
    expect(runSdlc).not.toHaveBeenCalled();
  });

  it("CAS_LOST: a concurrent winner of the terminal→developing CAS → CAS_LOST, no dispatch", async () => {
    const loop = makeLoop({ state: "converged", round: 2, currentIterationNumber: 2 });
    const { storage, cas } = makeDevStorage(loop);
    cas.mockImplementation(async () => undefined); // lost the race
    const runSdlc = vi.fn(async () => PR);
    const controller = makeDevController(storage, runSdlc);

    const res = await controller.develop(loop.id);
    expect(res).toEqual({ ok: false, code: "CAS_LOST" });
    expect(runSdlc).not.toHaveBeenCalled();
  });

  it("getDevProgress surfaces the latest per-AP beat of the developing phase", async () => {
    const loop = makeLoop({ state: "converged", round: 2, currentIterationNumber: 2 });
    const { storage } = makeDevStorage(loop);
    const runSdlc = vi.fn((_req: unknown, _deps: unknown, onProgress?: (p: unknown) => void) => {
      onProgress?.({ phase: "coding", actionPointIndex: 1, actionPointTotal: 2, actionPointTitle: "DEV AP1", completedCount: 0 });
      return new Promise(() => {}); // stay running so the beat persists
    });
    const controller = makeDevController(storage, runSdlc as never);

    const res = await controller.develop(loop.id);
    expect(res.ok).toBe(true);
    expect(controller.getDevProgress(loop.id)).toMatchObject({
      phase: "coding",
      actionPointIndex: 1,
      actionPointTotal: 2,
      actionPointTitle: "DEV AP1",
      completedCount: 0,
    });
    // An unknown loop has no progress.
    expect(controller.getDevProgress("nope")).toBeUndefined();
  });

  it("R1 global cap: the 4th concurrent in-flight human dev handoff → BUSY", async () => {
    const ids = ["L1", "L2", "L3", "L4"];
    const loops = new Map(
      ids.map((id) => [id, makeLoop({ id, groupId: `grp-${id}`, state: "converged", round: 2, currentIterationNumber: 2 })]),
    );
    const storage = {
      getLoop: vi.fn(async (id: string) => loops.get(id)),
      getActiveLoopByGroup: vi.fn(async () => undefined),
      getIteration: vi.fn(async () => ({ id: "it", iterationNumber: 2, status: "completed" })),
      getExecutionsByIteration: vi.fn(async () => [{ output: JUDGE_WITH_APS }]),
      getWorkspaces: vi.fn(async () => [{ path: process.cwd() }]),
      getLoopRounds: vi.fn(async () => []),
      appendLoopRound: vi.fn(async () => ({})),
      casLoopState: vi.fn(async (id: string, expected: LoopState, next: LoopState, extra?: Record<string, unknown>) => {
        const cur = loops.get(id);
        if (!cur || cur.state !== expected) return undefined;
        const upd = { ...cur, ...(extra ?? {}), state: next } as ConsiliumLoopRow;
        loops.set(id, upd);
        return upd;
      }),
      updateLoop: vi.fn(async (id: string, extra?: Record<string, unknown>) => {
        const upd = { ...loops.get(id)!, ...(extra ?? {}) } as ConsiliumLoopRow;
        loops.set(id, upd);
        return upd;
      }),
    };
    const runSdlc = vi.fn(() => new Promise(() => {})); // every run stays in-flight
    const controller = makeDevController(storage, runSdlc as never);

    for (const id of ["L1", "L2", "L3"]) {
      const r = await controller.develop(id);
      expect(r.ok).toBe(true);
    }
    const over = await controller.develop("L4");
    expect(over).toEqual({ ok: false, code: "BUSY" });
    expect(runSdlc).toHaveBeenCalledTimes(3); // L4 never dispatched
  });
});

describe("controller.develop — R1 cap atomicity under a concurrent burst", () => {
  /** A multi-loop storage where each id resolves to its OWN promotable loop. */
  function makeBurstStorage(ids: string[]) {
    const loops = new Map<string, ConsiliumLoopRow>(
      ids.map((id) => [id, makeLoop({ id, groupId: `g-${id}`, state: "converged", round: 2, currentIterationNumber: 2 })]),
    );
    return {
      getLoop: vi.fn(async (id: string) => loops.get(id)),
      getActiveLoopByGroup: vi.fn(async () => undefined),
      getIteration: vi.fn(async () => ({ id: "it", iterationNumber: 2, status: "completed" })),
      getExecutionsByIteration: vi.fn(async () => [{ output: JUDGE_WITH_APS }]),
      getWorkspaces: vi.fn(async () => [{ path: process.cwd() }]),
      getLoopRounds: vi.fn(async () => []),
      appendLoopRound: vi.fn(async () => ({})),
      casLoopState: vi.fn(async (id: string, expected: LoopState, next: LoopState, extra?: Record<string, unknown>) => {
        const cur = loops.get(id);
        if (!cur || cur.state !== expected) return undefined;
        const upd = { ...cur, ...(extra ?? {}), state: next } as ConsiliumLoopRow;
        loops.set(id, upd);
        return upd;
      }),
      updateLoop: vi.fn(async (id: string, extra?: Record<string, unknown>) => {
        const upd = { ...loops.get(id)!, ...(extra ?? {}) } as ConsiliumLoopRow;
        loops.set(id, upd);
        return upd;
      }),
    };
  }

  it("a BURST of concurrent develop() on DISTINCT loops dispatches AT MOST the cap; the rest are BUSY", async () => {
    const ids = ["B1", "B2", "B3", "B4", "B5"]; // 5 > cap(3)
    const storage = makeBurstStorage(ids);
    // A runSdlc that NEVER resolves on its own → every winner stays in-flight, so
    // the derived count + reservation accounting is exercised across the whole burst.
    const resolvers: Array<(r: { prRef: string | null; headCommit: string }) => void> = [];
    const runSdlc = vi.fn(() => new Promise<{ prRef: string | null; headCommit: string }>((res) => { resolvers.push(res); }));
    const controller = makeDevController(storage, runSdlc as never);

    // Fire all 5 CONCURRENTLY — the pre-fix derived-count race would let all 5 pass.
    const results = await Promise.all(ids.map((id) => controller.develop(id)));
    const ok = results.filter((r) => r.ok);
    const busy = results.filter((r) => !r.ok && r.code === "BUSY");

    expect(ok.length).toBeLessThanOrEqual(MAX_CONCURRENT_DEV_HANDOFFS); // the cap is airtight
    expect(ok.length).toBe(MAX_CONCURRENT_DEV_HANDOFFS); // deterministic with immediate-resolve fakes
    expect(ok.length + busy.length).toBe(ids.length); // every non-winner is BUSY
    expect(runSdlc).toHaveBeenCalledTimes(ok.length); // ONLY winners dispatched a coder

    // After a winner SETTLES, its slot frees and a previously-BUSY loop can re-develop
    // (no leaked reservation). resolvers[0] is the first dispatched (a winner).
    resolvers[0]({ prRef: "https://github.com/o/r/pull/1", headCommit: "abc1234" });
    await flush(); // settleSdlcRun flips the winner's run done=true → drops the derived count

    const busyId = ids.find((_id, i) => !results[i].ok);
    expect(busyId).toBeDefined();
    const retry = await controller.develop(busyId!);
    expect(retry.ok).toBe(true); // a freed slot is immediately reusable
    expect(runSdlc).toHaveBeenCalledTimes(MAX_CONCURRENT_DEV_HANDOFFS + 1);
  });
});
