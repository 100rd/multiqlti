/**
 * execute-sdlc-route.test.ts — POST /api/task-groups/:groupId/execute-sdlc and
 * its GET .../status sibling. Wires the REAL `SdlcExecutionService` (with a MOCKED
 * `runSdlcHandoff` injected via deps.runSdlc) behind the real route + a fake
 * storage, and a requireAuth/requireProject stand-in (applied at mount in
 * routes.ts). Asserts:
 *   - action points are SERVER-READ from the verdict and a CLIENT-supplied
 *     `action_points` in the body is IGNORED (zod strips it) — the executor runs
 *     the server verdict, never the client text;
 *   - repoPath not allowlisted / not a project workspace → 400, executor NEVER run;
 *   - a no-verdict group → 400 "no action points to execute";
 *   - single-flight: a 2nd POST returns the existing handle (deduped), executor
 *     dispatched ONCE;
 *   - MED-1: a NEW group's run beyond the global cap → 429 (executor busy);
 *   - the status route reflects running → done with the prRef;
 *   - authorize: a non-owner/non-admin → 403 (no execution); status 404 when none.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { AppConfig } from "../../../server/config/schema.js";
import type { IStorage } from "../../../server/storage.js";
import type { SdlcHandoffResult } from "../../../server/services/sdlc/executor.js";
import { SdlcExecutionService } from "../../../server/services/consilium/execute-sdlc.js";
import { registerExecuteSdlcRoutes } from "../../../server/routes/execute-sdlc.js";

const GROUP = "group-1";
const OWNER = "user-1";
const ALLOWED = "/repos";
const LOOP_REPO = "/repos/widget";

const JUDGE_OUTPUT = {
  verdict: "needs work",
  action_points: [
    { title: "SERVER AP1", priority: "P0" },
    { title: "SERVER AP2", priority: "P2" },
  ],
};

interface StorageOpts {
  group?: { id: string; createdBy: string | null } | undefined;
  iteration?: { id: string; groupId: string; iterationNumber: number } | undefined;
  executionOutputs?: unknown[];
  loops?: { groupId: string; repoPath: string; createdAt: Date }[];
  workspaces?: { path: string }[];
}

function makeStorage(opts: StorageOpts = {}): IStorage {
  // Respect an EXPLICIT `group: undefined` / `iteration: undefined` (destructuring
  // defaults would re-apply on undefined and mask the missing-group / no-verdict
  // cases), so key on presence.
  const group = "group" in opts ? opts.group : { id: GROUP, createdBy: OWNER };
  const iteration =
    "iteration" in opts ? opts.iteration : { id: "iter-1", groupId: GROUP, iterationNumber: 1 };
  const {
    executionOutputs = [JUDGE_OUTPUT],
    loops = [{ groupId: GROUP, repoPath: LOOP_REPO, createdAt: new Date() }],
    workspaces = [{ path: ALLOWED }],
  } = opts;
  return {
    getTaskGroup: vi.fn(async (id: string) => (group && group.id === id ? group : undefined)),
    getLatestIteration: vi.fn(async () => iteration),
    getExecutionsByIteration: vi.fn(async () => executionOutputs.map((output) => ({ output }))),
    getLoops: vi.fn(async () => loops),
    getWorkspaces: vi.fn(async () => workspaces),
  } as unknown as IStorage;
}

/**
 * A storage that serves ANY of `groupIds` (each owned by OWNER, with its own
 * verdict + loop), for the MED-1 cap test where several DISTINCT groups run.
 */
function makeMultiStorage(groupIds: string[]): IStorage {
  return {
    getTaskGroup: vi.fn(async (id: string) => ({ id, createdBy: OWNER })),
    getLatestIteration: vi.fn(async (g: string) => ({ id: `iter-${g}`, groupId: g, iterationNumber: 1 })),
    getExecutionsByIteration: vi.fn(async () => [{ output: JUDGE_OUTPUT }]),
    getLoops: vi.fn(async () => groupIds.map((g) => ({ groupId: g, repoPath: LOOP_REPO, createdAt: new Date() }))),
    getWorkspaces: vi.fn(async () => [{ path: ALLOWED }]),
  } as unknown as IStorage;
}

function makeConfig(allowedRepoPaths: string[] = [ALLOWED]): () => AppConfig {
  return () =>
    ({ pipeline: { consiliumLoop: { allowedRepoPaths, sdlcTimeoutMs: 1_200_000 } } }) as unknown as AppConfig;
}

const PR_RESULT: SdlcHandoffResult = { prRef: "https://gh/pr/42", headCommit: "deadbeef" };

function makeApp(
  storage: IStorage,
  runSdlc = vi.fn(async () => PR_RESULT),
  opts: { user?: { id: string; role?: string }; config?: () => AppConfig } = {},
) {
  const { user = { id: OWNER }, config = makeConfig() } = opts;
  const service = new SdlcExecutionService({ storage, config, runSdlc });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof user }).user = user;
    (req as unknown as { projectId: string }).projectId = "project-1";
    next();
  });
  registerExecuteSdlcRoutes(app, storage, service);
  return { app, service, runSdlc };
}

describe("POST /api/task-groups/:groupId/execute-sdlc", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SERVER-READS the verdict's action points and IGNORES a client-supplied action_points body", async () => {
    const { app, runSdlc } = makeApp(makeStorage());
    const res = await request(app)
      .post(`/api/task-groups/${GROUP}/execute-sdlc`)
      // A malicious client tries to inject its own action points — must be dropped.
      .send({ action_points: [{ title: "CLIENT EVIL — rm -rf /" }] });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("running");
    expect(res.body.deduped).toBe(false);
    expect(res.body.actionPointCount).toBe(2);

    expect(runSdlc).toHaveBeenCalledTimes(1);
    const titles = (runSdlc.mock.calls[0][0] as { actionPoints: { title: string }[] }).actionPoints.map(
      (a) => a.title,
    );
    expect(titles).toEqual(["SERVER AP1", "SERVER AP2"]); // the verdict, NOT the client text
    expect(titles.join(" ")).not.toMatch(/CLIENT EVIL/);
  });

  it("a NO-VERDICT group → 400 'no action points to execute', executor never run", async () => {
    const { app, runSdlc } = makeApp(makeStorage({ iteration: undefined }));
    const res = await request(app).post(`/api/task-groups/${GROUP}/execute-sdlc`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no action points to execute/i);
    expect(runSdlc).not.toHaveBeenCalled();
  });

  it("repoPath NOT allowlisted → 400 (allowlist message), nothing runs", async () => {
    const { app, runSdlc } = makeApp(makeStorage(), vi.fn(async () => PR_RESULT), {
      config: makeConfig(["/other/root"]),
    });
    const res = await request(app).post(`/api/task-groups/${GROUP}/execute-sdlc`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allowedRepoPaths in config\.yaml/i);
    expect(res.body.error).not.toMatch(/registered as a workspace/i);
    expect(runSdlc).not.toHaveBeenCalled();
  });

  it("repoPath allowlisted but NOT a project workspace → 400 (workspace message), nothing runs", async () => {
    const { app, runSdlc } = makeApp(makeStorage({ workspaces: [{ path: "/other/ws" }] }));
    const res = await request(app).post(`/api/task-groups/${GROUP}/execute-sdlc`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/is not registered as a workspace of the selected project/i);
    expect(res.body.error).not.toMatch(/allowedRepoPaths in config\.yaml/i);
    expect(runSdlc).not.toHaveBeenCalled();
  });

  it("SINGLE-FLIGHT: a 2nd POST returns the existing handle (deduped), executor dispatched once", async () => {
    const runSdlc = vi.fn(() => new Promise<SdlcHandoffResult>(() => {})); // never settles
    const { app } = makeApp(makeStorage(), runSdlc as never);

    const first = await request(app).post(`/api/task-groups/${GROUP}/execute-sdlc`).send({});
    const second = await request(app).post(`/api/task-groups/${GROUP}/execute-sdlc`).send({});

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.deduped).toBe(false);
    expect(second.body.deduped).toBe(true);
    expect(second.body.runId).toBe(first.body.runId);
    expect(runSdlc).toHaveBeenCalledTimes(1);
  });

  it("MED-1: a NEW group's run beyond the global cap → 429 (busy); a dedup is NOT capped", async () => {
    const groups = ["g1", "g2", "g3", "g4"]; // cap is 3 → g4 is over the cap
    const runSdlc = vi.fn(() => new Promise<SdlcHandoffResult>(() => {})); // every run stays running
    const { app } = makeApp(makeMultiStorage(groups), runSdlc as never);

    // Fill the cap with 3 DISTINCT groups.
    for (const g of ["g1", "g2", "g3"]) {
      const r = await request(app).post(`/api/task-groups/${g}/execute-sdlc`).send({});
      expect(r.status).toBe(202);
      expect(r.body.deduped).toBe(false);
    }

    // The 4th DISTINCT group is over the cap → 429, NOTHING launched.
    const over = await request(app).post(`/api/task-groups/g4/execute-sdlc`).send({});
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/busy/i);
    expect(over.headers["retry-after"]).toBe("30");
    expect(runSdlc).toHaveBeenCalledTimes(3); // g4 never dispatched

    // An ALREADY-running group still returns its handle — the cap never blocks dedup.
    const again = await request(app).post(`/api/task-groups/g1/execute-sdlc`).send({});
    expect(again.status).toBe(202);
    expect(again.body.deduped).toBe(true);
    expect(runSdlc).toHaveBeenCalledTimes(3);
  });

  it("a non-owner / non-admin → 403, executor never run", async () => {
    const { app, runSdlc } = makeApp(makeStorage(), vi.fn(async () => PR_RESULT), {
      user: { id: "intruder" },
    });
    const res = await request(app).post(`/api/task-groups/${GROUP}/execute-sdlc`).send({});
    expect(res.status).toBe(403);
    expect(runSdlc).not.toHaveBeenCalled();
  });

  it("a missing group → 404", async () => {
    const { app } = makeApp(makeStorage({ group: undefined }));
    const res = await request(app).post(`/api/task-groups/${GROUP}/execute-sdlc`).send({});
    expect(res.status).toBe(404);
  });
});

describe("GET /api/task-groups/:groupId/execute-sdlc/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when no run has been launched for the group", async () => {
    const { app } = makeApp(makeStorage());
    const res = await request(app).get(`/api/task-groups/${GROUP}/execute-sdlc/status`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no execute-sdlc run/i);
  });

  it("reflects running → done with the prRef", async () => {
    const { app, service } = makeApp(makeStorage());

    const post = await request(app).post(`/api/task-groups/${GROUP}/execute-sdlc`).send({});
    expect(post.status).toBe(202);

    const running = await request(app).get(`/api/task-groups/${GROUP}/execute-sdlc/status`);
    expect(running.status).toBe(200);
    expect(["running", "done"]).toContain(running.body.status);

    await vi.waitFor(() => expect(service.getStatus(GROUP)?.status).toBe("done"));
    const done = await request(app).get(`/api/task-groups/${GROUP}/execute-sdlc/status`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("done");
    expect(done.body.prRef).toBe("https://gh/pr/42");
    expect(done.body.headCommit).toBe("deadbeef");
  });

  it("a non-owner cannot read another user's run status (403)", async () => {
    const { app } = makeApp(makeStorage(), vi.fn(async () => PR_RESULT), { user: { id: "intruder" } });
    const res = await request(app).get(`/api/task-groups/${GROUP}/execute-sdlc/status`);
    expect(res.status).toBe(403);
  });
});
