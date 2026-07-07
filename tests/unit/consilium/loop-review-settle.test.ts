/**
 * loop-review-settle.test.ts — B5 (Phase 2) coverage for the runner-mode SETTLE→CONSUME
 * side of the reviewing transition, the peer of loop-review-dispatch.test.ts (B4 = dispatch).
 *
 * Once a background direct review settles in `reviewRuns`, `deriveReviewEvent` reads it
 * (keyed off the ROUND's actual mode — the entry — NOT the live flag) and drives the FSM:
 *   - clean settle  ⇒ reviewing→deciding, and `recordRound` persists the round audit with
 *     the runner's ALREADY-parsed judge verdict + participants (on the CAS winner, in
 *     runSideEffect), then the consumed entry is dropped.
 *   - degraded settle ⇒ reviewing→failed carrying the FIXED-GENERIC `loop.error`
 *     ("review run failed"); the raw scrubbed detail goes to the LOGS only (Security L1);
 *     NO round recorded (mirrors a failed legacy iteration); entry dropped.
 *   - in-flight ⇒ no transition (loop stays reviewing, entry intact).
 *
 * Double-record: the runner records round N (rich) at reviewing→deciding; the later
 * deciding→terminal recordRound(N) re-append MUST hit the idempotent UNIQUE(loop,round)
 * swallow (Postgres/Mem `code = "23505"`), leaving the rich row intact and `loop.error`
 * clean. deciding is unstuck here via the existing `readIterationVerdict` seam (runner-mode
 * verdict-read is B6); this file only proves the double-record is non-destructive.
 *
 * Flag-OFF / legacy parity is proven by the whole consilium/loop-fsm suite passing
 * UNMODIFIED; the last case here additionally pins the straddle fall-through (no entry ⇒
 * the UNCHANGED iteration path).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState, ConsiliumLoopRoundRow, InsertConsiliumLoopRound } from "@shared/schema";
import type { RoundVerdict, RoundParticipant, ActionPoint } from "@shared/types";

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
 * Fake storage honouring the CAS + STORING rounds with a real UNIQUE(loop,round) guard
 * (throws the Postgres-parity `code = "23505"` on a duplicate append), so the double-record
 * idempotency is exercised for real — not stubbed away.
 */
function makeFakeStorage(loop: ConsiliumLoopRow) {
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
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, name: "[consilium-review:sdlc-cross-review] x", input: "objective" })),
    getIteration: vi.fn(async () => undefined),
    getExecutionsByIteration: vi.fn(async () => []),
  };
  return { storage, get: () => current, rounds: () => roundRows };
}

const configWith = (directReviewEnabled: boolean) =>
  (() => ({
    pipeline: {
      taskGroups: { taskTimeoutMs: 300000, defaultModel: "claude-opus" },
      consiliumLoop: {
        enabled: true,
        maxRounds: 6,
        pollIntervalMs: 5000,
        maxDiffBytes: 200000,
        allowedRepoPaths: [process.cwd()],
        directReview: { enabled: directReviewEnabled },
        implement: { enabled: false, verification: { enabled: false }, research: { enabled: false } },
      },
    },
    providers: {},
  })) as never;

const orchestratorStub = {
  startGroup: vi.fn(),
  startGroupAsync: vi.fn(),
  createTaskGroup: vi.fn(),
  cancelGroup: vi.fn(),
} as never;

/** Seed a settled/in-flight review run directly (isolates the consume from the dispatch). */
function seedReviewRun(controller: ConsiliumLoopController, loopId: string, run: unknown): void {
  (controller as unknown as { reviewRuns: Map<string, unknown> }).reviewRuns.set(loopId, run);
}
function reviewRunsOf(controller: ConsiliumLoopController): Map<string, unknown> {
  return (controller as unknown as { reviewRuns: Map<string, unknown> }).reviewRuns;
}

const AP: ActionPoint = { title: "fix the null deref", priority: "P0" } as ActionPoint;
const VERDICT: RoundVerdict = {
  verdict: "not yet — one P0 open",
  pros: ["clear structure"],
  cons: ["missing guard"],
  actionPoints: [AP],
};
const PARTICIPANTS: RoundParticipant[] = [
  { name: "reviewer-a", model: "claude-opus", role: "primary", text: "found a null deref" },
  { name: "reviewer-b", model: "claude-sonnet", role: "rebuttal", text: "agree, P0" },
];

afterEach(() => vi.restoreAllMocks());

describe("B5 — reviewing settle→consume drives the FSM off the reviewRuns registry", () => {
  it("clean settle ⇒ reviewing→deciding, round persisted with verdict+participants, entry dropped", async () => {
    const loop = makeLoop({ state: "reviewing", round: 1, currentIterationNumber: null });
    const { storage, get, rounds } = makeFakeStorage(loop);
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestratorStub,
      config: configWith(true),
      readRepoHead: async () => "HEADSHA",
    });
    seedReviewRun(controller, loop.id, {
      round: 1,
      done: true,
      result: { converged: false, openP0: 1, openActionPoints: [AP], verdict: VERDICT, participants: PARTICIPANTS },
    });

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("deciding");
    expect(get().state).toBe("deciding");
    // The round audit was persisted with the runner's parsed verdict + participants.
    expect(rounds()).toHaveLength(1);
    expect(rounds()[0]).toMatchObject({
      round: 1,
      converged: false,
      openP0: 1,
      verdict: VERDICT,
      participants: PARTICIPANTS,
      headCommit: "HEADSHA",
    });
    // The consumed entry was dropped.
    expect(reviewRunsOf(controller).get(loop.id)).toBeUndefined();
  });

  it("degraded settle ⇒ reviewing→failed with the FIXED-GENERIC error, raw→logs only, NO round, entry dropped", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const loop = makeLoop({ state: "reviewing", round: 2, currentIterationNumber: null });
    const { storage, get, rounds } = makeFakeStorage(loop);
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestratorStub,
      config: configWith(true),
      readRepoHead: async () => "HEADSHA",
    });
    seedReviewRun(controller, loop.id, {
      round: 2,
      done: true,
      result: { converged: false, openP0: 0, openActionPoints: [], verdict: null, participants: null, error: "kaboom in <path>" },
    });

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("failed");
    // L1: loop.error is the FIXED GENERIC — the raw detail never reaches it.
    expect(res?.error).toBe("review run failed");
    expect(res?.error).not.toContain("kaboom");
    // A degraded run records NO round (mirrors a failed legacy iteration).
    expect(rounds()).toHaveLength(0);
    // Entry dropped.
    expect(reviewRunsOf(controller).get(loop.id)).toBeUndefined();
    // Raw scrubbed detail went to the LOGS only.
    const loggedRaw = logSpy.mock.calls.some(
      (c) => String(c[0]).includes("review run degraded") && String(c[0]).includes("kaboom"),
    );
    expect(loggedRaw).toBe(true);
    expect(get().state).toBe("failed");
  });

  it("in-flight settle ⇒ no transition (loop stays reviewing, entry intact, no round)", async () => {
    const loop = makeLoop({ state: "reviewing", round: 1, currentIterationNumber: null });
    const { storage, get, rounds } = makeFakeStorage(loop);
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestratorStub,
      config: configWith(true),
      readRepoHead: async () => "HEADSHA",
    });
    seedReviewRun(controller, loop.id, { round: 1, done: false });

    const res = await controller.tick(loop.id);

    expect(res).toBeNull(); // no event ⇒ no-op
    expect(get().state).toBe("reviewing");
    expect(reviewRunsOf(controller).get(loop.id)).toMatchObject({ round: 1, done: false });
    expect(rounds()).toHaveLength(0);
  });

  it("double-record: the later deciding→terminal recordRound(N) hits the UNIQUE swallow — rich row survives, loop.error clean", async () => {
    const loop = makeLoop({ state: "reviewing", round: 1, currentIterationNumber: null });
    const { storage, get, rounds } = makeFakeStorage(loop);
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestratorStub,
      config: configWith(true),
      readRepoHead: async () => "HEADSHA",
      // Unstick deciding for THIS test (runner-mode verdict-read is B6): a converged
      // verdict routes deciding→converged, exercising the terminal recordRound(1) re-append.
      readIterationVerdict: async () => ({ converged: true, openP0: 0, openActionPoints: [] }),
    });
    seedReviewRun(controller, loop.id, {
      round: 1,
      done: true,
      result: { converged: true, openP0: 0, openActionPoints: [], verdict: VERDICT, participants: PARTICIPANTS },
    });

    await controller.tick(loop.id); // reviewing→deciding, records round 1 (rich)
    expect(get().state).toBe("deciding");
    expect(rounds()).toHaveLength(1);

    await controller.tick(loop.id); // deciding→converged, recordRound(1)#2 → UNIQUE swallow
    expect(get().state).toBe("converged");

    // Exactly ONE round row, still carrying the runner's rich verdict + participants
    // (the #2 re-append — verdict:null/participants:null — was swallowed, never overwrote).
    expect(rounds()).toHaveLength(1);
    expect(rounds()[0]).toMatchObject({ round: 1, verdict: VERDICT, participants: PARTICIPANTS });
    // UNIQUE-swallow is a true no-op: loop.error stays clean (never the audit-write path).
    expect(get().error ?? null).toBeNull();
  });

  it("legacy straddle: NO reviewRuns entry ⇒ the UNCHANGED iteration path drives review_completed", async () => {
    const loop = makeLoop({ state: "reviewing", round: 1, currentIterationNumber: 7 });
    const { storage, get, rounds } = makeFakeStorage(loop);
    // Legacy: a settled task-group iteration + an injected iteration verdict (the old seam).
    storage.getIteration = vi.fn(async () => ({ status: "completed" })) as never;
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: orchestratorStub,
      config: configWith(true), // flag ON, but NO entry for this round ⇒ still legacy path
      readRepoHead: async () => "HEADSHA",
      readIterationVerdict: async () => ({ converged: false, openP0: 1, openActionPoints: [AP] }),
    });
    // NO seedReviewRun — the straddle must fall through to the iteration poll.

    const res = await controller.tick(loop.id);

    expect(res?.state).toBe("deciding"); // review_completed via the legacy iteration path
    expect(reviewRunsOf(controller).get(loop.id)).toBeUndefined(); // never a runner entry
    // Legacy reviewing→deciding records NO round here (recorded later at deciding→X), and
    // carries no participants — proving the runner branch stayed inert.
    expect(rounds()).toHaveLength(0);
    expect(get().state).toBe("deciding");
  });
});
