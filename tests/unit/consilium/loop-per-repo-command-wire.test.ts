/**
 * loop-per-repo-command-wire.test.ts — PER-REPO command overrides reach the executor.
 *
 * The controller resolves the EFFECTIVE test/lint command + timeout + coder model for
 * the loop's repoPath (`resolveImplementForRepo`) and threads the RESOLVED values into
 * the SDLC request — NOT the raw global keys. Here we assert the observable end: what
 * `runSdlc` receives for a repo WITH a per-repo entry, for a repo WITHOUT one (falls
 * back to the global keys), and that an absent `perRepo` is byte-identical to today.
 */
import { describe, it, expect, vi } from "vitest";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";
import type { ConvergenceVerdict } from "@shared/types";

const REPO_PY = "/repos/py";
const REPO_NODE = "/repos/node";

const verdict = (openP0: number): ConvergenceVerdict => ({
  converged: false,
  openP0,
  openActionPoints: Array.from({ length: openP0 }, (_, i) => ({ title: `ap${i}`, priority: "P0" })),
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop-1",
    projectId: "proj1",
    groupId: "grp1",
    state: "deciding",
    round: 2,
    maxRounds: 6,
    repoPath: REPO_PY,
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
  return {
    getLoop: vi.fn(async () => current),
    getLoops: vi.fn(async () => [current]),
    getLoopRounds: vi.fn(async () => []),
    casLoopState: vi.fn(
      async (id: string, expected: ConsiliumLoopState, next: ConsiliumLoopState, extra?: Record<string, unknown>) => {
        if (id !== current.id || current.state !== expected) return undefined;
        current = { ...current, ...(extra ?? {}), state: next };
        return current;
      },
    ),
    claimRedrive: vi.fn(async () => undefined),
    appendLoopRound: vi.fn(async () => ({})),
    updateLoopRoundTestSummary: vi.fn(async () => undefined),
    updateLoop: vi.fn(async (_id: string, extra?: Record<string, unknown>) => {
      current = { ...current, ...(extra ?? {}) };
      return current;
    }),
    getTaskGroup: vi.fn(async () => ({ id: current.groupId, input: "objective" })),
    updateTaskGroup: vi.fn(async () => ({})),
    getIteration: vi.fn(async () => ({ id: "it1", iterationNumber: 2, status: "completed" })),
    getExecutionsByIteration: vi.fn(async () => []),
  };
}

/** Config with verification effectively ON (ack) + a per-repo override map. */
const makeConfig =
  (perRepo?: Record<string, unknown>) =>
  () =>
    ({
      features: { sandbox: { enabled: false } },
      pipeline: {
        consiliumLoop: {
          enabled: true,
          maxRounds: 6,
          pollIntervalMs: 5000,
          maxDiffBytes: 200000,
          sdlcTimeoutMs: 600000,
          allowedRepoPaths: [REPO_PY, REPO_NODE],
          implement: {
            enabled: true,
            verification: { enabled: true },
            trustedRepoAck: true, // ⇒ effectiveVerificationEnabled = true (test cmd threaded)
            maxFixIterations: 3,
            testCommand: "npm test", // GLOBAL default
            lintCommand: "npm run lint", // GLOBAL default
            testRunTimeoutMs: 300000, // GLOBAL default
            coderModel: "claude-sonnet", // GLOBAL default
            perRepo,
            finalVerification: { enabled: false, maxFinalFixIterations: 1 },
          },
        },
      },
    }) as never;

function controllerWith(config: () => unknown, runSdlc: ReturnType<typeof vi.fn>, storage: unknown) {
  return new ConsiliumLoopController({
    storage: storage as never,
    taskOrchestrator: {
      startGroup: vi.fn(),
      startGroupAsync: vi.fn(),
      createTaskGroup: vi.fn(),
      cancelGroup: vi.fn(),
    } as never,
    config: config as never,
    readIterationVerdict: async () => verdict(2),
    // Inject head read so the virtual (non-existent) repoPaths never hit real git.
    readRepoHead: async () => "headsha000",
    runSdlc: runSdlc as never,
  });
}

describe("per-repo command wire — the RESOLVED command reaches runSdlc", () => {
  it("a repo WITH a per-repo entry threads the OVERRIDE (test/lint/timeout/model)", async () => {
    const loop = makeLoop({ repoPath: REPO_PY });
    const storage = fakeStorage(loop);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = controllerWith(
      makeConfig({
        [REPO_PY]: {
          testCommand: "uv run pytest",
          lintCommand: "ruff check",
          testRunTimeoutMs: 600000,
          coderModel: "opus",
        },
      }),
      runSdlc,
      storage,
    );
    await controller.tick(loop.id);
    await flush();

    const req = runSdlc.mock.calls[0][0];
    expect(req.coderModel).toBe("opus");
    expect(req.verification).toEqual(
      expect.objectContaining({
        testCommand: "uv run pytest",
        lintCommand: "ruff check",
        testRunTimeoutMs: 600000,
      }),
    );
  });

  it("a repo WITHOUT a per-repo entry falls back to the GLOBAL keys", async () => {
    const loop = makeLoop({ repoPath: REPO_NODE });
    const storage = fakeStorage(loop);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = controllerWith(
      makeConfig({ [REPO_PY]: { testCommand: "uv run pytest" } }), // only /repos/py mapped
      runSdlc,
      storage,
    );
    await controller.tick(loop.id);
    await flush();

    const req = runSdlc.mock.calls[0][0];
    expect(req.coderModel).toBe("claude-sonnet");
    expect(req.verification).toEqual(
      expect.objectContaining({
        testCommand: "npm test",
        lintCommand: "npm run lint",
        testRunTimeoutMs: 300000,
      }),
    );
  });

  it("an ABSENT perRepo is byte-identical to the global-only request (backward-compat)", async () => {
    const loop = makeLoop({ repoPath: REPO_PY });
    const storage = fakeStorage(loop);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = controllerWith(makeConfig(undefined), runSdlc, storage);
    await controller.tick(loop.id);
    await flush();

    const req = runSdlc.mock.calls[0][0];
    expect(req.coderModel).toBe("claude-sonnet");
    expect(req.verification).toEqual(
      expect.objectContaining({
        enabled: true,
        maxFixIterations: 3,
        testCommand: "npm test",
        lintCommand: "npm run lint",
        testRunTimeoutMs: 300000,
      }),
    );
  });

  it("a per-repo entry for a NON-ALLOWLISTED repo is harmless dead config (adversarial)", async () => {
    // /repos/py is allowlisted; the entry for /elsewhere never matches this loop and the
    // allowlist is enforced independently — so the loop still runs with the GLOBAL keys.
    const loop = makeLoop({ repoPath: REPO_PY });
    const storage = fakeStorage(loop);
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "" }));
    const controller = controllerWith(
      makeConfig({ "/elsewhere/not-allowed": { testCommand: "rm -rf /" } }),
      runSdlc,
      storage,
    );
    await controller.tick(loop.id);
    await flush();

    const req = runSdlc.mock.calls[0][0];
    expect(req.verification.testCommand).toBe("npm test"); // global, NOT the dead entry
  });
});
