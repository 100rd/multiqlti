/**
 * loop-runner-verdict-straddle.test.ts — B6 (Phase 2) coverage for the verdict/action-point
 * STRADDLE read + the anti-stall guard.
 *
 * `resolveVerdict` / `resolveDevActionPoints` read the loop's CURRENT round via the round's
 * ACTUAL mode (NOT the live directReview flag): a RUNNER round (identified by a recorded
 * round row carrying `participants`, under the `currentIterationNumber == null` marker)
 * yields its convergence + full action-point list straight off the persisted row (written
 * by recordRound via the SHARED readConvergence/readJudgeVerdict — no re-parse); a LEGACY
 * round falls through to the UNCHANGED old path (the `readIterationVerdict` seam / executions).
 *
 * Anti-stall guard (`deriveDecideEvent`): a runner round records its row EARLY (at
 * reviewing→deciding), so the current round is already in `getLoopRounds` during its own
 * deciding. The guard builds the prior series from rounds STRICTLY BEFORE the current round
 * then pushes the fresh verdict — excluding the early row so it is not double-counted
 * (which would corrupt isAntiStall's 3-window AND decide()'s round number). Byte-identical
 * for legacy (the current round is not recorded during its own deciding, so nothing is
 * excluded). The exact bug Architect reproduced (runner r1=2/r2=2 flat ⇒ spurious escalate)
 * is pinned here as the parity gate.
 */
import { describe, it, expect, vi } from "vitest";
import { ConsiliumLoopController, reduce } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopRoundRow, ConvergenceVerdict } from "@shared/schema";
import type { RoundVerdict, RoundParticipant, ActionPoint } from "@shared/types";

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop1",
    groupId: "grp1",
    state: "deciding",
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

const AP0: ActionPoint = { title: "fix the null deref", priority: "P0" } as ActionPoint;
const AP1: ActionPoint = { title: "tidy the log line", priority: "P1" } as ActionPoint;
const VERDICT: RoundVerdict = { verdict: "one P0 open", pros: ["ok"], cons: ["gap"], actionPoints: [AP0, AP1] };
const PARTS: RoundParticipant[] = [{ name: "rev-a", model: "claude-opus", role: "primary", text: "found it" }];

function roundRow(over: Partial<ConsiliumLoopRoundRow>): ConsiliumLoopRoundRow {
  return {
    id: `r${over.round}`,
    loopId: "loop1",
    round: 1,
    iterationNumber: 1,
    converged: false,
    openP0: 0,
    openActionPoints: [],
    verdict: null,
    participants: null,
    baselineCommit: null,
    headCommit: null,
    testSummary: null,
    report: null,
    executionTrace: null,
    createdAt: new Date(),
    ...over,
  } as ConsiliumLoopRoundRow;
}

/** Minimal storage exposing the reads the straddle + old path touch. */
function makeController(opts: {
  rounds: ConsiliumLoopRoundRow[];
  readIterationVerdict?: (loop: ConsiliumLoopRow) => Promise<ConvergenceVerdict | null>;
}) {
  const storage = {
    getLoopRounds: vi.fn(async () => opts.rounds),
    getIteration: vi.fn(async () => ({ id: "it", status: "completed" })),
    getExecutionsByIteration: vi.fn(async () => []),
    getTaskGroup: vi.fn(async () => ({ id: "grp1", name: "x", input: "obj" })),
  };
  const controller = new ConsiliumLoopController({
    storage: storage as never,
    taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
    config: (() => ({ pipeline: { taskGroups: { taskTimeoutMs: 300000 }, consiliumLoop: { enabled: true, maxRounds: 6, pollIntervalMs: 5000, allowedRepoPaths: [process.cwd()], directReview: { enabled: true } } } })) as never,
    ...(opts.readIterationVerdict ? { readIterationVerdict: opts.readIterationVerdict } : {}),
  });
  return { controller, storage };
}
type Priv = {
  resolveVerdict(loop: ConsiliumLoopRow): Promise<ConvergenceVerdict | null>;
  resolveDevActionPoints(loop: ConsiliumLoopRow): Promise<ActionPoint[]>;
  deriveDecideEvent(loop: ConsiliumLoopRow): Promise<{ kind: string; verdict: ConvergenceVerdict; priorOpenP0: number[] } | null>;
};

describe("B6 — verdict/action-point straddle keys off the round's actual mode", () => {
  it("runner round: resolveVerdict reads convergence off the round row, NOT the iteration seam", async () => {
    const loop = makeLoop({ round: 1, currentIterationNumber: null });
    const round = roundRow({ round: 1, converged: false, openP0: 3, openActionPoints: [AP0], verdict: VERDICT, participants: PARTS });
    // The iteration seam would return a DIFFERENT verdict — the runner round must win.
    const { controller } = makeController({ rounds: [round], readIterationVerdict: async () => ({ converged: true, openP0: 0, openActionPoints: [] }) });

    const v = await (controller as unknown as Priv).resolveVerdict(loop);

    expect(v).toEqual({ converged: false, openP0: 3, openActionPoints: [AP0] });
  });

  it("runner round: resolveDevActionPoints returns the FULL ranked list from the persisted RoundVerdict", async () => {
    const loop = makeLoop({ round: 1, currentIterationNumber: null });
    const round = roundRow({ round: 1, openP0: 1, openActionPoints: [AP0], verdict: VERDICT, participants: PARTS });
    const { controller } = makeController({ rounds: [round] });

    const aps = await (controller as unknown as Priv).resolveDevActionPoints(loop);

    expect(aps).toEqual([AP0, AP1]); // FULL list (all priorities), not just the open subset
  });

  it("legacy round (iteration set, participants null): resolveVerdict falls through to the OLD-path seam", async () => {
    const loop = makeLoop({ round: 1, currentIterationNumber: 5 });
    // A recorded round with participants NULL is a legacy round — the straddle must NOT claim it.
    const round = roundRow({ round: 1, converged: false, openP0: 9, verdict: VERDICT, participants: null });
    const seam = async () => ({ converged: true, openP0: 0, openActionPoints: [] });
    const { controller } = makeController({ rounds: [round], readIterationVerdict: seam });

    const v = await (controller as unknown as Priv).resolveVerdict(loop);

    // The OLD-path seam wins (converged:true) — NOT the legacy round row's openP0:9.
    expect(v).toEqual({ converged: true, openP0: 0, openActionPoints: [] });
  });

  it("anti-stall PARITY (the gate): a runner 2-round FLAT-openP0 loop (r1=2, r2=2) does NOT spuriously escalate", async () => {
    const loop = makeLoop({ state: "deciding", round: 2, currentIterationNumber: null });
    const r1 = roundRow({ round: 1, openP0: 2, participants: PARTS });
    // r2 is the CURRENT round, recorded EARLY at reviewing→deciding (runner-mode).
    const r2 = roundRow({ round: 2, converged: false, openP0: 2, openActionPoints: [AP0], verdict: VERDICT, participants: PARTS });
    const { controller } = makeController({ rounds: [r1, r2] });

    const event = await (controller as unknown as Priv).deriveDecideEvent(loop);

    expect(event?.kind).toBe("decided");
    // The guard excluded the early r2 row: [2,2], NOT the double-counted [2,2,2].
    expect(event?.priorOpenP0).toEqual([2, 2]);
    expect(reduce("deciding", { kind: "decided", verdict: event!.verdict, priorOpenP0: event!.priorOpenP0 })?.to).toBe("developing");
    // Contrast: the double-counted series is exactly what would have spuriously escalated.
    expect(reduce("deciding", { kind: "decided", verdict: event!.verdict, priorOpenP0: [2, 2, 2] })?.to).toBe("escalated");
  });

  it("legacy guard parity: a legacy 3-round loop still pushes the fresh verdict (round not pre-recorded) and anti-stall is UNCHANGED", async () => {
    const loop = makeLoop({ state: "deciding", round: 3, currentIterationNumber: 9 });
    // Legacy: only PRIOR rounds are recorded during this round's deciding (round 3 not yet).
    const r1 = roundRow({ round: 1, openP0: 2, participants: null });
    const r2 = roundRow({ round: 2, openP0: 2, participants: null });
    const { controller } = makeController({ rounds: [r1, r2], readIterationVerdict: async () => ({ converged: false, openP0: 2, openActionPoints: [AP0] }) });

    const event = await (controller as unknown as Priv).deriveDecideEvent(loop);

    // Push FIRED: filter(r<3)=[r1,r2]=[2,2], then push the fresh 2 → [2,2,2] (length rounds.length+1).
    expect(event?.priorOpenP0).toEqual([2, 2, 2]);
    // Legacy anti-stall behaviour is preserved — a genuine 3-round flat stall STILL escalates.
    expect(reduce("deciding", { kind: "decided", verdict: event!.verdict, priorOpenP0: event!.priorOpenP0 })?.to).toBe("escalated");
  });
});
