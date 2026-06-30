/**
 * execute-sdlc-service.test.ts — the SERVER path that EXECUTES a consilium
 * verdict's action_points via the SDLC executor (human-triggered DEVELOPING
 * phase). Drives `SdlcExecutionService` directly with a fake storage + a MOCKED
 * `runSdlcHandoff` (deps.runSdlc), asserting:
 *   - action points are SERVER-READ from the latest iteration's Judge verdict
 *     (the FULL bounded list) and handed to the executor;
 *   - repoPath is resolved from the loop (else the body) and RE-VALIDATED through
 *     the global allowlist AND the per-project workspace gate — a rejection runs
 *     NOTHING and frees the registry slot;
 *   - no verdict / no action points → a clean NO_ACTION_POINTS rejection;
 *   - the branch-shape invariant: a FRESH uuid loopId + round 1;
 *   - single-flight: an in-flight run dedups (no 2nd executor dispatch);
 *   - the status registry reflects running → done / failed;
 *   - MED-1: a global concurrency CAP refuses an (N+1)th DISTINCT-group run with
 *     EXECUTOR_BUSY while N run, but never caps a deduped already-running group;
 *   - MED-2: a watchdog FORCE-settles a never-resolving run past its time budget,
 *     frees the slot (relaunch works), and wins over a late resolve (no double-
 *     settle); a SETTLED row is GC'd after the retention window but a running one
 *     is never evicted;
 *   - LOW-1: the happy-path settle scrubs `result.error` (no fs leak).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppConfig } from "../../../server/config/schema.js";
import type { IStorage } from "../../../server/storage.js";
import type { SdlcHandoffResult, SdlcProgress } from "../../../server/services/sdlc/executor.js";
import {
  SdlcExecutionService,
  ExecuteSdlcError,
  MAX_CONCURRENT_EXECUTE_SDLC,
} from "../../../server/services/consilium/execute-sdlc.js";

const GROUP = "group-1";
const OWNER = "user-1";
const ALLOWED = "/repos";
const LOOP_REPO = "/repos/widget";
const SDLC_TIMEOUT_MS = 1_234_000;
const WATCHDOG_MARGIN_MS = 60_000;
const SETTLED_RETENTION_MS = 10 * 60_000;

/** A judge execution output carrying a verdict + a mixed-priority action_points list. */
const JUDGE_OUTPUT = {
  verdict: "needs work",
  action_points: [
    { title: "AP1 fix the auth bug", priority: "P0", rationale: "security" },
    { title: "AP2 add tests", priority: "P1" },
  ],
};

interface FakeStorageOpts {
  iteration?: { id: string; groupId: string; iterationNumber: number; status?: string } | undefined;
  executionOutputs?: unknown[];
  loops?: { groupId: string; repoPath: string; createdAt: Date }[];
  workspaces?: { path: string }[];
}

function makeStorage(opts: FakeStorageOpts): IStorage {
  // NOTE: respect an EXPLICIT `iteration: undefined` (a destructuring default
  // would treat undefined as "absent" and re-apply the default — masking the
  // no-verdict case), so key on presence.
  const iteration =
    "iteration" in opts
      ? opts.iteration
      : { id: "iter-1", groupId: GROUP, iterationNumber: 3, status: "completed" };
  const {
    executionOutputs = [JUDGE_OUTPUT],
    loops = [{ groupId: GROUP, repoPath: LOOP_REPO, createdAt: new Date() }],
    workspaces = [{ path: ALLOWED }],
  } = opts;
  return {
    getLatestIteration: vi.fn(async (g: string) => (iteration && iteration.groupId === g ? iteration : undefined)),
    getExecutionsByIteration: vi.fn(async () => executionOutputs.map((output) => ({ output }))),
    getLoops: vi.fn(async () => loops),
    getWorkspaces: vi.fn(async () => workspaces),
  } as unknown as IStorage;
}

/**
 * A storage that serves ANY of `groupIds` (each with its own verdict + loop), for
 * the MED-1 global-cap test where several DISTINCT groups run concurrently.
 */
function makeMultiStorage(groupIds: string[]): IStorage {
  return {
    getLatestIteration: vi.fn(async (g: string) => ({ id: `iter-${g}`, groupId: g, iterationNumber: 1 })),
    getExecutionsByIteration: vi.fn(async () => [{ output: JUDGE_OUTPUT }]),
    getLoops: vi.fn(async () => groupIds.map((g) => ({ groupId: g, repoPath: LOOP_REPO, createdAt: new Date() }))),
    getWorkspaces: vi.fn(async () => [{ path: ALLOWED }]),
  } as unknown as IStorage;
}

function makeConfig(allowedRepoPaths: string[] = [ALLOWED], sdlcTimeoutMs = SDLC_TIMEOUT_MS): () => AppConfig {
  return () => ({ pipeline: { consiliumLoop: { allowedRepoPaths, sdlcTimeoutMs } } }) as unknown as AppConfig;
}

const PR_RESULT: SdlcHandoffResult = { prRef: "https://gh/pr/1", headCommit: "abc123" };

function makeService(storage: IStorage, runSdlc = vi.fn(async () => PR_RESULT), config = makeConfig()) {
  return { service: new SdlcExecutionService({ storage, config, runSdlc }), runSdlc };
}

/** A never-resolving executor — keeps a run pinned at "running" for the test. */
function neverResolves() {
  return vi.fn(() => new Promise<SdlcHandoffResult>(() => {}));
}

describe("SdlcExecutionService.execute — server-read action points + executor dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SERVER-READS the full action_points list and hands it to the executor", async () => {
    const { service, runSdlc } = makeService(makeStorage({}));
    const handle = await service.execute(GROUP, OWNER);

    expect(handle.status).toBe("running");
    expect(handle.deduped).toBe(false);
    expect(handle.actionPointCount).toBe(2); // BOTH P0 and P1 — not the loop's P0-only narrowing
    expect(runSdlc).toHaveBeenCalledTimes(1);

    const arg = runSdlc.mock.calls[0][0] as Parameters<typeof runSdlc>[0];
    expect(arg.actionPoints.map((a) => a.title)).toEqual([
      "AP1 fix the auth bug",
      "AP2 add tests",
    ]);
    // repoPath came from the loop (realpath of /repos/widget) + executor inputs.
    expect(arg.repoPath).toBe(LOOP_REPO);
    expect(arg.ownerId).toBe(OWNER);
    expect(arg.coderTimeoutMs).toBe(SDLC_TIMEOUT_MS);
    expect(arg.allowedRepoPaths).toEqual([ALLOWED]);
    // Branch-shape invariant: a FRESH uuid loopId (NOT the loop id) + round 1.
    expect(arg.round).toBe(1);
    expect(arg.loopId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(handle.runId).toBe(arg.loopId);
  });

  it("status reflects running → done with the prRef once the background run settles", async () => {
    const { service } = makeService(makeStorage({}));
    const handle = await service.execute(GROUP, OWNER);
    expect(handle.status).toBe("running"); // the returned handle is deterministically running

    await vi.waitFor(() => expect(service.getStatus(GROUP)?.status).toBe("done"));
    const status = service.getStatus(GROUP)!;
    expect(status.prRef).toBe("https://gh/pr/1");
    expect(status.headCommit).toBe("abc123");
    expect(status.settledAt).toBeGreaterThan(0);
  });

  it("classifies a no-PR degraded result as failed", async () => {
    const runSdlc = vi.fn(async () => ({ prRef: null, headCommit: "", error: "no changes produced" }));
    const { service } = makeService(makeStorage({}), runSdlc);
    await service.execute(GROUP, OWNER);
    await vi.waitFor(() => expect(service.getStatus(GROUP)?.status).toBe("failed"));
    expect(service.getStatus(GROUP)?.error).toBe("no changes produced");
  });

  it("a NO-VERDICT group → NO_ACTION_POINTS, executor NEVER called, slot freed", async () => {
    const { service, runSdlc } = makeService(makeStorage({ iteration: undefined }));
    await expect(service.execute(GROUP, OWNER)).rejects.toMatchObject({
      code: "NO_ACTION_POINTS",
    });
    expect(runSdlc).not.toHaveBeenCalled();
    expect(service.getStatus(GROUP)).toBeUndefined(); // reserved slot freed for retry
  });

  it("a verdict with NO action_points → NO_ACTION_POINTS, executor NEVER called", async () => {
    const { service, runSdlc } = makeService(
      makeStorage({ executionOutputs: [{ verdict: "ok", convergence: { converged: true } }] }),
    );
    await expect(service.execute(GROUP, OWNER)).rejects.toBeInstanceOf(ExecuteSdlcError);
    expect(runSdlc).not.toHaveBeenCalled();
  });

  it("repoPath NOT in the global allowlist → REPO_NOT_ALLOWED, nothing runs", async () => {
    const { service, runSdlc } = makeService(
      makeStorage({}),
      vi.fn(async () => PR_RESULT),
      makeConfig(["/some/other/root"]),
    );
    await expect(service.execute(GROUP, OWNER)).rejects.toMatchObject({ code: "REPO_NOT_ALLOWED" });
    expect(runSdlc).not.toHaveBeenCalled();
    expect(service.getStatus(GROUP)).toBeUndefined();
  });

  it("repoPath allowlisted but NOT a project workspace → REPO_NOT_WORKSPACE, nothing runs", async () => {
    const { service, runSdlc } = makeService(
      makeStorage({ workspaces: [{ path: "/some/other/workspace" }] }),
    );
    await expect(service.execute(GROUP, OWNER)).rejects.toMatchObject({ code: "REPO_NOT_WORKSPACE" });
    expect(runSdlc).not.toHaveBeenCalled();
  });

  it("no loop + no body repoPath → NO_REPO_PATH", async () => {
    const { service, runSdlc } = makeService(makeStorage({ loops: [] }));
    await expect(service.execute(GROUP, OWNER)).rejects.toMatchObject({ code: "NO_REPO_PATH" });
    expect(runSdlc).not.toHaveBeenCalled();
  });

  it("falls back to the BODY repoPath when the group has no loop", async () => {
    const { service, runSdlc } = makeService(makeStorage({ loops: [] }));
    const handle = await service.execute(GROUP, OWNER, LOOP_REPO);
    expect(handle.status).toBe("running");
    expect(runSdlc).toHaveBeenCalledTimes(1);
    expect((runSdlc.mock.calls[0][0] as { repoPath: string }).repoPath).toBe(LOOP_REPO);
  });

  it("SINGLE-FLIGHT: a 2nd execute while one is in-flight dedups (no 2nd executor run)", async () => {
    // A never-resolving executor keeps the first run in-flight.
    const runSdlc = neverResolves();
    const { service } = makeService(makeStorage({}), runSdlc as never);

    const first = await service.execute(GROUP, OWNER);
    const second = await service.execute(GROUP, OWNER);

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.runId).toBe(first.runId); // the SAME run handed back
    expect(runSdlc).toHaveBeenCalledTimes(1); // no second worktree/branch dispatched
  });

  it("LOW-1: the happy-path settle SCRUBS result.error (no fs path leak in the status)", async () => {
    // A non-null prRef ⇒ classified "done", but the result still carries a note that
    // embeds an absolute path. The `.then` settle must run it through scrub() too.
    const runSdlc = vi.fn(async () => ({
      prRef: "https://gh/pr/9",
      headCommit: "abc",
      error: "warning at /Users/secret/repo/file.ts — partial",
    }));
    const { service } = makeService(makeStorage({}), runSdlc as never);
    await service.execute(GROUP, OWNER);

    await vi.waitFor(() => expect(service.getStatus(GROUP)?.settledAt).toBeGreaterThan(0));
    const status = service.getStatus(GROUP)!;
    expect(status.status).toBe("done");
    expect(status.error).not.toMatch(/\/Users\/secret/); // the fs layout is gone
    expect(status.error).toMatch(/<path>/); // replaced by the scrub placeholder
  });
});

describe("SdlcExecutionService — MED-1 global concurrency cap", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses an (N+1)th DISTINCT-group run with EXECUTOR_BUSY while N run, but never caps a dedup", async () => {
    expect(MAX_CONCURRENT_EXECUTE_SDLC).toBe(3);
    const N = MAX_CONCURRENT_EXECUTE_SDLC;
    const groups = Array.from({ length: N + 1 }, (_, i) => `cap-group-${i}`);
    const runSdlc = neverResolves(); // every launched run stays "running" → holds its slot
    const { service } = makeService(makeMultiStorage(groups), runSdlc as never);

    // Fill the cap with N DISTINCT groups.
    for (let i = 0; i < N; i++) {
      const h = await service.execute(groups[i], OWNER);
      expect(h.deduped).toBe(false);
      expect(h.status).toBe("running");
    }
    expect(runSdlc).toHaveBeenCalledTimes(N);

    // The (N+1)th DISTINCT group is over the cap → typed 429 outcome, NOTHING launched.
    await expect(service.execute(groups[N], OWNER)).rejects.toMatchObject({ code: "EXECUTOR_BUSY" });
    expect(runSdlc).toHaveBeenCalledTimes(N); // still N — no extra dispatch
    expect(service.getStatus(groups[N])).toBeUndefined(); // no stuck reservation

    // An ALREADY-running group is NOT subject to the cap — it dedups to its handle.
    const again = await service.execute(groups[0], OWNER);
    expect(again.deduped).toBe(true);
    expect(again.status).toBe("running");
    expect(runSdlc).toHaveBeenCalledTimes(N); // dedup launched nothing new
  });

  it("frees the cap slot on a validation failure so a later distinct group can run", async () => {
    const runSdlc = neverResolves();
    // group-A is a NO-VERDICT group (validation fails → slot freed); group-B is valid.
    const storage = {
      getLatestIteration: vi.fn(async (g: string) =>
        g === "grp-A" ? undefined : { id: `iter-${g}`, groupId: g, iterationNumber: 1 },
      ),
      getExecutionsByIteration: vi.fn(async () => [{ output: JUDGE_OUTPUT }]),
      getLoops: vi.fn(async () => [{ groupId: "grp-B", repoPath: LOOP_REPO, createdAt: new Date() }]),
      getWorkspaces: vi.fn(async () => [{ path: ALLOWED }]),
    } as unknown as IStorage;
    const { service } = makeService(storage, runSdlc as never);

    // A validation failure must NOT permanently consume a cap slot.
    await expect(service.execute("grp-A", OWNER)).rejects.toMatchObject({ code: "NO_ACTION_POINTS" });
    // ...so a fresh valid run still launches.
    const ok = await service.execute("grp-B", OWNER);
    expect(ok.deduped).toBe(false);
    expect(runSdlc).toHaveBeenCalledTimes(1);
  });
});

describe("SdlcExecutionService — MED-2 watchdog + settled-row GC", () => {
  beforeEach(() => vi.clearAllMocks());

  it("watchdog FORCE-settles a never-resolving run past the budget and frees the slot to relaunch", async () => {
    vi.useFakeTimers();
    try {
      const runSdlc = neverResolves();
      const { service } = makeService(makeStorage({}), runSdlc as never);

      const first = await service.execute(GROUP, OWNER);
      expect(service.getStatus(GROUP)?.status).toBe("running");

      // Advance just past the WHOLE-run budget: actionPoints(2) x coderTimeoutMs + margin.
      await vi.advanceTimersByTimeAsync(2 * SDLC_TIMEOUT_MS + WATCHDOG_MARGIN_MS + 1);

      const settled = service.getStatus(GROUP)!;
      expect(settled.status).toBe("failed");
      expect(settled.error).toMatch(/force-settled/i);
      expect(settled.settledAt).toBeGreaterThan(0);

      // Slot freed + the group is no longer wedged → a fresh POST relaunches with a NEW uuid.
      const second = await service.execute(GROUP, OWNER);
      expect(second.deduped).toBe(false);
      expect(second.runId).not.toBe(first.runId);
      expect(runSdlc).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("watchdog force-settle WINS over a late executor resolve (no double-settle)", async () => {
    vi.useFakeTimers();
    try {
      let resolveExec!: (r: SdlcHandoffResult) => void;
      const runSdlc = vi.fn(() => new Promise<SdlcHandoffResult>((r) => (resolveExec = r)));
      const { service } = makeService(makeStorage({}), runSdlc as never);

      await service.execute(GROUP, OWNER);
      // WHOLE-run budget: actionPoints(2) x coderTimeoutMs + margin.
      await vi.advanceTimersByTimeAsync(2 * SDLC_TIMEOUT_MS + WATCHDOG_MARGIN_MS + 1);

      const forced = service.getStatus(GROUP)!;
      expect(forced.status).toBe("failed");
      const settledAt = forced.settledAt;

      // The executor finally resolves LATE — the idempotent settle guard must drop it.
      resolveExec({ prRef: "https://gh/pr/late", headCommit: "late" });
      await vi.advanceTimersByTimeAsync(0);

      const after = service.getStatus(GROUP)!;
      expect(after.status).toBe("failed"); // unchanged
      expect(after.prRef).toBeNull(); // the late PR did NOT overwrite the row
      expect(after.settledAt).toBe(settledAt); // settled exactly once
    } finally {
      vi.useRealTimers();
    }
  });

  it("GC evicts a SETTLED (done) row after the retention window", async () => {
    vi.useFakeTimers();
    try {
      const { service } = makeService(makeStorage({})); // default resolves to PR_RESULT
      await service.execute(GROUP, OWNER);
      await vi.advanceTimersByTimeAsync(0); // let the background resolve settle the row
      expect(service.getStatus(GROUP)?.status).toBe("done");

      // Still readable BEFORE the retention window elapses.
      await vi.advanceTimersByTimeAsync(SETTLED_RETENTION_MS - 1000);
      expect(service.getStatus(GROUP)).toBeDefined();

      // Evicted once PAST the retention window.
      await vi.advanceTimersByTimeAsync(2000);
      expect(service.getStatus(GROUP)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("GC NEVER evicts a still-running row", async () => {
    vi.useFakeTimers();
    try {
      const runSdlc = neverResolves();
      const { service } = makeService(makeStorage({}), runSdlc as never);
      await service.execute(GROUP, OWNER);

      // Well past the retention window, but still BEFORE the watchdog budget — the
      // run never settled, so no GC was ever scheduled and the row survives.
      await vi.advanceTimersByTimeAsync(SETTLED_RETENTION_MS + 1000);
      expect(service.getStatus(GROUP)?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SdlcExecutionService — per-AP progress recording", () => {
  beforeEach(() => vi.clearAllMocks());

  const beat = (over: Partial<SdlcProgress> = {}): SdlcProgress => ({
    phase: "coding",
    actionPointIndex: 1,
    actionPointTotal: 2,
    actionPointTitle: "AP1",
    completedCount: 0,
    ...over,
  });

  it("records the LATEST progress beat onto the run row; the status surfaces it", async () => {
    // A runSdlc that emits two beats SYNCHRONOUSLY, then stays running (holds the row).
    const runSdlc = vi.fn((_req: unknown, _deps: unknown, onProgress?: (p: SdlcProgress) => void) => {
      onProgress?.(beat({ phase: "coding", actionPointIndex: 1, completedCount: 0 }));
      onProgress?.(beat({ phase: "committing", actionPointIndex: 2, actionPointTitle: "AP2", completedCount: 1 }));
      return new Promise<SdlcHandoffResult>(() => {}); // never settles → stays running
    });
    const { service } = makeService(makeStorage({}), runSdlc as never);

    await service.execute(GROUP, OWNER);
    const status = service.getStatus(GROUP)!;
    expect(status.status).toBe("running");
    // The LATEST beat (committing AP2) wins — not the earlier coding beat.
    expect(status.progress).toEqual({
      phase: "committing",
      actionPointIndex: 2,
      actionPointTotal: 2,
      actionPointTitle: "AP2",
      completedCount: 1,
    });
  });

  it("a progress beat AFTER settle does NOT mutate / resurrect a settled run", async () => {
    let captured: ((p: SdlcProgress) => void) | undefined;
    // Emit one beat, capture the sink, then RESOLVE (settles the row to done).
    const runSdlc = vi.fn(async (_req: unknown, _deps: unknown, onProgress?: (p: SdlcProgress) => void) => {
      captured = onProgress;
      onProgress?.(beat({ phase: "coding", actionPointIndex: 1, completedCount: 0 }));
      return PR_RESULT;
    });
    const { service } = makeService(makeStorage({}), runSdlc as never);

    await service.execute(GROUP, OWNER);
    await vi.waitFor(() => expect(service.getStatus(GROUP)?.status).toBe("done"));
    const settled = service.getStatus(GROUP)!;
    const progressAtSettle = settled.progress;

    // A LATE beat arrives after the run settled — the running-guard must drop it.
    captured?.(beat({ phase: "done", actionPointIndex: 2, actionPointTitle: "LATE", completedCount: 2 }));

    const after = service.getStatus(GROUP)!;
    expect(after.status).toBe("done"); // unchanged — not resurrected
    expect(after.progress).toEqual(progressAtSettle); // the late beat did NOT overwrite it
    expect(after.progress?.actionPointTitle).not.toBe("LATE");
  });

  it("status carries the LAST-SEEN progress once a run is settled (done)", async () => {
    const runSdlc = vi.fn(async (_req: unknown, _deps: unknown, onProgress?: (p: SdlcProgress) => void) => {
      onProgress?.(beat({ phase: "opening_pr", actionPointIndex: 2, actionPointTitle: "", completedCount: 2 }));
      return PR_RESULT;
    });
    const { service } = makeService(makeStorage({}), runSdlc as never);
    await service.execute(GROUP, OWNER);
    await vi.waitFor(() => expect(service.getStatus(GROUP)?.status).toBe("done"));
    const status = service.getStatus(GROUP)!;
    expect(status.prRef).toBe("https://gh/pr/1"); // final fields kept
    expect(status.progress?.phase).toBe("opening_pr"); // last-seen progress retained
  });
});
