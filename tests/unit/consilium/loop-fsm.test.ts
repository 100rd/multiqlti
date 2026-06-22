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
        devPipelineId: "dev-pipe",
      },
    },
  }) as never;

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
      taskOrchestrator: { startGroup, createTaskGroup: storage.createTaskGroup, cancelGroup: vi.fn() } as never,
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

  it("in-process lock: two concurrent same-process ticks → exactly ONE createTaskGroup (2nd is locked out)", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, maxRounds: 6, currentIterationNumber: 2 });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    // A slow createTaskGroup keeps the first tick's side effect in flight while
    // the second tick fires — the in-process lock must bar the 2nd before CAS.
    const createTaskGroup = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return { group: { id: "devgrp" }, tasks: [] };
    });
    const startGroup = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup, createTaskGroup, cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2), // open P0s, room left → DEVELOPING
    });
    const [a, b] = await Promise.all([controller.tick(loop.id), controller.tick(loop.id)]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.state).toBe("developing");
    // The non-idempotent DEV-group mint fires for the single in-flight tick ONLY.
    expect(createTaskGroup).toHaveBeenCalledTimes(1);
  });

  it("cross-instance CAS: a 2nd controller (separate process) that loses the CAS is a no-op", async () => {
    // Two controllers share storage but NOT the in-process lock (simulating two
    // pods). The first wins the CAS deciding->developing; the second's CAS sees
    // state !== deciding → undefined → no-op, no second createTaskGroup.
    const loop = makeLoop({ state: "deciding", round: 2, maxRounds: 6, currentIterationNumber: 2 });
    const { storage, cas } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const createTaskGroup = vi.fn(async () => ({ group: { id: "devgrp" }, tasks: [] }));
    const mkController = () =>
      new ConsiliumLoopController({
        storage: storage as never,
        taskOrchestrator: { startGroup: vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } })), createTaskGroup, cancelGroup: vi.fn() } as never,
        config: fakeConfig,
        readIterationVerdict: async () => verdict(false, 2),
      });
    const [a, b] = await Promise.all([mkController().tick(loop.id), mkController().tick(loop.id)]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(createTaskGroup).toHaveBeenCalledTimes(1);
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
      taskOrchestrator: { startGroup: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
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
      taskOrchestrator: { startGroup: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
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
      taskOrchestrator: { startGroup: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
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
      taskOrchestrator: { startGroup: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
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

  it("DEVELOPING with null devGroupId, past grace → re-drives → exactly one createTaskGroup", async () => {
    // Genuinely stranded: a crash between the CAS claim (deciding→developing) and
    // the updateLoop that writes devGroupId left devGroupId null, AND updatedAt is
    // older than the grace window. tick re-runs the dev handoff once.
    const loop = makeLoop({ state: "developing", round: 2, devGroupId: null, currentIterationNumber: 2, updatedAt: STALE });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const createTaskGroup = vi.fn(async () => ({ group: { id: "devgrp-redrive" }, tasks: [] }));
    const startGroup = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup, createTaskGroup, cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => verdict(false, 2), // open P0s → real handoff
      readRepoHead: async () => "deadbeef", // no real git
    });
    const res = await controller.tick(loop.id);
    expect(createTaskGroup).toHaveBeenCalledTimes(1);
    expect(res?.devGroupId).toBe("devgrp-redrive");
    expect(res?.state).toBe("developing"); // state unchanged — only the ref filled
  });

  it("CROSS-INSTANCE: two controllers (two in-process Sets) re-driving the SAME stranded loop → EXACTLY ONE createTaskGroup", async () => {
    // Security gap closer: two pods, separate in-process locks, ONE storage. Both
    // read the stranded null-ref row past grace; the atomic claimRedrive lets only
    // ONE win (the other's grace predicate fails after the winner bumps
    // updatedAt) → exactly one non-idempotent side effect.
    const loop = makeLoop({ state: "developing", round: 2, devGroupId: null, currentIterationNumber: 2, updatedAt: STALE });
    const { storage, claimRedrive } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    const createTaskGroup = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20)); // keep the winner's side effect in flight
      return { group: { id: "devgrp-x" }, tasks: [] };
    });
    const mk = () =>
      new ConsiliumLoopController({
        storage: storage as never,
        taskOrchestrator: { startGroup: vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } })), createTaskGroup, cancelGroup: vi.fn() } as never,
        config: fakeConfig,
        readIterationVerdict: async () => verdict(false, 2),
        readRepoHead: async () => "deadbeef",
      });
    // Two SEPARATE controllers → two independent in-process Sets (simulating pods).
    const [a, b] = await Promise.all([mk().tick(loop.id), mk().tick(loop.id)]);
    expect(createTaskGroup).toHaveBeenCalledTimes(1); // atomic claim → no double-fire
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
      taskOrchestrator: { startGroup, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
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
      taskOrchestrator: { startGroup, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readRepoHead: async () => "abc1234",
    });
    const [a, b] = await Promise.all([controller.tick(loop.id), controller.tick(loop.id)]);
    expect(startGroup).toHaveBeenCalledTimes(1); // the duplicate-iteration regression is fixed
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.currentIterationNumber).toBe(1);
  });

  it("DEVELOPING WITH a devGroupId → does NOT re-create (advances on the existing group)", async () => {
    // Not stranded: devGroupId is set. tick must NOT re-create; it advances on
    // the existing DEV group's status (here: completed → AWAITING_MERGE).
    const loop = makeLoop({ state: "developing", round: 2, devGroupId: "existing-grp", currentIterationNumber: 2, prRef: "pr/9" });
    const { storage } = makeFakeStorage(loop, [{ round: 1, openP0: 3 }]);
    // The existing DEV group reports completed so the loop opens the merge gate.
    storage.getTaskGroup = vi.fn(async (id: string) =>
      id === "existing-grp"
        ? { id, status: "completed" }
        : { id: loop.groupId, input: "objective" },
    ) as never;
    const createTaskGroup = vi.fn(async () => ({ group: { id: "SHOULD-NOT-HAPPEN" }, tasks: [] }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), createTaskGroup, cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readRepoHead: async () => "cafef00d",
    });
    const res = await controller.tick(loop.id);
    expect(createTaskGroup).not.toHaveBeenCalled(); // no re-create on a set ref
    expect(res?.state).toBe("awaiting_merge"); // advanced on the existing group
    expect(res?.headCommitAtReview).toBe("cafef00d"); // M-3 captured
  });

  it("REVIEWING with null currentIterationNumber, past grace → re-drives the review side effect", async () => {
    const loop = makeLoop({ state: "reviewing", round: 0, currentIterationNumber: null, lastReviewedCommit: null, updatedAt: new Date(Date.now() - 120_000) });
    const { storage } = makeFakeStorage(loop);
    const startGroup = vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 1 } }));
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup, createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
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
