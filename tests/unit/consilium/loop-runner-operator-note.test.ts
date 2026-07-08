/**
 * loop-runner-operator-note.test.ts — #18 coverage.
 *
 * Runner-mode rounds never mint a `task_group_iterations` row, so the legacy
 * carry-forward (`humanNote` on the iteration, folded into the NEXT iteration's
 * `input` via `composeIterationInput`) never fires for them — the operator's
 * steering note was silently lost across runner-mode rounds.
 *
 * Fix: the note is now persisted on the ROUND record itself
 * (`consilium_loop_rounds.human_note`) and `runReviewFromLoop` (the runner-mode
 * context builder) injects the most recent round's note into round > 1 context —
 * ALONGSIDE the existing `buildPriorFindings` carry-forward, via the SAME
 * `priorFindings` field threaded into `buildDiffContext`.
 *
 * The legacy path is untouched: `startReviewRound`'s legacy branch never calls
 * `buildOperatorNote`, and `task_group_iterations.human_note` / `TaskOrchestrator`
 * are not exercised or changed here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const buildDiffContextMock = vi.fn();
vi.mock("../../../server/services/consilium/diff-context.js", () => ({
  buildDiffContext: (...args: unknown[]) => buildDiffContextMock(...args),
}));

const runReviewTasksMock = vi.fn();
vi.mock("../../../server/services/consilium/review-runner.js", () => ({
  runReviewTasks: (...args: unknown[]) => runReviewTasksMock(...args),
}));

import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import { HUMAN_NOTE_HEADING } from "../../../server/services/task-orchestrator.js";
import type { ConsiliumLoopRow, ConsiliumLoopRoundRow } from "@shared/schema";

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop1",
    groupId: "grp1",
    state: "reviewing",
    round: 2,
    maxRounds: 6,
    repoPath: process.cwd(),
    lastReviewedCommit: "abc123",
    reviewRef: null,
    reviewMode: null,
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
    humanNote: null,
    report: null,
    executionTrace: null,
    createdAt: new Date(),
    ...over,
  } as ConsiliumLoopRoundRow;
}

const configFactory = () =>
  ({
    pipeline: {
      taskGroups: { taskTimeoutMs: 300000, defaultModel: "claude-opus" },
      consiliumLoop: {
        enabled: true,
        maxRounds: 6,
        pollIntervalMs: 5000,
        maxDiffBytes: 200000,
        allowedRepoPaths: [process.cwd()],
        directReview: { enabled: true },
        implement: { enabled: false, verification: { enabled: false }, research: { enabled: false } },
      },
    },
  }) as never;

type Priv = {
  runReviewFromLoop(loop: ConsiliumLoopRow): Promise<unknown>;
};

describe("#18 — runner-mode carries the operator's steering note into round > 1 context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildDiffContextMock.mockReset();
    buildDiffContextMock.mockResolvedValue({ ok: true, input: "assembled input", truncated: false });
    runReviewTasksMock.mockReset();
    runReviewTasksMock.mockResolvedValue({ converged: false, openP0: 1, openActionPoints: [], verdict: null, participants: null });
  });

  it("round with a persisted human_note: the note is folded into the round>1 priorFindings field, alongside prior findings", async () => {
    const round1 = roundRow({ round: 1, humanNote: "Keep the retry budget at 3 — do NOT reduce it further." });
    const storage = {
      getLoopRounds: vi.fn(async () => [round1]),
      getTaskGroup: vi.fn(async () => ({ id: "grp1", name: "[consilium-review:sdlc-cross-review] x", input: "objective" })),
    };
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: configFactory,
      gateway: {} as never,
    });

    const loop = makeLoop({ round: 2 });
    await (controller as unknown as Priv).runReviewFromLoop(loop);

    expect(buildDiffContextMock).toHaveBeenCalledTimes(1);
    const call = buildDiffContextMock.mock.calls[0][0] as { priorFindings?: string };
    expect(call.priorFindings).toBeDefined();
    expect(call.priorFindings).toContain(HUMAN_NOTE_HEADING);
    expect(call.priorFindings).toContain("Keep the retry budget at 3 — do NOT reduce it further.");
  });

  it("no note on any round: priorFindings carries no operator-note section (byte-identical to before #18)", async () => {
    const round1 = roundRow({ round: 1, humanNote: null });
    const storage = {
      getLoopRounds: vi.fn(async () => [round1]),
      getTaskGroup: vi.fn(async () => ({ id: "grp1", name: "[consilium-review:sdlc-cross-review] x", input: "objective" })),
    };
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: configFactory,
      gateway: {} as never,
    });

    const loop = makeLoop({ round: 2 });
    await (controller as unknown as Priv).runReviewFromLoop(loop);

    const call = buildDiffContextMock.mock.calls[0][0] as { priorFindings?: string };
    expect(call.priorFindings ?? "").not.toContain(HUMAN_NOTE_HEADING);
  });

  it("note recorded on an EARLIER round survives past an intervening note-less round (latest-note scan)", async () => {
    const round1 = roundRow({ round: 1, humanNote: "Earlier direction: prefer the simpler fix." });
    const round2 = roundRow({ round: 2, humanNote: null });
    const storage = {
      getLoopRounds: vi.fn(async () => [round1, round2]),
      getTaskGroup: vi.fn(async () => ({ id: "grp1", name: "[consilium-review:sdlc-cross-review] x", input: "objective" })),
    };
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: configFactory,
      gateway: {} as never,
    });

    const loop = makeLoop({ round: 3 });
    await (controller as unknown as Priv).runReviewFromLoop(loop);

    const call = buildDiffContextMock.mock.calls[0][0] as { priorFindings?: string };
    expect(call.priorFindings).toContain("Earlier direction: prefer the simpler fix.");
  });

  it("round 1 (first review, no history yet): priorFindings stays undefined — nothing to inject", async () => {
    const storage = {
      getLoopRounds: vi.fn(async () => []),
      getTaskGroup: vi.fn(async () => ({ id: "grp1", name: "[consilium-review:sdlc-cross-review] x", input: "objective" })),
    };
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: configFactory,
      gateway: {} as never,
    });

    const loop = makeLoop({ round: 1 });
    await (controller as unknown as Priv).runReviewFromLoop(loop);

    const call = buildDiffContextMock.mock.calls[0][0] as { priorFindings?: string };
    expect(call.priorFindings).toBeUndefined();
  });

  it("getLoopRounds failure: buildOperatorNote is best-effort — round>1 review proceeds without the note", async () => {
    const storage = {
      getLoopRounds: vi.fn(async () => {
        throw new Error("transient storage blip");
      }),
      getTaskGroup: vi.fn(async () => ({ id: "grp1", name: "[consilium-review:sdlc-cross-review] x", input: "objective" })),
    };
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: configFactory,
      gateway: {} as never,
    });

    const loop = makeLoop({ round: 2 });
    const result = await (controller as unknown as Priv).runReviewFromLoop(loop);

    // NOT thrown/degraded because of the note lookup failure — the review still runs.
    expect(runReviewTasksMock).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
  });

  it("legacy (directReview OFF) path: startReviewRound never consults the round's human_note", async () => {
    // Even if a round row happens to carry a human_note (e.g. a loop that ran a
    // runner-mode round earlier, then the flag flipped OFF), the legacy branch of
    // startReviewRound must not inject it — it has its own carry-forward mechanism
    // (task_group_iterations.human_note / composeIterationInput), untouched by #18.
    const round1 = roundRow({ round: 1, humanNote: "should NEVER reach the legacy review input" });
    const storage = {
      getLoopRounds: vi.fn(async () => [round1]),
      getTaskGroup: vi.fn(async () => ({ id: "grp1", name: "[consilium-review:sdlc-cross-review] x", input: "objective" })),
      updateTaskGroup: vi.fn(async () => ({})),
    };
    const config = () =>
      ({
        pipeline: {
          taskGroups: { taskTimeoutMs: 300000, defaultModel: "claude-opus" },
          consiliumLoop: {
            enabled: true,
            maxRounds: 6,
            pollIntervalMs: 5000,
            maxDiffBytes: 200000,
            allowedRepoPaths: [process.cwd()],
            directReview: { enabled: false },
            implement: { enabled: false, verification: { enabled: false }, research: { enabled: false } },
          },
        },
      }) as never;
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: {
        startGroup: vi.fn(),
        startGroupAsync: vi.fn(async () => ({ group: {}, iteration: { iterationNumber: 2 } })),
        createTaskGroup: vi.fn(),
        cancelGroup: vi.fn(),
      } as never,
      config,
      gateway: {} as never,
    });

    type LegacyPriv = {
      startReviewRound(loop: ConsiliumLoopRow, opts?: { relaunch?: boolean }): Promise<Record<string, unknown>>;
    };
    const loop = makeLoop({ round: 1 }); // startReviewRound reads loop.round BEFORE incrementing
    await (controller as unknown as LegacyPriv).startReviewRound(loop);

    expect(buildDiffContextMock).toHaveBeenCalledTimes(1);
    const call = buildDiffContextMock.mock.calls[0][0] as { priorFindings?: string };
    expect(call.priorFindings ?? "").not.toContain(HUMAN_NOTE_HEADING);
    expect(call.priorFindings ?? "").not.toContain("should NEVER reach the legacy review input");
  });
});
