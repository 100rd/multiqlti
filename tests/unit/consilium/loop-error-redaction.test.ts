/**
 * loop-error-redaction.test.ts — B-sec L1: an EXCEPTION-derived `loop.error` must be a
 * FIXED GENERIC; the raw (scrubbed) detail goes to the LOGS ONLY.
 *
 * The one raw-leak site is `recordRound`'s non-unique audit-write failure: it used to
 * persist `round N audit write failed: ${err.message}` — an UNSCRUBBED exception string on
 * the persisted, UI-rendered `loop.error`. Now the row carries the FIXED generic
 * `round N audit write failed`, and the scrubbed detail rides the server log only.
 *
 * (Curated explanations — composeCancelExplanation, failUnresolvedReview, merge-HEAD-delta —
 * and the already-scrubbed operator reasons are UNCHANGED and covered by their own suites;
 * this file pins the one redaction.)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";
import type { ConvergenceVerdict } from "@shared/types";

const CONVERGED: ConvergenceVerdict = { converged: true, openP0: 0, openActionPoints: [] };

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop1",
    groupId: "grp1",
    state: "deciding",
    round: 2,
    maxRounds: 6,
    repoPath: process.cwd(),
    lastReviewedCommit: null,
    currentIterationNumber: 2, // legacy round ⇒ resolveVerdict uses the injected seam
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

/** Storage whose appendLoopRound throws a RAW, path-bearing NON-unique error. */
function makeFakeStorage(loop: ConsiliumLoopRow, rawAppendError: string) {
  let current = loop;
  const cas = vi.fn(
    async (id: string, expected: ConsiliumLoopState, next: ConsiliumLoopState, extra?: Record<string, unknown>) => {
      if (id !== current.id || current.state !== expected) return undefined;
      current = { ...current, ...(extra ?? {}), state: next };
      return current;
    },
  );
  const storage = {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => []),
    casLoopState: cas,
    claimRedrive: vi.fn(async () => undefined),
    appendLoopRound: vi.fn(async () => {
      throw new Error(rawAppendError);
    }),
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, input: "objective" })),
    updateTaskGroup: vi.fn(async () => ({})),
    getIteration: vi.fn(async () => ({ id: "it1", iterationNumber: current.currentIterationNumber ?? 1, status: "completed" })),
    getExecutionsByIteration: vi.fn(async () => []),
  };
  return { storage, get: () => current };
}

const fakeConfig = () =>
  ({
    pipeline: {
      taskGroups: { taskTimeoutMs: 300000 },
      consiliumLoop: { enabled: true, maxRounds: 6, pollIntervalMs: 5000, maxDiffBytes: 200000, allowedRepoPaths: [process.cwd()], implement: { enabled: false, verification: { enabled: false }, research: { enabled: false } } },
    },
  }) as never;

afterEach(() => vi.restoreAllMocks());

describe("B-sec L1 — recordRound audit-write failure redacts the exception off loop.error", () => {
  it("persists a FIXED GENERIC on loop.error; the raw scrubbed detail goes to the LOGS only", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const RAW = "disk full writing /Users/secret/db.sock"; // a path + a secret-y token
    const loop = makeLoop({ state: "deciding", round: 2, currentIterationNumber: 2 });
    const { storage, get } = makeFakeStorage(loop, RAW);
    const controller = new ConsiliumLoopController({
      storage: storage as never,
      taskOrchestrator: { startGroup: vi.fn(), startGroupAsync: vi.fn(), createTaskGroup: vi.fn(), cancelGroup: vi.fn() } as never,
      config: fakeConfig,
      readIterationVerdict: async () => CONVERGED, // deciding → converged (terminal) ⇒ recordRound
      readRepoHead: async () => "HEADSHA",
    });

    const res = await controller.tick(loop.id);

    // The FSM transition still committed (audit write is best-effort, never blocks it).
    expect(res?.state).toBe("converged");
    // loop.error is the FIXED GENERIC — NO raw message, NO path, NO secret token.
    expect(get().error).toBe("round 2 audit write failed");
    expect(get().error).not.toContain("disk full");
    expect(get().error).not.toContain("/Users/secret");
    // The scrubbed detail reached the LOGS: fs path stripped to <path>, raw path absent.
    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes("disk full writing <path>"))).toBe(true);
    expect(logged.some((l) => l.includes("/Users/secret"))).toBe(false);
  });
});
